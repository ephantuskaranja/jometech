import { Router } from 'express';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { db } from '../../core/db.js';
import { httpError } from '../../core/validate.js';
import * as transfers from './transfers.js';
import { availableStock } from '../issues/service.js';

// Inventory → Transfers: send stock to another site; the other site receives it.
// Sending needs a user at the sending site, receiving one at the receiving site.
export const router = Router();
const manage = canAny('inventory.manage');
const see = canAny('inventory.manage', 'inventory.approve');

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);
const text = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || null;

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
}

/** Rows: what is in stock here (balance id), its name, and how many. Like issuing materials. */
function readLines(body) {
  const list = (key) => [].concat(body[key] ?? []).map((v) => String(v ?? '').trim());
  const [ids, labels, quantities] = ['line_balance_id', 'line_label', 'line_quantity'].map(list);
  const rows = labels.map((label, i) => ({ balance_id: ids[i] ?? '', label, quantity: quantities[i] ?? '' }));
  const lines = [];
  let error = null;
  rows.forEach((row, i) => {
    if (!row.label && !row.balance_id && !row.quantity) return;
    const qty = number(row.quantity);
    if (!Number(row.balance_id)) error ??= `Line ${i + 1}: choose an item from what is in stock`;
    else if (!Number.isFinite(qty) || qty <= 0 || !decimals(qty, 3)) error ??= `Line ${i + 1}: check the quantity`;
    else if (lines.some((l) => l.balance_id === Number(row.balance_id))) error ??= `Line ${i + 1}: that item is on the list twice`;
    else lines.push({ balance_id: Number(row.balance_id), quantity: qty });
  });
  if (!error && !lines.length) error = 'Add at least one item';
  return { rows, lines, error };
}

const otherSites = (req) => db('sites').where({ is_active: true }).whereNot({ id: req.site.id }).orderBy('name').select('id', 'name');

async function renderForm(req, res, { status = 200, values = { to_site_id: '', carried_by: '', note: '' }, rows = [], errors = {} } = {}) {
  res.status(status).render('stock/views/transfer-form', {
    title: 'Send stock to another site', values, errors,
    rows: rows.length ? rows : [{ balance_id: '', label: '', quantity: '' }],
    stock: await availableStock(req.site.id),
    sites: await otherSites(req),
  });
}

async function loadTransfer(req) {
  const id = Number(req.params.id);
  const t = Number.isInteger(id) ? await transfers.getTransfer(id) : null;
  if (!t) throw httpError(404, 'That transfer doesn’t exist.');
  if (!worksAt(req, t.from_site_id) && !worksAt(req, t.to_site_id)) throw httpError(403, `${t.number} is between sites that aren’t yours.`);
  return t;
}

router.get('/inventory/transfers', see, async (req, res) => {
  const siteIds = req.user.sites.map((s) => s.id);
  const show = ['incoming', 'outgoing', 'all'].includes(req.query.show) ? req.query.show : 'incoming';
  res.render('stock/views/transfers', {
    title: 'Stock transfers', show, statuses: transfers.STATUSES,
    list: await transfers.listTransfers({ siteIds, show }),
    incoming: await transfers.incomingCount(siteIds),
    canSend: req.user.can('inventory.manage'),
  });
});

router.get('/inventory/transfers/new', manage, async (req, res) => {
  needSite(req);
  await renderForm(req, res);
});

router.post('/inventory/transfers', manage, async (req, res) => {
  needSite(req);
  const values = { to_site_id: String(req.body.to_site_id ?? ''), carried_by: req.body.carried_by ?? '', note: req.body.note ?? '' };
  const { rows, lines, error } = readLines(req.body);
  const errors = {};
  if (!Number(values.to_site_id)) errors.to_site_id = 'Choose the site it is going to';
  if (error) errors.lines = error;
  if (Object.keys(errors).length) return renderForm(req, res, { status: 422, values, rows, errors });
  try {
    const { id, number: no } = await transfers.sendTransfer({
      fromSiteId: req.site.id, toSiteId: Number(values.to_site_id), carriedBy: text(values.carried_by, 100), note: text(values.note, 500), lines,
    }, req);
    req.session.flash = { type: 'success', text: `${no} sent. It is in transit until the other site receives it.` };
    res.redirect(`/inventory/transfers/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, values, rows, errors: { [err.field]: err.message } });
  }
});

router.get('/inventory/transfers/:id', see, async (req, res) => {
  const t = await loadTransfer(req);
  res.render('stock/views/transfer', {
    title: t.number, t, statuses: transfers.STATUSES,
    entries: await history('stock_transfer', t.id),
    canReceive: t.status === 'in_transit' && req.user.can('inventory.manage') && worksAt(req, t.to_site_id),
    canCancel: t.status === 'in_transit' && req.user.can('inventory.manage') && worksAt(req, t.from_site_id),
  });
});

router.post('/inventory/transfers/:id/receive', manage, async (req, res) => {
  const t = await loadTransfer(req);
  if (!worksAt(req, t.to_site_id)) throw httpError(403, `${t.number} is going to ${t.to_name}, which isn’t one of your sites.`);
  const received = {};
  for (const line of t.lines) {
    const raw = String(req.body[`received_${line.id}`] ?? '').trim();
    const n = raw === '' ? NaN : number(raw);
    if (!Number.isFinite(n) || n < 0 || n > Number(line.quantity) + 1e-9 || !decimals(n, 3) || (line.size_key && !Number.isInteger(n))) {
      req.session.flash = { type: 'warning', text: `${line.item_name}: enter how many arrived, from 0 up to the ${Number(line.quantity)} sent${line.size_key ? ', in whole pieces' : ''}.` };
      return res.redirect(`/inventory/transfers/${t.id}`);
    }
    received[line.id] = n;
  }
  try {
    const { shortLines, adjustment } = await transfers.receiveTransfer(t.id, { received, note: text(req.body.note, 500) }, req);
    req.session.flash = shortLines
      ? { type: 'warning', text: `${t.number} received with ${shortLines} line${shortLines === 1 ? '' : 's'} short. ${adjustment.number} takes off what is missing once a manager approves it.` }
      : { type: 'success', text: `${t.number} received: everything arrived. It is in stock at ${t.to_name}.` };
  } catch (err) {
    if (![409, 422].includes(err.status)) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/inventory/transfers/${t.id}`);
});

router.post('/inventory/transfers/:id/cancel', manage, async (req, res) => {
  const t = await loadTransfer(req);
  if (!worksAt(req, t.from_site_id)) throw httpError(403, `Only ${t.from_name} can cancel ${t.number}.`);
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why it is being cancelled (3 to 255 characters).' };
    return res.redirect(`/inventory/transfers/${t.id}`);
  }
  try {
    await transfers.cancelTransfer(t.id, reason, req);
    req.session.flash = { type: 'success', text: `${t.number} cancelled. The stock is back at ${t.from_name}.` };
  } catch (err) {
    if (err.status !== 409) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/inventory/transfers/${t.id}`);
});
