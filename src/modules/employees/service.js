import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';

// Employees: the people who work in the workshops, most of them paid by the day. Not app users.
// Each has one or more clock IDs: the number the clock-in machine knows them by.

export const STATUSES = ['active', 'inactive', 'all'];

/** Suggestions for the trade box (from the requirements); anything else can be typed. */
export const TRADES = ['Welder', 'Fabricator', 'Painter', 'Grinder', 'Electrician', 'Mechanic', 'Fitter', 'Storekeeper', 'Driver', 'Supervisor', 'Casual worker', 'Office'];

export const CATEGORIES = { casual: 'Casual', permanent: 'Permanent' };

const FIELDS = ['name', 'phone', 'id_no', 'trade', 'site_id', 'category', 'joined_on', 'mpesa_phone', 'emergency_name', 'emergency_phone', 'notes'];
const pick = (input, { withRate }) => ({
  ...Object.fromEntries(FIELDS.map((k) => [k, input[k] ?? null])),
  ...(withRate ? { daily_rate: input.daily_rate ?? null } : {}),
});

const err = (status, message, field) => Object.assign(httpError(status, message), { field });

/** Clock IDs belong to one employee only. */
async function checkClockIds(trx, ids, exceptEmployeeId = null) {
  if (!ids.length) return;
  const q = trx('employee_clock_ids as c').join('employees as e', 'e.id', 'c.employee_id').whereIn('c.clock_id', ids);
  if (exceptEmployeeId) q.whereNot('c.employee_id', exceptEmployeeId);
  const taken = await q.first('c.clock_id', 'e.name');
  if (taken) throw err(422, `Clock ID ${taken.clock_id} is already ${taken.name}’s`, 'clock_ids');
}

async function writeClockIds(trx, employeeId, ids) {
  await trx('employee_clock_ids').where({ employee_id: employeeId }).delete();
  if (ids.length) await trx('employee_clock_ids').insert(ids.map((clock_id) => ({ clock_id, employee_id: employeeId })));
}

async function checkSite(trx, siteId) {
  if (!(await trx('sites').where({ id: siteId, is_active: true }).first('id'))) throw err(422, 'Choose a site', 'site_id');
}

/**
 * @param {object} input  fields, clock_ids (string[]), and daily_rate when the actor may set pay
 * @param {{ withRate: boolean }} opts
 * @returns {Promise<{ id: number, number: string }>}
 */
export async function createEmployee(input, actor, { withRate = false } = {}, outer = null) {
  const run = (fn) => (outer ? fn(outer) : db.transaction(fn));
  return run(async (trx) => {
    await checkSite(trx, input.site_id);
    await checkClockIds(trx, input.clock_ids ?? []);
    const number = await nextNumber(trx, 'employee');
    const [id] = await trx('employees').insert({ ...pick(input, { withRate }), number, created_by: actor.user.id });
    await writeClockIds(trx, id, input.clock_ids ?? []);
    await audit(trx, actor, { entity: 'employee', id, action: 'create', summary: `${number}: ${input.name}` });
    return { id, number };
  });
}

/** What the history shows: names, not ids. Pay only when the change was made by someone who sees it. */
async function snapshot(trx, e, clockIds, withRate) {
  const site = await trx('sites').where({ id: e.site_id }).first('name');
  return {
    name: e.name, phone: e.phone, id_no: e.id_no, trade: e.trade, site: site?.name, category: CATEGORIES[e.category], joined_on: e.joined_on,
    mpesa_phone: e.mpesa_phone, emergency: [e.emergency_name, e.emergency_phone].filter(Boolean).join(', ') || null, notes: e.notes,
    clock_ids: clockIds.join(', ') || null,
    ...(withRate ? { daily_rate: e.daily_rate === null || e.daily_rate === undefined ? null : Number(e.daily_rate) } : {}),
  };
}

export async function updateEmployee(id, input, actor, { withRate = false } = {}) {
  await db.transaction(async (trx) => {
    const before = await trx('employees').where({ id }).forUpdate().first();
    if (!before) throw httpError(404, 'That employee doesn’t exist.');
    if (Number(input.site_id) !== before.site_id) await checkSite(trx, input.site_id);
    await checkClockIds(trx, input.clock_ids ?? [], id);
    const beforeIds = await trx('employee_clock_ids').where({ employee_id: id }).orderBy('clock_id').pluck('clock_id');
    const changes = pick(input, { withRate });
    await trx('employees').where({ id }).update(changes);
    await writeClockIds(trx, id, input.clock_ids ?? []);
    await audit(trx, actor, { entity: 'employee', id, action: 'update',
      before: await snapshot(trx, before, beforeIds, withRate), after: await snapshot(trx, { ...before, ...changes }, [...(input.clock_ids ?? [])].sort(), withRate) });
  });
}

/** Left, or back: never deleted, because their attendance and pay are kept. */
export async function setActive(id, active, actor) {
  await db.transaction(async (trx) => {
    const e = await trx('employees').where({ id }).forUpdate().first('id', 'name', 'is_active');
    if (!e) throw httpError(404, 'That employee doesn’t exist.');
    if (Boolean(e.is_active) === active) return;
    await trx('employees').where({ id }).update({ is_active: active, left_on: active ? null : trx.raw('CURDATE()') });
    await audit(trx, actor, { entity: 'employee', id, action: active ? 'record_on' : 'record_off', summary: active ? `${e.name} is back` : `${e.name} has left` });
  });
}

export async function getEmployee(id) {
  const e = await db('employees as e').join('sites as s', 's.id', 'e.site_id').where('e.id', id).first('e.*', 's.name as site_name');
  if (!e) return null;
  e.clock_ids = await db('employee_clock_ids').where({ employee_id: id }).orderBy('clock_id').pluck('clock_id');
  return e;
}

/** One site's staff (or all the user's sites), with their clock IDs. */
export async function listEmployees({ siteIds, siteId = null, status = 'active', q = '' }) {
  const query = db('employees as e').join('sites as s', 's.id', 'e.site_id')
    .whereIn('e.site_id', siteId ? [siteId] : siteIds)
    .orderBy('e.name').limit(1000)
    .select('e.*', 's.name as site_name',
      db('employee_clock_ids as c').whereRaw('c.employee_id = e.id').select(db.raw("GROUP_CONCAT(c.clock_id ORDER BY c.clock_id SEPARATOR ', ')")).as('clock_ids'));
  if (status !== 'all') query.where('e.is_active', status === 'active');
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('e.name', 'like', `%${term}%`).orWhere('e.number', 'like', `%${term}%`).orWhere('e.trade', 'like', `%${term}%`)
      .orWhere('e.phone', 'like', `%${term.replace(/^0/, '')}%`)
      .orWhereExists(db('employee_clock_ids as c').whereRaw('c.employee_id = e.id').where('c.clock_id', term)));
  }
  return query;
}

/** "70, 61 67" → ['61', '67', '70']: digits (and letters some machines use), no repeats. */
export function parseClockIds(text) {
  return [...new Set(String(text ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))].sort();
}
