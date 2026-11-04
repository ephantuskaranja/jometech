import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { httpError } from '../../core/validate.js';
import { followVehicle } from '../jobs/service.js';

// A vehicle in the workshop moving between sites (HQ ⇄ Site B):
//
//   send     at the site it is leaving: driver, odometer → "in transit"
//   receive  at the other site: the check-in's site changes, so it shows in that workshop list
//   cancel   at the sending site, if it never left
//
// The history of each step is kept on the check-in.

const err = (status, message, field) => Object.assign(httpError(status, message), { field });

const withSites = (q) => q
  .join('sites as from_site', 'from_site.id', 'm.from_site_id')
  .join('sites as to_site', 'to_site.id', 'm.to_site_id');

/** The move still under way for a check-in, if any. */
export function openMovement(checkinId, q = db) {
  return withSites(q('vehicle_movements as m'))
    .leftJoin('users as sender', 'sender.id', 'm.sent_by')
    .where({ 'm.checkin_id': checkinId, 'm.status': 'in_transit' })
    .first('m.*', 'from_site.name as from_site_name', 'to_site.name as to_site_name', 'sender.name as sent_by_name');
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
    await trx('vehicle_movements').where({ id: move.id }).update({ status: 'cancelled' });
    await audit(trx, actor, { entity: 'checkin', id: move.checkin_id, action: 'move_cancelled', summary: `Move cancelled (${move.number})` });
    return move;
  });
}

export function getMovement(id) {
  return db('vehicle_movements').where({ id }).first();
}

const listColumns = ['m.id', 'm.number', 'm.status', 'm.checkin_id', 'm.driver_name', 'm.sent_at', 'm.received_at', 'm.from_site_id', 'm.to_site_id',
  'from_site.name as from_site_name', 'to_site.name as to_site_name', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag', 'vehicles.make', 'vehicles.model'];

/** Vehicles on their way to this site. */
export function arriving(siteId) {
  return withSites(db('vehicle_movements as m')).join('vehicles', 'vehicles.id', 'm.vehicle_id')
    .where({ 'm.status': 'in_transit', 'm.to_site_id': siteId })
    .orderBy('m.sent_at').select(listColumns);
}

/** The 100 latest moves into or out of this site. */
export function listMovements(siteId) {
  return withSites(db('vehicle_movements as m')).join('vehicles', 'vehicles.id', 'm.vehicle_id')
    .where((q) => q.where('m.from_site_id', siteId).orWhere('m.to_site_id', siteId))
    .orderBy('m.sent_at', 'desc').orderBy('m.id', 'desc').limit(100).select(listColumns);
}
