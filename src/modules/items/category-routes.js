import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { check, httpError } from '../../core/validate.js';
import * as categories from './categories.js';

// Items → Categories: add, rename, reorder, merge duplicates, delete empty ones.
// Mounted before the item pages, so /items/categories isn't read as an item id.
export const router = Router();
router.use('/items/categories', canAny('inventory.manage'));

const nameSchema = z.object({
  name: z.string().trim().min(2, 'Give the category a name').max(60, 'Use 60 characters or fewer').transform((v) => v.replace(/\s+/g, ' ')),
});

async function renderList(res, { status = 200, values = { name: '' }, errors = {}, existingId = null } = {}) {
  res.status(status).render('items/views/categories', {
    title: 'Item categories', list: await categories.listCategories(), values, errors, existingId,
  });
}

async function renderCategory(res, { status = 200, category, values, errors = {}, existingId = null }) {
  res.status(status).render('items/views/category', {
    title: category.name, category, values, errors, existingId,
    others: (await categories.listCategories()).filter((c) => c.id !== category.id),
    entries: await history('item_category', category.id),
  });
}

async function loadCategory(req) {
  const id = Number(req.params.id);
  const category = Number.isInteger(id) ? await categories.getCategory(id) : null;
  if (!category) throw httpError(404, 'That category doesn’t exist.');
  return category;
}

router.get('/items/categories', (req, res) => renderList(res));

router.post('/items/categories', async (req, res) => {
  const values = { name: req.body.name ?? '' };
  const { data, errors } = check(nameSchema, req.body);
  if (errors) return renderList(res, { status: 422, values, errors });
  try {
    await categories.createCategory(data, req);
    req.session.flash = { type: 'success', text: `“${data.name}” added. It can be chosen on items now.` };
    res.redirect('/items/categories');
  } catch (err) {
    if (!err.field) throw err;
    await renderList(res, { status: 422, values, errors: { name: err.message }, existingId: err.existingId });
  }
});

router.post('/items/categories/:id/move', async (req, res) => {
  const { id } = await loadCategory(req);
  await categories.moveCategory(id, req.body.direction === 'up' ? 'up' : 'down');
  res.redirect(`/items/categories#cat-${id}`);
});

router.get('/items/categories/:id', async (req, res) => {
  const category = await loadCategory(req);
  await renderCategory(res, { category, values: { name: category.name } });
});

router.post('/items/categories/:id', async (req, res) => {
  const category = await loadCategory(req);
  const values = { name: req.body.name ?? '' };
  const { data, errors } = check(nameSchema, req.body);
  if (errors) return renderCategory(res, { status: 422, category, values, errors });
  try {
    await categories.renameCategory(category.id, data, req);
    req.session.flash = { type: 'success', text: `Renamed to “${data.name}”. Its items follow.` };
    res.redirect('/items/categories');
  } catch (err) {
    if (!err.field) throw err;
    await renderCategory(res, { status: 422, category, values, errors: { name: err.message }, existingId: err.existingId });
  }
});

router.post('/items/categories/:id/merge', async (req, res) => {
  const category = await loadCategory(req);
  try {
    const { into, count } = await categories.mergeCategory(category.id, Number(req.body.into), req);
    req.session.flash = { type: 'success', text: `Moved ${count} into “${into.name}” and removed “${category.name}”.` };
    res.redirect('/items/categories');
  } catch (err) {
    if (!err.field) throw err;
    await renderCategory(res, { status: 422, category, values: { name: category.name }, errors: { into: err.message } });
  }
});

router.post('/items/categories/:id/delete', async (req, res) => {
  const category = await loadCategory(req);
  await categories.deleteCategory(category.id, req);
  req.session.flash = { type: 'success', text: `“${category.name}” deleted.` };
  res.redirect('/items/categories');
});
