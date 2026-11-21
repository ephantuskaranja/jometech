import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { httpError } from '../../core/validate.js';
import { followVehicle } from '../jobs/service.js';

// A vehicle in the workshop moving between sites (HQ ⇄ Site B):
//
//   send       at the site it is leaving: driver, odometer → "in transit"
//   gate out   the sending gate clears it out
//   gate in    the receiving gate logs it in
//   receive    at the other site, by an admin, manager or supervisor: the check-in's site changes,
//              so it shows in that workshop list
//   cancel     at the sending site, only before it has left the gate
//
// The status stays "in_transit" from sending until it is received; gate_out_at and gate_in_at say
// how far it has got (stage()). The history of each step is kept on the check-in.

const err = (status, message, field) => Object.assign(httpError(status, message), { field });

/**
 * Where a move is now:
 *   at_sending_gate   sent, waiting for the sending gate to clear it out
 *   on_the_road       cleared out, not yet logged in at the other gate
 *   at_receiving_gate logged in at the other gate: waiting for an admin, manager or supervisor to confirm
 *   received | cancelled
 */
export function stage(m) {
  if (m.status !== 'in_transit') return m.status;
  if (!m.gate_out_at) return 'at_sending_gate';
  if (!m.gate_in_at) return 'on_the_road';
  return 'at_receiving_gate';
}

export const STAGES = {
  at_sending_gate: { label: 'Waiting at the gate', tone: 'warn' },
  on_the_road: { label: 'On the way', tone: 'info' },
  at_receiving_gate: { label: 'At the gate: to confirm', tone: 'warn' },
  received: { label: 'Received', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Who confirms a vehicle arrived: admins, managers and supervisors (the receiving side). */
export const canConfirmArrival = (user) => Boolean(user?.isAdmin || user?.roles?.some((r) => ['manager', 'supervisor'].includes(r.key)));

const withSites = (q) => q
  .join('sites as from_site', 'from_site.id', 'm.from_site_id')
  .join('sites as to_site', 'to_site.id', 'm.to_site_id');

/** The move still under way for a check-in, if any. */
export function openMovement(checkinId, q = db) {
  return withSites(q('vehicle_movements as m'))
    .leftJoin('users as sender', 'sender.id', 'm.sent_by')
    .where({ 'm.checkin_id': checkinId, 'm.status': 'in_transit' })
    .leftJoin('users as gout', 'gout.id', 'm.gate_out_by')
    .leftJoin('users as gin', 'gin.id', 'm.gate_in_by')
    .first('m.*', 'from_site.name as from_site_name', 'to_site.name as to_site_name', 'sender.name as sent_by_name',
      'gout.name as gate_out_by_name', 'gin.name as gate_in_by_name')
    .then((m) => (m ? { ...m, stage: stage(m) } : m));
}

/** Sites a check-in can be sent to: every other active site. */
export function otherSites(siteId) {
  return db('sites').where({ is_active: true }).whereNot({ id: siteId }).orderBy('name').select('id', 'name');
}

/**
 * The vehicle leaves its site for another one.
 * @param {{ to_site_id: number, driver_name: string, driver_phone: string|null, odometer_out: number|null, notes: string|null }} input
 */
export async function sendVehicle(checkinId, input, actor) {
  return db.transaction(async (trx) => {
    const checkin = await trx('checkins').join('vehicles', 'vehicles.id', 'checkins.vehicle_id').where('checkins.id', checkinId).forUpdate()
      .first('checkins.id', 'checkins.number', 'checkins.status', 'checkins.site_id', 'checkins.vehicle_id', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag');
    if (!checkin) throw httpError(404, 'That check-in doesn’t exist.');
    if (checkin.status !== 'in_workshop') throw httpError(409, `${checkin.number} is no longer in the workshop.`);
    if (await openMovement(checkinId, trx)) throw httpError(409, `${vehicleLabel(checkin)} is already on its way to another site.`);
    const to = await trx('sites').where({ id: input.to_site_id, is_active: true }).first('id', 'name');
    if (!to || to.id === checkin.site_id) throw err(422, 'Choose the site it is going to', 'to_site_id');

    const number = await nextNumber(trx, 'movement');
    const [id] = await trx('vehicle_movements').insert({
      number, checkin_id: checkin.id, vehicle_id: checkin.vehicle_id, from_site_id: checkin.site_id, to_site_id: to.id,
      driver_name: input.driver_name, driver_phone: input.driver_phone, odometer_out: input.odometer_out, notes: input.notes,
      sent_by: actor.user.id,
    });
    await audit(trx, actor, { entity: 'checkin', id: checkin.id, action: 'sent', summary: `Sent to ${to.name} with ${input.driver_name} (${number})` });
    return { id, number, to };
  });
}

/** The other site confirms the vehicle arrived; it now belongs to that site's workshop. */
export async function receiveVehicle(movementId, input, actor) {
  return db.transaction(async (trx) => {
    const move = await withSites(trx('vehicle_movements as m')).where('m.id', movementId).forUpdate()
      .first('m.*', 'to_site.name as to_site_name');
    if (!move) throw httpError(404, 'That movement doesn’t exist.');
    if (move.status !== 'in_transit') throw httpError(409, `${move.number} has already been ${move.status === 'received' ? 'received' : 'cancelled'}.`);
    if (!move.gate_in_at) throw httpError(409, `${move.number} hasn’t been logged in at the ${move.to_site_name} gate yet. The gate logs it in first.`);
    await trx('vehicle_movements').where({ id: move.id }).update({
      status: 'received', received_at: trx.fn.now(), received_by: actor.user.id, odometer_in: input.odometer_in, receive_notes: input.receive_notes,
    });
    await trx('checkins').where({ id: move.checkin_id }).update({ site_id: move.to_site_id });
    await audit(trx, actor, { entity: 'checkin', id: move.checkin_id, action: 'received', summary: `Received at ${move.to_site_name} (${move.number})` });
    await followVehicle(trx, move.checkin_id, { id: move.to_site_id, name: move.to_site_name }, actor);
    return move;
  });
}

/** Sent by mistake, or the trip was called off before it left. */
export async function cancelMovement(movementId, actor) {
  return db.transaction(async (trx) => {
    const move = await trx('vehicle_movements').where({ id: movementId }).forUpdate().first();
    if (!move) throw httpError(404, 'That movement doesn’t exist.');
    if (move.status !== 'in_transit') throw httpError(409, `${move.number} can no longer be cancelled.`);
    if (move.gate_out_at) throw httpError(409, `${move.number} has already left the gate, so it can’t be cancelled. The other site receives it.`);
    await trx('vehicle_movements').where({ id: move.id }).update({ status: 'cancelled' });
    await audit(trx, actor, { entity: 'checkin', id: move.checkin_id, action: 'move_cancelled', summary: `Move cancelled (${move.number})` });
    return move;
  });
}

export function getMovement(id) {
  return db('vehicle_movements').where({ id }).first();
}

const listColumns = ['m.id', 'm.number', 'm.status', 'm.checkin_id', 'm.driver_name', 'm.sent_at', 'm.received_at', 'm.from_site_id', 'm.to_site_id', 'm.gate_out_at', 'm.gate_in_at',
  'from_site.name as from_site_name', 'to_site.name as to_site_name', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag', 'vehicles.make', 'vehicles.model'];

/** Vehicles on their way to this site, with how far each has got. */
export async function arriving(siteId) {
  const rows = await withSites(db('vehicle_movements as m')).join('vehicles', 'vehicles.id', 'm.vehicle_id')
    .where({ 'm.status': 'in_transit', 'm.to_site_id': siteId })
    .orderBy('m.sent_at').select(listColumns);
  return rows.map((m) => ({ ...m, stage: stage(m) }));
}

/**
 * The gate's lists at this site: vehicles to clear out to another site, and vehicles from
 * another site to log in. Each with its customer and the driver, for the guard to check.
 */
export async function atGate(siteId) {
  const rows = await withSites(db('vehicle_movements as m')).join('vehicles', 'vehicles.id', 'm.vehicle_id')
    .join('customers as c', 'c.id', 'vehicles.customer_id')
    .where('m.status', 'in_transit')
    .where((w) => w.where((a) => a.where('m.from_site_id', siteId).whereNull('m.gate_out_at'))
      .orWhere((b) => b.where('m.to_site_id', siteId).whereNotNull('m.gate_out_at').whereNull('m.gate_in_at')))
    .orderBy('m.sent_at')
    .select(...listColumns, 'm.driver_phone', 'm.gate_out_at', 'm.gate_in_at', 'm.notes', 'vehicles.colour', 'c.name as customer_name');
  return { leaving: rows.filter((m) => m.from_site_id === siteId && !m.gate_out_at), arriving: rows.filter((m) => m.to_site_id === siteId && m.gate_out_at) };
}

/** The sending gate lets it out. Only once, and only for a move still waiting at this gate. */
export async function gateOut(movementId, actor) {
  return db.transaction(async (trx) => {
    const move = await withSites(trx('vehicle_movements as m')).where('m.id', movementId).forUpdate().first('m.*', 'to_site.name as to_site_name');
    if (!move) throw httpError(404, 'That movement doesn’t exist.');
    if (move.status !== 'in_transit') throw httpError(409, `${move.number} has been ${move.status}.`);
    if (move.gate_out_at) throw httpError(409, `${move.number} was already cleared out.`);
    await trx('vehicle_movements').where({ id: move.id }).update({ gate_out_at: trx.fn.now(), gate_out_by: actor.user.id });
    await audit(trx, actor, { entity: 'checkin', id: move.checkin_id, action: 'move_gate_out', summary: `Left the gate for ${move.to_site_name} (${move.number})` });
    return move;
  });
}

/** The receiving gate logs it in. Then an admin, manager or supervisor there confirms it was received. */
export async function gateIn(movementId, note, actor) {
  return db.transaction(async (trx) => {
    const move = await withSites(trx('vehicle_movements as m')).where('m.id', movementId).forUpdate().first('m.*', 'to_site.name as to_site_name', 'from_site.name as from_site_name');
    if (!move) throw httpError(404, 'That movement doesn’t exist.');
    if (move.status !== 'in_transit') throw httpError(409, `${move.number} has been ${move.status}.`);
    if (!move.gate_out_at) throw httpError(409, `${move.number} hasn’t left the ${move.from_site_name} gate yet.`);
    if (move.gate_in_at) throw httpError(409, `${move.number} was already logged in.`);
    await trx('vehicle_movements').where({ id: move.id }).update({ gate_in_at: trx.fn.now(), gate_in_by: actor.user.id, gate_in_note: note });
    await audit(trx, actor, { entity: 'checkin', id: move.checkin_id, action: 'move_gate_in', summary: `Arrived at the ${move.to_site_name} gate (${move.number})${note ? `: ${note}` : ''}` });
    return move;
  });
}

/** The 100 latest moves into or out of this site. */
export async function listMovements(siteId) {
  const rows = await withSites(db('vehicle_movements as m')).join('vehicles', 'vehicles.id', 'm.vehicle_id')
    .where((q) => q.where('m.from_site_id', siteId).orWhere('m.to_site_id', siteId))
    .orderBy('m.sent_at', 'desc').orderBy('m.id', 'desc').limit(100).select(listColumns);
  return rows.map((m) => ({ ...m, stage: stage(m) }));
}
