import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalId, optionalText } from '../../core/validate.js';
import { config } from '../../config.js';
import * as orders from './service.js';
import { readLines, blankRow, rowsOf } from './lines.js';
import { forOrdering, requestsOnOrder } from './requests.js';
import { getSupplier } from '../suppliers/service.js';
import { listCategories } from '../items/service.js';
import { receiptsForOrder, RECEIVABLE } from '../stock/service.js';
import { waitingFor } from '../gate/deliveries.js';

// Purchase orders: write one, have it approved, print it for the supplier.

export const router = Router();
const view = canAny('purchasing.manage', 'purchasing.approve');
const manage = canAny('purchasing.manage');
const approve = canAny('purchasing.approve');
const manageOrApprove = view;

const day = (message) => z.string().trim().refine((v) => isDay(v), message);
const orderSchema = z.object({
  supplier_id: optionalId().refine((v) => v !== null, 'Choose the supplier'),
  order_date: day('Check the date'),
  expected_on: z.string().trim().optional().refine((v) => !v || isDay(v), 'Check the date').transform((v) => v || null),
  notes: optionalText(2000),
}).refine((v) => !v.expected_on || !isDay(v.order_date) || v.expected_on >= v.order_date,
  { path: ['expected_on'], message: 'Delivery can’t be before the order date' });

const blank = () => ({ supplier_id: '', order_date: localDay(), expected_on: '', notes: '' });
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
}

async function loadOrder(req) {
  const id = Number(req.params.id);
  const order = Number.isInteger(id) ? await orders.getOrder(id) : null;
  if (!order) throw httpError(404, 'That purchase order doesn’t exist.');
  if (!worksAt(req, order.site_id)) throw httpError(403, `${order.number} belongs to ${order.site_name}, which isn’t one of your sites.`);
  return order;
}

async function renderForm(req, res, { status = 200, order = null, values, rows = [], errors = {}, requests = [] }) {
  const supplier = values.supplier_id ? await getSupplier(Number(values.supplier_id)) : null;
  res.status(status).render('purchasing/views/form', {
    title: order ? `Edit ${order.number}` : 'New purchase order',
    order, values, errors, requests,
    rows: rows.length ? rows : [blankRow()],
    supplierOption: supplier ? [{ value: supplier.id, label: `${supplier.name} (${supplier.number})` }] : [],
    items: await orders.itemOptions(),
    jobs: await orders.jobOptions(req.user.sites.map((s) => s.id)),
    categories: await listCategories(),
    canAddItems: req.user.can('purchasing.manage') || req.user.can('inventory.manage'),
  });
}

async function validate(body) {
  const { data, errors } = check(orderSchema, body);
  const { rows, lines, error } = await readLines(body);
  const all = { ...errors, ...(error ? { lines: error } : {}) };
  if (data) data.lines = lines;
  return { data, rows, errors: all };
}

router.get('/purchase-orders', view, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const tab = orders.TABS.includes(req.query.show) ? req.query.show : 'open';
  const siteIds = req.user.sites.map((s) => s.id);
  res.render('purchasing/views/index', {
    title: 'Purchase orders', tab, q,
    list: await orders.listOrders({ siteIds, tab, q }),
    counts: await orders.countByTab(siteIds),
    statuses: orders.STATUSES,
    canManage: req.user.can('purchasing.manage'),
  });
});

/** Approved purchase requests to put on the order: ?requests=3,5 (from the list), or request_id fields (the form). */
const requestIds = (v) => [...new Set([].concat(v ?? []).flatMap((x) => String(x).split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
async function requestsFor(req, ids) {
  const found = await forOrdering(ids, req.user.sites.map((s) => s.id));
  if (found.length !== ids.length) throw httpError(409, 'One of those purchase requests has already been ordered, or is no longer approved. Go back to the requests and choose again.');
  return found;
}

/** The same item, size and purpose asked for in several requests: one line, quantities added. */
function combine(lines) {
  const out = new Map();
  for (const l of lines) {
    const key = [l.item_id, l.length, l.width, l.size_unit, l.job_id, l.for_text].join('|');
    const seen = out.get(key);
    if (seen) seen.quantity = Math.round((Number(seen.quantity) + Number(l.quantity)) * 1000) / 1000;
    else out.set(key, { ...l });
  }
  return [...out.values()];
}

router.get('/purchase-orders/new', manage, async (req, res) => {
  needSite(req);
  const values = blank();
  const supplier = req.query.supplier_id ? await getSupplier(Number(req.query.supplier_id)) : null;
  if (supplier) values.supplier_id = supplier.id;
  const requests = await requestsFor(req, requestIds(req.query.requests));
  await renderForm(req, res, { values, requests, rows: rowsOf(combine(requests.flatMap((r) => r.lines))) });
});

router.post('/purchase-orders', manage, async (req, res) => {
  needSite(req);
  const values = { ...blank(), ...req.body };
  const requests = await requestsFor(req, requestIds(req.body.request_id));
  const { data, rows, errors } = await validate(req.body);
  if (Object.keys(errors).length) return renderForm(req, res, { status: 422, values, rows, errors, requests });
  data.request_ids = requests.map((r) => r.id);
  try {
    const { id, number: orderNumber } = await orders.createOrder(data, req);
    req.session.flash = { type: 'success', text: `${orderNumber} saved as a draft.` };
    res.redirect(`/purchase-orders/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, values, rows, requests, errors: { [err.field]: err.message } });
  }
});

router.get('/purchase-orders/:id', view, async (req, res) => {
  const order = await loadOrder(req);
  res.render('purchasing/views/show', {
    title: order.number, order, statuses: orders.STATUSES,
    entries: await history('purchase_order', order.id),
    requests: await requestsOnOrder(order.id),
    canManage: req.user.can('purchasing.manage'),
    canApprove: req.user.can('purchasing.approve'),
    canSeeJobs: req.user.can('jobs.view') || req.user.can('jobs.progress') || req.user.can('jobs.manage'),
    receipts: await receiptsForOrder(order.id),
    canReceive: req.user.can('purchasing.manage') && RECEIVABLE.includes(order.status),
    // Logged in at the gate, at the site you're working at: goods are received against these.
    arrivals: req.site ? (await waitingFor(order.id)).filter((d) => d.site_id === req.site.id) : [],
  });
});


router.get('/purchase-orders/:id/edit', manage, async (req, res) => {
  const order = await loadOrder(req);
  if (order.status !== 'draft') throw httpError(409, `${order.number} is ${orders.STATUSES[order.status].label.toLowerCase()}. Take it back to draft to change it.`);
  const values = { supplier_id: order.supplier_id, order_date: order.order_date, expected_on: order.expected_on ?? '', notes: order.notes ?? '' };
  const rows = rowsOf(order.lines);
  await renderForm(req, res, { order, values, rows });
});

router.post('/purchase-orders/:id', manage, async (req, res) => {
  const order = await loadOrder(req);
  const values = { ...blank(), ...req.body };
  const { data, rows, errors } = await validate(req.body);
  if (Object.keys(errors).length) return renderForm(req, res, { status: 422, order, values, rows, errors });
  try {
    await orders.updateOrder(order.id, data, req);
    req.session.flash = { type: 'success', text: `Saved changes to ${order.number}.` };
    res.redirect(`/purchase-orders/${order.id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, order, values, rows, errors: { [err.field]: err.message } });
  }
});

/** One button that changes the status, then back to the order with a message. */
const action = (guard, url, run, message) => router.post(`/purchase-orders/:id/${url}`, guard, async (req, res) => {
  const order = await loadOrder(req);
  await run(order, req);
  req.session.flash = { type: 'success', text: message(order) };
  res.redirect(`/purchase-orders/${order.id}`);
});

action(manage, 'submit', (o, req) => orders.submitOrder(o.id, req), (o) => `${o.number} is waiting for approval.`);
action(approve, 'approve', (o, req) => orders.approveOrder(o.id, req), (o) => `${o.number} approved. Print it for the supplier.`);
action(manage, 'send', (o, req) => orders.markSent(o.id, req), (o) => `${o.number} marked as sent to ${o.supplier_name}.`);
action(manageOrApprove, 'draft', (o, req) => orders.backToDraft(o.id, String(req.body.reason ?? '').trim().slice(0, 255), req), (o) => `${o.number} is back to draft.`);

router.post('/purchase-orders/:id/cancel', manageOrApprove, async (req, res) => {
  const order = await loadOrder(req);
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why it is being cancelled (3 to 255 characters).' };
    return res.redirect(`/purchase-orders/${order.id}`);
  }
  await orders.cancelOrder(order.id, reason, req);
  req.session.flash = { type: 'warning', text: `${order.number} cancelled.` };
  res.redirect(`/purchase-orders/${order.id}`);
});

// The order on letterhead, like the paper one: an A4 page to print or save as PDF.
router.get('/purchase-orders/:id/print', view, async (req, res) => {
  const order = await loadOrder(req);
  res.render('purchasing/views/print', { layout: false, title: `${order.number} ${order.supplier_name}`, order, company: config.company });
});
