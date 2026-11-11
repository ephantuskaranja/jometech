import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { changeBalance, sizeKey } from './service.js';

// Stock adjustments (step 25a): stock taken off or added outside deliveries and issues.
// Recorded by stores (inventory.manage); applied only when a manager or admin approves it (inventory.approve).
// Taken off: at the item's average cost that day, so the average doesn't move.
// Added: at the average too; an item with no average yet uses the cost typed on the line.

export const REASONS = {
  damaged: { label: 'Damaged', hint: 'Broken, rusted, spoiled' },
  lost: { label: 'Lost or stolen', hint: 'Not found, missing' },
  found: { label: 'Found', hint: 'On the racks but not in the system' },
  used: { label: 'Used without an issue', hint: 'Taken for work but never issued to a job' },
  count: { label: 'Stock count', hint: 'The count found a different number' },
  other: { label: 'Other', hint: 'Say what happened in the note' },
};
export const STATUSES = {
  pending: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10_000) / 10_000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Records an adjustment, waiting for approval. Nothing in stock changes yet.
 * @param {{ siteId: number, reason: string, note: string|null, countId?: number|null,
 *   lines: { item_id: number, quantity: number, length: number|null, width: number|null, size_unit: string|null, area_sq_ft: number|null, entered_cost: number|null }[] }} input
 *   quantity: pieces for a plate, minus = taken off
 */
export async function createAdjustment(input, actor, outer = null) {
  const run = (fn) => (outer ? fn(outer) : db.transaction(fn));
  return run(async (trx) => {
    const number = await nextNumber(trx, 'adjustment');
    const [id] = await trx('stock_adjustments').insert({
      number, site_id: input.siteId, reason: input.reason, note: input.note, count_id: input.countId ?? null, created_by: actor.user.id,
    });
    await trx('stock_adjustment_lines').insert(input.lines.map((l) => ({
      adjustment_id: id, item_id: l.item_id, size_key: sizeKey(l), length: l.length, width: l.width, size_unit: l.size_unit, area_sq_ft: l.area_sq_ft,
      quantity: l.quantity, stock_qty: round3(l.area_sq_ft === null ? l.quantity : l.quantity * l.area_sq_ft), entered_cost: l.entered_cost,
    })));
    await audit(trx, actor, { entity: 'stock_adjustment', id, action: 'create', summary: `${REASONS[input.reason].label}, ${plural(input.lines.length, 'line')}` });
    return { id, number };
  });
}

/**
 * Applies it to stock. Quantities are checked again now: something may have been issued since it was recorded.
 * Lines are applied item by item in id order, so two approvals never lock items the other way round.
 */
export async function approveAdjustment(id, actor) {
  return db.transaction(async (trx) => {
    const adj = await trx('stock_adjustments').where({ id }).forUpdate().first();
    if (!adj) throw httpError(404, 'That adjustment doesn’t exist.');
    if (adj.status !== 'pending') throw httpError(409, `${adj.number} is already ${STATUSES[adj.status].label.toLowerCase()}.`);
    const lines = await trx('stock_adjustment_lines').where({ adjustment_id: id }).orderBy('item_id').orderBy('id');
    let total = 0;
    for (const line of lines) {
      const item = await trx('items').where({ id: line.item_id }).forUpdate().first();
      const pieces = Number(line.quantity);
      const stockQty = Number(line.stock_qty);
      const what = `${item.name}${line.size_key ? ` ${line.size_key}` : ''}`;
      if (pieces < 0) {
        const balance = await trx('stock_balances').where({ site_id: adj.site_id, item_id: item.id, size_key: line.size_key }).forUpdate().first();
        const here = Number(balance?.quantity ?? 0);
        if (here < -pieces) throw httpError(409, `${what}: only ${here} left at this site, so ${-pieces} can’t be taken off. Reject it, or ask for a new one.`);
      }
      const average = item.avg_cost === null ? null : Number(item.avg_cost);
      const unitCost = average ?? (line.entered_cost === null ? null : Number(line.entered_cost));
      if (unitCost === null) throw httpError(409, `${what} has no cost yet. Reject it and record it with a cost per unit.`);
      const qty = round3(Number(item.on_hand_qty) + stockQty);
      // Taking off everything leaves no value; otherwise the value moves by quantity × cost.
      const value = qty <= 0 ? -Number(item.stock_value) : round4(stockQty * unitCost);
      const stockValue = qty <= 0 ? 0 : round4(Number(item.stock_value) + value);
      await trx('items').where({ id: item.id }).update({
        on_hand_qty: Math.max(0, qty), stock_value: stockValue, avg_cost: qty > 0 ? round4(stockValue / qty) : item.avg_cost ?? unitCost,
      });
      await changeBalance(trx, { siteId: adj.site_id, itemId: item.id, line, by: pieces });
      await trx('stock_movements').insert({
        type: 'adjust', site_id: adj.site_id, item_id: item.id, size_key: line.size_key, quantity: pieces, stock_qty: stockQty, value,
        adjustment_id: adj.id, created_by: actor.user.id,
      });
      await trx('stock_adjustment_lines').where({ id: line.id }).update({ unit_cost: unitCost, value });
      await audit(trx, actor, { entity: 'item', id: item.id, action: 'stock_adjusted', summary: `${stockQty > 0 ? '+' : ''}${stockQty} ${item.unit} (${adj.number}, ${REASONS[adj.reason].label.toLowerCase()})` });
      total += value;
    }
    await trx('stock_adjustments').where({ id }).update({ status: 'approved', value: round4(total), decided_by: actor.user.id, decided_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'stock_adjustment', id, action: 'approved', summary: `Stock value ${total >= 0 ? '+' : '−'}KES ${Math.abs(total).toFixed(2)}` });
    return { number: adj.number, value: total };
  });
}

/** Rejected by the approver, or cancelled by stores, with a reason. Stock never changed. */
export async function closeAdjustment(id, status, note, actor) {
  await db.transaction(async (trx) => {
    const adj = await trx('stock_adjustments').where({ id }).forUpdate().first();
    if (!adj) throw httpError(404, 'That adjustment doesn’t exist.');
    if (adj.status !== 'pending') throw httpError(409, `${adj.number} is already ${STATUSES[adj.status].label.toLowerCase()}.`);
    await trx('stock_adjustments').where({ id }).update({ status, decision_note: note, decided_by: actor.user.id, decided_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'stock_adjustment', id, action: status, summary: note });
  });
}

// ---------- reading ----------

export async function getAdjustment(id) {
  const adj = await db('stock_adjustments as a').join('sites as s', 's.id', 'a.site_id')
    .leftJoin('users as c', 'c.id', 'a.created_by').leftJoin('users as d', 'd.id', 'a.decided_by')
    .where('a.id', id).first('a.*', 's.name as site_name', 'c.name as created_name', 'd.name as decided_name');
  if (!adj) return null;
  adj.lines = await db('stock_adjustment_lines as l').join('items as i', 'i.id', 'l.item_id')
    .where('l.adjustment_id', id).orderBy('l.id')
    .select('l.*', 'i.name as item_name', 'i.unit', 'i.priced_by', 'i.avg_cost as current_avg');
  return adj;
}

/** @param {{ siteIds: number[], show: 'pending'|'done'|'all' }} options */
export async function listAdjustments({ siteIds, show = 'pending' }) {
  const q = db('stock_adjustments as a').join('sites as s', 's.id', 'a.site_id').leftJoin('users as u', 'u.id', 'a.created_by')
    .whereIn('a.site_id', siteIds).orderBy('a.id', 'desc').limit(200)
    .select('a.id', 'a.number', 'a.reason', 'a.note', 'a.status', 'a.value', 'a.created_at', 's.name as site_name', 'u.name as created_name',
      db('stock_adjustment_lines as l').whereRaw('l.adjustment_id = a.id').count('*').as('line_count'));
  if (show === 'pending') q.where('a.status', 'pending');
  if (show === 'done') q.whereNot('a.status', 'pending');
  return q;
}

export async function pendingCount(siteIds) {
  if (!siteIds.length) return 0;
  const [{ n }] = await db('stock_adjustments').whereIn('site_id', siteIds).where({ status: 'pending' }).count({ n: '*' });
  return Number(n);
}

/** What is on the racks at a site, for the form: pieces per item and sheet size. */
export function balancesAt(siteId) {
  return db('stock_balances').where({ site_id: siteId }).where('quantity', '>', 0)
    .orderBy('item_id').orderBy('area_sq_ft', 'desc')
    .select('item_id', 'size_key', 'length', 'width', 'size_unit', 'quantity');
}
