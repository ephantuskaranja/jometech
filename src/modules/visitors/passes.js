import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { localDay } from '../../core/dates.js';
import { compact } from '../../core/vehicle-format.js';
import { httpError } from '../../core/validate.js';
import { PURPOSES } from './service.js';

// Customer gate passes: a visitor on site at one yard sent to the other, like the paper
// "Customer Gate Pass". Reception, a supervisor or a manager issues it from the visit ("Approved by");
// it can be printed for the visitor to carry.
//
//   issued ──▶ on the way (the sending gate cleared the visitor out) ──▶ arrived (signed in at the other site)
//          └─▶ cancelled (before they arrive, with a reason)
//
// Stored as status open | arrived | cancelled; left_at says whether they have left (stage()).
// Still open after its day: "Didn't arrive" (worked out, not stored), so the other gate follows it up.

export const STAGES = {
  issued: { label: 'Not left yet', tone: 'warn' },
  on_the_way: { label: 'On the way', tone: 'info' },
  arrived: { label: 'Arrived', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  not_arrived: { label: 'Didn’t arrive', tone: 'bad' },
};

/** Where a pass is now. */
export function stage(p, today = localDay()) {
  if (p.status !== 'open') return p.status;
  if (localDay(p.issued_at) < today) return 'not_arrived';
  return p.left_at ? 'on_the_way' : 'issued';
}

const COLUMNS = ['p.*', 'fs.name as from_site_name', 'ts.name as to_site_name', 'iss.name as issued_by_name', 'lft.name as left_by_name',
  'cx.name as cancelled_by_name', 'v.number as visitor_number', 'av.number as arrived_visitor_number', 'av.arrived_by as arrived_by', 'arr.name as arrived_by_name'];
const withNames = (q) => q
  .join('sites as fs', 'fs.id', 'p.from_site_id')
  .join('sites as ts', 'ts.id', 'p.to_site_id')
  .join('visitors as v', 'v.id', 'p.visitor_id')
  .leftJoin('visitors as av', 'av.id', 'p.arrived_visitor_id')
  .leftJoin('users as iss', 'iss.id', 'p.issued_by')
  .leftJoin('users as lft', 'lft.id', 'p.left_by')
  .leftJoin('users as arr', 'arr.id', 'av.arrived_by')
  .leftJoin('users as cx', 'cx.id', 'p.cancelled_by');

/**
 * Issues a pass for a visitor on site, to another site.
 * @param {object} visitor the visit they leave from (still on site)
 * @param {{ to_site_id: number, purpose: string, host: string|null, people: number, vehicle_reg: string|null, notes: string|null }} input
 */
export async function issuePass(visitor, input, actor) {
  return db.transaction(async (trx) => {
    const v = await trx('visitors').where({ id: visitor.id }).forUpdate().first();
    if (!v || v.status === 'cleared') throw httpError(409, `${visitor.name} has already been cleared out. Sign them in again first.`);
    if (input.to_site_id === v.site_id) throw httpError(422, 'Choose the other site.');
    const site = await trx('sites').where({ id: input.to_site_id, is_active: true }).first('id', 'name');
    if (!site) throw httpError(422, 'Choose a site they are going to.');
    const open = await trx('visitor_passes').where({ visitor_id: v.id, status: 'open' }).first('number');
    if (open) throw httpError(409, `${v.name} already has a gate pass (${open.number}). Cancel it first to send them somewhere else.`);

    const number = await nextNumber(trx, 'visitor_pass');
    const [id] = await trx('visitor_passes').insert({
      number, visitor_id: v.id, from_site_id: v.site_id, to_site_id: site.id,
      name: v.name, phone: v.phone, company: v.company,
      purpose: input.purpose, host: input.host, people: input.people, vehicle_reg: input.vehicle_reg, notes: input.notes,
      issued_by: actor.user.id,
    });
    await audit(trx, actor, { entity: 'visitor_pass', id, action: 'issued', summary: `Gate pass ${number}: ${v.name} to ${site.name}` });
    await audit(trx, actor, { entity: 'visitor', id: v.id, action: 'pass_issued', summary: `Sent to ${site.name} with gate pass ${number}` });
    return { id, number, siteName: site.name };
  });
}

/** Inside the clear out: the visitor's open pass, if any, now shows they have left. */
export async function markLeft(trx, visitorId, actor) {
  const pass = await trx('visitor_passes').where({ visitor_id: visitorId, status: 'open' }).whereNull('left_at').first('id', 'number');
  if (!pass) return null;
  await trx('visitor_passes').where({ id: pass.id }).update({ left_at: trx.fn.now(), left_by: actor.user.id });
  await audit(trx, actor, { entity: 'visitor_pass', id: pass.id, action: 'left', summary: 'Cleared out at the gate: on the way' });
  return pass;
}

/** Inside the undo of a clear out: the pass goes back to not left. */
export async function unmarkLeft(trx, visitorId, actor) {
  const pass = await trx('visitor_passes').where({ visitor_id: visitorId, status: 'open' }).whereNotNull('left_at').first('id');
  if (!pass) return;
  await trx('visitor_passes').where({ id: pass.id }).update({ left_at: null, left_by: null });
  await audit(trx, actor, { entity: 'visitor_pass', id: pass.id, action: 'left_undone', summary: 'Clear out undone: not left yet' });
}

async function lockPass(trx, id) {
  const pass = await trx('visitor_passes').where({ id }).forUpdate().first();
  if (!pass) throw httpError(404, 'That gate pass doesn’t exist.');
  return pass;
}

/** Inside the sign in at the other site: the pass is used, and points at the new visit. */
export async function markArrived(trx, passId, siteId, visitor, actor) {
  const p = await lockPass(trx, passId);
  if (p.to_site_id !== siteId) throw httpError(409, 'That gate pass is for another site.');
  if (p.status !== 'open') throw httpError(409, `Gate pass ${p.number} is ${p.status === 'arrived' ? 'already used: they were signed in' : 'cancelled'}.`);
  await trx('visitor_passes').where({ id: p.id }).update({ status: 'arrived', arrived_visitor_id: visitor.id, arrived_at: trx.fn.now() });
  await audit(trx, actor, { entity: 'visitor_pass', id: p.id, action: 'arrived', summary: `${visitor.name} arrived (${visitor.number})` });
  return p;
}

export async function cancelPass(id, reason, actor) {
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw httpError(422, 'Say why the gate pass is cancelled.');
  return db.transaction(async (trx) => {
    const p = await lockPass(trx, id);
    if (p.status !== 'open') throw httpError(409, `Gate pass ${p.number} is already ${p.status}.`);
    await trx('visitor_passes').where({ id: p.id }).update({ status: 'cancelled', cancelled_at: trx.fn.now(), cancelled_by: actor.user.id, cancel_reason: why.slice(0, 255) });
    await audit(trx, actor, { entity: 'visitor_pass', id: p.id, action: 'cancelled', summary: `Gate pass cancelled: ${why}` });
    return p;
  });
}

export function getPass(id) {
  return withNames(db('visitor_passes as p')).where('p.id', id).first(COLUMNS);
}

/** The latest pass a visit left with, and the one it came in on (either may be null). */
export async function passesOfVisit(visitorId) {
  const [out, came] = await Promise.all([
    withNames(db('visitor_passes as p')).where('p.visitor_id', visitorId).orderBy('p.id', 'desc').first(COLUMNS),
    withNames(db('visitor_passes as p')).where('p.arrived_visitor_id', visitorId).first(COLUMNS),
  ]);
  return { out: out ?? null, came: came ?? null };
}

/** Open passes of these visits, by visit id: for "Going to Site B" on the register. */
export async function openFor(visitorIds) {
  if (!visitorIds.length) return new Map();
  const rows = await db('visitor_passes as p').join('sites as ts', 'ts.id', 'p.to_site_id')
    .whereIn('p.visitor_id', visitorIds).where('p.status', 'open').select('p.id', 'p.visitor_id', 'p.number', 'ts.name as to_site_name');
  return new Map(rows.map((r) => [r.visitor_id, r]));
}

/**
 * Passes at a site.
 *   incoming: coming to this site and not here yet (today's, then older ones nobody signed in)
 *   sent:     from this site: still open first, then the last 30 days
 *   search:   to or from this site, any day, by pass number, name, phone, company or vehicle
 */
export function list(siteId, tab = 'incoming', q = '') {
  const query = withNames(db('visitor_passes as p'));
  if (tab === 'incoming') {
    return query.where({ 'p.to_site_id': siteId, 'p.status': 'open' }).orderBy('p.issued_at', 'desc').select(COLUMNS);
  }
  if (tab === 'sent') {
    const since = new Date(Date.now() - 30 * 86400000);
    return query.where('p.from_site_id', siteId).where((w) => w.where('p.status', 'open').orWhere('p.issued_at', '>=', since))
      .orderByRaw("p.status = 'open' DESC").orderBy('p.issued_at', 'desc').limit(200).select(COLUMNS);
  }
  const term = q.trim();
  query.where((w) => w.where('p.from_site_id', siteId).orWhere('p.to_site_id', siteId));
  if (term) {
    const like = `%${term}%`;
    const digits = term.replace(/\D/g, '');
    query.where((w) => {
      w.where('p.number', 'like', like).orWhere('p.name', 'like', like).orWhere('p.company', 'like', like)
        .orWhereRaw("REPLACE(p.vehicle_reg, ' ', '') LIKE ?", [`%${compact(term)}%`]);
      // "0042" or "42" off the paper finds CGP-2026-0042; a phone needs more digits.
      if (digits.length && digits.length <= 4) w.orWhere('p.number', 'like', `%-${digits.padStart(4, '0')}`);
      if (digits.length >= 4) w.orWhere('p.phone', 'like', `%${digits.replace(/^0/, '')}%`);
    });
  }
  return query.orderBy('p.issued_at', 'desc').limit(200).select(COLUMNS);
}

/**
 * An open pass coming to this site for this phone (normalized, +254…): someone the guard is about to
 * sign in as a walk-in who was in fact sent here. The newest if there are several.
 */
export function incomingForPhone(siteId, phone) {
  if (!phone) return null;
  return withNames(db('visitor_passes as p')).where({ 'p.to_site_id': siteId, 'p.status': 'open', 'p.phone': phone })
    .orderBy('p.issued_at', 'desc').first(COLUMNS).then((p) => p ?? null);
}

/**
 * What "Arrived" signs them in with, straight from the pass (no form): the same details, the pass
 * number in "Gate pass no.", and the ID number from the visit they left.
 */
export async function signInValues(p) {
  const left = await db('visitors').where({ id: p.visitor_id }).first('id_no');
  return {
    phone: p.phone, name: p.name, company: p.company, host: p.host ?? 'Reception', purpose: p.purpose,
    vehicle_reg: p.vehicle_reg, people: p.people ?? 1, notes: p.notes, pass_no: p.number, id_no: left?.id_no ?? null,
  };
}

/** Tab counts: coming in (not here yet), and sent from here still open. */
export async function counts(siteId) {
  const [row] = await db('visitor_passes').where({ status: 'open' }).select(
    db.raw('SUM(to_site_id = ?) AS incoming', [siteId]),
    db.raw('SUM(from_site_id = ?) AS sent', [siteId]),
  );
  return { incoming: Number(row.incoming ?? 0), sent: Number(row.sent ?? 0) };
}

/** What the sign-in form starts with when signing in from a pass. */
export function formValues(p) {
  const known = PURPOSES.includes(p.purpose);
  return {
    phone: p.phone ?? '', name: p.name, company: p.company ?? '', host: p.host ?? 'Reception', vehicle_reg: p.vehicle_reg ?? '',
    purpose: known ? p.purpose : 'Other', other_purpose: known ? '' : p.purpose,
    people: String(p.people ?? 1), notes: p.notes ?? '', pass_id: String(p.id),
  };
}
