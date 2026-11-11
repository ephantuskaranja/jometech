import { Router } from 'express';
import { canAny } from '../../core/auth.js';
import { httpError } from '../../core/validate.js';
import * as transfers from '../stock/transfers.js';
import * as deliveries from './deliveries.js';
import * as issues from '../issues/service.js';

// The gate: goods going out and coming in (step 26). Guards (goods.gate) at their site:
//   transfers to another site leave → "Left the gate"; transfers from another site arrive → "Arrived at the gate".
//   a supplier's truck arrives → logged against its open purchase order (or as no order);
//   materials issued to a job that leave the site → "Let out".
// Stores can't receive a transfer, or goods from a supplier, until the arrival is logged here.
export const router = Router();
const gate = canAny('goods.gate');

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
}

const text = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || null;

const BLANK = { order_id: '', supplier_name: '', delivery_note: '', vehicle_reg: '', driver_name: '', note: '' };

async function renderGoods(req, res, { status = 200, values = BLANK, errors = {} } = {}) {
  const list = await transfers.atGate(req.site.id);
  res.status(status).render('gate/views/goods', {
    title: 'Goods at the gate',
    leaving: list.filter((t) => t.leaving),
    arriving: list.filter((t) => !t.leaving),
    passes: await issues.passesAtGate(req.site.id),
    orders: await deliveries.openOrders(req.site.id),
    today: await deliveries.loggedToday(req.site.id),
    statuses: deliveries.STATUSES,
    values, errors,
  });
}

router.get('/gate/goods', gate, async (req, res) => {
  needSite(req);
  await renderGoods(req, res);
});

/** A supplier's truck has arrived: log it against the open order, or as no order. */
router.post('/gate/deliveries', gate, async (req, res) => {
  needSite(req);
  const values = Object.fromEntries(Object.keys(BLANK).map((k) => [k, String(req.body[k] ?? '').trim()]));
  const errors = {};
  const noOrder = values.order_id === 'none';
  const orderId = noOrder ? null : Number(values.order_id);
  if (!noOrder && !Number.isInteger(orderId)) errors.order_id = 'Choose the order on the delivery note, or No order';
  if (!values.order_id) errors.order_id = 'Choose the order on the delivery note, or No order';
  if (noOrder && values.supplier_name.length < 2) errors.supplier_name = 'Type who it is from';
  if (values.driver_name.length < 2) errors.driver_name = 'Type the driver’s name';
  if (Object.keys(errors).length) return renderGoods(req, res, { status: 422, values, errors });
  try {
    const { number, order } = await deliveries.logArrival({
      siteId: req.site.id, orderId,
      supplierName: noOrder ? text(values.supplier_name, 150) : null,
      deliveryNote: text(values.delivery_note, 60),
      vehicleReg: text(values.vehicle_reg, 20)?.toUpperCase() ?? null,
      driverName: text(values.driver_name, 100),
      note: text(values.note, 255),
    }, req);
    req.session.flash = { type: 'success', text: `${number} logged in${order ? ` against ${order.number}` : ''}. Stores can receive it now.` };
    res.redirect('/gate/goods');
  } catch (err) {
    if (!err.field) throw err;
    await renderGoods(req, res, { status: 422, values, errors: { [err.field]: err.message } });
  }
});

async function step(req, res, fn, done) {
  needSite(req);
  try {
    const t = await fn();
    req.session.flash = { type: 'success', text: done(t) };
  } catch (err) {
    if (![403, 409].includes(err.status)) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(req.body.back === 'transfer' ? `/inventory/transfers/${req.params.id}` : '/gate/goods');
}

router.post('/gate/transfers/:id/out', gate, (req, res) => step(req, res,
  () => transfers.gateOut(Number(req.params.id), req.site.id, req),
  (t) => `${t.number} left the gate.`));

router.post('/gate/transfers/:id/in', gate, (req, res) => step(req, res,
  () => transfers.gateIn(Number(req.params.id), req.site.id, text(req.body.note, 255), req),
  (t) => `${t.number} logged in at the gate. Stores can receive it now.`));

/** Materials issued to a job going out: the guard checked the load. */
router.post('/gate/issues/:id/out', gate, async (req, res) => {
  needSite(req);
  try {
    const issue = await issues.letOut(Number(req.params.id), req.site.id, text(req.body.note, 255), req);
    req.session.flash = { type: 'success', text: `${issue.number} let out of the gate.` };
  } catch (err) {
    if (![403, 404, 409].includes(err.status)) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect('/gate/goods');
});
