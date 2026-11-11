import { Router } from 'express';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { db } from '../../core/db.js';
import { sheetSize, SHEET_UNITS } from '../../core/sheet.js';
import { httpError } from '../../core/validate.js';
import * as adjustments from './adjustments.js';
import { listCategories } from '../items/service.js';

// Inventory → Adjustments: stores record stock taken off or added, with a reason;
// a manager or admin approves it before stock changes.
export const router = Router();
const record = canAny('inventory.manage');
const approve = canAny('inventory.approve');
const see = canAny('inventory.manage', 'inventory.approve');

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

/** Active items, with the average the form needs to know whether an addition needs a cost. */
async function itemsForForm() {
  const rows = await db('items').where({ is_active: true }).orderBy('name').select('id', 'name', 'priced_by', 'unit', 'avg_cost');
  return rows.map((i) => ({ ...i, avg_cost: i.avg_cost === null ? null : Number(i.avg_cost) }));
}

/**
 * Lines arrive as lists, one entry per row: direction (off/on), item, plate size, quantity, and a cost
 * only for an addition to an item with no average yet. Removals are checked against what is here now.
 */
async function readLines(body, siteId) {
  const list = (key) => [].concat(body[key] ?? []).map((v) => String(v ?? '').trim());
  const [dirs, ids, names, quantities, lengths, widths, units, costs] = ['line_dir', 'line_item_id', 'line_item_name', 'line_quantity', 'line_length', 'line_width', 'line_size_unit', 'line_cost'].map(list);
  const rows = names.map((item_name, i) => ({
    dir: dirs[i] === 'on' ? 'on' : 'off', item_id: ids[i] ?? '', item_name, quantity: quantities[i] ?? '', length: lengths[i] ?? '', width: widths[i] ?? '', size_unit: units[i] || 'ft', cost: costs[i] ?? '',
  }));
  const items = await itemsForForm();
  const here = await adjustments.balancesAt(siteId);
  const lines = [];
  let error = null;
  rows.forEach((row, i) => {
    if (!row.item_name && !row.item_id && !row.quantity) return;
    const n = `Line ${i + 1}`;
    const item = items.find((it) => it.id === Number(row.item_id));
    const qty = number(row.quantity);
    if (!item) { error ??= `${n}: choose an item from the list`; return; }
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9_999_999 || !decimals(qty, 3)) { error ??= `${n}: check the quantity`; return; }
    const line = { item_id: item.id, quantity: row.dir === 'off' ? -qty : qty, length: null, width: null, size_unit: null, area_sq_ft: null, entered_cost: null };
    let key = '';
    if (item.priced_by === 'area') {
      const [length, width] = [number(row.length), number(row.width)];
      const fine = (v) => Number.isFinite(v) && v > 0 && v <= 100_000 && decimals(v, 2);
      if (!fine(length) || !fine(width) || !SHEET_UNITS.includes(row.size_unit)) { error ??= `${n}: enter the plate’s length and width`; return; }
      if (!Number.isInteger(qty)) { error ??= `${n}: plates are counted in whole pieces`; return; }
      Object.assign(line, { length, width, size_unit: row.size_unit, area_sq_ft: Math.round(sheetSize({ length, width, unit: row.size_unit }).sqFt * 10_000) / 10_000 });
      key = `${length}x${width}${row.size_unit}`;
    }
    if (row.dir === 'off') {
      const have = Number(here.find((b) => b.item_id === item.id && b.size_key === key)?.quantity ?? 0);
      if (have < qty) { error ??= `${n}: only ${have} ${item.priced_by === 'area' ? `piece${have === 1 ? '' : 's'} of ${key}` : item.unit} here, so ${qty} can’t be taken off`; return; }
    } else if (item.avg_cost === null) {
      const cost = number(row.cost);
      if (row.cost === '' || !Number.isFinite(cost) || cost <= 0 || cost > 999_999_999 || !decimals(cost, 2)) { error ??= `${n}: ${item.name} has no cost yet, so enter the cost per ${item.priced_by === 'area' ? 'sq ft' : 'unit'}`; return; }
      line.entered_cost = cost;
    }
    lines.push(line);
  });
  if (!error && !lines.length) error = 'Add at least one item';
  return { rows, lines, error };
}

const blankRow = () => ({ dir: 'off', item_id: '', item_name: '', quantity: '', length: '', width: '', size_unit: 'ft', cost: '' });

async function renderForm(req, res, { status = 200, values = { reason: '', note: '' }, rows = [], errors = {} } = {}) {
  res.status(status).render('stock/views/adjustment-form', {
    title: 'Adjust stock', values, errors, reasons: adjustments.REASONS,
    rows: rows.length ? rows : [blankRow()],
    items: await itemsForForm(),
    here: (await adjustments.balancesAt(req.site.id)).map((b) => ({ ...b, quantity: Number(b.quantity), length: b.length === null ? null : Number(b.length), width: b.width === null ? null : Number(b.width) })),
    categories: await listCategories(),
  });
}

async function loadAdjustment(req) {
  const id = Number(req.params.id);
  const adj = Number.isInteger(id) ? await adjustments.getAdjustment(id) : null;
  if (!adj) throw httpError(404, 'That adjustment doesn’t exist.');
  if (!worksAt(req, adj.site_id)) throw httpError(403, `${adj.number} is at ${adj.site_name}, which isn’t one of your sites.`);
  return adj;
}

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
}

router.get('/inventory/adjustments', see, async (req, res) => {
  const show = ['pending', 'done', 'all'].includes(req.query.show) ? req.query.show : 'pending';
  const siteIds = req.user.sites.map((s) => s.id);
  res.render('stock/views/adjustments', {
    title: 'Stock adjustments', show, reasons: adjustments.REASONS, statuses: adjustments.STATUSES,
    list: await adjustments.listAdjustments({ siteIds, show }),
    pending: await adjustments.pendingCount(siteIds),
    canRecord: req.user.can('inventory.manage'),
    canApprove: req.user.can('inventory.approve'),
  });
});

router.get('/inventory/adjustments/new', record, async (req, res) => {
  needSite(req);
  await renderForm(req, res);
});

router.post('/inventory/adjustments', record, async (req, res) => {
  needSite(req);
  const values = { reason: String(req.body.reason ?? ''), note: String(req.body.note ?? '').trim().slice(0, 500) };
  const { rows, lines, error } = await readLines(req.body, req.site.id);
  const errors = {};
  if (!adjustments.REASONS[values.reason] || values.reason === 'count') errors.reason = 'Choose why';
  if (values.reason === 'other' && values.note.length < 3) errors.note = 'Say what happened';
  if (error) errors.lines = error;
  if (Object.keys(errors).length) return renderForm(req, res, { status: 422, values, rows, errors });
  const { id, number: no } = await adjustments.createAdjustment({ siteId: req.site.id, reason: values.reason, note: values.note || null, lines }, req);
  req.session.flash = { type: 'success', text: `${no} saved. Stock changes when a manager approves it.` };
  res.redirect(`/inventory/adjustments/${id}`);
});

router.get('/inventory/adjustments/:id', see, async (req, res) => {
  const adj = await loadAdjustment(req);
  res.render('stock/views/adjustment', {
    title: adj.number, adj, reasons: adjustments.REASONS, statuses: adjustments.STATUSES,
    entries: await history('stock_adjustment', adj.id),
    canApprove: req.user.can('inventory.approve'),
    canCancel: req.user.can('inventory.manage'),
  });
});

router.post('/inventory/adjustments/:id/approve', approve, async (req, res) => {
  const adj = await loadAdjustment(req);
  try {
    const { value } = await adjustments.approveAdjustment(adj.id, req);
    req.session.flash = { type: 'success', text: `${adj.number} approved: stock changed at ${adj.site_name} (value ${value < 0 ? '−' : '+'}KES ${res.locals.fmt.money(Math.abs(value))}).` };
  } catch (err) {
    if (err.status !== 409) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/inventory/adjustments/${adj.id}`);
});

async function close(req, res, status) {
  const adj = await loadAdjustment(req);
  const note = String(req.body.note ?? '').trim();
  if (note.length < 3 || note.length > 255) {
    req.session.flash = { type: 'warning', text: `Say why it is being ${status} (3 to 255 characters).` };
    return res.redirect(`/inventory/adjustments/${adj.id}`);
  }
  try {
    await adjustments.closeAdjustment(adj.id, status, note, req);
    req.session.flash = { type: 'success', text: `${adj.number} ${status}. Stock didn’t change.` };
  } catch (err) {
    if (err.status !== 409) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/inventory/adjustments/${adj.id}`);
}
router.post('/inventory/adjustments/:id/reject', approve, (req, res) => close(req, res, 'rejected'));
router.post('/inventory/adjustments/:id/cancel', record, (req, res) => close(req, res, 'cancelled'));
