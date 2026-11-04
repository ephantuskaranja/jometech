import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { sheetSize, SHEET_UNITS } from '../../core/sheet.js';
import { check, httpError, optionalAmount, optionalText } from '../../core/validate.js';
import * as items from './service.js';

// Items: the list of what the workshop buys and uses, with prices excluding VAT.

export const router = Router();
const view = canAny('inventory.manage', 'stores.issue', 'purchasing.manage', 'purchasing.approve');
const manage = canAny('inventory.manage');

const itemSchema = z.object({
  name: z.string().trim().min(2, 'Give the item a name').max(120, 'Use 120 characters or fewer').transform((v) => v.replace(/\s+/g, ' ')),
  category: z.string().trim().min(2, 'Choose or type a category').max(60, 'Use 60 characters or fewer'),
  priced_by: z.enum(['unit', 'area']).catch('unit'),
  unit: optionalText(20),
  thickness_mm: optionalAmount(200),
  current_price: optionalAmount(),
  reorder_level: optionalAmount(9_999_999),
  notes: optionalText(2000),
});

const blank = () => ({ name: '', category: '', priced_by: 'unit', unit: 'Pc', thickness_mm: '', current_price: '', reorder_level: '', notes: '' });

/**
 * A plate needs its thickness, and is always counted in sq ft; anything else needs a unit.
 * Read from what was typed, so these show together with any other mistakes on the form.
 */
function validate(body) {
  const { data, errors } = check(itemSchema, body);
  const all = { ...errors };
  const area = body.priced_by === 'area';
  const typed = (key) => String(body[key] ?? '').trim();
  if (area && (!typed('thickness_mm') || /^[0.,\s]+$/.test(typed('thickness_mm')))) all.thickness_mm ??= 'Enter the thickness, e.g. 4';
  if (!area && !typed('unit')) all.unit ??= 'Say what it is counted in, e.g. Pc';
  if (data) Object.assign(data, area ? { unit: 'sq ft' } : { thickness_mm: null });
  return { data, errors: all };
}

async function renderForm(res, { status = 200, item = null, values, errors = {}, existingId = null }) {
  res.status(status).render('items/views/form', {
    title: item ? `Edit ${item.name}` : 'New item',
    item, values, errors, existingId,
    categories: await items.listCategories(),
  });
}

async function loadItem(req) {
  const id = Number(req.params.id);
  const item = Number.isInteger(id) ? await items.getItem(id) : null;
  if (!item) throw httpError(404, 'That item doesn’t exist.');
  return item;
}

router.get('/items', view, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const status = items.STATUSES.includes(req.query.status) ? req.query.status : 'active';
  const categories = await items.listCategories();
  const categoryId = categories.some((c) => c.id === Number(req.query.category)) ? Number(req.query.category) : null;
  res.render('items/views/index', {
    title: 'Items', q, status, categoryId, categories,
    list: await items.listItems({ status, categoryId, q }),
    canManage: req.user.can('inventory.manage'),
  });
});

router.get('/items/new', manage, (req, res) => renderForm(res, { values: blank() }));

router.post('/items', manage, async (req, res) => {
  const values = { ...blank(), ...req.body };
  const { data, errors } = validate(req.body);
  if (Object.keys(errors).length) return renderForm(res, { status: 422, values, errors });
  try {
    const { id, code } = await items.createItem(data, req);
    req.session.flash = { type: 'success', text: `${data.name} added as ${code}.` };
    res.redirect(`/items/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, values, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
});

router.get('/items/:id', view, async (req, res) => {
  const item = await loadItem(req);
  res.render('items/views/show', {
    title: item.name, item,
    entries: await history('item', item.id),
    canManage: req.user.can('inventory.manage'),
  });
});

const number = (v) => (v === null || v === undefined ? '' : String(Number(v)));

router.get('/items/:id/edit', manage, async (req, res) => {
  const item = await loadItem(req);
  const values = {
    name: item.name, category: item.category, priced_by: item.priced_by, unit: item.unit, notes: item.notes ?? '',
    thickness_mm: number(item.thickness_mm), current_price: number(item.current_price), reorder_level: number(item.reorder_level),
  };
  await renderForm(res, { item, values });
});

router.post('/items/:id', manage, async (req, res) => {
  const item = await loadItem(req);
  const values = { ...blank(), ...req.body };
  const { data, errors } = validate(req.body);
  if (Object.keys(errors).length) return renderForm(res, { status: 422, item, values, errors });
  try {
    await items.updateItem(item.id, data, req);
    req.session.flash = { type: 'success', text: `Saved changes to ${data.name}.` };
    res.redirect(`/items/${item.id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, item, values, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
});

// Added in place from a purchase order. Returns what the order form needs to pick it.
router.post('/api/items', canAny('inventory.manage', 'purchasing.manage'), async (req, res) => {
  const { data, errors } = validate(req.body ?? {});
  if (Object.keys(errors).length) return res.status(422).json({ errors });
  try {
    const { id } = await items.createItem(data, req);
    res.status(201).json({ id, name: data.name, priced_by: data.priced_by, unit: data.unit, current_price: data.current_price });
  } catch (err) {
    if (!err.field) throw err;
    res.status(422).json({ errors: { [err.field]: err.message } });
  }
});

async function setActive(req, res, active) {
  const item = await loadItem(req);
  await items.setActive(item.id, active, req);
  req.session.flash = { type: 'success', text: `${item.name} switched ${active ? 'back on' : 'off'}.` };
  res.redirect(`/items/${item.id}`);
}
router.post('/items/:id/switch-off', manage, (req, res) => setActive(req, res, false));
router.post('/items/:id/switch-on', manage, (req, res) => setActive(req, res, true));

// What a sheet of this plate comes to: ?length=12&width=4&unit=ft&pieces=9
router.get('/api/items/:id/sheet', view, async (req, res) => {
  const item = await loadItem(req);
  if (item.priced_by !== 'area') return res.status(422).json({ error: 'This item isn’t priced by area.' });
  const read = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
  const [length, width, pieces] = [read(req.query.length), read(req.query.width), req.query.pieces ? read(req.query.pieces) : 1];
  const unit = SHEET_UNITS.includes(req.query.unit) ? req.query.unit : null;
  const fine = (n) => Number.isFinite(n) && n > 0 && n <= 100_000;
  if (!unit || !fine(length) || !fine(width) || !fine(pieces)) return res.status(422).json({ error: 'Enter the length and width.' });
  const { sqFt, kg } = sheetSize({ length, width, unit, thicknessMm: Number(item.thickness_mm) });
  const price = item.current_price === null ? null : Number(item.current_price);
  res.json({
    sq_ft: sqFt, kg, total_sq_ft: sqFt * pieces, total_kg: kg === null ? null : kg * pieces,
    price, cost: price === null ? null : Math.round(sqFt * pieces * price * 100) / 100,
  });
});
