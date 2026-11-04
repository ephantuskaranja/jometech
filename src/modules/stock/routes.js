import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalAmount, optionalText } from '../../core/validate.js';
import * as stock from './service.js';
import { getOrder } from '../purchasing/service.js';

// Goods received against a purchase order, and the stock page.

export const router = Router();
const seeReceipts = canAny('purchasing.manage', 'purchasing.approve', 'inventory.manage');
const receive = canAny('purchasing.manage');
const seeStock = canAny('inventory.manage', 'stores.issue', 'purchasing.manage', 'purchasing.approve');

const receiptSchema = z.object({
  received_on: z.string().trim().refine((v) => isDay(v), 'Check the date'),
  delivery_note: optionalText(60),
  invoice_ref: optionalText(60),
  transport_cost: optionalAmount(),
  notes: optionalText(2000),
});

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);
const plain = (v) => (v === null || v === undefined ? '' : String(Number(v)));

/** The order's lines still to come, as form rows: everything left is filled in, for one-tap "it all came". */
function rowsFor(order) {
  return order.lines
    .filter((l) => Number(l.received_qty) < Number(l.quantity))
    .map((l) => ({
      line_id: l.id,
      name: l.item_name,
      size: l.size_unit ? `${Number(l.length)} × ${Number(l.width)} ${l.size_unit}` : '',
      area: l.area_sq_ft === null ? null : Number(l.area_sq_ft),
      unit: l.priced_by === 'area' ? 'pcs' : l.item_unit,
      price_unit: l.item_unit,
      ordered: Number(l.quantity),
      left: Number(l.quantity) - Number(l.received_qty),
      quantity: String(Number(l.quantity) - Number(l.received_qty)),
      rejected: '',
      price: plain(l.unit_price),
    }));
}

/** What was typed, onto the rows. Empty quantity means none came. */
function readLines(body, rows) {
  const list = (key) => [].concat(body[key] ?? []).map((v) => String(v ?? '').trim());
  const [ids, quantities, rejected, prices] = ['line_id', 'line_quantity', 'line_rejected', 'line_price'].map(list);
  const lines = [];
  let error = null;
  const shown = rows.map((row) => {
    const i = ids.indexOf(String(row.line_id));
    return i < 0 ? { ...row, quantity: '' } : { ...row, quantity: quantities[i] ?? '', rejected: rejected[i] ?? '', price: prices[i] ?? '' };
  });
  shown.forEach((row, i) => {
    const qty = row.quantity === '' ? 0 : number(row.quantity);
    const rej = row.rejected === '' ? 0 : number(row.rejected);
    const price = number(row.price);
    if (!qty && !rej) return;
    const n = `Line ${i + 1} (${row.name})`;
    if (!Number.isFinite(qty) || qty < 0 || !decimals(qty, 3)) error ??= `${n}: check the quantity received`;
    else if (row.area !== null && !Number.isInteger(qty)) error ??= `${n}: plates are received in whole pieces`;
    else if (!Number.isFinite(rej) || rej < 0 || !decimals(rej, 3)) error ??= `${n}: check the quantity rejected`;
    else if (qty > 0 && (row.price === '' || !Number.isFinite(price) || price <= 0 || price > 999_999_999 || !decimals(price, 2))) error ??= `${n}: enter the price from the receipt, excluding VAT`;
    else lines.push({ line_id: row.line_id, quantity: qty, rejected: rej, unit_price: qty > 0 ? price : null });
  });
  if (!error && !lines.some((l) => l.quantity > 0)) error = 'Enter what arrived';
  return { shown, lines, error };
}

async function loadOrder(req) {
  const id = Number(req.params.id);
  const order = Number.isInteger(id) ? await getOrder(id) : null;
  if (!order) throw httpError(404, 'That purchase order doesn’t exist.');
  if (!worksAt(req, order.site_id)) throw httpError(403, `${order.number} belongs to ${order.site_name}, which isn’t one of your sites.`);
  return order;
}

function renderForm(res, { status = 200, order, values, rows, errors = {} }) {
  res.status(status).render('stock/views/receive', { title: `Receive ${order.number}`, order, values, rows, errors });
}

function canReceive(req, order) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  if (!stock.RECEIVABLE.includes(order.status)) {
    throw httpError(409, order.status === 'received' ? `${order.number} has been fully received.` : `${order.number} has to be approved before goods can be received against it.`);
  }
}

router.get('/purchase-orders/:id/receive', receive, async (req, res) => {
  const order = await loadOrder(req);
  canReceive(req, order);
  renderForm(res, { order, rows: rowsFor(order), values: { received_on: localDay(), delivery_note: '', invoice_ref: '', transport_cost: '', notes: '' } });
});

router.post('/purchase-orders/:id/receive', receive, async (req, res) => {
  const order = await loadOrder(req);
  canReceive(req, order);
  const values = { received_on: '', delivery_note: '', invoice_ref: '', transport_cost: '', notes: '', ...req.body };
  const { data, errors } = check(receiptSchema, req.body);
  const { shown, lines, error } = readLines(req.body, rowsFor(order));
  const all = { ...errors, ...(error ? { lines: error } : {}) };
  if (Object.keys(all).length) return renderForm(res, { status: 422, order, values, rows: shown, errors: all });
  try {
    const { id, number: receiptNumber, changes } = await stock.receiveGoods(order.id, { ...data, lines }, req);
    req.session.flash = changes.length
      ? { type: 'warning', text: `${receiptNumber} saved and stock updated. Big price change: ${changes.join(', ')}.` }
      : { type: 'success', text: `${receiptNumber} saved and stock updated.` };
    res.redirect(`/goods-received/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(res, { status: 422, order, values, rows: shown, errors: { [err.field]: err.message } });
  }
});

router.post('/purchase-orders/:id/close', receive, async (req, res) => {
  const order = await loadOrder(req);
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why nothing more is coming (3 to 255 characters).' };
    return res.redirect(`/purchase-orders/${order.id}`);
  }
  await stock.closeOrder(order.id, reason, req);
  req.session.flash = { type: 'success', text: `${order.number} closed.` };
  res.redirect(`/purchase-orders/${order.id}`);
});

router.get('/goods-received', seeReceipts, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  res.render('stock/views/receipts', { title: 'Goods received', q, list: await stock.listReceipts({ siteIds: req.user.sites.map((s) => s.id), q }) });
});

async function loadReceipt(req) {
  const id = Number(req.params.id);
  const receipt = Number.isInteger(id) ? await stock.getReceipt(id) : null;
  if (!receipt) throw httpError(404, 'That goods received note doesn’t exist.');
  if (!worksAt(req, receipt.site_id)) throw httpError(403, `${receipt.number} is at ${receipt.site_name}, which isn’t one of your sites.`);
  return receipt;
}

router.get('/goods-received/:id', seeReceipts, async (req, res) => {
  const receipt = await loadReceipt(req);
  res.render('stock/views/receipt', {
    title: receipt.number, receipt,
    entries: await history('goods_receipt', receipt.id),
    canReverse: req.user.can('purchasing.manage') && !receipt.reversed_at,
  });
});

router.post('/goods-received/:id/reverse', receive, async (req, res) => {
  const receipt = await loadReceipt(req);
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why it is being reversed (3 to 255 characters).' };
    return res.redirect(`/goods-received/${receipt.id}`);
  }
  await stock.reverseReceipt(receipt.id, reason, req);
  req.session.flash = { type: 'warning', text: `${receipt.number} reversed. It is out of stock, and the order is waiting for those goods again.` };
  res.redirect(`/goods-received/${receipt.id}`);
});

router.get('/inventory', seeStock, async (req, res) => {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  const q = String(req.query.q ?? '').slice(0, 60);
  const lowOnly = req.query.show === 'low';
  res.render('stock/views/inventory', {
    title: 'Inventory', q, lowOnly,
    list: await stock.stockList({ siteId: req.site.id, q, lowOnly }),
    totals: await stock.stockTotals(),
  });
});
