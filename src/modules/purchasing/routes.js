import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { sheetSize, SHEET_UNITS } from '../../core/sheet.js';
import { check, httpError, optionalId, optionalText } from '../../core/validate.js';
import { config } from '../../config.js';
import * as orders from './service.js';
import { getSupplier } from '../suppliers/service.js';
import { listCategories } from '../items/service.js';
import { receiptsForOrder, RECEIVABLE } from '../stock/service.js';

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
});

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;
const JOB_NUMBER = /^(JOB-\d{4}-\d+)/i;

/**
 * Lines arrive as lists, one entry per row. A row with no item and no quantity is skipped.
 * "For" is free text ("Trailer"), or starts with a job number (chosen from the suggestions) to link that job.
 */
async function readLines(body) {
  const list = (key) => [].concat(body[key] ?? []).map((v) => String(v ?? '').trim());
  const [ids, names, quantities, lengths, widths, units, fors, prices] = ['line_item_id', 'line_item_name', 'line_quantity', 'line_length', 'line_width', 'line_size_unit', 'line_for', 'line_price'].map(list);
  const rows = names.map((item_name, i) => ({
    item_id: ids[i] ?? '', item_name, quantity: quantities[i] ?? '', length: lengths[i] ?? '', width: widths[i] ?? '',
    size_unit: units[i] || 'ft', for: fors[i] ?? '', price: prices[i] ?? '',
  }));
  const items = await orders.activeItems(rows.map((r) => Number(r.item_id)).filter(Boolean));
  const lines = [];
  let error = null;
  for (const [i, row] of rows.entries()) {
    if (!row.item_name && !row.item_id && !row.quantity) continue;
    const n = i + 1;
    const item = items.find((it) => it.id === Number(row.item_id));
    const qty = number(row.quantity);
    const price = row.price === '' ? null : number(row.price);
    if (!item) { error ??= `Line ${n}: choose an item from the list, or add it`; continue; }
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9_999_999 || !decimals(qty, 3)) { error ??= `Line ${n}: check the quantity`; continue; }
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 999_999_999 || !decimals(price, 2))) { error ??= `Line ${n}: check the price`; continue; }

    const line = { item_id: item.id, quantity: qty, length: null, width: null, size_unit: null, area_sq_ft: null, job_id: null, for_text: null, unit_price: price, amount: null };
    let billed = qty;
    if (item.priced_by === 'area') {
      const [length, width] = [number(row.length), number(row.width)];
      const fine = (v) => Number.isFinite(v) && v > 0 && v <= 100_000 && decimals(v, 2);
      if (!fine(length) || !fine(width) || !SHEET_UNITS.includes(row.size_unit)) { error ??= `Line ${n}: enter the plate’s length and width`; continue; }
      if (!Number.isInteger(qty)) { error ??= `Line ${n}: plates are ordered in whole pieces`; continue; }
      const { sqFt } = sheetSize({ length, width, unit: row.size_unit });
      Object.assign(line, { length, width, size_unit: row.size_unit, area_sq_ft: Math.round(sqFt * 10_000) / 10_000 });
      billed = qty * sqFt;
    }
    if (price !== null) line.amount = Math.round(billed * price * 100) / 100;

    const jobNumber = JOB_NUMBER.exec(row.for)?.[1];
    if (jobNumber) {
      const job = await orders.jobIdFor(jobNumber.toUpperCase());
      if (!job) { error ??= `Line ${n}: there is no job ${jobNumber}`; continue; }
      line.job_id = job.id;
    } else if (row.for.length > 60) { error ??= `Line ${n}: keep “for” to 60 characters`; continue; } else {
      line.for_text = row.for || null;
    }
    lines.push(line);
  }
  if (!error && !lines.length) error = 'Add at least one item';
  return { rows, lines, error };
}

const blank = () => ({ supplier_id: '', order_date: localDay(), expected_on: '', notes: '' });
const blankRow = () => ({ item_id: '', item_name: '', quantity: '', length: '', width: '', size_unit: 'ft', for: '', price: '' });
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

async function renderForm(req, res, { status = 200, order = null, values, rows = [], errors = {} }) {
  const supplier = values.supplier_id ? await getSupplier(Number(values.supplier_id)) : null;
  res.status(status).render('purchasing/views/form', {
    title: order ? `Edit ${order.number}` : 'New purchase order',
    order, values, errors,
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

router.get('/purchase-orders/new', manage, async (req, res) => {
  needSite(req);
  const values = blank();
  const supplier = req.query.supplier_id ? await getSupplier(Number(req.query.supplier_id)) : null;
  if (supplier) values.supplier_id = supplier.id;
  await renderForm(req, res, { values });
});

router.post('/purchase-orders', manage, async (req, res) => {
  needSite(req);
  const values = { ...blank(), ...req.body };
  const { data, rows, errors } = await validate(req.body);
  if (Object.keys(errors).length) return renderForm(req, res, { status: 422, values, rows, errors });
  try {
    const { id, number: orderNumber } = await orders.createOrder(data, req);
    req.session.flash = { type: 'success', text: `${orderNumber} saved as a draft.` };
    res.redirect(`/purchase-orders/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, values, rows, errors: { [err.field]: err.message } });
  }
});

router.get('/purchase-orders/:id', view, async (req, res) => {
  const order = await loadOrder(req);
  res.render('purchasing/views/show', {
    title: order.number, order, statuses: orders.STATUSES,
    entries: await history('purchase_order', order.id),
    canManage: req.user.can('purchasing.manage'),
    canApprove: req.user.can('purchasing.approve'),
    canSeeJobs: req.user.can('jobs.view') || req.user.can('jobs.progress') || req.user.can('jobs.manage'),
    receipts: await receiptsForOrder(order.id),
    canReceive: req.user.can('purchasing.manage') && RECEIVABLE.includes(order.status),
  });
});

const plain = (v) => (v === null || v === undefined ? '' : String(Number(v)));

router.get('/purchase-orders/:id/edit', manage, async (req, res) => {
  const order = await loadOrder(req);
  if (order.status !== 'draft') throw httpError(409, `${order.number} is ${orders.STATUSES[order.status].label.toLowerCase()}. Take it back to draft to change it.`);
  const values = { supplier_id: order.supplier_id, order_date: order.order_date, expected_on: order.expected_on ?? '', notes: order.notes ?? '' };
  const rows = order.lines.map((l) => ({
    item_id: l.item_id, item_name: l.item_name, quantity: plain(l.quantity), length: plain(l.length), width: plain(l.width), size_unit: l.size_unit ?? 'ft',
    for: l.job_number ?? l.for_text ?? '', price: plain(l.unit_price),
  }));
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
