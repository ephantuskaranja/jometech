import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import { config } from '../../config.js';
import { summarize } from './day.js';
import { createEmployee } from '../employees/service.js';

// Attendance: punches from the clock-in machines, and each day's attendance per site.
//
//   import (Excel/CSV) ──▶ attendance_punches (as they came; the same file twice adds nothing)
//   punches + employees' clock IDs ──▶ a suggested status per person and day ──▶ the supervisor saves, then confirms
//   confirmed days are locked for payroll; a manager can reopen one.

export const STATUSES = {
  present: { label: 'Present', short: 'P', tone: 'ok', days: 1 },
  half: { label: 'Half day', short: '½', tone: 'info', days: 0.5 },
  absent: { label: 'Absent', short: 'A', tone: 'bad', days: 0 },
  sick: { label: 'Sick', short: 'S', tone: 'warn', days: 0 },
  leave: { label: 'Leave', short: 'L', tone: 'neutral', days: 0 },
  off: { label: 'Off', short: 'O', tone: 'neutral', days: 0 },
  holiday: { label: 'Holiday', short: 'H', tone: 'neutral', days: 0 },
};

const CHUNK = 500;

// ---------- importing punches ----------

/**
 * @param {{ punches: object[], fileName: string }} input  from readPunchFile
 * @returns {Promise<{ id: number, rows: number, added: number, firstDay: string|null, lastDay: string|null }>}
 */
export async function importPunches({ punches, fileName }, actor) {
  return db.transaction(async (trx) => {
    const days = punches.map((p) => p.day).sort();
    const [id] = await trx('attendance_imports').insert({
      file_name: fileName.slice(0, 255), rows: punches.length, first_day: days[0] ?? null, last_day: days.at(-1) ?? null, created_by: actor.user.id,
    });
    // The machines, by name; a new one waits for its site to be set.
    const devices = new Map();
    for (const p of punches.filter((x) => x.device)) {
      if (devices.has(p.device)) continue;
      await trx('clock_devices').insert({ name: p.device, serial: p.serial }).onConflict('name').ignore();
      devices.set(p.device, (await trx('clock_devices').where({ name: p.device }).first('id')).id);
    }
    for (let i = 0; i < punches.length; i += CHUNK) {
      await trx('attendance_punches').insert(punches.slice(i, i + CHUNK).map((p) => ({
        clock_id: p.clock_id, clock_name: p.name, day: p.day, time: p.time, device_id: devices.get(p.device) ?? null, state: p.state, import_id: id,
      }))).onConflict().ignore();
    }
    const [{ added }] = await trx('attendance_punches').where({ import_id: id }).count({ added: '*' });
    await trx('attendance_imports').where({ id }).update({ added: Number(added) });
    await audit(trx, actor, { entity: 'attendance_import', id, action: 'create', summary: `${fileName}: ${added} new punches of ${punches.length}` });
    return { id, rows: punches.length, added: Number(added), firstDay: days[0] ?? null, lastDay: days.at(-1) ?? null };
  });
}

export function recentImports() {
  return db('attendance_imports as i').leftJoin('users as u', 'u.id', 'i.created_by')
    .orderBy('i.id', 'desc').limit(10).select('i.*', 'u.name as by_name');
}

export function devices() {
  return db('clock_devices as d').leftJoin('sites as s', 's.id', 'd.site_id').orderBy('d.name')
    .select('d.id', 'd.name', 'd.serial', 'd.site_id', 's.name as site_name',
      db('attendance_punches as p').whereRaw('p.device_id = d.id').max('p.day').as('last_day'));
}

export async function setDeviceSite(deviceId, siteId, actor) {
  await db.transaction(async (trx) => {
    const d = await trx('clock_devices').where({ id: deviceId }).forUpdate().first();
    if (!d) throw httpError(404, 'That machine doesn’t exist.');
    if (siteId && !(await trx('sites').where({ id: siteId }).first('id'))) throw httpError(422, 'Choose a site.');
    await trx('clock_devices').where({ id: deviceId }).update({ site_id: siteId });
    const site = siteId ? await trx('sites').where({ id: siteId }).first('name') : null;
    await audit(trx, actor, { entity: 'clock_device', id: deviceId, action: 'update', summary: `${d.name} is at ${site?.name ?? 'no site'}` });
  });
}

// ---------- clock IDs nobody is linked to ----------

const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** Clock IDs in the punches that no employee has, with the name the machine gives and where they punched. */
export async function unknownClockIds() {
  const rows = await db('attendance_punches as p')
    .leftJoin('employee_clock_ids as c', 'c.clock_id', 'p.clock_id')
    .leftJoin('clock_devices as d', 'd.id', 'p.device_id')
    .whereNull('c.clock_id')
    .groupBy('p.clock_id')
    .orderByRaw('MAX(p.clock_name)')
    .select('p.clock_id', db.raw('MAX(p.clock_name) as clock_name'), db.raw('COUNT(*) as punches'),
      db.raw('MIN(p.day) as first_day'), db.raw('MAX(p.day) as last_day'), db.raw('MAX(d.site_id) as site_id'));
  // Someone already on the staff list with that name is suggested; so is another unknown ID with the same name.
  const staff = await db('employees').where({ is_active: true }).select('id', 'name', 'number');
  const byName = new Map(staff.map((e) => [nameKey(e.name), e]));
  return rows.map((r) => ({ ...r, punches: Number(r.punches), match: byName.get(nameKey(r.clock_name)) ?? null,
    sameNameAs: rows.filter((o) => o !== r && nameKey(o.clock_name) && nameKey(o.clock_name) === nameKey(r.clock_name)).map((o) => o.clock_id) }));
}

/**
 * Links clock IDs to employees. Each choice: an employee id, or "new" (an employee is made from the machine's name;
 * several new IDs with the same name become one person with all of them).
 * @param {{ clock_id: string, choice: string, name: string|null, site_id: number }[]} choices
 * @returns {Promise<{ linked: number, created: number }>}
 */
export async function linkClockIds(choices, actor) {
  return db.transaction(async (trx) => {
    let linked = 0;
    let created = 0;
    const fresh = new Map(); // name → ids for new employees
    for (const c of choices) {
      if (await trx('employee_clock_ids').where({ clock_id: c.clock_id }).first('clock_id')) continue; // linked meanwhile
      if (c.choice === 'new') {
        const key = nameKey(c.name) || `id:${c.clock_id}`;
        const entry = fresh.get(key) ?? { name: c.name || `Clock ID ${c.clock_id}`, site_id: c.site_id, ids: [] };
        entry.ids.push(c.clock_id);
        fresh.set(key, entry);
      } else {
        const employee = await trx('employees').where({ id: Number(c.choice) }).first('id', 'name');
        if (!employee) continue;
        await trx('employee_clock_ids').insert({ clock_id: c.clock_id, employee_id: employee.id });
        await audit(trx, actor, { entity: 'employee', id: employee.id, action: 'update', summary: `Clock ID ${c.clock_id} linked` });
        linked++;
      }
    }
    for (const e of fresh.values()) {
      await createEmployee({ name: e.name.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase()), site_id: e.site_id, category: 'casual', clock_ids: e.ids }, actor, {}, trx);
      created++;
      linked += e.ids.length;
    }
    return { linked, created };
  });
}

// ---------- a site's day ----------

/**
 * Everyone who counts at a site on a day: its staff, anyone who punched on its machine, anyone already saved
 * there. Each row has the saved status (if any), the suggestion from the punches, and the punches.
 */
export async function dayGrid(siteId, day) {
  const confirmation = await db('attendance_confirmations as c').leftJoin('users as u', 'u.id', 'c.confirmed_by')
    .where({ 'c.site_id': siteId, 'c.day': day }).first('c.confirmed_at', 'u.name as confirmed_by_name');
  const saved = await db('attendance_days').where({ site_id: siteId, day }).select();
  const punchedHere = db('attendance_punches as p').join('clock_devices as d', 'd.id', 'p.device_id').join('employee_clock_ids as c', 'c.clock_id', 'p.clock_id')
    .where({ 'p.day': day, 'd.site_id': siteId }).distinct('c.employee_id');
  const people = await db('employees as e')
    .where((w) => w.where((x) => x.where('e.site_id', siteId).where('e.is_active', true))
      .orWhereIn('e.id', punchedHere)
      .orWhereIn('e.id', saved.map((s) => s.employee_id)))
    .orderBy('e.name')
    .select('e.id', 'e.name', 'e.number', 'e.trade', 'e.site_id', 'e.is_active');
  const punches = await db('attendance_punches as p').join('employee_clock_ids as c', 'c.clock_id', 'p.clock_id')
    .where('p.day', day).whereIn('c.employee_id', people.map((p) => p.id)).select('c.employee_id', 'p.time', 'p.state');
  // Did the machines' data cover this day? Then no punch means absent; otherwise nothing is suggested.
  const covered = Boolean(await db('attendance_punches as p').join('clock_devices as d', 'd.id', 'p.device_id').where({ 'p.day': day, 'd.site_id': siteId }).first('p.id'));
  const rules = config.attendance;
  const rows = people.map((e) => {
    const summary = summarize(punches.filter((p) => p.employee_id === e.id), rules);
    const record = saved.find((s) => s.employee_id === e.id) ?? null;
    const suggestion = summary ? summary.status : covered ? 'absent' : null;
    return { ...e, summary, record, suggestion, status: record?.status ?? suggestion ?? '', note: record?.note ?? '', visiting: e.site_id !== siteId };
  });
  return { rows, confirmation: confirmation ?? null, covered };
}

async function lockedCheck(trx, siteId, day) {
  if (await trx('attendance_confirmations').where({ site_id: siteId, day }).first('day')) {
    throw httpError(409, 'This day has been confirmed. A manager can reopen it.');
  }
}

/**
 * Saves the day as the supervisor set it. Rows with no status are left unsaved.
 * @param {{ employee_id: number, status: string, note: string|null }[]} rows
 */
export async function saveDay(siteId, day, rows, actor, { confirm = false } = {}) {
  return db.transaction(async (trx) => {
    await lockedCheck(trx, siteId, day);
    const grid = await dayGrid(siteId, day);
    const allowed = new Map(grid.rows.map((r) => [r.id, r]));
    let saved = 0;
    for (const r of rows) {
      const g = allowed.get(r.employee_id);
      if (!g || !STATUSES[r.status]) continue;
      const values = {
        status: r.status, note: r.note, site_id: siteId,
        first_in: g.summary?.first_in ?? null, last_out: g.summary?.last_out ?? null, hours: g.summary?.hours ?? null, updated_by: actor.user.id,
      };
      await trx('attendance_days').insert({ employee_id: r.employee_id, day, ...values }).onConflict(['employee_id', 'day']).merge(values);
      saved++;
    }
    if (confirm) {
      const marked = new Set(await trx('attendance_days').where({ site_id: siteId, day }).pluck('employee_id'));
      const missing = grid.rows.filter((r) => !r.visiting && !marked.has(r.id));
      if (missing.length) throw httpError(422, `Mark everyone before confirming: ${missing.slice(0, 5).map((m) => m.name).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`);
      await trx('attendance_confirmations').insert({ site_id: siteId, day, confirmed_by: actor.user.id });
    }
    await audit(trx, actor, { entity: 'attendance', id: siteId, action: confirm ? 'attendance_confirmed' : 'attendance_saved', summary: `${day}: ${saved} people${confirm ? ', confirmed' : ''}` });
    return { saved };
  });
}

export async function reopenDay(siteId, day, actor) {
  await db.transaction(async (trx) => {
    const n = await trx('attendance_confirmations').where({ site_id: siteId, day }).delete();
    if (n) await audit(trx, actor, { entity: 'attendance', id: siteId, action: 'attendance_reopened', summary: `${day} reopened` });
  });
}

/** The statuses of the last saved day before this one, for "Copy the last day". */
export async function lastDayBefore(siteId, day) {
  const prev = await db('attendance_days').where({ site_id: siteId }).where('day', '<', day).max({ day: 'day' }).first();
  if (!prev?.day) return null;
  return { day: prev.day, rows: await db('attendance_days').where({ site_id: siteId, day: prev.day }).select('employee_id', 'status') };
}

/** An employee's attendance for the last few weeks, for their page. */
export function recentFor(employeeId, days = 42) {
  return db('attendance_days as a').join('sites as s', 's.id', 'a.site_id')
    .where('a.employee_id', employeeId).where('a.day', '>=', db.raw('DATE_SUB(CURDATE(), INTERVAL ? DAY)', [days]))
    .orderBy('a.day', 'desc').select('a.day', 'a.site_id', 'a.status', 'a.first_in', 'a.last_out', 'a.hours', 'a.note', 's.name as site_name');
}
