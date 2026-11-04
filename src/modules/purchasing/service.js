import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';

// Purchase orders.
//
//   draft (editable) ──▶ pending ──▶ approved ──▶ sent
//   Anyone who may approve can approve a draft directly. Before goods arrive, an order can go
//   back to draft to be changed, or be cancelled with a reason.
//
// Prices are optional and exclude VAT. A plate's amount is pieces × sq ft × price per sq ft.

export const STATUSES = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  partly_received: { label: 'Partly received', tone: 'warn' },
  received: { label: 'Received', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
};

/** List tabs. "open" = not yet sent; "sent" = waiting for goods. */
export const TABS = ['open', 'sent', 'received', 'all'];

const err = (status, message, field) => Object.assign(httpError(status, message), { field });
const totalOf = (lines) => {
  const priced = lines.filter((l) => l.amount !== null && l.amount !== undefined);
  return priced.length ? Math.round(priced.reduce((sum, l) => sum + Number(l.amount), 0) * 100) / 100 : null;
};

async function checkSupplier(trx, supplierId, currentId = null) {
  const s = await trx('suppliers').where({ id: supplierId }).first('id', 'is_active');
  if (!s || (!s.is_active && s.id !== currentId)) throw err(422, 'Choose an active supplier', 'supplier_id');
}

async function writeLines(trx, orderId, lines) {
  await trx('purchase_order_lines').where({ order_id: orderId }).delete();
  await trx('purchase_order_lines').insert(lines.map((l, i) => ({ ...l, order_id: orderId, sort_order: i + 1 })));
}

const details = (input) => ({ supplier_id: input.supplier_id, order_date: input.order_date, expected_on: input.expected_on, notes: input.notes, total: totalOf(input.lines) });

/** @returns {Promise<{ id: number, number: string }>} */
export async function createOrder(input, actor) {
  return db.transaction(async (trx) => {
    await checkSupplier(trx, input.supplier_id);
    const number = await nextNumber(trx, 'order');
    const [id] = await trx('purchase_orders').insert({ ...details(input), number, site_id: actor.site.id, created_by: actor.user.id });
    await writeLines(trx, id, input.lines);
    await audit(trx, actor, { entity: 'purchase_order', id, action: 'create', summary: `${input.lines.length} line${input.lines.length === 1 ? '' : 's'}` });
    return { id, number };
  });
}

async function lock(trx, id) {
  const order = await trx('purchase_orders').where({ id }).forUpdate().first();
  if (!order) throw httpError(404, 'That purchase order doesn’t exist.');
  return order;
}
const wrongStatus = (order, doing) => httpError(409, `${order.number} is ${STATUSES[order.status].label.toLowerCase()}, so it can’t be ${doing}.`);

/** Only a draft can be changed. */
export async function updateOrder(id, input, actor) {
  await db.transaction(async (trx) => {
    const order = await lock(trx, id);
    if (order.status !== 'draft') throw wrongStatus(order, 'changed');
    await checkSupplier(trx, input.supplier_id, order.supplier_id);
    await trx('purchase_orders').where({ id }).update(details(input));
    await writeLines(trx, id, input.lines);
    await audit(trx, actor, { entity: 'purchase_order', id, action: 'update', summary: `${input.lines.length} line${input.lines.length === 1 ? '' : 's'}` });
  });
}

export async function submitOrder(id, actor) {
  await db.transaction(async (trx) => {
    const order = await lock(trx, id);
    if (order.status !== 'draft') throw wrongStatus(order, 'sent for approval');
    await trx('purchase_orders').where({ id }).update({ status: 'pending' });
    await audit(trx, actor, { entity: 'purchase_order', id, action: 'po_submitted' });
  });
}

export async function approveOrder(id, actor) {
  await db.transaction(async (trx) => {
    const order = await lock(trx, id);
    if (!['draft', 'pending'].includes(order.status)) throw wrongStatus(order, 'approved');
    await trx('purchase_orders').where({ id }).update({ status: 'approved', approved_by: actor.user.id, approved_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'purchase_order', id, action: 'po_approved' });
  });
}

export async function markSent(id, actor) {
  await db.transaction(async (trx) => {
    const order = await lock(trx, id);
    if (order.status !== 'approved') throw httpError(409, `${order.number} has to be approved before it goes to the supplier.`);
    await trx('purchase_orders').where({ id }).update({ status: 'sent', sent_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'purchase_order', id, action: 'po_sent' });
  });
}

/** To change it, or sent back by the approver. Its approval no longer stands. */
export async function backToDraft(id, reason, actor) {
  await db.transaction(async (trx) => {
    const order = await lock(trx, id);
    if (!['pending', 'approved', 'sent'].includes(order.status)) throw wrongStatus(order, 'taken back to draft');
    // Deliveries point at the order's lines, and stay on record even when reversed.
    if (await trx('goods_receipts').where({ order_id: id }).first('id')) throw httpError(409, `${order.number} has had a delivery recorded, so it can’t be changed. Start a new order instead.`);
    await trx('purchase_orders').where({ id }).update({ status: 'draft', approved_by: null, approved_at: null, sent_at: null });
    await audit(trx, actor, { entity: 'purchase_order', id, action: 'po_redraft', summary: reason || null });
  });
}

export async function cancelOrder(id, reason, actor) {
  await db.transaction(async (trx) => {
    const order = await lock(trx, id);
    if (['cancelled', 'partly_received', 'received'].includes(order.status)) throw wrongStatus(order, 'cancelled');
    await trx('purchase_orders').where({ id }).update({ status: 'cancelled', cancelled_at: trx.fn.now(), cancelled_reason: reason });
    await audit(trx, actor, { entity: 'purchase_order', id, action: 'po_cancelled', summary: reason });
  });
}

// ---------- reading ----------

export async function getOrder(id) {
  const order = await db('purchase_orders as o')
    .join('suppliers as s', 's.id', 'o.supplier_id')
    .join('sites as site', 'site.id', 'o.site_id')
    .leftJoin('users as cr', 'cr.id', 'o.created_by')
    .leftJoin('users as ap', 'ap.id', 'o.approved_by')
    .where('o.id', id)
    .first('o.*', 's.name as supplier_name', 's.number as supplier_number', 's.phone as supplier_phone', 's.address as supplier_address', 's.kra_pin as supplier_pin',
      'site.name as site_name', 'cr.name as created_name', 'ap.name as approved_name');
  if (!order) return null;
  order.lines = await db('purchase_order_lines as l')
    .join('items as i', 'i.id', 'l.item_id')
    .leftJoin('jobs as j', 'j.id', 'l.job_id')
    .where('l.order_id', id).orderBy('l.sort_order')
    .select('l.*', 'i.name as item_name', 'i.code as item_code', 'i.unit as item_unit', 'i.priced_by', 'j.number as job_number');
  return order;
}

function tabFilter(q, tab) {
  if (tab === 'open') q.whereIn('o.status', ['draft', 'pending', 'approved']);
  else if (tab === 'sent') q.whereIn('o.status', ['sent', 'partly_received']);
  else if (tab !== 'all') q.where('o.status', tab);
}

export function listOrders({ siteIds, tab = 'open', q = '' }) {
  const query = db('purchase_orders as o').join('suppliers as s', 's.id', 'o.supplier_id')
    .whereIn('o.site_id', siteIds).orderBy('o.id', 'desc').limit(200)
    .select('o.id', 'o.number', 'o.status', 'o.order_date', 'o.expected_on', 'o.total', 's.name as supplier_name',
      db('purchase_order_lines').where('order_id', db.ref('o.id')).count('*').as('line_count'));
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('o.number', 'like', `%${term}%`).orWhere('s.name', 'like', `%${term}%`)
      .orWhereExists(db('purchase_order_lines as l').join('items as i', 'i.id', 'l.item_id').whereRaw('l.order_id = o.id').where('i.name', 'like', `%${term}%`)));
  } else {
    tabFilter(query, tab);
  }
  return query;
}

export async function countByTab(siteIds) {
  const counts = {};
  for (const tab of TABS) {
    const q = db('purchase_orders as o').whereIn('o.site_id', siteIds);
    tabFilter(q, tab);
    counts[tab] = Number((await q.count({ n: '*' }))[0].n);
  }
  return counts;
}

export function ordersForSupplier(supplierId, siteIds) {
  return db('purchase_orders').where({ supplier_id: supplierId }).whereIn('site_id', siteIds)
    .orderBy('id', 'desc').limit(100).select('id', 'number', 'status', 'order_date');
}

/** Orders with a line for this job, for its page. */
export function ordersForJob(jobId, siteIds) {
  return db('purchase_orders as o').whereIn('o.site_id', siteIds)
    .whereExists(db('purchase_order_lines as l').whereRaw('l.order_id = o.id').where('l.job_id', jobId))
    .orderBy('o.id', 'desc').select('o.id', 'o.number', 'o.status');
}

/** Everything the order form needs to know about items, to pick one by name. */
export async function itemOptions() {
  const rows = await db('items').where({ is_active: true }).orderBy('name').select('id', 'name', 'priced_by', 'unit', 'current_price');
  return rows.map((i) => ({ ...i, current_price: i.current_price === null ? null : Number(i.current_price) }));
}

/** "For" suggestions: active jobs at the user's sites. */
export function jobOptions(siteIds) {
  return db('jobs as j').join('customers as c', 'c.id', 'j.customer_id')
    .whereIn('j.site_id', siteIds).whereIn('j.status', ['open', 'in_progress'])
    .orderBy('j.id', 'desc').limit(100).select('j.number', 'c.name as customer_name');
}

export function jobIdFor(number) {
  return db('jobs').where({ number }).first('id');
}

export function activeItems(ids) {
  return db('items').whereIn('id', ids).where({ is_active: true }).select('id', 'name', 'priced_by', 'thickness_mm');
}
