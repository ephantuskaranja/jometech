import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';

// Item categories: the list the item form picks from. Kept here so it stays tidy (no "Paint" and "Paints").

const err = (status, message, field, extra = {}) => Object.assign(httpError(status, message), { field, ...extra });

/** "Paint", "paint" and "Pa int" count as the same name. */
async function checkName(trx, name, exceptId = null) {
  const q = trx('item_categories').whereRaw("LOWER(REPLACE(`name`, ' ', '')) = ?", [name.replace(/\s+/g, '').toLowerCase()]);
  if (exceptId) q.whereNot({ id: exceptId });
  const match = await q.first('id', 'name');
  if (match) throw err(409, `“${match.name}” is already a category.`, 'name', { existingId: match.id });
}

/** In order, with how many items each has (active and switched off). */
export function listCategories() {
  return db('item_categories as c').leftJoin('items as i', 'i.category_id', 'c.id')
    .groupBy('c.id', 'c.name', 'c.sort_order').orderBy('c.sort_order').orderBy('c.name')
    .select('c.id', 'c.name', db.raw('COUNT(i.id) as item_count'), db.raw('COALESCE(SUM(i.is_active), 0) as active_count'))
    .then((rows) => rows.map((r) => ({ ...r, item_count: Number(r.item_count), active_count: Number(r.active_count) })));
}

export async function getCategory(id) {
  const category = await db('item_categories').where({ id }).first('id', 'name');
  if (!category) return null;
  const { n } = await db('items').where({ category_id: id }).first(db.raw('COUNT(*) as n'));
  return { ...category, item_count: Number(n) };
}

/** New ones go at the end of the list. */
export async function createCategory({ name }, actor) {
  return db.transaction(async (trx) => {
    await checkName(trx, name);
    const { last } = await trx('item_categories').first(trx.raw('COALESCE(MAX(sort_order), 0) as last'));
    const [id] = await trx('item_categories').insert({ name, sort_order: Math.min(Number(last) + 10, 65_000) });
    await audit(trx, actor, { entity: 'item_category', id, action: 'create', summary: name });
    return id;
  });
}

/** Every item in it follows, since items point at the category, not its name. */
export async function renameCategory(id, { name }, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('item_categories').where({ id }).forUpdate().first('name');
    if (!before) throw httpError(404, 'That category doesn’t exist.');
    await checkName(trx, name, id);
    await trx('item_categories').where({ id }).update({ name });
    await audit(trx, actor, { entity: 'item_category', id, action: 'update', before: { name: before.name }, after: { name } });
  });
}

/** One place up or down. The whole list is renumbered 10, 20, 30… so ties never get stuck. */
export async function moveCategory(id, direction) {
  await db.transaction(async (trx) => {
    const ids = await trx('item_categories').forUpdate().orderBy('sort_order').orderBy('name').pluck('id');
    const at = ids.indexOf(id);
    if (at === -1) throw httpError(404, 'That category doesn’t exist.');
    const to = at + (direction === 'up' ? -1 : 1);
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    for (const [i, cid] of ids.entries()) await trx('item_categories').where({ id: cid }).update({ sort_order: (i + 1) * 10 });
  });
}

/** Moves every item into another category, then removes this one. Each item's history shows the move. */
export async function mergeCategory(id, intoId, actor) {
  return db.transaction(async (trx) => {
    const [from, into] = await Promise.all([
      trx('item_categories').where({ id }).forUpdate().first('id', 'name'),
      trx('item_categories').where({ id: intoId }).forUpdate().first('id', 'name'),
    ]);
    if (!from) throw httpError(404, 'That category doesn’t exist.');
    if (!into || into.id === from.id) throw err(422, 'Choose the category to move the items into', 'into');
    const moved = await trx('items').where({ category_id: from.id }).forUpdate().select('id');
    await trx('items').where({ category_id: from.id }).update({ category_id: into.id });
    for (const { id: itemId } of moved) {
      await audit(trx, actor, { entity: 'item', id: itemId, action: 'update', before: { category: from.name }, after: { category: into.name } });
    }
    await trx('item_categories').where({ id: from.id }).delete();
    const count = `${moved.length} item${moved.length === 1 ? '' : 's'}`;
    await audit(trx, actor, { entity: 'item_category', id: into.id, action: 'merged', summary: `${count} from “${from.name}”` });
    await audit(trx, actor, { entity: 'item_category', id: from.id, action: 'delete', summary: `${from.name}: merged into “${into.name}”` });
    return { from, into, count };
  });
}

/** Only an empty category can go; one with items is merged instead. */
export async function deleteCategory(id, actor) {
  await db.transaction(async (trx) => {
    const category = await trx('item_categories').where({ id }).forUpdate().first('id', 'name');
    if (!category) throw httpError(404, 'That category doesn’t exist.');
    if (await trx('items').where({ category_id: id }).first('id')) {
      throw httpError(409, `“${category.name}” still has items. Move them into another category first (Merge).`);
    }
    await trx('item_categories').where({ id }).delete();
    await audit(trx, actor, { entity: 'item_category', id, action: 'delete', summary: category.name });
  });
}
