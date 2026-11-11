import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { sizeKey } from './service.js';
import { createAdjustment } from './adjustments.js';

// Stock counts (step 25b). Blind: the sheet never shows the system's figures, so the counter writes what is
// on the racks, not what they expect. On posting, each counted line is compared with stock at that moment
// (count when nothing is moving), and the differences become one adjustment (reason "count") for a manager.

export const STATUSES = {
  open: { label: 'Counting', tone: 'info' },
  posted: { label: 'Posted', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Starts a count: every active item (in the category, if one is chosen), one line per plate size on the racks here.
 * Items switched off but still in stock here are listed too, so nothing on the racks is missed.
 */
export async function startCount({ siteId, categoryId = null, note = null }, actor) {
  return db.transaction(async (trx) => {
    const open = await trx('stock_counts').where({ site_id: siteId, status: 'open' }).first('number');
    if (open) throw httpError(409, `${open.number} is still being counted here. Post or cancel it first.`);
    const balances = await trx('stock_balances').where({ site_id: siteId }).where('quantity', '>', 0).select('item_id', 'size_key', 'length', 'width', 'size_unit', 'area_sq_ft');
    const stocked = new Set(balances.map((b) => b.item_id));
    const items = await trx('items')
      .where((w) => w.where('is_active', true).orWhereIn('id', [...stocked]))
      .modify((q) => { if (categoryId) q.where('category_id', categoryId); })
      .select('id', 'priced_by');
    const lines = [];
    for (const item of items) {
      if (item.priced_by === 'area') {
        for (const b of balances.filter((x) => x.item_id === item.id && x.size_key)) {
          lines.push({ item_id: item.id, size_key: b.size_key, length: b.length, width: b.width, size_unit: b.size_unit, area_sq_ft: b.area_sq_ft });
        }
      } else {
        lines.push({ item_id: item.id, size_key: '' });
      }
    }
    if (!lines.length) throw httpError(422, 'Nothing to count: no items in that category.');
    const number = await nextNumber(trx, 'count');
    const [id] = await trx('stock_counts').insert({ number, site_id: siteId, category_id: categoryId, note, created_by: actor.user.id });
    await trx('stock_count_lines').insert(lines.map((l) => ({ ...l, count_id: id })));
    await audit(trx, actor, { entity: 'stock_count', id, action: 'create', summary: `${lines.length} lines` });
    return { id, number };
  });
}

async function openCount(trx, id) {
  const count = await trx('stock_counts').where({ id }).forUpdate().first();
  if (!count) throw httpError(404, 'That count doesn’t exist.');
  if (count.status !== 'open') throw httpError(409, `${count.number} is already ${STATUSES[count.status].label.toLowerCase()}.`);
  return count;
}

/** Saves what has been counted so far. `counted`: { lineId: number|null } (null = not counted). */
export async function saveCounted(id, counted) {
  await db.transaction(async (trx) => {
    await openCount(trx, id);
    for (const [lineId, value] of Object.entries(counted)) {
      await trx('stock_count_lines').where({ id: Number(lineId), count_id: id }).update({ counted: value });
    }
  });
}

/** Something found that isn't on the sheet (another item, or a plate size the system doesn't have here). */
export async function addLine(id, line) {
  await db.transaction(async (trx) => {
    await openCount(trx, id);
    const key = sizeKey(line);
    const existing = await trx('stock_count_lines').where({ count_id: id, item_id: line.item_id, size_key: key }).first('id');
    if (existing) throw Object.assign(httpError(409, 'That item (and size) is already on the sheet.'), { lineId: existing.id });
    await trx('stock_count_lines').insert({
      count_id: id, item_id: line.item_id, size_key: key, length: line.length, width: line.width, size_unit: line.size_unit, area_sq_ft: line.area_sq_ft,
      counted: line.counted, added: true,
    });
  });
}

/** Removes a line the counter added by mistake. Lines from the sheet stay (leave them blank instead). */
export async function removeAddedLine(id, lineId) {
  await db.transaction(async (trx) => {
    await openCount(trx, id);
    await trx('stock_count_lines').where({ id: lineId, count_id: id, added: true }).delete();
  });
}

/** Counted lines against stock now: system, difference and its value at today's average. */
async function differences(trx, count) {
  const lines = await trx('stock_count_lines as l').join('items as i', 'i.id', 'l.item_id')
    .where('l.count_id', count.id)
    .select('l.*', 'i.name as item_name', 'i.unit', 'i.priced_by', 'i.avg_cost', 'i.current_price');
  const balances = await trx('stock_balances').where({ site_id: count.site_id }).select('item_id', 'size_key', 'quantity');
  return lines.map((l) => {
    const system = Number(balances.find((b) => b.item_id === l.item_id && b.size_key === l.size_key)?.quantity ?? 0);
    const counted = l.counted === null ? null : Number(l.counted);
    const diff = counted === null ? 0 : round3(counted - system);
    const perPiece = l.area_sq_ft === null ? 1 : Number(l.area_sq_ft);
    const cost = l.avg_cost ?? l.current_price;
    return { ...l, system, counted, diff, value: cost === null ? null : diff * perPiece * Number(cost) };
  });
}

/** The review page, before posting. */
export async function review(id) {
  const count = await db('stock_counts').where({ id }).first();
  return count ? differences(db, count) : [];
}

/**
 * Posts it: what the system has now is kept on each line, and the differences become one adjustment
 * waiting for approval. Nothing different: the count just closes.
 */
export async function postCount(id, actor) {
  return db.transaction(async (trx) => {
    const count = await openCount(trx, id);
    const lines = await differences(trx, count);
    const counted = lines.filter((l) => l.counted !== null);
    if (!counted.length) throw httpError(422, 'Nothing has been counted yet.');
    for (const l of counted) await trx('stock_count_lines').where({ id: l.id }).update({ system_qty: l.system });
    const changed = counted.filter((l) => l.diff !== 0);
    let adjustment = null;
    if (changed.length) {
      adjustment = await createAdjustment({
        siteId: count.site_id, reason: 'count', note: `From stock count ${count.number}`, countId: count.id,
        lines: changed.map((l) => ({
          item_id: l.item_id, quantity: l.diff, length: l.length === null ? null : Number(l.length), width: l.width === null ? null : Number(l.width),
          size_unit: l.size_unit, area_sq_ft: l.area_sq_ft === null ? null : Number(l.area_sq_ft),
          // An item found with no average yet is valued at its last price, if it has one.
          entered_cost: l.diff > 0 && l.avg_cost === null && l.current_price !== null ? Number(l.current_price) : null,
        })),
      }, actor, trx);
    }
    await trx('stock_counts').where({ id }).update({ status: 'posted', adjustment_id: adjustment?.id ?? null, posted_by: actor.user.id, posted_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'stock_count', id, action: 'posted', summary: adjustment ? `${changed.length} differences: ${adjustment.number}` : 'Everything counted matched' });
    return { adjustment, counted: counted.length, changed: changed.length };
  });
}

export async function cancelCount(id, note, actor) {
  await db.transaction(async (trx) => {
    await openCount(trx, id);
    await trx('stock_counts').where({ id }).update({ status: 'cancelled', note });
    await audit(trx, actor, { entity: 'stock_count', id, action: 'cancelled', summary: note });
  });
}

// ---------- reading ----------

export async function getCount(id) {
  const count = await db('stock_counts as c').join('sites as s', 's.id', 'c.site_id')
    .leftJoin('item_categories as cat', 'cat.id', 'c.category_id').leftJoin('users as u', 'u.id', 'c.created_by').leftJoin('users as p', 'p.id', 'c.posted_by')
    .leftJoin('stock_adjustments as a', 'a.id', 'c.adjustment_id')
    .where('c.id', id)
    .first('c.*', 's.name as site_name', 'cat.name as category_name', 'u.name as created_name', 'p.name as posted_name', 'a.number as adjustment_number', 'a.status as adjustment_status');
  if (!count) return null;
  // The sheet: by category, then name, then biggest sheet first. No system figures here (blind count).
  count.lines = await db('stock_count_lines as l').join('items as i', 'i.id', 'l.item_id').join('item_categories as cat', 'cat.id', 'i.category_id')
    .where('l.count_id', id).orderBy('cat.sort_order').orderBy('cat.name').orderBy('i.name').orderBy('l.area_sq_ft', 'desc').orderBy('l.id')
    .select('l.id', 'l.item_id', 'l.size_key', 'l.length', 'l.width', 'l.size_unit', 'l.counted', 'l.system_qty', 'l.added', 'i.name as item_name', 'i.unit', 'i.priced_by', 'cat.name as category');
  return count;
}

export function listCounts(siteIds) {
  return db('stock_counts as c').join('sites as s', 's.id', 'c.site_id').leftJoin('item_categories as cat', 'cat.id', 'c.category_id')
    .leftJoin('users as u', 'u.id', 'c.created_by').leftJoin('stock_adjustments as a', 'a.id', 'c.adjustment_id')
    .whereIn('c.site_id', siteIds).orderBy('c.id', 'desc').limit(100)
    .select('c.id', 'c.number', 'c.status', 'c.created_at', 'c.posted_at', 's.name as site_name', 'cat.name as category_name', 'u.name as created_name',
      'a.id as adjustment_id', 'a.number as adjustment_number', 'a.status as adjustment_status',
      db('stock_count_lines as l').whereRaw('l.count_id = c.id').count('*').as('line_count'),
      db('stock_count_lines as l').whereRaw('l.count_id = c.id').whereNotNull('l.counted').count('*').as('counted_count'));
}
