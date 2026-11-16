import { db } from '../../core/db.js';
import { countTabs } from '../../core/count-tabs.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';

// Purchase requests: the workshop asks stores for materials.
//
//   pending ──▶ approved ──▶ ordered        (declined; or cancelled before it is ordered)
//
// A manager (purchasing.approve) approves or declines; a request raised by someone who may approve
// starts approved. Stores (purchasing.manage) put approved requests on a purchase order; if that order
// is cancelled, they go back to approved, to be ordered again.

export const STATUSES = {
  pending: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved: to order', tone: 'info' },
  ordered: { label: 'Ordered', tone: 'ok' },
  declined: { label: 'Declined', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const TABS = ['pending', 'approved', 'ordered', 'all'];

const lineCount = (lines) => `${lines.length} line${lines.length === 1 ? '' : 's'}`;

async function writeLines(trx, requestId, lines) {
  await trx('purchase_request_lines').where({ request_id: requestId }).delete();
  await trx('purchase_request_lines').insert(lines.map((l, i) => ({ ...l, request_id: requestId, sort_order: i + 1 })));
}

/** @returns {Promise<{ id: number, number: string, status: string }>} */
export async function createRequest(input, actor) {
  return db.transaction(async (trx) => {
    const number = await nextNumber(trx, 'request');
    const approved = actor.user.can('purchasing.approve');
    const [id] = await trx('purchase_requests').insert({
      number, site_id: actor.site.id, needed_by: input.needed_by, notes: input.notes, requested_by: actor.user.id,
      ...(approved ? { status: 'approved', decided_by: actor.user.id, decided_at: trx.fn.now() } : {}),
    });
    await writeLines(trx, id, input.lines);
    await audit(trx, actor, { entity: 'purchase_request', id, action: 'create', summary: lineCount(input.lines) });
    if (approved) await audit(trx, actor, { entity: 'purchase_request', id, action: 'approved' });
    return { id, number, status: approved ? 'approved' : 'pending' };
  });
}

async function lock(trx, id) {
  const request = await trx('purchase_requests').where({ id }).forUpdate().first();
  if (!request) throw httpError(404, 'That purchase request doesn’t exist.');
  return request;
}
const wrongStatus = (r, doing) => httpError(409, `${r.number} is ${STATUSES[r.status].label.toLowerCase()}, so it can’t be ${doing}.`);

/** Only while it waits for approval. */
export async function updateRequest(id, input, actor) {
  await db.transaction(async (trx) => {
    const request = await lock(trx, id);
    if (request.status !== 'pending') throw wrongStatus(request, 'changed');
    await trx('purchase_requests').where({ id }).update({ needed_by: input.needed_by, notes: input.notes });
    await writeLines(trx, id, input.lines);
    await audit(trx, actor, { entity: 'purchase_request', id, action: 'update', summary: lineCount(input.lines) });
  });
}

export async function approveRequest(id, actor) {
  await db.transaction(async (trx) => {
    const request = await lock(trx, id);
    if (request.status !== 'pending') throw wrongStatus(request, 'approved');
    await trx('purchase_requests').where({ id }).update({ status: 'approved', decided_by: actor.user.id, decided_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'purchase_request', id, action: 'approved' });
  });
}

export async function declineRequest(id, reason, actor) {
  await db.transaction(async (trx) => {
    const request = await lock(trx, id);
    if (request.status !== 'pending') throw wrongStatus(request, 'declined');
    await trx('purchase_requests').where({ id }).update({ status: 'declined', decided_by: actor.user.id, decided_at: trx.fn.now(), reason });
    await audit(trx, actor, { entity: 'purchase_request', id, action: 'declined', summary: reason });
  });
}

/** Withdrawn by whoever asked, or by stores: no longer needed. */
export async function cancelRequest(id, reason, actor) {
  await db.transaction(async (trx) => {
    const request = await lock(trx, id);
    if (!['pending', 'approved'].includes(request.status)) throw wrongStatus(request, 'cancelled');
    await trx('purchase_requests').where({ id }).update({ status: 'cancelled', reason });
    await audit(trx, actor, { entity: 'purchase_request', id, action: 'pr_cancelled', summary: reason });
  });
}

/**
 * Inside the order's transaction: these requests go on the new order. Each must still be approved
 * (someone else may have ordered or cancelled it meanwhile).
 */
export async function markOrdered(trx, requestIds, order, actor) {
  if (!requestIds.length) return;
  const rows = await trx('purchase_requests').whereIn('id', requestIds).forUpdate().select('id', 'number', 'status');
  if (rows.length !== requestIds.length) throw httpError(404, 'One of those purchase requests no longer exists.');
  for (const r of rows) if (r.status !== 'approved') throw wrongStatus(r, 'ordered');
  await trx('purchase_requests').whereIn('id', requestIds).update({ status: 'ordered', order_id: order.id });
  for (const r of rows) await audit(trx, actor, { entity: 'purchase_request', id: r.id, action: 'pr_ordered', summary: order.number });
}

/** Inside the order's transaction: the order was cancelled, so its requests are to be ordered again. */
export async function orderCancelled(trx, order, actor) {
  const rows = await trx('purchase_requests').where({ order_id: order.id, status: 'ordered' }).forUpdate().select('id');
  if (!rows.length) return;
  await trx('purchase_requests').whereIn('id', rows.map((r) => r.id)).update({ status: 'approved', order_id: null });
  for (const r of rows) await audit(trx, actor, { entity: 'purchase_request', id: r.id, action: 'pr_reopened', summary: order.number });
}

// ---------- reading ----------

const linesQuery = () => db('purchase_request_lines as l')
  .join('items as i', 'i.id', 'l.item_id')
  .leftJoin('jobs as j', 'j.id', 'l.job_id')
  .orderBy(['l.request_id', 'l.sort_order'])
  .select('l.*', 'i.name as item_name', 'i.unit as item_unit', 'i.priced_by', 'i.is_active as item_active', 'j.number as job_number');

export async function getRequest(id) {
  const request = await db('purchase_requests as r')
    .join('sites as s', 's.id', 'r.site_id')
    .leftJoin('users as rq', 'rq.id', 'r.requested_by')
    .leftJoin('users as d', 'd.id', 'r.decided_by')
    .leftJoin('purchase_orders as o', 'o.id', 'r.order_id')
    .where('r.id', id)
    .first('r.*', 's.name as site_name', 'rq.name as requested_name', 'd.name as decided_name', 'o.number as order_number', 'o.status as order_status');
  if (!request) return null;
  request.lines = await linesQuery().where('l.request_id', id);
  return request;
}

/** Approved requests, with their lines, to fill a new order; only those at these sites. */
export async function forOrdering(ids, siteIds) {
  if (!ids.length) return [];
  const requests = await db('purchase_requests').whereIn('id', ids).whereIn('site_id', siteIds).where({ status: 'approved' }).orderBy('id').select('id', 'number');
  if (!requests.length) return [];
  const lines = await linesQuery().whereIn('l.request_id', requests.map((r) => r.id));
  return requests.map((r) => ({ ...r, lines: lines.filter((l) => l.request_id === r.id) }));
}

function tabFilter(q, tab) {
  if (tab !== 'all') q.where('r.status', tab);
}

export function listRequests({ siteIds, tab = 'pending', q = '' }) {
  const query = db('purchase_requests as r')
    .leftJoin('users as u', 'u.id', 'r.requested_by')
    .leftJoin('purchase_orders as o', 'o.id', 'r.order_id')
    .whereIn('r.site_id', siteIds).orderBy('r.id', 'desc').limit(200)
    .select('r.id', 'r.number', 'r.status', 'r.needed_by', 'r.created_at', 'u.name as requested_name', 'o.id as order_id', 'o.number as order_number',
      db.raw("(SELECT GROUP_CONCAT(i.name ORDER BY l.sort_order SEPARATOR ', ') FROM purchase_request_lines l JOIN items i ON i.id = l.item_id WHERE l.request_id = r.id) AS items"),
      db.raw('(SELECT GROUP_CONCAT(DISTINCT j.number) FROM purchase_request_lines l JOIN jobs j ON j.id = l.job_id WHERE l.request_id = r.id) AS jobs'));
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('r.number', 'like', `%${term}%`)
      .orWhereExists(db('purchase_request_lines as l').join('items as i', 'i.id', 'l.item_id').leftJoin('jobs as j', 'j.id', 'l.job_id').whereRaw('l.request_id = r.id')
        .where((x) => x.where('i.name', 'like', `%${term}%`).orWhere('j.number', 'like', `%${term}%`))));
  } else {
    tabFilter(query, tab);
  }
  return query;
}

export function countByTab(siteIds) {
  return countTabs(TABS, (tab) => { const q = db('purchase_requests as r').whereIn('r.site_id', siteIds); tabFilter(q, tab); return q; });
}

/** The requests this order was made from. */
export const requestsOnOrder = (orderId) => db('purchase_requests').where({ order_id: orderId }).orderBy('id').select('id', 'number');

/** Requests with a line for this job, for its page. */
export function requestsForJob(jobId, siteIds) {
  return db('purchase_requests as r').whereIn('r.site_id', siteIds)
    .whereExists(db('purchase_request_lines as l').whereRaw('l.request_id = r.id').where('l.job_id', jobId))
    .orderBy('r.id', 'desc').select('r.id', 'r.number', 'r.status');
}

/** For the dashboard: waiting for approval, and approved but not yet ordered (one query). */
export function openRequests(siteIds) {
  return db('purchase_requests as r').leftJoin('users as u', 'u.id', 'r.requested_by')
    .whereIn('r.site_id', siteIds).whereIn('r.status', ['pending', 'approved'])
    .orderByRaw('r.needed_by IS NULL, r.needed_by').orderBy('r.id')
    .select('r.id', 'r.number', 'r.status', 'r.needed_by', 'r.created_at', 'u.name as requested_name');
}
