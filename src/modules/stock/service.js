import { db } from '../../core/db.js';
import { claimForReceipt } from '../gate/deliveries.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';

// Goods received and stock.
//
// Costs: weighted average, one per item across all sites, excluding VAT.
//   new average = (value in stock + what this delivery cost) ÷ (quantity in stock + quantity received)
// A delivery's transport is shared across its lines by value, and is part of what it cost.
// items.current_price is the price last paid, without transport: new proformas quote from it.
//
// A plate's stock is kept in sq ft for its value, and in sheets of each size for the store.
// Every change adds a row to stock_movements; those rows are never edited.

const err = (status, message, field) => Object.assign(httpError(status, message), { field });
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10_000) / 10_000;

export const RECEIVABLE = ['approved', 'sent', 'partly_received'];

export const sizeKey = (l) => (l.size_unit ? `${Number(l.length)}x${Number(l.width)}${l.size_unit}` : '');

/** Transport shared by each line's value. Rounding left over goes on the largest line, so the shares add up exactly. */
export function shareTransport(amounts, transport) {
  const total = amounts.reduce((sum, a) => sum + a, 0);
  if (!transport || !total) return amounts.map(() => 0);
  const shares = amounts.map((a) => round2((transport * a) / total));
  const left = round2(transport - shares.reduce((sum, s) => sum + s, 0));
  shares[amounts.indexOf(Math.max(...amounts))] = round2(shares[amounts.indexOf(Math.max(...amounts))] + left);
  return shares;
}

/** The order's status from what has arrived so far. */
async function statusFromLines(trx, orderId) {
  const lines = await trx('purchase_order_lines').where({ order_id: orderId }).select('quantity', 'received_qty');
  const received = lines.some((l) => Number(l.received_qty) > 0);
  const all = lines.every((l) => Number(l.received_qty) >= Number(l.quantity));
  return all ? 'received' : received ? 'partly_received' : 'sent';
}

export async function changeBalance(trx, { siteId, itemId, line, by }) {
  const key = sizeKey(line);
  const where = { site_id: siteId, item_id: itemId, size_key: key };
  const balance = await trx('stock_balances').where(where).forUpdate().first();
  if (balance) await trx('stock_balances').where({ id: balance.id }).update({ quantity: Number(balance.quantity) + by });
  else {
    await trx('stock_balances').insert({
      ...where, quantity: by, length: line.length ?? null, width: line.width ?? null, size_unit: line.size_unit ?? null, area_sq_ft: line.area_sq_ft ?? null,
    });
  }
  return key;
}

/**
 * Goods arrive. `input.lines`: { line_id, quantity, rejected, unit_price }.
 * @returns {Promise<{ id: number, number: string, changes: string[] }>}
 */
export async function receiveGoods(orderId, input, actor) {
  return db.transaction(async (trx) => {
    const order = await trx('purchase_orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw httpError(404, 'That purchase order doesn’t exist.');
    if (!RECEIVABLE.includes(order.status)) throw httpError(409, `${order.number} can’t receive goods while it is ${order.status === 'received' ? 'fully received' : order.status}.`);

    const orderLines = await trx('purchase_order_lines').where({ order_id: orderId }).forUpdate().select();
    const rows = input.lines.map((row) => {
      const line = orderLines.find((l) => l.id === row.line_id);
      if (!line) throw err(422, 'That line isn’t on this order.', 'lines');
      const left = Number(line.quantity) - Number(line.received_qty);
      if (row.quantity > left + 1e-9) throw err(422, `Only ${left} left to receive on one of the lines. Check the quantity, or change the order first.`, 'lines');
      // Rounded as the database stores it, so what goes in is exactly what a reversal takes out.
      const stockQty = round3(line.area_sq_ft === null ? row.quantity : row.quantity * Number(line.area_sq_ft));
      return { ...row, line, stockQty, goods: row.quantity > 0 ? round2(stockQty * row.unit_price) : 0 };
    });
    if (!rows.some((r) => r.quantity > 0)) throw err(422, 'Enter what arrived.', 'lines');
    // Only against a delivery the gate logged in for this order (step 26b): one arrival, one GRN.
    const arrival = await claimForReceipt(trx, { deliveryId: input.delivery_id, orderId, siteId: actor.site.id });

    const shares = shareTransport(rows.map((r) => r.goods), input.transport_cost ?? 0);
    const goodsTotal = round2(rows.reduce((sum, r) => sum + r.goods, 0));
    const number = await nextNumber(trx, 'receipt');
    const [id] = await trx('goods_receipts').insert({
      number, order_id: orderId, site_id: actor.site.id, received_on: input.received_on, delivery_note: input.delivery_note ?? arrival.delivery_note, invoice_ref: input.invoice_ref,
      goods_total: goodsTotal, transport_cost: input.transport_cost ?? 0, notes: input.notes, received_by: actor.user.id,
    });

    const changes = [];
    // Always in the same order, so two deliveries at once can't lock each other out.
    const order_ = rows.map((r, i) => ({ r, share: shares[i] })).sort((a, b) => a.r.line.item_id - b.r.line.item_id);
    for (const { r, share } of order_) {
      const item = await trx('items').where({ id: r.line.item_id }).forUpdate().first();
      const accepted = r.quantity > 0;
      await trx('goods_receipt_lines').insert({
        receipt_id: id, order_line_id: r.line.id, item_id: item.id, quantity: r.quantity, rejected_qty: r.rejected, stock_qty: r.stockQty,
        unit_price: accepted ? r.unit_price : null, previous_price: accepted ? item.current_price : null, goods_amount: r.goods, transport_share: share,
      });
      if (!accepted) continue;

      const value = r.goods + share;
      const qty = round3(Number(item.on_hand_qty) + r.stockQty);
      const stockValue = Number(item.stock_value) + value;
      await trx('items').where({ id: item.id }).update({ on_hand_qty: qty, stock_value: round4(stockValue), avg_cost: round4(stockValue / qty), current_price: r.unit_price });
      if (item.current_price !== null && Number(item.current_price) !== r.unit_price) {
        await audit(trx, actor, { entity: 'item', id: item.id, action: 'price_changed', before: { current_price: Number(item.current_price) }, after: { current_price: r.unit_price }, summary: number });
        const pct = Math.round(((r.unit_price - Number(item.current_price)) / Number(item.current_price)) * 100);
        if (Math.abs(pct) >= 10) changes.push(`${item.name} ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%`);
      }
      const key = await changeBalance(trx, { siteId: actor.site.id, itemId: item.id, line: r.line, by: r.quantity });
      await trx('stock_movements').insert({
        type: 'receive', site_id: actor.site.id, item_id: item.id, size_key: key, quantity: r.quantity, stock_qty: r.stockQty, value: round4(value), receipt_id: id, created_by: actor.user.id,
      });
      await trx('purchase_order_lines').where({ id: r.line.id }).update({ received_qty: Number(r.line.received_qty) + r.quantity });
    }

    await trx('purchase_orders').where({ id: orderId }).update({ status: await statusFromLines(trx, orderId) });
    await trx('gate_deliveries').where({ id: arrival.id }).update({ status: 'received', receipt_id: id });
    await audit(trx, actor, { entity: 'gate_delivery', id: arrival.id, action: 'received', summary: number });
    await audit(trx, actor, { entity: 'goods_receipt', id, action: 'create', summary: `Against ${order.number}, ${arrival.number}` });
    await audit(trx, actor, { entity: 'purchase_order', id: orderId, action: 'po_received', summary: number });
    return { id, number, changes };
  });
}

/**
 * Entered by mistake: takes the delivery back out of stock, as long as it is all still there.
 * The average comes back out by value. It can't be recalculated exactly once other deliveries have
 * come in since, so what is left is valued at what remains.
 */
export async function reverseReceipt(id, reason, actor) {
  await db.transaction(async (trx) => {
    const receipt = await trx('goods_receipts').where({ id }).forUpdate().first();
    if (!receipt) throw httpError(404, 'That goods received note doesn’t exist.');
    if (receipt.reversed_at) throw httpError(409, `${receipt.number} has already been reversed.`);
    const lines = (await trx('goods_receipt_lines as gl').join('purchase_order_lines as ol', 'ol.id', 'gl.order_line_id')
      .where('gl.receipt_id', id).orderBy('gl.item_id')
      .select('gl.*', 'ol.length', 'ol.width', 'ol.size_unit', 'ol.received_qty')).filter((l) => Number(l.quantity) > 0);

    for (const l of lines) {
      const item = await trx('items').where({ id: l.item_id }).forUpdate().first();
      const key = sizeKey(l);
      const balance = await trx('stock_balances').where({ site_id: receipt.site_id, item_id: l.item_id, size_key: key }).forUpdate().first();
      if (!balance || Number(balance.quantity) < Number(l.quantity)) {
        throw httpError(409, `${item.name}: some of this delivery has already left the store, so it can’t be reversed.`);
      }
      const value = Number(l.goods_amount) + Number(l.transport_share);
      const qty = Math.max(0, round3(Number(item.on_hand_qty) - Number(l.stock_qty)));
      const stockValue = qty > 0 ? Math.max(0, Number(item.stock_value) - value) : 0;
      // The price goes back too, unless a later delivery has already set a newer one.
      const later = await trx('goods_receipt_lines as gl').join('goods_receipts as g', 'g.id', 'gl.receipt_id')
        .where('gl.item_id', l.item_id).where('g.id', '>', id).whereNull('g.reversed_at').where('gl.quantity', '>', 0).first('gl.id');
      await trx('items').where({ id: l.item_id }).update({
        on_hand_qty: qty, stock_value: round4(stockValue), avg_cost: qty > 0 ? round4(stockValue / qty) : item.avg_cost,
        ...(later ? {} : { current_price: l.previous_price }),
      });
      await trx('stock_balances').where({ id: balance.id }).update({ quantity: Number(balance.quantity) - Number(l.quantity) });
      await trx('stock_movements').insert({
        type: 'reverse', site_id: receipt.site_id, item_id: l.item_id, size_key: key, quantity: -Number(l.quantity), stock_qty: -Number(l.stock_qty), value: -round4(value), receipt_id: id, created_by: actor.user.id,
      });
      await trx('purchase_order_lines').where({ id: l.order_line_id }).decrement('received_qty', Number(l.quantity));
    }

    await trx('goods_receipts').where({ id }).update({ reversed_at: trx.fn.now(), reversed_by: actor.user.id, reversed_reason: reason });
    // The arrival it came from waits for stores again, to be received properly.
    const arrival = await trx('gate_deliveries').where({ receipt_id: id }).forUpdate().first('id');
    if (arrival) {
      await trx('gate_deliveries').where({ id: arrival.id }).update({ status: 'waiting', receipt_id: null });
      await audit(trx, actor, { entity: 'gate_delivery', id: arrival.id, action: 'grn_reversed', summary: receipt.number });
    }
    const order = await trx('purchase_orders').where({ id: receipt.order_id }).forUpdate().first('id', 'number');
    await trx('purchase_orders').where({ id: order.id }).update({ status: await statusFromLines(trx, order.id) });
    await audit(trx, actor, { entity: 'goods_receipt', id, action: 'grn_reversed', summary: reason });
    await audit(trx, actor, { entity: 'purchase_order', id: order.id, action: 'po_receipt_reversed', summary: receipt.number });
  });
}

/** Nothing more is coming: the order stops waiting for the rest. */
export async function closeOrder(orderId, reason, actor) {
  await db.transaction(async (trx) => {
    const order = await trx('purchase_orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw httpError(404, 'That purchase order doesn’t exist.');
    if (order.status !== 'partly_received') throw httpError(409, `Only a partly received order can be closed. ${order.number} isn’t one.`);
    await trx('purchase_orders').where({ id: orderId }).update({ status: 'received' });
    await audit(trx, actor, { entity: 'purchase_order', id: orderId, action: 'po_closed', summary: reason });
  });
}

// ---------- opening stock ----------

/**
 * What is already on the racks. It joins the weighted average like a delivery, with no transport.
 * @param {{ item_id: number, quantity: number, length: number|null, width: number|null, size_unit: string|null, area_sq_ft: number|null, unit_cost: number }[]} lines
 */
export async function addOpeningStock(lines, actor) {
  await db.transaction(async (trx) => {
    for (const line of [...lines].sort((a, b) => a.item_id - b.item_id)) {
      const item = await trx('items').where({ id: line.item_id }).forUpdate().first();
      const stockQty = round3(line.area_sq_ft === null ? line.quantity : line.quantity * line.area_sq_ft);
      const value = round4(stockQty * line.unit_cost);
      const qty = round3(Number(item.on_hand_qty) + stockQty);
      const stockValue = round4(Number(item.stock_value) + value);
      await trx('items').where({ id: item.id }).update({
        on_hand_qty: qty, stock_value: stockValue, avg_cost: round4(stockValue / qty), ...(item.current_price === null ? { current_price: line.unit_cost } : {}),
      });
      const key = await changeBalance(trx, { siteId: actor.site.id, itemId: item.id, line, by: line.quantity });
      await trx('stock_movements').insert({
        type: 'opening', site_id: actor.site.id, item_id: item.id, size_key: key, quantity: line.quantity, stock_qty: stockQty, value, created_by: actor.user.id,
      });
      await audit(trx, actor, { entity: 'item', id: item.id, action: 'opening_stock', summary: `${stockQty} ${item.unit} at KES ${line.unit_cost}` });
    }
  });
}

/** Typed wrongly: takes the entry back out, as long as it is all still in stock. */
export async function undoOpening(movementId, actor) {
  await db.transaction(async (trx) => {
    const m = await trx('stock_movements').where({ id: movementId, type: 'opening' }).forUpdate().first();
    if (!m) throw httpError(404, 'That entry doesn’t exist.');
    if (await trx('stock_movements').where({ reverses_id: m.id }).first('id')) throw httpError(409, 'That entry has already been undone.');
    const item = await trx('items').where({ id: m.item_id }).forUpdate().first();
    const balance = await trx('stock_balances').where({ site_id: m.site_id, item_id: m.item_id, size_key: m.size_key }).forUpdate().first();
    if (!balance || Number(balance.quantity) < Number(m.quantity)) throw httpError(409, `${item.name}: some of this has already left the store, so it can’t be undone.`);
    const qty = Math.max(0, round3(Number(item.on_hand_qty) - Number(m.stock_qty)));
    const stockValue = qty > 0 ? Math.max(0, round4(Number(item.stock_value) - Number(m.value))) : 0;
    await trx('items').where({ id: item.id }).update({ on_hand_qty: qty, stock_value: stockValue, avg_cost: qty > 0 ? round4(stockValue / qty) : item.avg_cost });
    await trx('stock_balances').where({ id: balance.id }).update({ quantity: round3(Number(balance.quantity) - Number(m.quantity)) });
    await trx('stock_movements').insert({
      type: 'reverse', site_id: m.site_id, item_id: m.item_id, size_key: m.size_key, quantity: -Number(m.quantity), stock_qty: -Number(m.stock_qty), value: -Number(m.value), reverses_id: m.id, created_by: actor.user.id,
    });
    await audit(trx, actor, { entity: 'item', id: item.id, action: 'opening_undone', summary: `${Number(m.stock_qty)} ${item.unit}` });
  });
}

export const getMovement = (id) => db('stock_movements').where({ id }).first();

export async function openingEntries(siteIds) {
  const rows = await db('stock_movements as m').join('items as i', 'i.id', 'm.item_id').join('sites as s', 's.id', 'm.site_id').leftJoin('users as u', 'u.id', 'm.created_by')
    .where('m.type', 'opening').whereIn('m.site_id', siteIds).orderBy('m.id', 'desc').limit(200)
    .select('m.id', 'm.item_id', 'm.size_key', 'm.stock_qty', 'm.value', 'm.created_at', 'i.name as item_name', 'i.unit', 's.name as site_name', 'u.name as by_name',
      db('stock_movements as r').whereRaw('r.reverses_id = m.id').count('*').as('undone'));
  return rows.map((r) => ({ ...r, undone: Number(r.undone) > 0 }));
}

// ---------- reading ----------

export async function getReceipt(id) {
  const r = await db('goods_receipts as g')
    .join('purchase_orders as o', 'o.id', 'g.order_id')
    .join('suppliers as s', 's.id', 'o.supplier_id')
    .join('sites as site', 'site.id', 'g.site_id')
    .leftJoin('users as u', 'u.id', 'g.received_by')
    .leftJoin('users as rv', 'rv.id', 'g.reversed_by')
    .leftJoin('gate_deliveries as d', 'd.receipt_id', 'g.id').leftJoin('users as du', 'du.id', 'd.logged_by')
    .where('g.id', id)
    .first('g.*', 'o.number as order_number', 's.id as supplier_id', 's.name as supplier_name', 'site.name as site_name', 'u.name as received_name', 'rv.name as reversed_name',
      'd.number as arrival_number', 'd.arrived_at', 'd.vehicle_reg', 'd.driver_name', 'du.name as arrival_logged_name');
  if (!r) return null;
  r.lines = await db('goods_receipt_lines as gl')
    .join('items as i', 'i.id', 'gl.item_id')
    .join('purchase_order_lines as ol', 'ol.id', 'gl.order_line_id')
    .where('gl.receipt_id', id).orderBy('ol.sort_order')
    .select('gl.*', 'i.name as item_name', 'i.unit as item_unit', 'i.priced_by', 'ol.length', 'ol.width', 'ol.size_unit');
  return r;
}

export function listReceipts({ siteIds, q = '' }) {
  const query = db('goods_receipts as g')
    .join('purchase_orders as o', 'o.id', 'g.order_id')
    .join('suppliers as s', 's.id', 'o.supplier_id')
    .whereIn('g.site_id', siteIds).orderBy('g.id', 'desc').limit(200)
    .select('g.id', 'g.number', 'g.received_on', 'g.goods_total', 'g.transport_cost', 'g.invoice_ref', 'g.reversed_at', 'o.number as order_number', 's.name as supplier_name');
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('g.number', 'like', `%${term}%`).orWhere('o.number', 'like', `%${term}%`)
      .orWhere('s.name', 'like', `%${term}%`).orWhere('g.invoice_ref', 'like', `%${term}%`).orWhere('g.delivery_note', 'like', `%${term}%`));
  }
  return query;
}

export function receiptsForOrder(orderId) {
  return db('goods_receipts').where({ order_id: orderId }).orderBy('id')
    .select('id', 'number', 'received_on', 'goods_total', 'transport_cost', 'reversed_at');
}

const low = (i) => i.reorder_level !== null && Number(i.on_hand_qty) <= Number(i.reorder_level);

/** The stock page: what is at this site, what the item totals across sites, and what it is worth. */
export async function stockList({ siteId, q = '', lowOnly = false }) {
  const query = db('items as i').join('item_categories as c', 'c.id', 'i.category_id')
    .where((w) => w.where('i.on_hand_qty', '>', 0).orWhere((a) => a.where('i.is_active', true).whereNotNull('i.reorder_level')))
    .orderBy('c.sort_order').orderBy('i.name').limit(500)
    .select('i.id', 'i.code', 'i.name', 'i.unit', 'i.priced_by', 'i.on_hand_qty', 'i.stock_value', 'i.avg_cost', 'i.reorder_level', 'c.name as category');
  const term = q.trim();
  if (term) query.where((w) => w.where('i.code', 'like', `%${term}%`).orWhereRaw("REPLACE(`i`.`name`, ' ', '') LIKE ?", [`%${term.replace(/\s+/g, '')}%`]));
  const items = (await query).map((i) => ({ ...i, isLow: low(i), here: 0, sizes: [] }));
  const balances = items.length ? await db('stock_balances').where({ site_id: siteId }).where('quantity', '>', 0).whereIn('item_id', items.map((i) => i.id)).orderBy('area_sq_ft', 'desc') : [];
  for (const b of balances) {
    const item = items.find((i) => i.id === b.item_id);
    item.here += Number(b.quantity) * (b.area_sq_ft === null ? 1 : Number(b.area_sq_ft));
    if (b.size_key) item.sizes.push(b);
  }
  return lowOnly ? items.filter((i) => i.isLow) : items;
}

export async function stockTotals() {
  const [t] = await db('items').sum({ value: 'stock_value' });
  const lowCount = await db('items').where({ is_active: true }).whereNotNull('reorder_level').whereRaw('`on_hand_qty` <= `reorder_level`').count({ n: '*' });
  return { value: Number(t.value ?? 0), low: Number(lowCount[0].n) };
}

/** An item's page: where it is, and its latest movements. */
export async function stockOfItem(itemId) {
  return {
    balances: await db('stock_balances as b').join('sites as s', 's.id', 'b.site_id').where('b.item_id', itemId).where('b.quantity', '>', 0)
      .orderBy('s.name').orderBy('b.area_sq_ft', 'desc').select('b.*', 's.name as site_name'),
    movements: await db('stock_movements as m').join('sites as s', 's.id', 'm.site_id').leftJoin('goods_receipts as g', 'g.id', 'm.receipt_id').leftJoin('users as u', 'u.id', 'm.created_by')
      .leftJoin('material_issues as iss', 'iss.id', 'm.issue_id').leftJoin('jobs as j', 'j.id', 'm.job_id')
      .where('m.item_id', itemId).orderBy('m.id', 'desc').limit(20)
      .select('m.*', 's.name as site_name', 'g.number as receipt_number', 'u.name as by_name', 'iss.number as issue_number', 'j.number as job_number'),
  };
}
