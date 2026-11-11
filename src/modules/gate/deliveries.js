import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { dayStart, localDay, nextDay } from '../../core/dates.js';

// Supplier deliveries at the gate (step 26b). The guard logs the truck in against an open purchase
// order (or as "no order" with the supplier typed); stores receive goods only against an arrival
// logged here, one GRN per arrival. A no-order arrival waits until stores link it to an order or close it.

export const STATUSES = {
  waiting: { label: 'Waiting for stores', tone: 'warn' },
  received: { label: 'Received', tone: 'ok' },
  closed: { label: 'Closed', tone: 'neutral' },
};

/** Orders that can still receive goods (as in stock/service.js RECEIVABLE). */
export const OPEN = ['approved', 'sent', 'partly_received'];

const fail = (status, message, field) => Object.assign(httpError(status, message), field ? { field } : {});
const num = (v) => Number(v ?? 0);

/** Open orders at a site, with what is still to come (no prices: the gate checks the load, not the cost). */
export async function openOrders(siteId) {
  const orders = await db('purchase_orders as o').join('suppliers as s', 's.id', 'o.supplier_id')
    .where('o.site_id', siteId).whereIn('o.status', OPEN).orderBy('o.id', 'desc')
    .select('o.id', 'o.number', 'o.expected_on', 's.name as supplier_name');
  const lines = orders.length ? await db('purchase_order_lines as l').join('items as i', 'i.id', 'l.item_id')
    .whereIn('l.order_id', orders.map((o) => o.id)).whereRaw('l.received_qty < l.quantity').orderBy('l.sort_order')
    .select('l.order_id', 'l.quantity', 'l.received_qty', 'l.length', 'l.width', 'l.size_unit', 'i.name', 'i.unit', 'i.priced_by') : [];
  return orders.map((o) => ({
    ...o,
    lines: lines.filter((l) => l.order_id === o.id).map((l) => ({
      name: l.name,
      size: l.size_unit ? `${num(l.length)} × ${num(l.width)} ${l.size_unit}` : '',
      left: num(l.quantity) - num(l.received_qty),
      unit: l.priced_by === 'area' ? 'pcs' : l.unit,
    })),
  }));
}

/** The guard logs a truck in. orderId null: no order, supplierName typed. */
export async function logArrival({ siteId, orderId, supplierName, deliveryNote, vehicleReg, driverName, note }, actor) {
  return db.transaction(async (trx) => {
    let order = null;
    if (orderId) {
      order = await trx('purchase_orders').where({ id: orderId }).forUpdate().first('id', 'number', 'site_id', 'status');
      if (!order || order.site_id !== siteId || !OPEN.includes(order.status)) throw fail(422, 'That order isn’t open at this site. Choose it again, or log it as no order.', 'order_id');
    }
    const number = await nextNumber(trx, 'delivery');
    const [id] = await trx('gate_deliveries').insert({
      number, site_id: siteId, order_id: order?.id ?? null, supplier_name: order ? null : supplierName,
      delivery_note: deliveryNote, vehicle_reg: vehicleReg, driver_name: driverName, note, logged_by: actor.user.id,
    });
    await audit(trx, actor, { entity: 'gate_delivery', id, action: 'logged_in', summary: order ? `Against ${order.number}` : `No order: ${supplierName}` });
    if (order) await audit(trx, actor, { entity: 'purchase_order', id: order.id, action: 'po_at_gate', summary: number });
    return { id, number, order };
  });
}

const base = () => db('gate_deliveries as d')
  .leftJoin('purchase_orders as o', 'o.id', 'd.order_id').leftJoin('suppliers as s', 's.id', 'o.supplier_id')
  .join('sites as site', 'site.id', 'd.site_id').leftJoin('users as u', 'u.id', 'd.logged_by')
  .leftJoin('goods_receipts as g', 'g.id', 'd.receipt_id')
  .select('d.*', 'o.number as order_number', 'o.status as order_status', db.raw('COALESCE(s.name, d.supplier_name) as supplier'),
    'site.name as site_name', 'u.name as logged_name', 'g.number as receipt_number');

export const getDelivery = (id) => base().where('d.id', id).first();

/** What the gate logged today at a site (any status), newest first. */
export function loggedToday(siteId) {
  const today = localDay();
  return base().where('d.site_id', siteId).where('d.arrived_at', '>=', dayStart(today)).where('d.arrived_at', '<', dayStart(nextDay(today))).orderBy('d.id', 'desc');
}

/** Arrivals waiting for stores at these sites. */
export const waitingAt = (siteIds) => (siteIds.length ? base().whereIn('d.site_id', siteIds).where('d.status', 'waiting').orderBy('d.id') : Promise.resolve([]));

/** Arrivals waiting to be received against one order. */
export const waitingFor = (orderId) => base().where('d.order_id', orderId).where('d.status', 'waiting').orderBy('d.id');

export async function waitingCount(siteIds) {
  if (!siteIds.length) return 0;
  const [{ n }] = await db('gate_deliveries').whereIn('site_id', siteIds).where({ status: 'waiting' }).count('* as n');
  return Number(n);
}

/** Stores: a no-order arrival turns out to be for an open order here. */
export async function linkOrder(id, orderId, actor) {
  return db.transaction(async (trx) => {
    const d = await trx('gate_deliveries').where({ id }).forUpdate().first();
    if (!d) throw httpError(404, 'That delivery doesn’t exist.');
    if (d.status !== 'waiting' || d.order_id) throw httpError(409, `${d.number} is already ${d.order_id ? 'against an order' : d.status}.`);
    const order = await trx('purchase_orders').where({ id: orderId }).first('id', 'number', 'site_id', 'status');
    if (!order || order.site_id !== d.site_id || !OPEN.includes(order.status)) throw httpError(409, 'Choose an open order at the site the delivery came to.');
    await trx('gate_deliveries').where({ id }).update({ order_id: order.id });
    await audit(trx, actor, { entity: 'gate_delivery', id, action: 'linked_order', summary: order.number });
    await audit(trx, actor, { entity: 'purchase_order', id: order.id, action: 'po_at_gate', summary: d.number });
    return { ...d, order };
  });
}

/** Stores: sent back, or not ours. */
export async function closeDelivery(id, reason, actor) {
  return db.transaction(async (trx) => {
    const d = await trx('gate_deliveries').where({ id }).forUpdate().first();
    if (!d) throw httpError(404, 'That delivery doesn’t exist.');
    if (d.status !== 'waiting') throw httpError(409, `${d.number} is already ${d.status}.`);
    await trx('gate_deliveries').where({ id }).update({ status: 'closed', closed_at: trx.fn.now(), closed_by: actor.user.id, close_reason: reason });
    await audit(trx, actor, { entity: 'gate_delivery', id, action: 'closed', summary: reason });
    return d;
  });
}

/** Inside receiveGoods: the arrival this GRN is made from. Locks it and checks it fits. */
export async function claimForReceipt(trx, { deliveryId, orderId, siteId }) {
  const d = deliveryId ? await trx('gate_deliveries').where({ id: deliveryId }).forUpdate().first() : null;
  if (!d || d.order_id !== orderId || d.site_id !== siteId) throw fail(422, 'Choose the delivery the gate logged in for this order.', 'delivery_id');
  if (d.status !== 'waiting') throw fail(409, `${d.number} has already been ${d.status === 'received' ? 'received' : 'closed'}.`, 'delivery_id');
  return d;
}
