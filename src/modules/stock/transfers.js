import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { changeBalance } from './service.js';
import { createAdjustment } from './adjustments.js';

// Stock transfers between sites (step 25c): sent → in transit → received.
// Only the site balances move; the item's total and value stay the same (one average across all sites),
// so the out and in movements carry equal and opposite values for the record.
// Fewer received than sent: everything sent lands at the receiving site, and the shortfall becomes a
// "lost" adjustment there that a manager approves (or rejects, if it turns up).

export const STATUSES = {
  in_transit: { label: 'In transit', tone: 'warn' },
  received: { label: 'Received', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const num = (v) => Number(v ?? 0);
const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10_000) / 10_000;
const sizeLabel = (l) => (l.size_unit ? `${num(l.length)} × ${num(l.width)} ${l.size_unit}` : '');

/** The movement for one line leaving or arriving at a site, valued at today's average. */
async function move(trx, { type, siteId, line, pieces, transferId, actor }) {
  const item = await trx('items').where({ id: line.item_id }).first('avg_cost');
  const stockQty = round3(line.area_sq_ft === null ? pieces : pieces * num(line.area_sq_ft));
  await changeBalance(trx, { siteId, itemId: line.item_id, line, by: pieces });
  await trx('stock_movements').insert({
    type, site_id: siteId, item_id: line.item_id, size_key: line.size_key, quantity: pieces, stock_qty: stockQty,
    value: round4(stockQty * num(item.avg_cost)), transfer_id: transferId, created_by: actor.user.id,
  });
}

/**
 * Sends stock to another site. `lines`: { balance_id, quantity } from what is in stock here.
 * @returns {Promise<{ id: number, number: string }>}
 */
export async function sendTransfer({ fromSiteId, toSiteId, carriedBy, note, lines }, actor) {
  return db.transaction(async (trx) => {
    const to = await trx('sites').where({ id: toSiteId, is_active: true }).first('id', 'name');
    if (!to || to.id === fromSiteId) throw Object.assign(httpError(422, 'Choose the site it is going to'), { field: 'to_site_id' });
    const number = await nextNumber(trx, 'transfer');
    const [id] = await trx('stock_transfers').insert({ number, from_site_id: fromSiteId, to_site_id: toSiteId, carried_by: carriedBy, note, sent_by: actor.user.id });
    for (const row of [...lines].sort((a, b) => a.balance_id - b.balance_id)) {
      const balance = await trx('stock_balances as b').join('items as i', 'i.id', 'b.item_id')
        .where('b.id', row.balance_id).forUpdate().first('b.*', 'i.name');
      if (!balance || balance.site_id !== fromSiteId) throw Object.assign(httpError(422, 'One of those items isn’t in stock at this site.'), { field: 'lines' });
      if (row.quantity > num(balance.quantity) + 1e-9) {
        throw Object.assign(httpError(422, `${balance.name}${balance.size_key ? `, ${sizeLabel(balance)}` : ''}: only ${num(balance.quantity)} here.`), { field: 'lines' });
      }
      if (balance.size_key && !Number.isInteger(row.quantity)) throw Object.assign(httpError(422, `${balance.name}: plates go as whole pieces.`), { field: 'lines' });
      const line = { item_id: balance.item_id, size_key: balance.size_key, length: balance.length, width: balance.width, size_unit: balance.size_unit, area_sq_ft: balance.area_sq_ft };
      await trx('stock_transfer_lines').insert({ ...line, transfer_id: id, quantity: row.quantity });
      await move(trx, { type: 'transfer_out', siteId: fromSiteId, line, pieces: -row.quantity, transferId: id, actor });
    }
    await audit(trx, actor, { entity: 'stock_transfer', id, action: 'sent', summary: `To ${to.name}, ${lines.length} line${lines.length === 1 ? '' : 's'}` });
    return { id, number };
  });
}

async function inTransit(trx, id) {
  const transfer = await trx('stock_transfers').where({ id }).forUpdate().first();
  if (!transfer) throw httpError(404, 'That transfer doesn’t exist.');
  if (transfer.status !== 'in_transit') throw httpError(409, `${transfer.number} is already ${STATUSES[transfer.status].label.toLowerCase()}.`);
  return transfer;
}

/**
 * Received at the other site. `received`: { lineId: pieces } (more than sent isn't allowed).
 * @returns {Promise<{ shortLines: number, adjustment: { id: number, number: string } | null }>}
 */
export async function receiveTransfer(id, { received, note }, actor) {
  return db.transaction(async (trx) => {
    const transfer = await inTransit(trx, id);
    const lines = await trx('stock_transfer_lines').where({ transfer_id: id }).orderBy('item_id').orderBy('id');
    const short = [];
    for (const line of lines) {
      const got = received[line.id];
      if (got === undefined || got < 0 || got > num(line.quantity) + 1e-9) throw Object.assign(httpError(422, 'Check the quantities received: from 0 up to what was sent.'), { field: 'lines' });
      await trx('stock_transfer_lines').where({ id: line.id }).update({ received_qty: got });
      // Everything sent arrives on paper; what didn't arrive is taken off by the shortfall adjustment, once approved.
      await move(trx, { type: 'transfer_in', siteId: transfer.to_site_id, line, pieces: num(line.quantity), transferId: id, actor });
      if (got < num(line.quantity)) short.push({ line, missing: round3(num(line.quantity) - got) });
    }
    let adjustment = null;
    if (short.length) {
      adjustment = await createAdjustment({
        siteId: transfer.to_site_id, reason: 'lost', note: `Short on transfer ${transfer.number}${note ? `: ${note}` : ''}`,
        lines: short.map(({ line, missing }) => ({
          item_id: line.item_id, quantity: -missing, length: line.length === null ? null : num(line.length), width: line.width === null ? null : num(line.width),
          size_unit: line.size_unit, area_sq_ft: line.area_sq_ft === null ? null : num(line.area_sq_ft), entered_cost: null,
        })),
      }, actor, trx);
    }
    await trx('stock_transfers').where({ id }).update({
      status: 'received', received_by: actor.user.id, received_at: trx.fn.now(), receive_note: note, adjustment_id: adjustment?.id ?? null,
    });
    await audit(trx, actor, { entity: 'stock_transfer', id, action: 'received', summary: short.length ? `${short.length} line${short.length === 1 ? '' : 's'} short: ${adjustment.number}` : 'Everything arrived' });
    return { shortLines: short.length, adjustment };
  });
}

/** Sent by mistake (or it never left): the stock goes back to the sending site. */
export async function cancelTransfer(id, reason, actor) {
  await db.transaction(async (trx) => {
    const transfer = await inTransit(trx, id);
    const lines = await trx('stock_transfer_lines').where({ transfer_id: id }).orderBy('item_id').orderBy('id');
    for (const line of lines) await move(trx, { type: 'transfer_in', siteId: transfer.from_site_id, line, pieces: num(line.quantity), transferId: id, actor });
    await trx('stock_transfers').where({ id }).update({ status: 'cancelled', cancel_reason: reason });
    await audit(trx, actor, { entity: 'stock_transfer', id, action: 'cancelled', summary: `${reason}. Back in stock at the sending site.` });
  });
}

// ---------- reading ----------

export async function getTransfer(id) {
  const t = await db('stock_transfers as t').join('sites as f', 'f.id', 't.from_site_id').join('sites as d', 'd.id', 't.to_site_id')
    .leftJoin('users as s', 's.id', 't.sent_by').leftJoin('users as r', 'r.id', 't.received_by').leftJoin('stock_adjustments as a', 'a.id', 't.adjustment_id')
    .where('t.id', id)
    .first('t.*', 'f.name as from_name', 'd.name as to_name', 's.name as sent_name', 'r.name as received_name', 'a.number as adjustment_number', 'a.status as adjustment_status');
  if (!t) return null;
  t.lines = await db('stock_transfer_lines as l').join('items as i', 'i.id', 'l.item_id').where('l.transfer_id', id).orderBy('l.id')
    .select('l.*', 'i.name as item_name', 'i.unit', 'i.priced_by');
  return t;
}

/** show: 'incoming' (to my sites, in transit), 'outgoing' (from my sites, in transit), 'all' */
export function listTransfers({ siteIds, show = 'incoming' }) {
  const q = db('stock_transfers as t').join('sites as f', 'f.id', 't.from_site_id').join('sites as d', 'd.id', 't.to_site_id').leftJoin('users as u', 'u.id', 't.sent_by')
    .orderBy('t.id', 'desc').limit(200)
    .select('t.id', 't.number', 't.status', 't.carried_by', 't.sent_at', 't.received_at', 't.from_site_id', 't.to_site_id', 'f.name as from_name', 'd.name as to_name', 'u.name as sent_name',
      db('stock_transfer_lines as l').whereRaw('l.transfer_id = t.id').count('*').as('line_count'));
  if (show === 'incoming') q.whereIn('t.to_site_id', siteIds).where('t.status', 'in_transit');
  else if (show === 'outgoing') q.whereIn('t.from_site_id', siteIds).where('t.status', 'in_transit');
  else q.where((w) => w.whereIn('t.to_site_id', siteIds).orWhereIn('t.from_site_id', siteIds));
  return q;
}

export async function incomingCount(siteIds) {
  if (!siteIds.length) return 0;
  const [{ n }] = await db('stock_transfers').whereIn('to_site_id', siteIds).where({ status: 'in_transit' }).count({ n: '*' });
  return Number(n);
}
