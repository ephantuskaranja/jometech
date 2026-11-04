import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';

// Items: what the workshop buys and uses, and what each one costs (excluding VAT).

export const STATUSES = ['active', 'inactive', 'all'];

const err = (status, message, field, extra = {}) => Object.assign(httpError(status, message), { field, ...extra });
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** "Plate 4mm" and "plate 4 mm" are the same item: names are compared without spaces (and without case). */
const sameName = (q, name) => q.whereRaw("REPLACE(`name`, ' ', '') = ?", [name.replace(/\s+/g, '')]);

async function checkName(trx, name, exceptId = null) {
  const q = sameName(trx('items'), name);
  if (exceptId) q.whereNot({ id: exceptId });
  const match = await q.first('id', 'name', 'is_active');
  if (match) {
    throw err(409, match.is_active ? `“${match.name}” is already an item.` : `“${match.name}” is already an item, but it is switched off.`, 'name', { existingId: match.id });
  }
}

/** The category's id; a name not on the list is added to it. */
async function categoryId(trx, name) {
  await trx('item_categories').insert({ name }).onConflict('name').ignore();
  return (await trx('item_categories').where({ name }).first('id')).id;
}

/** What the history shows: names and plain numbers, not ids. */
function snapshot(item, category) {
  return {
    name: item.name, category, priced_by: item.priced_by, unit: item.unit,
    thickness_mm: num(item.thickness_mm), current_price: num(item.current_price), reorder_level: num(item.reorder_level), notes: item.notes ?? null,
  };
}

const fields = (input) => ({
  name: input.name, priced_by: input.priced_by, unit: input.unit, thickness_mm: input.thickness_mm,
  current_price: input.current_price, reorder_level: input.reorder_level, notes: input.notes,
});

/** @returns {Promise<{ id: number, code: string }>} */
export async function createItem(input, actor) {
  return db.transaction(async (trx) => {
    await checkName(trx, input.name);
    const category_id = await categoryId(trx, input.category);
    const code = await nextNumber(trx, 'item');
    const [id] = await trx('items').insert({ ...fields(input), code, category_id, created_by: actor.user.id });
    await audit(trx, actor, { entity: 'item', id, action: 'create', summary: `${code}: ${input.name}` });
    return { id, code };
  });
}

export async function updateItem(id, input, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('items').where({ id }).forUpdate().first();
    if (!before) throw httpError(404, 'That item doesn’t exist.');
    await checkName(trx, input.name, id);
    const beforeCategory = await trx('item_categories').where({ id: before.category_id }).first('name');
    const category_id = await categoryId(trx, input.category);
    await trx('items').where({ id }).update({ ...fields(input), category_id });
    const { name: category } = await trx('item_categories').where({ id: category_id }).first('name');
    await audit(trx, actor, {
      entity: 'item', id, action: 'update',
      before: snapshot(before, beforeCategory.name), after: snapshot(input, category),
    });
  });
}

/** Switched off, never deleted: orders and jobs will refer to it. */
export async function setActive(id, active, actor) {
  await db.transaction(async (trx) => {
    const item = await trx('items').where({ id }).forUpdate().first('id', 'name', 'is_active');
    if (!item) throw httpError(404, 'That item doesn’t exist.');
    if (Boolean(item.is_active) === active) return;
    await trx('items').where({ id }).update({ is_active: active });
    await audit(trx, actor, { entity: 'item', id, action: active ? 'record_on' : 'record_off', summary: item.name });
  });
}

export function getItem(id) {
  return db('items as i').join('item_categories as c', 'c.id', 'i.category_id').leftJoin('users as u', 'u.id', 'i.created_by')
    .where('i.id', id).first('i.*', 'c.name as category', 'u.name as created_name');
}

export function listCategories() {
  return db('item_categories').orderBy('sort_order').orderBy('name').select('id', 'name');
}

function filter(q, { status, categoryId: category }) {
  if (status !== 'all') q.where('i.is_active', status === 'active');
  if (category) q.where('i.category_id', category);
  return q;
}

export function listItems({ status = 'active', categoryId: category = null, q = '' } = {}) {
  const query = filter(db('items as i').join('item_categories as c', 'c.id', 'i.category_id'), { status, categoryId: category })
    .orderBy('c.sort_order').orderBy('i.name').limit(500)
    .select('i.id', 'i.code', 'i.name', 'i.priced_by', 'i.unit', 'i.thickness_mm', 'i.current_price', 'i.is_active', 'c.name as category');
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('i.code', 'like', `%${term}%`)
      .orWhereRaw("REPLACE(`i`.`name`, ' ', '') LIKE ?", [`%${term.replace(/\s+/g, '')}%`]));
  }
  return query;
}
