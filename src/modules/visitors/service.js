import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { dayStart, localDay, nextDay } from '../../core/dates.js';
import { compact } from '../../core/vehicle-format.js';
import { httpError } from '../../core/validate.js';

// Visitor register, per site: the gate signs a visitor in, reception confirms
// they were received, the gate clears them out.
//
//   arrived ──▶ received ──▶ cleared
//        └──────────────────▶ cleared   (flagged: never received)

export const PURPOSES = ['Delivery', 'Customer', 'Collecting a vehicle', 'Supplier', 'Job enquiry', 'Interview', 'Official visit', 'Other'];

export const STATUSES = {
  arrived: { label: 'Signed in', tone: 'warn' },
  received: { label: 'Received', tone: 'info' },
  cleared: { label: 'Cleared', tone: 'ok' },
};

const COLUMNS = ['v.*', 'in_by.name as arrived_by_name', 'rec_by.name as received_by_name', 'out_by.name as cleared_by_name'];
const withNames = (q) => q
  .leftJoin('users as in_by', 'in_by.id', 'v.arrived_by')
  .leftJoin('users as rec_by', 'rec_by.id', 'v.received_by')
  .leftJoin('users as out_by', 'out_by.id', 'v.cleared_by');

/**
 * Signs a visitor in at a site. `atReception`: reception signed in a walk-in,
 * so they are received at the same moment.
 */
export async function signIn(siteId, input, actor, { atReception = false } = {}) {
  return db.transaction(async (trx) => {
    const number = await nextNumber(trx, 'visitor');
    const now = new Date();
    const [id] = await trx('visitors').insert({
      number, site_id: siteId,
      name: input.name, phone: input.phone, id_no: input.id_no, company: input.company, purpose: input.purpose,
      host: input.host, vehicle_reg: input.vehicle_reg, pass_no: input.pass_no, people: input.people, notes: input.notes,
      arrived_at: now, arrived_by: actor.user.id,
      ...(atReception ? { status: 'received', received_at: now, received_by: actor.user.id } : {}),
    });
    await audit(trx, actor, { entity: 'visitor', id, action: 'visitor_in', summary: `${input.name} signed in (${number})${atReception ? ' at reception' : ''}` });
    return { id, number };
  });
}

async function lockVisitor(trx, id) {
  const visitor = await trx('visitors').where({ id }).forUpdate().first();
  if (!visitor) throw httpError(404, 'That visitor isn’t in the register.');
  return visitor;
}

/** Reception confirms the visitor reached them (or the person they came to see). */
export async function markReceived(id, actor) {
  return db.transaction(async (trx) => {
    const v = await lockVisitor(trx, id);
    if (v.status !== 'arrived') throw httpError(409, `${v.name} has already been ${v.status === 'received' ? 'received' : 'cleared out'}.`);
    await trx('visitors').where({ id }).update({ status: 'received', received_at: trx.fn.now(), received_by: actor.user.id });
    await audit(trx, actor, { entity: 'visitor', id, action: 'visitor_received', summary: `${v.name} received (${v.number})` });
    return v;
  });
}

/** The gate signs the visitor out. */
export async function clearOut(id, actor) {
  return db.transaction(async (trx) => {
    const v = await lockVisitor(trx, id);
    if (v.status === 'cleared') throw httpError(409, `${v.name} has already been cleared out.`);
    await trx('visitors').where({ id }).update({ status: 'cleared', cleared_at: trx.fn.now(), cleared_by: actor.user.id });
    const note = v.status === 'arrived' ? ', never received at reception' : '';
    await audit(trx, actor, { entity: 'visitor', id, action: 'visitor_cleared', summary: `${v.name} cleared out (${v.number})${note}` });
    return v;
  });
}

export function getVisitor(id) {
  return withNames(db('visitors as v')).where('v.id', id).first(COLUMNS);
}

/** Everyone at the site who hasn't been cleared out, longest there first. */
export function onSite(siteId) {
  return withNames(db('visitors as v')).where({ 'v.site_id': siteId }).whereIn('v.status', ['arrived', 'received'])
    .orderBy('v.arrived_at').select(COLUMNS);
}

/** A day's register (default today), or a search across all days when `q` is given. */
export function register(siteId, { day = localDay(), q = '' } = {}) {
  const query = withNames(db('visitors as v')).where({ 'v.site_id': siteId });
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    const digits = term.replace(/\D/g, '');
    query.where((w) => {
      w.where('v.name', 'like', like).orWhere('v.company', 'like', like).orWhere('v.number', 'like', like).orWhere('v.host', 'like', like)
        .orWhereRaw("REPLACE(v.vehicle_reg, ' ', '') LIKE ?", [`%${compact(term)}%`]);
      if (digits.length >= 4) w.orWhere('v.phone', 'like', `%${digits.replace(/^0/, '')}%`).orWhere('v.id_no', 'like', `%${digits}%`);
    });
  } else {
    query.where('v.arrived_at', '>=', dayStart(day)).where('v.arrived_at', '<', dayStart(nextDay(day)));
  }
  return query.orderBy('v.arrived_at', 'desc').limit(200).select(COLUMNS);
}

/** The visitor's last visit (any site), to fill in the form when they come again. */
export function lastVisit(phone) {
  return db('visitors').where({ phone }).orderBy('arrived_at', 'desc')
    .first('name', 'id_no', 'company', 'vehicle_reg', 'host', 'purpose', 'arrived_at');
}

/** Names for the "who are they seeing?" suggestions: staff at the site. */
export function staffAt(siteId) {
  return db('users').join('user_sites', 'user_sites.user_id', 'users.id')
    .where({ 'user_sites.site_id': siteId, 'users.is_active': true }).orderBy('users.name').pluck('users.name');
}

/** Still on site from an earlier day: they were never cleared out. */
export const overdue = (v, today = localDay()) => v.status !== 'cleared' && localDay(v.arrived_at) < today;
