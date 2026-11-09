import { db } from '../../core/db.js';
import { dayStart, isDay, localDay, nextDay } from '../../core/dates.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { forPeriod as moneyFor } from '../invoices/service.js';
import { PURPOSES, purposeLabel } from '../checkins/service.js';

// Period summary for admins and managers: what happened between two days, at one
// site or all. "Now" figures (overdue jobs, low stock, orders waiting) are today's
// position whatever the period, and are labelled so.

export const PERIODS = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  month: 'This month',
  last_month: 'Last month',
  custom: 'Choose dates',
};
const MAX_DAYS = 366;

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The period asked for in the query string; anything odd falls back to today.
 * Weeks start on Monday. A chosen range stops at today and is at most a year.
 * @returns {{ key: string, from: string, to: string, start: Date, end: Date }} end is the moment after the last day
 */
export function periodOf(query, today = localDay()) {
  const key = Object.hasOwn(PERIODS, query.period) ? query.period : 'today';
  let from = today;
  let to = today;
  if (key === 'yesterday') from = to = addDays(today, -1);
  if (key === 'week') from = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  if (key === 'month') from = `${today.slice(0, 8)}01`;
  if (key === 'last_month') {
    to = addDays(`${today.slice(0, 8)}01`, -1);
    from = `${to.slice(0, 8)}01`;
  }
  if (key === 'custom') {
    const a = isDay(query.from) && query.from <= today ? query.from : today;
    const b = isDay(query.to) && query.to <= today ? query.to : today;
    [from, to] = a <= b ? [a, b] : [b, a];
    if (daysFrom(from, to) >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  }
  return { key, from, to, start: dayStart(from), end: dayStart(nextDay(to)) };
}

/** What each job history entry means in the summary. */
export const JOB_CHANGES = {
  create: 'New job',
  job_started: 'Started',
  step_done: 'Step done',
  step_skipped: 'Step skipped',
  step_undone: 'Step undone',
  job_completed: 'Completed',
  job_cancelled: 'Cancelled',
  reopened: 'Reopened',
  job_moved: 'Moved site',
};
const CHANGE_LIMIT = 500;

const num = Number;
const sum = (rows, f) => rows.reduce((t, r) => t + num(f(r) ?? 0), 0);
const atSite = (q, column, siteId) => (siteId ? q.where(column, siteId) : q);
const inPeriod = (q, column, p) => q.where(column, '>=', p.start).where(column, '<', p.end);
const onDays = (q, column, p) => q.whereBetween(column, [p.from, p.to]);
/** `vehicle`: its reg, chassis or tag number (`plate` true), or the description typed on the job. */
const withVehicle = (r) => {
  const plate = Boolean(r.reg_no || r.chassis_no || r.temp_tag);
  return { ...r, plate, vehicle: plate ? vehicleLabel(r) : (r.vehicle_description ?? null) };
};
const VEHICLE = ['v.reg_no', 'v.chassis_no', 'v.temp_tag'];

/** How much of an item: "2 × 8x4ft" for plates, "4 Pc" otherwise. */
const amountOf = (r) => (r.priced_by === 'area' ? `${num(r.quantity)} × ${r.size_key}` : `${num(r.quantity)} ${r.unit}`);

async function jobs(p, siteId, today) {
  const jobQuery = () => db('jobs as j').join('customers as c', 'c.id', 'j.customer_id').leftJoin('vehicles as v', 'v.id', 'j.vehicle_id');
  const changes = await atSite(inPeriod(jobQuery().join('audit_log as a', function () {
    this.on('a.entity_id', 'j.id').andOnVal('a.entity', 'job');
  }), 'a.created_at', p), 'j.site_id', siteId)
    .whereIn('a.action', Object.keys(JOB_CHANGES))
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .orderBy('a.id', 'desc').limit(CHANGE_LIMIT + 1)
    .select('a.created_at', 'a.action', 'a.summary', 'u.name as user_name', 'j.id', 'j.number', 'j.vehicle_description', 'c.name as customer_name', ...VEHICLE);

  const started = await atSite(inPeriod(db('jobs'), 'started_at', p), 'site_id', siteId).count({ n: '*' });
  const created = await atSite(inPeriod(db('jobs'), 'created_at', p), 'site_id', siteId).count({ n: '*' });

  const completed = (await atSite(inPeriod(jobQuery(), 'j.completed_at', p), 'j.site_id', siteId)
    .where('j.status', 'completed').orderBy('j.completed_at', 'desc')
    .select('j.id', 'j.number', 'j.vehicle_description', 'j.created_at', 'j.started_at', 'j.completed_at', 'j.due_on', 'c.name as customer_name', ...VEHICLE))
    .map((j) => {
      const doneOn = localDay(j.completed_at);
      return { ...withVehicle(j), days: daysFrom(localDay(j.started_at ?? j.created_at), doneOn), late: j.due_on ? doneOn > j.due_on : null };
    });

  const overdue = (await atSite(jobQuery(), 'j.site_id', siteId)
    .whereIn('j.status', ['open', 'in_progress']).where('j.due_on', '<', today).orderBy('j.due_on')
    .select('j.id', 'j.number', 'j.status', 'j.vehicle_description', 'j.due_on', 'c.name as customer_name', ...VEHICLE,
      db('job_steps').whereRaw('job_steps.job_id = j.id').where('status', 'pending').orderBy('sort_order').limit(1).select('name').as('current_step')))
    .map((j) => ({ ...withVehicle(j), daysLate: daysFrom(j.due_on, today) }));

  return {
    changes: changes.slice(0, CHANGE_LIMIT).map(withVehicle),
    changesCut: changes.length > CHANGE_LIMIT,
    started: num(started[0].n),
    created: num(created[0].n),
    completed,
    overdue,
  };
}

async function stores(p, siteId) {
  // Issued in the period (by the issue's date), less what came back in the period. Opening stock isn't a cost.
  const issued = await atSite(onDays(db('material_issue_lines as l').join('material_issues as m', 'm.id', 'l.issue_id'), 'm.issued_on', p), 'm.site_id', siteId)
    .join('items as i', 'i.id', 'l.item_id')
    .orderBy('m.issued_on').orderBy('l.id')
    .select('m.job_id', 'i.id as item_id', 'i.name as item_name', 'i.priced_by', 'i.unit', 'l.size_key', 'l.quantity', 'l.value');
  const returned = await atSite(inPeriod(db('stock_movements as sm'), 'sm.created_at', p), 'sm.site_id', siteId)
    .where('sm.type', 'return').select('sm.job_id', 'sm.value');

  const jobIds = [...new Set([...issued, ...returned].map((r) => r.job_id).filter(Boolean))];
  const jobRows = jobIds.length ? await db('jobs as j').join('customers as c', 'c.id', 'j.customer_id').leftJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .whereIn('j.id', jobIds).select('j.id', 'j.number', 'j.vehicle_description', 'c.name as customer_name', ...VEHICLE) : [];
  const byJob = new Map(jobRows.map((j) => [j.id, { ...withVehicle(j), lines: [], issuedValue: 0, returnedValue: 0 }]));
  for (const l of issued) {
    const job = byJob.get(l.job_id);
    job.lines.push({ item_id: l.item_id, name: l.item_name, amount: amountOf(l), value: num(l.value) });
    job.issuedValue += num(l.value);
  }
  for (const r of returned) if (byJob.has(r.job_id)) byJob.get(r.job_id).returnedValue += num(r.value);
  const issuedToJobs = [...byJob.values()].map((j) => ({ ...j, net: j.issuedValue - j.returnedValue })).sort((a, b) => b.net - a.net);

  const received = await atSite(onDays(db('goods_receipts as g'), 'g.received_on', p), 'g.site_id', siteId)
    .join('purchase_orders as po', 'po.id', 'g.order_id').join('suppliers as s', 's.id', 'po.supplier_id')
    .orderBy('g.received_on').orderBy('g.id')
    .select('g.id', 'g.number', 'g.received_on', 'g.goods_total', 'g.transport_cost', 'g.reversed_at', 'po.id as order_id', 'po.number as order_number', 's.name as supplier_name');
  for (const g of received) g.value = num(g.goods_total) + num(g.transport_cost);

  const priceRises = (await atSite(onDays(db('goods_receipt_lines as l').join('goods_receipts as g', 'g.id', 'l.receipt_id'), 'g.received_on', p), 'g.site_id', siteId)
    .whereNull('g.reversed_at').where('l.previous_price', '>', 0).whereRaw('`l`.`unit_price` >= `l`.`previous_price` * 1.1')
    .join('items as i', 'i.id', 'l.item_id')
    .select('i.id as item_id', 'i.name as item_name', 'i.unit', 'l.previous_price', 'l.unit_price', 'g.id as receipt_id', 'g.number as receipt_number', 'g.received_on'))
    .map((r) => ({ ...r, rise: (num(r.unit_price) / num(r.previous_price) - 1) * 100 }))
    .sort((a, b) => b.rise - a.rise);

  const lowStock = await db('items').where({ is_active: true }).whereNotNull('reorder_level').whereRaw('`on_hand_qty` <= `reorder_level`')
    .orderBy('name').select('id', 'name', 'unit', 'on_hand_qty', 'reorder_level');

  const ordersWaiting = await atSite(db('purchase_orders as po'), 'po.site_id', siteId)
    .where('po.status', 'pending').join('suppliers as s', 's.id', 'po.supplier_id')
    .select('po.id', 'po.number', 'po.total', 'po.updated_at', 's.name as supplier_name',
      db('audit_log').whereRaw('audit_log.entity_id = po.id').where({ entity: 'purchase_order', action: 'po_submitted' }).max('created_at').as('submitted_at'))
    .orderBy('po.id');

  return {
    issuedToJobs,
    issuedValue: sum(issuedToJobs, (j) => j.net),
    received,
    receivedValue: sum(received.filter((g) => !g.reversed_at), (g) => g.value),
    priceRises,
    lowStock,
    ordersWaiting: ordersWaiting.map((o) => ({ ...o, waitingSince: o.submitted_at ?? o.updated_at })),
  };
}

async function frontOffice(p, siteId) {
  const checkins = (column) => atSite(inPeriod(db('checkins as k'), `k.${column}`, p), 'k.site_id', siteId)
    .whereNot('k.status', 'cancelled')
    .join('vehicles as v', 'v.id', 'k.vehicle_id').join('customers as c', 'c.id', 'k.customer_id')
    .orderBy(`k.${column}`)
    .select('k.id', 'k.number', 'k.purpose', `k.${column} as at`, 'c.name as customer_name', ...VEHICLE)
    .then((rows) => rows.map((r) => ({ ...withVehicle(r), purpose: purposeLabel(r.purpose) })));
  const checkedIn = await checkins('checked_in_at');
  // Check-ins per purpose, in the list's order; those from before purposes were asked come last.
  const byPurpose = [...PURPOSES.map((p) => p.label), null]
    .map((label) => ({ purpose: label ?? 'Not recorded', n: checkedIn.filter((k) => k.purpose === label).length }))
    .filter((p) => p.n);

  const movements = await inPeriod(db('vehicle_movements as m'), 'm.sent_at', p)
    .modify((q) => siteId && q.where((w) => w.where('m.from_site_id', siteId).orWhere('m.to_site_id', siteId)))
    .whereNot('m.status', 'cancelled')
    .join('vehicles as v', 'v.id', 'm.vehicle_id').join('sites as f', 'f.id', 'm.from_site_id').join('sites as t', 't.id', 'm.to_site_id')
    .orderBy('m.sent_at')
    .select('m.id', 'm.checkin_id', 'm.number', 'm.status', 'm.sent_at', 'f.name as from_site', 't.name as to_site', ...VEHICLE);

  const proformas = (column, where) => atSite(inPeriod(db('proformas as pf'), `pf.${column}`, p), 'pf.site_id', siteId)
    .modify(where).join('customers as c', 'c.id', 'pf.customer_id')
    .orderBy(`pf.${column}`)
    .select('pf.id', 'pf.number', 'pf.total', `pf.${column} as at`, 'c.name as customer_name');
  const sent = await proformas('sent_at', () => {});
  const accepted = await proformas('closed_at', (q) => q.where('pf.status', 'accepted'));
  const declined = await proformas('closed_at', (q) => q.where('pf.status', 'declined'));

  const enquiries = await atSite(inPeriod(db('enquiries'), 'created_at', p), 'site_id', siteId)
    .groupBy('work_type').orderBy('n', 'desc').select('work_type').count({ n: '*' });
  const closed = await atSite(inPeriod(db('enquiries'), 'closed_at', p), 'site_id', siteId)
    .whereIn('status', ['won', 'lost']).groupBy('status').select('status').count({ n: '*' });
  const closedCount = (status) => num(closed.find((c) => c.status === status)?.n ?? 0);

  return {
    checkedIn,
    byPurpose,
    checkedOut: await checkins('checked_out_at'),
    movements: movements.map(withVehicle),
    proformas: {
      sent, accepted, declined,
      sentValue: sum(sent, (r) => r.total),
      acceptedValue: sum(accepted, (r) => r.total),
    },
    enquiries: {
      byWorkType: enquiries.map((e) => ({ work_type: e.work_type, n: num(e.n) })),
      count: sum(enquiries, (e) => e.n),
      won: closedCount('won'),
      lost: closedCount('lost'),
    },
  };
}

/** Everything on the summary page for one period, at one site (siteId) or all (null). */
export async function summary(p, siteId = null, today = localDay()) {
  const [j, s, f, m] = [await jobs(p, siteId, today), await stores(p, siteId), await frontOffice(p, siteId), await moneyFor(p, siteId)];
  return { jobs: j, stores: s, front: f, money: m };
}
