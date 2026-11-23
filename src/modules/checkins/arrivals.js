import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { formatReg, formatChassis, vehicleLabel } from '../../core/vehicle-format.js';
import { PURPOSES, kindLabel } from '../../core/work-kinds.js';

// Customers' vehicles arriving at the gate (migration 20261123000005). The guard, or someone who
// checks vehicles in, logs the vehicle in; the workshop's check-in is then made from that arrival.
//
//   gate logs it in ─▶ check-in made from it ─▶ job's Vehicle Received ticked ─▶ … ─▶ released ─▶ gate clears it out
//
// An arrival nobody checks in stays on the waiting lists (gate page, check-in list, dashboard;
// a warning after WAIT_WARN_HOURS) until it is checked in or closed with a reason.

export const STATUSES = {
  waiting: { label: 'Waiting for check-in', tone: 'warn' },
  checked_in: { label: 'Checked in', tone: 'ok' },
  closed: { label: 'Closed', tone: 'neutral' },
};

/** After this long at the gate without a check-in, the workshop is warned (dashboard). */
export const WAIT_WARN_HOURS = 2;

export const purposeLabel = (value) => kindLabel(PURPOSES, value);

const fail = (status, message, field) => Object.assign(httpError(status, message), field ? { field } : {});

/** A vehicle we already know, from what the guard typed: reg, chassis or temporary tag. */
export async function findVehicle(text, q = db) {
  const reg = formatReg(text);
  const chassis = formatChassis(text);
  const tag = String(text ?? '').toUpperCase().replace(/\s+/g, '');
  if (!reg && !chassis) return null;
  return q('vehicles as v').join('customers as c', 'c.id', 'v.customer_id')
    .where((w) => {
      if (reg) w.orWhere('v.reg_no', reg);
      if (chassis && chassis.length >= 6) w.orWhere('v.chassis_no', chassis);
      if (tag) w.orWhere('v.temp_tag', tag);
    })
    .first('v.id', 'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model', 'c.name as customer_name');
}

/**
 * Log a vehicle in. A second tap for the same vehicle (still waiting here) gives the same arrival.
 * @returns {Promise<{ id: number, number: string, existed: boolean, vehicle: object|null }>}
 */
export async function logArrival({ siteId, vehicleText, driverName, driverPhone, purpose, note }, actor) {
  return db.transaction(async (trx) => {
    const vehicle = await findVehicle(vehicleText, trx);
    if (vehicle) {
      const waiting = await trx('vehicle_arrivals').where({ site_id: siteId, vehicle_id: vehicle.id, status: 'waiting' }).first('id', 'number');
      if (waiting) return { ...waiting, existed: true, vehicle };
      const inside = await trx('checkins').where({ vehicle_id: vehicle.id }).whereIn('status', ['in_workshop', 'released']).first('number');
      if (inside) throw fail(422, `${vehicleLabel(vehicle)} is already checked in (${inside.number}), so it should be on site. Tell the workshop.`, 'vehicle_text');
    }
    const number = await nextNumber(trx, 'arrival');
    const [id] = await trx('vehicle_arrivals').insert({
      number, site_id: siteId, vehicle_text: vehicle ? vehicleLabel(vehicle) : vehicleText, vehicle_id: vehicle?.id ?? null,
      driver_name: driverName, driver_phone: driverPhone, purpose, note, logged_by: actor.user.id,
    });
    await audit(trx, actor, { entity: 'vehicle_arrival', id, action: 'logged_in', summary: `${vehicle ? vehicleLabel(vehicle) : vehicleText}, driven by ${driverName} (${number})` });
    return { id, number, existed: false, vehicle };
  });
}

const base = (q = db) => q('vehicle_arrivals as a')
  .join('sites as s', 's.id', 'a.site_id')
  .leftJoin('vehicles as v', 'v.id', 'a.vehicle_id')
  .leftJoin('customers as c', 'c.id', 'v.customer_id')
  .leftJoin('users as u', 'u.id', 'a.logged_by')
  .leftJoin('users as cu', 'cu.id', 'a.closed_by')
  .leftJoin('checkins as k', 'k.id', 'a.checkin_id')
  .select('a.*', 's.name as site_name', 'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model', 'c.name as customer_name',
    'u.name as logged_name', 'cu.name as closed_name', 'k.number as checkin_number');

const withLabels = (a) => a && ({
  ...a,
  purpose_label: purposeLabel(a.purpose),
  hours_waiting: a.status === 'waiting' ? (Date.now() - new Date(a.arrived_at).getTime()) / 3_600_000 : null,
});

export const getArrival = async (id) => withLabels(await base().where('a.id', id).first());

/** Arrivals at a site still waiting for a check-in, oldest first. */
export async function waitingAt(siteId) {
  return (await base().where({ 'a.site_id': siteId, 'a.status': 'waiting' }).orderBy('a.arrived_at')).map(withLabels);
}

/** The waiting arrival for one vehicle at a site, if any (a check-in started from the vehicle or its job). */
export const waitingFor = async (siteId, vehicleId) => withLabels(await base().where({ 'a.site_id': siteId, 'a.vehicle_id': vehicleId, 'a.status': 'waiting' }).first());

/** What the gate logged at a site today (any status), newest first. */
export async function loggedToday(siteId, dayStartUtc) {
  return (await base().where('a.site_id', siteId).where('a.arrived_at', '>=', dayStartUtc).orderBy('a.id', 'desc')).map(withLabels);
}

/** Left without a check-in, logged by mistake …: closed with a reason, so it leaves the waiting lists. */
export async function closeArrival(id, reason, actor) {
  await db.transaction(async (trx) => {
    const a = await trx('vehicle_arrivals').where({ id }).forUpdate().first('id', 'number', 'status');
    if (!a) throw httpError(404, 'That arrival doesn’t exist.');
    if (a.status !== 'waiting') throw httpError(409, `${a.number} is already ${STATUSES[a.status].label.toLowerCase()}.`);
    await trx('vehicle_arrivals').where({ id }).update({ status: 'closed', closed_at: trx.fn.now(), closed_by: actor.user.id, close_reason: reason });
    await audit(trx, actor, { entity: 'vehicle_arrival', id, action: 'closed', summary: reason });
  });
}

/**
 * The check-in made from an arrival (inside its transaction): the arrival must still be waiting,
 * at the site the vehicle is being checked in at. It takes the vehicle the check-in found.
 */
export async function claimArrival(trx, arrivalId, { siteId, checkinId, checkinNumber, vehicleId }, actor) {
  const a = await trx('vehicle_arrivals').where({ id: arrivalId }).forUpdate().first('id', 'number', 'status', 'site_id');
  if (!a || a.site_id !== siteId) throw fail(422, 'That gate arrival isn’t at this site. Choose it again.', 'arrival_id');
  if (a.status !== 'waiting') throw fail(409, `${a.number} is already ${STATUSES[a.status].label.toLowerCase()}. Choose another, or give a reason.`, 'arrival_id');
  await trx('vehicle_arrivals').where({ id: a.id }).update({ status: 'checked_in', checkin_id: checkinId, vehicle_id: vehicleId });
  await audit(trx, actor, { entity: 'vehicle_arrival', id: a.id, action: 'checked_in', summary: `Check-in ${checkinNumber}` });
  return a;
}
