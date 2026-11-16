import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import { config } from '../../config.js';
import { localDay, nextDay, dayStart } from '../../core/dates.js';
import { amountDue } from '../invoices/service.js';
import { materialsForJob } from '../issues/service.js';
import { monthTotal, monthEnd } from './running-costs.js';

// Job costing. What a job earned: its price (without VAT) less what it cost.
//
//   price      the invoice (a draft counts), else the accepted proforma; prices include VAT
//   materials  issued to the job less returns, at the average cost on the day (transport included)
//   work days  Monday to Saturday from the day it started to the day it was completed (today if
//              still open), less the days the workshop was closed (System → Closed days)
//
//   wages      each approved weekly payroll at the job's site, shared across that site's jobs by
//              their work days that week
//   running    each month's running costs at the site (electricity, rent …), shared the same way
//              by work days that month
//
//   gross profit = price − materials;  net profit = gross − wages − running costs

const round = (n) => Math.round(n * 100) / 100;

// ---------- work days ----------

/** Monday to Saturday from `from` to `to` (both 'YYYY-MM-DD', both counted), less the closed days. */
export function workDays(from, to, closed = new Set()) {
  let n = 0;
  for (let day = from; day <= to; day = nextDay(day)) {
    if (new Date(`${day}T12:00:00Z`).getUTCDay() !== 0 && !closed.has(day)) n++;
  }
  return n;
}

/** The days a site was closed between two days: those for every site and those for this one. */
export async function closedBetween(siteId, from, to) {
  const days = await db('closed_days').whereBetween('day', [from, to]).where((w) => w.whereNull('site_id').orWhere('site_id', siteId)).pluck('day');
  return new Set(days);
}

/** A job's work days so far, or null before it starts. */
export async function jobDays(job, today = localDay()) {
  if (!job.started_at) return null;
  const from = localDay(new Date(job.started_at));
  const to = job.completed_at ? localDay(new Date(job.completed_at)) : today;
  if (to < from) return { from, to: from, days: 0, open: !job.completed_at };
  return { from, to, days: workDays(from, to, await closedBetween(job.site_id, from, to)), open: !job.completed_at };
}

// ---------- sharing wages and running costs by work days ----------

const PAYROLL_COUNTED = ['approved', 'paid', 'closed'];
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (day) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));

/** The local days a job ran: start to completion, or to today while open. Null before it starts. */
function spanOf(job, today) {
  if (!job.started_at) return null;
  const from = localDay(new Date(job.started_at));
  const to = job.completed_at ? localDay(new Date(job.completed_at)) : today;
  return { from, to: to < from ? from : to };
}

/** Every job at a site with work days between two days, and how many of them. */
async function jobsBetween(siteId, from, to, today) {
  const rows = await db('jobs').where({ site_id: siteId }).whereNot('status', 'cancelled').whereNotNull('started_at')
    .where('started_at', '<', dayStart(nextDay(to)))
    .where((w) => w.whereNull('completed_at').orWhere('completed_at', '>=', dayStart(from)))
    .select('id', 'started_at', 'completed_at');
  const closed = await closedBetween(siteId, from, to);
  const days = new Map();
  for (const job of rows) {
    const s = spanOf(job, today);
    const a = s.from > from ? s.from : from;
    const b = s.to < to ? s.to : to;
    if (a <= b) days.set(job.id, workDays(a, b, closed));
  }
  return days;
}

/**
 * Shares of wages (by week) and running costs (by month), worked out once per site and period
 * and reused for every job (the report asks for many).
 */
export function makeShares(today = localDay()) {
  const cache = new Map();

  /** A period's cost at a site and the job days it is shared over. kind: 'week' (a Monday) | 'month' ('YYYY-MM'). */
  async function period(kind, siteId, key) {
    const id = `${kind}|${siteId}|${key}`;
    if (!cache.has(id)) {
      cache.set(id, (async () => {
        const [from, to] = kind === 'month' ? [`${key}-01`, monthEnd(key)] : [key, addDays(key, 5)];
        let total;
        if (kind === 'month') total = await monthTotal(db, siteId, key);
        else {
          const row = await db('payrolls').where({ site_id: siteId, week_start: key }).whereIn('status', PAYROLL_COUNTED).count({ n: '*' }).sum({ total: 'total' }).first();
          total = Number(row.n) ? Number(row.total) : null;
        }
        const jobs = await jobsBetween(siteId, from, to, today);
        const days = [...jobs.values()].reduce((n, d) => n + d, 0);
        return { kind, key, from, to, total, jobs, days, perDay: total !== null && days ? total / days : null };
      })());
    }
    return cache.get(id);
  }

  /** A job's share of wages and running costs, with the periods that have nothing entered yet. */
  async function forJob(job) {
    const s = spanOf(job, today);
    if (!s) return null;
    const wages = { amount: 0, missing: [] };
    const running = { amount: 0, missing: [] };
    for (let week = mondayOf(s.from); week <= s.to; week = addDays(week, 7)) {
      const p = await period('week', job.site_id, week);
      const days = p.jobs.get(job.id) ?? 0;
      if (!days) continue;
      if (p.total === null) wages.missing.push(week);
      else wages.amount += days * p.perDay;
    }
    for (let month = s.from.slice(0, 7); month <= s.to.slice(0, 7); month = nextMonth(month)) {
      const p = await period('month', job.site_id, month);
      const days = p.jobs.get(job.id) ?? 0;
      if (!days) continue;
      if (p.total === null) running.missing.push(month);
      else running.amount += days * p.perDay;
    }
    wages.amount = round(wages.amount);
    running.amount = round(running.amount);
    return { wages, running };
  }

  return { period, forJob };
}
const nextMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);

// ---------- a job ----------

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * What the job earned so far. `shares` (makeShares) is passed in when costing many jobs.
 * @returns {Promise<{ price: { total: number, exVat: number, against: string } | null, materials: number,
 *   wages: { amount: number, missing: string[] } | null, running: { amount: number, missing: string[] } | null,
 *   gross: number | null, margin: number | null, net: number | null, netMargin: number | null, days: object | null }>}
 */
export async function jobCosting(job, shares = makeShares()) {
  const due = await amountDue(job.id);
  const price = due ? { total: due.total, exVat: round(due.total / (1 + config.vatRate / 100)), against: due.against } : null;
  const materials = round((await materialsForJob(job.id)).total);
  const share = await shares.forJob(job);
  const gross = price ? round(price.exVat - materials) : null;
  const net = gross !== null && share ? round(gross - share.wages.amount - share.running.amount) : gross;
  return {
    price, materials, wages: share?.wages ?? null, running: share?.running ?? null,
    gross, margin: price ? pct(gross, price.exVat) : null,
    net, netMargin: price ? pct(net, price.exVat) : null,
    days: await jobDays(job),
  };
}

// ---------- closed days (System → Closed days) ----------

export function listClosedDays() {
  return db('closed_days as d').leftJoin('sites as s', 's.id', 'd.site_id').leftJoin('users as u', 'u.id', 'd.created_by')
    .orderBy('d.day', 'desc').select('d.id', 'd.day', 'd.site_id', 'd.reason', 's.name as site_name', 'u.name as created_by_name');
}

/** @param {{ day: string, site_id: number|null, reason: string }} input */
export async function addClosedDay(input, actor) {
  return db.transaction(async (trx) => {
    const same = await trx('closed_days').where({ day: input.day })
      .where((w) => (input.site_id ? w.whereNull('site_id').orWhere('site_id', input.site_id) : w)).first('id', 'site_id');
    if (same) {
      const message = same.site_id === null ? 'That day is already closed at every site.' : input.site_id ? 'That day is already closed at that site.' : 'That day is already closed at one site. Remove that first to close every site.';
      throw Object.assign(httpError(422, message), { field: 'day' });
    }
    const [id] = await trx('closed_days').insert({ ...input, created_by: actor.user.id });
    await audit(trx, actor, { entity: 'closed_day', id, action: 'create', summary: `${input.day}: ${input.reason}` });
    return id;
  });
}

export async function removeClosedDay(id, actor) {
  await db.transaction(async (trx) => {
    const row = await trx('closed_days').where({ id }).first();
    if (!row) throw httpError(404, 'That closed day has already been removed.');
    await trx('closed_days').where({ id }).delete();
    await audit(trx, actor, { entity: 'closed_day', id, action: 'delete', summary: `${row.day}: ${row.reason}` });
  });
}

// ---------- the report: jobs completed in a month, or in progress now ----------

/**
 * @param {{ month: string, siteIds: number[], tab: 'completed'|'open' }} opts
 * @returns {Promise<{ jobs: object[], totals: object }>}
 */
export async function report({ month, siteIds, tab }) {
  const q = db('jobs as j').join('customers as c', 'c.id', 'j.customer_id').join('sites as s', 's.id', 'j.site_id')
    .leftJoin('job_types as jt', 'jt.id', 'j.job_type_id')
    .whereIn('j.site_id', siteIds).orderBy('j.id').limit(500)
    .select('j.id', 'j.number', 'j.status', 'j.site_id', 'j.started_at', 'j.completed_at', 'c.name as customer_name', 's.name as site_name', 'jt.name as job_type_name');
  if (tab === 'open') q.where('j.status', 'in_progress');
  else q.where('j.status', 'completed').where('j.completed_at', '>=', dayStart(`${month}-01`)).where('j.completed_at', '<', dayStart(nextDay(monthEnd(month))));
  const rows = await q;
  const shares = makeShares();
  const jobs = [];
  for (const job of rows) jobs.push({ ...job, costing: await jobCosting(job, shares) });
  const sum = (f) => round(jobs.reduce((n, j) => n + (f(j.costing) ?? 0), 0));
  const priced = jobs.filter((j) => j.costing.price);
  const totals = {
    price: sum((c) => c.price?.exVat), materials: sum((c) => c.materials), wages: sum((c) => c.wages?.amount),
    running: sum((c) => c.running?.amount), net: round(priced.reduce((n, j) => n + j.costing.net, 0)),
    unpriced: jobs.length - priced.length,
    incomplete: jobs.filter((j) => j.costing.wages?.missing.length || j.costing.running?.missing.length).length,
  };
  totals.margin = pct(totals.net, totals.price);
  return { jobs, totals };
}
