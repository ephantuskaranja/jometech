import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { STATUSES as ATTENDANCE, firstPunchSites } from '../attendance/service.js';

// Weekly payroll: one per site per week, Monday to Saturday, paid on the Saturday. Staff criss-cross the
// sites: each day is recorded where it was worked, and a person is paid once, on their home site's payroll.
//
//   draft ──"Days are right"──▶ checked ──"Approve"──▶ approved (locked) ──every slip paid──▶ paid ──▶ closed
//
// Wages are days × daily rate (present 1, half day ½, anything else 0) from CONFIRMED attendance,
// plus or minus adjustments with a reason. No statutory deductions (agreed with Jome-Tech).

export const STATUSES = {
  draft: { label: 'Draft', tone: 'neutral' },
  checked: { label: 'Checked', tone: 'info' },
  approved: { label: 'Approved', tone: 'info' },
  paid: { label: 'Paid', tone: 'ok' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export const METHODS = { mpesa: 'M-Pesa', cash: 'Cash', bank: 'Bank' };

const round = (n) => Math.round(n * 100) / 100;
const kes = (n) => `KES ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const err = (status, message, field) => Object.assign(httpError(status, message), { field });

// ---------- weeks ----------

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The Monday of the week a day falls in. */
export function weekStartOf(day) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** Monday to Saturday of a week, and its pay day (the Saturday). */
export function weekDays(weekStart) {
  const days = Array.from({ length: 6 }, (_, i) => addDays(weekStart, i));
  return { days, payDay: days[5], weekEnd: days[5] };
}

/** Which of the week's days are confirmed at the site (payroll needs all six). */
export async function confirmedDays(siteId, weekStart, trx = db) {
  const { days } = weekDays(weekStart);
  const done = new Set(await trx('attendance_confirmations').where({ site_id: siteId }).whereIn('day', days).pluck('day'));
  return days.map((day) => ({ day, confirmed: done.has(day) }));
}

// ---------- working out the slips ----------

/**
 * Days at OTHER sites that this site's staff worked and that aren't confirmed yet: its payroll waits for them.
 * A day belongs to where it was saved, or before that to the site of the first punch (see attendance/service.js).
 * @returns {Promise<{ day: string, site_id: number, site_name: string }[]>}
 */
export async function waitingOnOtherSites(siteId, weekStart, trx = db) {
  const { days } = weekDays(weekStart);
  const staff = await trx('employees').where({ site_id: siteId }).pluck('id');
  const saved = await trx('attendance_days').whereIn('employee_id', staff).whereIn('day', days).select('employee_id', 'day', 'site_id');
  const owners = new Map(await firstPunchSites(trx, staff, days));
  for (const s of saved) owners.set(`${s.employee_id}|${s.day}`, s.site_id);
  const needed = new Map();
  for (const [key, owner] of owners) {
    if (owner !== siteId) needed.set(`${owner}|${key.split('|')[1]}`, { site_id: owner, day: key.split('|')[1] });
  }
  if (!needed.size) return [];
  const sites = await trx('sites').select('id', 'name');
  const done = new Set((await trx('attendance_confirmations').whereIn('day', days).select('site_id', 'day')).map((c) => `${c.site_id}|${c.day}`));
  return [...needed.entries()].filter(([key]) => !done.has(key))
    .map(([, n]) => ({ ...n, site_name: sites.find((x) => x.id === n.site_id)?.name }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Refuses unless the site's six days, and its staff's days at other sites, are all confirmed. */
async function requireConfirmed(trx, siteId, weekStart) {
  const missing = (await confirmedDays(siteId, weekStart, trx)).filter((d) => !d.confirmed);
  if (missing.length) throw httpError(409, `Confirm every day of the week in Attendance first. Not confirmed yet: ${missing.map((d) => d.day).join(', ')}.`);
  const others = await waitingOnOtherSites(siteId, weekStart, trx);
  if (others.length) throw httpError(409, `Some of your staff worked at another site. Waiting for it to confirm: ${others.map((o) => `${o.site_name} ${o.day}`).join(', ')}.`);
}

/**
 * Everyone whose home site this is, with what they worked that week at ANY site: one payslip per person.
 * Someone already on another payroll that week (their home site changed) stays there, so nobody is paid twice.
 */
async function workedOut(trx, siteId, weekStart, exceptPayrollId = null) {
  const { days } = weekDays(weekStart);
  const rows = await trx('attendance_days as a').join('employees as e', 'e.id', 'a.employee_id').join('sites as s', 's.id', 'a.site_id')
    .where('e.site_id', siteId).whereIn('a.day', days)
    .select('a.employee_id', 'a.day', 'a.status', 'e.daily_rate', 's.name as site_name');
  const elsewhere = trx('payslips as sl').join('payrolls as pr', 'pr.id', 'sl.payroll_id').where('pr.week_start', weekStart);
  if (exceptPayrollId) elsewhere.whereNot('pr.id', exceptPayrollId);
  const onAnother = new Set(await elsewhere.pluck('sl.employee_id'));
  const people = new Map();
  for (const r of rows) {
    if (onAnother.has(r.employee_id)) continue;
    const p = people.get(r.employee_id) ?? { employee_id: r.employee_id, daily_rate: r.daily_rate === null ? null : Number(r.daily_rate), detail: {}, days: 0 };
    p.detail[r.day] = { status: r.status, site: r.site_name };
    p.days += ATTENDANCE[r.status]?.days ?? 0;
    people.set(r.employee_id, p);
  }
  return [...people.values()].filter((p) => p.days > 0);
}

/** Recomputes a slip's base and net from its days, rate and adjustments. */
async function settle(trx, slipId) {
  const slip = await trx('payslips').where({ id: slipId }).first('days', 'daily_rate');
  const [{ adj }] = await trx('payslip_adjustments').where({ payslip_id: slipId }).select(trx.raw('COALESCE(SUM(amount), 0) as adj'));
  const base = slip.daily_rate === null ? 0 : round(Number(slip.days) * Number(slip.daily_rate));
  await trx('payslips').where({ id: slipId }).update({ base, adjustments: Number(adj), net: round(base + Number(adj)) });
}

async function settlePayroll(trx, payrollId) {
  const [{ total }] = await trx('payslips').where({ payroll_id: payrollId }).select(trx.raw('COALESCE(SUM(net), 0) as total'));
  await trx('payrolls').where({ id: payrollId }).update({ total: Number(total) });
}

async function writeSlips(trx, payrollId, people) {
  for (const p of people) {
    const values = { days: p.days, days_detail: JSON.stringify(p.detail), daily_rate: p.daily_rate };
    await trx('payslips').insert({ payroll_id: payrollId, employee_id: p.employee_id, ...values }).onConflict(['payroll_id', 'employee_id']).merge(values);
    const slip = await trx('payslips').where({ payroll_id: payrollId, employee_id: p.employee_id }).first('id');
    await settle(trx, slip.id);
  }
}

async function load(trx, payrollId, statuses) {
  const p = await trx('payrolls').where({ id: payrollId }).forUpdate().first();
  if (!p) throw httpError(404, 'That payroll doesn’t exist.');
  if (statuses && !statuses.includes(p.status)) throw httpError(409, `${p.number} is ${STATUSES[p.status].label.toLowerCase()}, so that can’t be done now.`);
  return p;
}

/** @returns {Promise<{ id: number, number: string }>} */
export async function preparePayroll(siteId, weekStart, actor) {
  return db.transaction(async (trx) => {
    if (await trx('payrolls').where({ site_id: siteId, week_start: weekStart }).first('id')) throw httpError(409, 'This week already has a payroll.');
    await requireConfirmed(trx, siteId, weekStart);
    const people = await workedOut(trx, siteId, weekStart);
    if (!people.length) throw httpError(409, 'None of this site’s staff worked that week.');
    const { payDay } = weekDays(weekStart);
    const number = await nextNumber(trx, 'payroll', new Date(`${payDay}T12:00:00Z`));
    const [id] = await trx('payrolls').insert({ number, site_id: siteId, week_start: weekStart, pay_day: payDay, prepared_by: actor.user.id });
    await writeSlips(trx, id, people);
    await settlePayroll(trx, id);
    await audit(trx, actor, { entity: 'payroll', id, action: 'create', summary: `${number}: ${people.length} people, week of ${weekStart}` });
    return { id, number };
  });
}

/** After attendance was reopened and changed: days and rates again; adjustments stay. Draft only. */
export async function recalculate(payrollId, actor) {
  await db.transaction(async (trx) => {
    const p = await load(trx, payrollId, ['draft']);
    await requireConfirmed(trx, p.site_id, p.week_start);
    const people = await workedOut(trx, p.site_id, p.week_start, payrollId);
    await writeSlips(trx, payrollId, people);
    // Someone no longer on it: kept only if they have adjustments (then at 0 days).
    const keep = new Set(people.map((x) => x.employee_id));
    for (const slip of await trx('payslips').where({ payroll_id: payrollId }).select('id', 'employee_id')) {
      if (keep.has(slip.employee_id)) continue;
      const hasAdj = await trx('payslip_adjustments').where({ payslip_id: slip.id }).first('id');
      if (hasAdj) {
        await trx('payslips').where({ id: slip.id }).update({ days: 0, days_detail: '{}' });
        await settle(trx, slip.id);
      } else {
        await trx('payslips').where({ id: slip.id }).delete();
      }
    }
    await settlePayroll(trx, payrollId);
    await audit(trx, actor, { entity: 'payroll', id: payrollId, action: 'recalculated', summary: 'Worked out again from attendance' });
  });
}

// ---------- adjustments ----------

export async function addAdjustment(slipId, { amount, reason }, actor) {
  await db.transaction(async (trx) => {
    const slip = await trx('payslips as s').join('employees as e', 'e.id', 's.employee_id').where('s.id', slipId).first('s.id', 's.payroll_id', 'e.name');
    if (!slip) throw httpError(404, 'That payslip doesn’t exist.');
    await load(trx, slip.payroll_id, ['draft', 'checked']);
    await trx('payslip_adjustments').insert({ payslip_id: slipId, amount, reason, created_by: actor.user.id });
    await settle(trx, slipId);
    await settlePayroll(trx, slip.payroll_id);
    await audit(trx, actor, { entity: 'payroll', id: slip.payroll_id, action: 'adjusted', summary: `${slip.name}: ${amount > 0 ? '+' : ''}${kes(amount)} (${reason})` });
  });
}

export async function removeAdjustment(adjustmentId, actor) {
  await db.transaction(async (trx) => {
    const a = await trx('payslip_adjustments as a').join('payslips as s', 's.id', 'a.payslip_id').join('employees as e', 'e.id', 's.employee_id')
      .where('a.id', adjustmentId).first('a.id', 'a.amount', 'a.reason', 'a.payslip_id', 's.payroll_id', 'e.name');
    if (!a) throw httpError(404, 'That adjustment doesn’t exist.');
    await load(trx, a.payroll_id, ['draft', 'checked']);
    await trx('payslip_adjustments').where({ id: adjustmentId }).delete();
    await settle(trx, a.payslip_id);
    await settlePayroll(trx, a.payroll_id);
    await audit(trx, actor, { entity: 'payroll', id: a.payroll_id, action: 'adjusted', summary: `${a.name}: removed ${kes(a.amount)} (${a.reason})` });
  });
}

// ---------- the steps ----------

/** The supervisor confirms the days are right (they see days, not money). */
export async function markChecked(payrollId, actor) {
  await db.transaction(async (trx) => {
    await load(trx, payrollId, ['draft']);
    await trx('payrolls').where({ id: payrollId }).update({ status: 'checked', checked_at: trx.fn.now(), checked_by: actor.user.id });
    await audit(trx, actor, { entity: 'payroll', id: payrollId, action: 'payroll_checked', summary: 'Days checked' });
  });
}

/** Back to draft, to work it out again (after attendance was corrected). */
export async function backToDraft(payrollId, actor) {
  await db.transaction(async (trx) => {
    await load(trx, payrollId, ['checked']);
    await trx('payrolls').where({ id: payrollId }).update({ status: 'draft', checked_at: null, checked_by: null });
    await audit(trx, actor, { entity: 'payroll', id: payrollId, action: 'payroll_reopened', summary: 'Back to draft' });
  });
}

/** Locks it. Everyone must have a daily rate and nobody can be owed less than nothing. */
export async function approve(payrollId, actor) {
  await db.transaction(async (trx) => {
    const p = await load(trx, payrollId, ['checked']);
    const slips = await trx('payslips as s').join('employees as e', 'e.id', 's.employee_id').where('s.payroll_id', payrollId).select('e.name', 's.daily_rate', 's.net');
    const noRate = slips.filter((s) => s.daily_rate === null);
    if (noRate.length) throw httpError(422, `Add a daily rate first (Employees): ${noRate.map((s) => s.name).join(', ')}. Then put the payroll back to draft and work it out again.`);
    const negative = slips.filter((s) => Number(s.net) < 0);
    if (negative.length) throw httpError(422, `Pay can’t be below zero: ${negative.map((s) => s.name).join(', ')}. Reduce their deductions.`);
    await trx('payrolls').where({ id: payrollId }).update({ status: 'approved', approved_at: trx.fn.now(), approved_by: actor.user.id });
    await audit(trx, actor, { entity: 'payroll', id: payrollId, action: 'payroll_approved', summary: `Approved: ${kes(p.total)}` });
  });
}

/** One person paid, or (slipId null) everyone not yet paid. When nobody is left, the payroll is paid. */
export async function markPaid(payrollId, slipId, { method, reference }, actor) {
  await db.transaction(async (trx) => {
    await load(trx, payrollId, ['approved']);
    const q = trx('payslips').where({ payroll_id: payrollId }).whereNull('paid_at');
    if (slipId) q.where({ id: slipId });
    const n = await q.update({ paid_at: trx.fn.now(), paid_method: method, paid_reference: reference, paid_by: actor.user.id });
    if (!n) throw httpError(409, slipId ? 'That payslip is already paid.' : 'Everyone is already paid.');
    const left = await trx('payslips').where({ payroll_id: payrollId }).whereNull('paid_at').first('id');
    if (!left) await trx('payrolls').where({ id: payrollId }).update({ status: 'paid' });
    await audit(trx, actor, { entity: 'payroll', id: payrollId, action: 'payroll_paid', summary: `${n} ${n === 1 ? 'person' : 'people'} paid by ${METHODS[method]}${reference ? ` (${reference})` : ''}` });
  });
}

export async function close(payrollId, actor) {
  await db.transaction(async (trx) => {
    await load(trx, payrollId, ['paid']);
    await trx('payrolls').where({ id: payrollId }).update({ status: 'closed', closed_at: trx.fn.now(), closed_by: actor.user.id });
    await audit(trx, actor, { entity: 'payroll', id: payrollId, action: 'payroll_closed', summary: 'Closed' });
  });
}

// ---------- reading ----------

export async function getPayroll(id) {
  const p = await db('payrolls as p').join('sites as s', 's.id', 'p.site_id')
    .leftJoin('users as pu', 'pu.id', 'p.prepared_by').leftJoin('users as cu', 'cu.id', 'p.checked_by').leftJoin('users as au', 'au.id', 'p.approved_by')
    .where('p.id', id)
    .first('p.*', 's.name as site_name', 'pu.name as prepared_by_name', 'cu.name as checked_by_name', 'au.name as approved_by_name');
  if (!p) return null;
  p.days = weekDays(p.week_start).days;
  p.slips = await db('payslips as sl').join('employees as e', 'e.id', 'sl.employee_id').leftJoin('users as u', 'u.id', 'sl.paid_by')
    .where('sl.payroll_id', id).orderBy('e.name')
    .select('sl.*', 'e.name', 'e.number as employee_number', 'e.trade', 'e.phone', 'e.mpesa_phone', 'u.name as paid_by_name');
  const adjustments = await db('payslip_adjustments').whereIn('payslip_id', p.slips.map((s) => s.id)).orderBy('id');
  for (const s of p.slips) {
    const stored = JSON.parse(s.days_detail || '{}');
    s.detail = Object.fromEntries(Object.entries(stored).map(([day, d]) => [day, d.status]));
    // Only the days worked at another site need saying.
    s.worked_at = Object.fromEntries(Object.entries(stored).filter(([, d]) => d.site !== p.site_name).map(([day, d]) => [day, d.site]));
    s.adjustment_lines = adjustments.filter((a) => a.payslip_id === s.id);
  }
  p.paidCount = p.slips.filter((s) => s.paid_at).length;
  return p;
}

export function listPayrolls(siteIds) {
  return db('payrolls as p').join('sites as s', 's.id', 'p.site_id').whereIn('p.site_id', siteIds)
    .orderBy('p.week_start', 'desc').orderBy('s.name').limit(100)
    .select('p.id', 'p.number', 'p.week_start', 'p.pay_day', 'p.status', 'p.total', 's.name as site_name',
      db('payslips').whereRaw('payroll_id = p.id').count().as('people'));
}

export function payrollFor(siteId, weekStart) {
  return db('payrolls').where({ site_id: siteId, week_start: weekStart }).first('id', 'number', 'status');
}
