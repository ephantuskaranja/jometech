import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import { config } from '../../config.js';
import { localDay, nextDay } from '../../core/dates.js';
import { amountDue } from '../invoices/service.js';
import { materialsForJob } from '../issues/service.js';

// Job costing. What a job earned: its price (without VAT) less what it cost.
//
//   price      the invoice (a draft counts), else the accepted proforma; prices include VAT
//   materials  issued to the job less returns, at the average cost on the day (transport included)
//   work days  Monday to Saturday from the day it started to the day it was completed (today if
//              still open), less the days the workshop was closed (System → Closed days)
//
// Running costs and wages are shared out by work days (next).

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

// ---------- a job ----------

/**
 * What the job earned so far.
 * @returns {Promise<{ price: { total: number, exVat: number, against: string } | null, materials: number,
 *   gross: number | null, margin: number | null, days: object | null }>}
 */
export async function jobCosting(job) {
  const due = await amountDue(job.id);
  const price = due ? { total: due.total, exVat: round(due.total / (1 + config.vatRate / 100)), against: due.against } : null;
  const materials = round((await materialsForJob(job.id)).total);
  const gross = price ? round(price.exVat - materials) : null;
  return {
    price, materials, gross,
    margin: price && price.exVat > 0 ? Math.round((gross / price.exVat) * 1000) / 10 : null,
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
