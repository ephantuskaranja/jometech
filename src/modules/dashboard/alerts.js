import { db } from '../../core/db.js';
import { localDay, nextDay } from '../../core/dates.js';
import { fmt } from '../../core/format.js';
import { waiting as qcWaiting } from '../qc/service.js';
import { monthLabel } from '../costing/running-costs.js';
import { openRequests } from '../purchasing/requests.js';
import { waitingAt as arrivalsAt, WAIT_WARN_HOURS } from '../checkins/arrivals.js';

// "Needs attention" at the top of the dashboard: the actual things that are late or waiting, named,
// each with a link. Only what this person deals with (by permission); nothing shows when all is well.
//
//   { key, tone: 'bad' | 'warn', icon, title, more: { count, href }, rows: [{ text, sub, href }] }

const SHOW = 5;
const can = (user, ...perms) => perms.some((p) => user.can(p));
const day = (d) => fmt.date(`${d}T12:00:00Z`);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A group of alerts; `total` is kept even when there are none, so the number cards can reuse it. */
function group(key, tone, icon, title, rows, href) {
  return { key, total: rows.length, tone, icon, title, rows: rows.slice(0, SHOW), more: rows.length > SHOW ? { count: rows.length - SHOW, href } : null };
}

async function overdueJobs(site, today) {
  const rows = await db('jobs as j').join('customers as c', 'c.id', 'j.customer_id')
    .where('j.site_id', site.id).whereIn('j.status', ['open', 'in_progress']).where('j.due_on', '<', today)
    .orderBy('j.due_on').select('j.id', 'j.number', 'j.due_on', 'c.name as customer_name');
  return group('jobs', 'bad', 'alarm', `${plural(rows.length, 'job')} past the promised date`, rows.map((j) => ({
    text: `${j.number} · ${j.customer_name}`, sub: `Promised ${day(j.due_on)}: ${plural(daysBetween(j.due_on, today), 'day')} late`, href: `/jobs/${j.id}`,
  })), '/jobs');
}

/**
 * Vehicles the gate logged in more than WAIT_WARN_HOURS ago that nobody has checked in. One query for
 * all those waiting: their number also feeds the dashboard's cards (hidden group `arrivals_waiting`).
 */
async function arrivalsWaiting(site) {
  const all = await arrivalsAt(site.id);
  const rows = all.filter((a) => a.hours_waiting >= WAIT_WARN_HOURS);
  return [{ key: 'arrivals_waiting', total: all.length, hidden: true }, group('arrivals', 'warn', 'box-arrow-in-down', `${plural(rows.length, 'vehicle')} at the gate over ${WAIT_WARN_HOURS} hours, not checked in`, rows.map((a) => ({
    text: `${a.vehicle_text} · ${a.driver_name}`, sub: `Logged in ${fmt.dateTime(a.arrived_at)} (${a.number}): check it in, or close it with a reason`, href: `/check-in/new?arrival=${a.id}`,
  })), '/check-in')];
}

async function lowStock() {
  const rows = await db('items').where({ is_active: true }).whereNotNull('reorder_level').whereRaw('`on_hand_qty` <= `reorder_level`')
    .orderByRaw('`on_hand_qty` / NULLIF(`reorder_level`, 0)').select('id', 'name', 'unit', 'on_hand_qty', 'reorder_level');
  return group('stock', 'warn', 'stack', `${plural(rows.length, 'item')} at or below the reorder level`, rows.map((i) => ({
    text: i.name, sub: `${fmt.qty(i.on_hand_qty)} ${i.unit} left · reorder at ${fmt.qty(i.reorder_level)}`, href: `/items/${i.id}`,
  })), '/inventory?show=low');
}

/** Issued, not fully paid, and past the customer's credit terms (cash: due on the day of the invoice). */
async function overdueInvoices(today) {
  const paid = db('payments').whereRaw('payments.job_id = i.job_id').whereNull('voided_at').select(db.raw('COALESCE(SUM(amount), 0)'));
  const rows = (await db('invoices as i').join('customers as c', 'c.id', 'i.customer_id').where('i.status', 'issued')
    .select('i.id', 'i.number', 'i.total', 'i.invoice_date', 'c.name as customer_name', 'c.credit_days', paid.as('paid')))
    .map((i) => ({ ...i, owed: Math.round((Number(i.total) - Number(i.paid)) * 100) / 100, due: addDays(i.invoice_date, Number(i.credit_days)) }))
    .filter((i) => i.owed > 0 && i.due < today)
    .sort((a, b) => a.due.localeCompare(b.due));
  return group('invoices', 'bad', 'receipt', `${plural(rows.length, 'invoice')} past due`, rows.map((i) => ({
    text: `Invoice ${i.number} · ${i.customer_name}`, sub: `KES ${fmt.money(i.owed)} owed · due ${day(i.due)}, ${plural(daysBetween(i.due, today), 'day')} ago`, href: `/invoices/${i.id}`,
  })), '/invoices?show=unpaid');
}

async function payrollToApprove(siteIds) {
  const rows = await db('payrolls as p').join('sites as s', 's.id', 'p.site_id').whereIn('p.site_id', siteIds).where('p.status', 'checked')
    .orderBy('p.week_start').select('p.id', 'p.number', 'p.week_start', 'p.total', 's.name as site_name');
  return group('payroll', 'warn', 'cash-stack', `${plural(rows.length, 'payroll')} waiting for approval`, rows.map((p) => ({
    text: `${p.number} · ${p.site_name}`, sub: `Week of ${day(p.week_start)} · KES ${fmt.money(p.total)}`, href: `/payroll/${p.id}`,
  })), '/payroll');
}

async function adjustmentsToApprove(siteIds) {
  const rows = await db('stock_adjustments as a').join('sites as s', 's.id', 'a.site_id').whereIn('a.site_id', siteIds).where('a.status', 'pending')
    .orderBy('a.id').select('a.id', 'a.number', 'a.created_at', 's.name as site_name');
  return group('adjustments', 'warn', 'sliders', `${plural(rows.length, 'stock adjustment')} waiting for approval`, rows.map((a) => ({
    text: `${a.number} · ${a.site_name}`, sub: `Raised ${fmt.dateTime(a.created_at)}`, href: `/inventory/adjustments/${a.id}`,
  })), '/inventory/adjustments');
}

async function qcToDo(site) {
  const rows = await qcWaiting(site.id);
  return group('qc', 'warn', 'shield-check', `${plural(rows.length, 'job')} waiting for a quality check`, rows.map((j) => ({
    text: `${j.number} · ${j.customer_name}`, sub: j.open_id ? 'Check started, not finished' : Number(j.failed_before) ? 'Back after rework' : 'Ready to check', href: j.open_id ? `/qc/${j.open_id}` : `/jobs/${j.id}`,
  })), '/qc');
}

/** Purchase requests: waiting for approval (approvers), approved but not ordered (stores). One query for both. */
async function purchaseRequests(user, siteIds, today) {
  const rows = await openRequests(siteIds);
  const row = (r) => ({ text: `${r.number} · ${r.requested_name ?? 'a removed user'}`, sub: r.needed_by ? `Needed by ${day(r.needed_by)}${r.needed_by < today ? ': late' : ''}` : `Asked ${fmt.dateTime(r.created_at)}`, href: `/purchase-requests/${r.id}` });
  const pending = rows.filter((r) => r.status === 'pending');
  const approved = rows.filter((r) => r.status === 'approved');
  return [
    can(user, 'purchasing.approve') ? group('requests', 'warn', 'inbox', `${plural(pending.length, 'purchase request')} waiting for approval`, pending.map(row), '/purchase-requests?show=pending') : null,
    can(user, 'purchasing.manage') ? group('to_order', approved.some((r) => r.needed_by && r.needed_by < today) ? 'bad' : 'warn', 'cart-plus', `${plural(approved.length, 'approved request')} to order`, approved.map(row), '/purchase-requests?show=approved') : null,
  ];
}

const lastMonth = (today) => addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
const lastWorkDay = (from) => { let d = addDays(from, -1); while (new Date(`${d}T12:00:00Z`).getUTCDay() === 0) d = addDays(d, -1); return d; };

/**
 * One query for the site's checks: does it have staff; is the last work day confirmed (or closed);
 * are last month's running costs entered.
 */
async function siteState(site, today) {
  let d = lastWorkDay(today);
  const ask = (day) => db.raw(`SELECT
      EXISTS(SELECT 1 FROM employees WHERE site_id = ? AND is_active = 1) AS staff,
      EXISTS(SELECT 1 FROM attendance_confirmations WHERE site_id = ? AND day = ?) AS confirmed,
      EXISTS(SELECT 1 FROM closed_days WHERE day = ? AND (site_id IS NULL OR site_id = ?)) AS closed,
      EXISTS(SELECT 1 FROM running_costs WHERE site_id = ? AND month = ?) AS running`, [site.id, site.id, day, day, site.id, site.id, lastMonth(today)]);
  let [[s]] = await ask(d);
  // That day was closed (rare): look at the work day before it.
  for (let i = 0; Number(s.closed) && i < 10; i++) { d = lastWorkDay(d); [[s]] = await ask(d); }
  return { day: d, staff: Number(s.staff) > 0, confirmed: Number(s.confirmed) > 0, running: Number(s.running) > 0 };
}

/** The last work day before today (Monday to Saturday, not a closed day) not yet confirmed at this site. */
function attendanceNotConfirmed(site, state) {
  if (!state.staff || state.confirmed) return null;
  const d = state.day;
  return group('attendance', 'warn', 'calendar-check', 'Attendance not confirmed', [{
    text: `${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${day(d)} at ${site.name}`, sub: 'Check and confirm it, so payroll can use it', href: `/attendance?day=${d}&site=${site.id}`,
  }], '/attendance');
}

/** Last month's running costs not entered at this site (job costing would leave them out). */
function runningCostsMissing(site, today, state) {
  if (state.running) return null;
  const month = lastMonth(today);
  return group('running', 'warn', 'lightning-charge', 'Running costs not entered', [{
    text: `${monthLabel(month)} at ${site.name}`, sub: 'Electricity, rent and other bills: job costing leaves them out until entered', href: `/costing/running-costs?month=${month}`,
  }], '/costing/running-costs');
}

/**
 * Every alert group this person should see, most urgent first (`groups`), and the total of every
 * check that was made, empty or not (`totals`, by key), for the dashboard's number cards.
 */
export async function alertsFor(user, site) {
  const today = localDay();
  const siteIds = user.sites.map((s) => s.id);
  const state = site && can(user, 'attendance.manage', 'costing.view') ? await siteState(site, today) : null;
  const list = await Promise.all([
    site && can(user, 'jobs.manage', 'jobs.progress', 'checkin.manage') ? overdueJobs(site, today) : null,
    can(user, 'invoices.manage') ? overdueInvoices(today) : null,
    site && can(user, 'qc.manage') ? qcToDo(site) : null,
    site && can(user, 'checkin.manage') ? arrivalsWaiting(site) : null,
    can(user, 'payroll.approve') ? payrollToApprove(siteIds) : null,
    can(user, 'inventory.approve') ? adjustmentsToApprove(siteIds) : null,
    can(user, 'purchasing.approve', 'purchasing.manage') ? purchaseRequests(user, siteIds, today) : null,
    can(user, 'inventory.manage', 'stores.issue', 'purchasing.manage', 'purchasing.approve') ? lowStock() : null,
    site && can(user, 'attendance.manage') ? attendanceNotConfirmed(site, state) : null,
    site && can(user, 'costing.view') ? runningCostsMissing(site, today, state) : null,
  ]);
  const done = list.flat().filter(Boolean);
  return { groups: done.filter((g) => g.total > 0 && !g.hidden), totals: Object.fromEntries(done.map((g) => [g.key, g.total])) };
}
