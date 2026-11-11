import { Router } from 'express';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { db } from '../../core/db.js';
import { sheetSize, SHEET_UNITS } from '../../core/sheet.js';
import { httpError } from '../../core/validate.js';
import * as counts from './counts.js';
import { listCategories } from '../items/service.js';

// Inventory → Stock counts: start a blind count (everything or one category), fill the sheet
// (on screen or printed), review the differences, post them as an adjustment for a manager to approve.
export const router = Router();
const manage = canAny('inventory.manage');
const see = canAny('inventory.manage', 'inventory.approve');

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
}

async function loadCount(req) {
  const id = Number(req.params.id);
  const count = Number.isInteger(id) ? await counts.getCount(id) : null;
  if (!count) throw httpError(404, 'That count doesn’t exist.');
  if (!worksAt(req, count.site_id)) throw httpError(403, `${count.number} is at ${count.site_name}, which isn’t one of your sites.`);
  return count;
}

/** A counted figure: blank = not counted; plates in whole pieces. Returns { value } or { error }. */
function readCounted(raw, { area, label }) {
  const typed = String(raw ?? '').trim();
  if (typed === '') return { value: null };
  const n = number(typed);
  if (!Number.isFinite(n) || n < 0 || n > 9_999_999 || !decimals(n, 3)) return { error: `${label}: check the number` };
  if (area && !Number.isInteger(n)) return { error: `${label}: plates are counted in whole pieces` };
  return { value: n };
}

const back = (req, res, id, type, text, hash = '') => {
  if (text) req.session.flash = { type, text };
  res.redirect(`/inventory/counts/${id}${hash}`);
};

router.get('/inventory/counts', see, async (req, res) => {
  res.render('stock/views/counts', {
    title: 'Stock counts', statuses: counts.STATUSES,
    list: await counts.listCounts(req.user.sites.map((s) => s.id)),
    categories: await listCategories(),
    canCount: req.user.can('inventory.manage') && Boolean(req.site),
  });
});

router.post('/inventory/counts', manage, async (req, res) => {
  needSite(req);
  const categories = await listCategories();
  const categoryId = categories.some((c) => c.id === Number(req.body.category_id)) ? Number(req.body.category_id) : null;
  try {
    const { id, number: no } = await counts.startCount({ siteId: req.site.id, categoryId }, req);
    req.session.flash = { type: 'success', text: `${no} started. Count what is on the racks and type it in, or print the sheet.` };
    res.redirect(`/inventory/counts/${id}`);
  } catch (err) {
    if (![409, 422].includes(err.status)) throw err;
    req.session.flash = { type: 'warning', text: err.message };
    res.redirect('/inventory/counts');
  }
});

router.get('/inventory/counts/:id', see, async (req, res) => {
  const count = await loadCount(req);
  const items = count.status === 'open'
    ? (await db('items').where({ is_active: true }).orderBy('name').select('id', 'name', 'priced_by', 'unit'))
    : [];
  res.render('stock/views/count', {
    title: count.number, count, statuses: counts.STATUSES, items,
    entries: await history('stock_count', count.id),
    canCount: req.user.can('inventory.manage'),
  });
});

// Save the sheet. "Review" saves, then opens the differences.
router.post('/inventory/counts/:id', manage, async (req, res) => {
  const count = await loadCount(req);
  const counted = {};
  const errors = [];
  for (const line of count.lines) {
    const key = `counted_${line.id}`;
    if (!(key in req.body)) continue;
    const label = `${line.item_name}${line.size_key ? ` ${Number(line.length)} × ${Number(line.width)} ${line.size_unit}` : ''}`;
    const { value, error } = readCounted(req.body[key], { area: line.priced_by === 'area', label });
    if (error) errors.push(error);
    else counted[line.id] = value;
  }
  await counts.saveCounted(count.id, counted);
  if (errors.length) return back(req, res, count.id, 'warning', `Saved, except: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}`);
  if (req.body.next === 'review') return res.redirect(`/inventory/counts/${count.id}/review`);
  back(req, res, count.id, 'success', 'Saved. Carry on counting, or review the differences when done.');
});

// Something on the racks that isn't on the sheet.
router.post('/inventory/counts/:id/lines', manage, async (req, res) => {
  const count = await loadCount(req);
  const item = await db('items').where({ id: Number(req.body.item_id) || 0 }).first('id', 'name', 'priced_by');
  if (!item) return back(req, res, count.id, 'warning', 'Choose the item that was found.', '#add-line');
  const line = { item_id: item.id, length: null, width: null, size_unit: null, area_sq_ft: null };
  if (item.priced_by === 'area') {
    const [length, width] = [number(req.body.length), number(req.body.width)];
    const fine = (v) => Number.isFinite(v) && v > 0 && v <= 100_000 && decimals(v, 2);
    if (!fine(length) || !fine(width) || !SHEET_UNITS.includes(req.body.size_unit)) return back(req, res, count.id, 'warning', `${item.name}: enter the plate’s length and width.`, '#add-line');
    Object.assign(line, { length, width, size_unit: req.body.size_unit, area_sq_ft: Math.round(sheetSize({ length, width, unit: req.body.size_unit }).sqFt * 10_000) / 10_000 });
  }
  const { value, error } = readCounted(req.body.counted, { area: item.priced_by === 'area', label: item.name });
  if (error) return back(req, res, count.id, 'warning', error, '#add-line');
  try {
    await counts.addLine(count.id, { ...line, counted: value });
  } catch (err) {
    if (err.status !== 409) throw err;
    return back(req, res, count.id, 'warning', err.message, err.lineId ? `#line-${err.lineId}` : '');
  }
  back(req, res, count.id, 'success', `${item.name} added to the sheet.`, '#add-line');
});

router.post('/inventory/counts/:id/lines/:lineId/remove', manage, async (req, res) => {
  const count = await loadCount(req);
  await counts.removeAddedLine(count.id, Number(req.params.lineId));
  back(req, res, count.id, 'success', 'Line removed.');
});

router.get('/inventory/counts/:id/review', manage, async (req, res) => {
  const count = await loadCount(req);
  if (count.status !== 'open') return res.redirect(`/inventory/counts/${count.id}`);
  const lines = await counts.review(count.id);
  res.render('stock/views/count-review', { title: `Review ${count.number}`, count, lines });
});

router.post('/inventory/counts/:id/post', manage, async (req, res) => {
  const count = await loadCount(req);
  try {
    const { adjustment, changed, counted } = await counts.postCount(count.id, req);
    if (adjustment) {
      req.session.flash = { type: 'success', text: `${count.number} posted: ${changed} of ${counted} counted lines differ. ${adjustment.number} is waiting for a manager’s approval.` };
      return res.redirect(`/inventory/adjustments/${adjustment.id}`);
    }
    back(req, res, count.id, 'success', `${count.number} posted: everything counted matched. Nothing to adjust.`);
  } catch (err) {
    if (![409, 422].includes(err.status)) throw err;
    back(req, res, count.id, 'warning', err.message);
  }
});

router.post('/inventory/counts/:id/cancel', manage, async (req, res) => {
  const count = await loadCount(req);
  const note = String(req.body.note ?? '').trim();
  if (note.length < 3 || note.length > 255) return back(req, res, count.id, 'warning', 'Say why it is being cancelled (3 to 255 characters).');
  await counts.cancelCount(count.id, note, req);
  back(req, res, count.id, 'success', `${count.number} cancelled. Stock didn’t change.`);
});
