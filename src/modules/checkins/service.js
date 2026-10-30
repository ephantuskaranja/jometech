import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { compact, vehicleLabel } from '../../core/vehicle-format.js';
import { normalizePhone } from '../../core/phone.js';
import { httpError } from '../../core/validate.js';
import { createVehicle, typeLabel } from '../vehicles/service.js';

// Check-in: the digital Truck Receiving Document.
// The driver's signature (part 3), photos (part 4) and check-out (part 5) build on this.

/** Fuel gauge buttons; stored as quarters (0–4). */
export const FUEL_LEVELS = [
  { value: 0, label: 'E' }, { value: 1, label: '¼' }, { value: 2, label: '½' }, { value: 3, label: '¾' }, { value: 4, label: 'F' },
];
export const fuelLabel = (q) => FUEL_LEVELS.find((f) => f.value === q)?.label ?? null;

export const STATUSES = {
  in_workshop: { label: 'In the workshop', tone: 'info' },
  checked_out: { label: 'Checked out', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const err = (status, message, field) => Object.assign(httpError(status, message), { field });

/**
 * Saves a check-in, adding the vehicle first when it is new.
 * @param {object} input  from the form (see routes.js)
 * @returns {Promise<{ id: number, number: string }>}
 */
export async function createCheckin(input, actor) {
  return db.transaction(async (trx) => {
    let vehicleId = input.vehicle_id;
    let customerId;

    if (input.new_vehicle) {
      const v = input.new_vehicle;
      customerId = v.customer_id;
      const temp_tag = v.issue_tag ? await nextNumber(trx, 'temp_tag') : null;
      // The vehicle keeps "brought in by" only when that person works for the owner (step 6 rule).
      const ownContact = input.contact_id
        ? await trx('customer_contacts').where({ id: input.contact_id, customer_id: customerId }).first('id')
        : null;
      vehicleId = await createVehicle({
        reg_no: v.issue_tag ? null : v.reg_no, chassis_no: v.issue_tag ? null : v.chassis_no, temp_tag,
        customer_id: customerId, contact_id: ownContact?.id ?? null, type: v.type, make: v.make, model: v.model,
      }, actor, trx);
    } else {
      const vehicle = await trx('vehicles').where({ id: vehicleId }).first('id', 'customer_id');
      if (!vehicle) throw err(422, 'Choose the vehicle', 'vehicle_id');
      customerId = vehicle.customer_id;
      const open = await openCheckin(trx, vehicleId);
      if (open) throw Object.assign(err(409, `Already in the workshop: checked in on ${open.number}.`, 'vehicle_id'), { existingId: open.id });
    }

    // Brought in by: anyone's contact person (a dealer's salesman may bring in an individual's truck).
    if (input.contact_id && !(await trx('customer_contacts').where({ id: input.contact_id }).first('id'))) {
      throw err(422, 'That contact person no longer exists.', 'contact_id');
    }

    const number = await nextNumber(trx, 'checkin');
    const [id] = await trx('checkins').insert({
      number,
      site_id: actor.site.id,
      vehicle_id: vehicleId,
      customer_id: customerId,
      contact_id: input.contact_id ?? null,
      odometer_km: input.odometer_not_working ? null : input.odometer_km,
      odometer_not_working: input.odometer_not_working,
      fuel_quarters: input.fuel_quarters,
      remarks: input.remarks,
      received_by: actor.user.id,
    });
    if (input.items.length) {
      await trx('checkin_items').insert(input.items.map((item, i) => ({ checkin_id: id, ...item, sort_order: i + 1 })));
    }
    const vehicle = await trx('vehicles').where({ id: vehicleId }).first('reg_no', 'chassis_no', 'temp_tag');
    await audit(trx, actor, { entity: 'checkin', id, action: 'create', summary: `Checked in ${vehicleLabel(vehicle)} (${number})` });
    return { id, number };
  });
}

/** The vehicle's check-in that is still open (in the workshop), if any. */
function openCheckin(q, vehicleId) {
  return q('checkins').where({ vehicle_id: vehicleId, status: 'in_workshop' }).first('id', 'number');
}

export async function getCheckin(id) {
  const checkin = await db('checkins')
    .join('vehicles', 'vehicles.id', 'checkins.vehicle_id')
    .join('customers', 'customers.id', 'checkins.customer_id')
    .join('users as receiver', 'receiver.id', 'checkins.received_by')
    .join('sites', 'sites.id', 'checkins.site_id')
    .leftJoin('customer_contacts as contact', 'contact.id', 'checkins.contact_id')
    .leftJoin('customers as contact_company', 'contact_company.id', 'contact.customer_id')
    .where('checkins.id', id)
    .first('checkins.*',
      'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag', 'vehicles.type', 'vehicles.make', 'vehicles.model',
      'customers.name as customer_name', 'customers.number as customer_number', 'customers.phone as customer_phone',
      'contact.name as contact_name', 'contact.role as contact_role', 'contact.phone as contact_phone',
      'contact_company.id as contact_company_id', 'contact_company.name as contact_company',
      'receiver.name as received_by_name', 'sites.name as site_name');
  if (!checkin) return null;
  checkin.items = await db('checkin_items').where({ checkin_id: id }).orderBy('sort_order').select('description', 'quantity');
  return checkin;
}

/** Vehicles in the workshop at a site, newest first. */
export async function listInWorkshop(siteId) {
  return db('checkins')
    .join('vehicles', 'vehicles.id', 'checkins.vehicle_id')
    .join('customers', 'customers.id', 'checkins.customer_id')
    .leftJoin('customer_contacts as contact', 'contact.id', 'checkins.contact_id')
    .where({ 'checkins.status': 'in_workshop', 'checkins.site_id': siteId })
    .orderBy('checkins.checked_in_at', 'desc')
    .limit(200)
    .select('checkins.id', 'checkins.number', 'checkins.checked_in_at', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag',
      'vehicles.make', 'vehicles.model', 'customers.name as customer_name', 'contact.name as contact_name');
}

export async function itemPresets() {
  return db('checkin_item_presets').where({ is_active: true }).orderBy('sort_order').pluck('name');
}

// ---------- lookups for the check-in form ----------

/** Vehicle dropdown: reg, chassis or tag typed any way, or the owner's name. */
export async function lookupVehicles(q) {
  const term = q.trim();
  const key = compact(term);
  if (term.length < 2) return [];
  const rows = await db('vehicles')
    .join('customers', 'customers.id', 'vehicles.customer_id')
    .where((w) => {
      if (key) {
        w.whereRaw("REPLACE(`vehicles`.`reg_no`, ' ', '') LIKE ?", [`%${key}%`])
          .orWhere('vehicles.chassis_no', 'like', `%${key}%`)
          .orWhereRaw("REPLACE(`vehicles`.`temp_tag`, '-', '') LIKE ?", [`%${key}%`]);
      }
      w.orWhere('customers.name', 'like', `%${term}%`);
    })
    .orderBy('vehicles.reg_no').limit(20)
    .select('vehicles.id', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag', 'vehicles.make', 'vehicles.model', 'customers.name as customer_name');
  return rows.map((v) => ({ value: v.id, label: vehicleOptionLabel(v) }));
}

const vehicleOptionLabel = (v) => [vehicleLabel(v), [v.make, v.model].filter(Boolean).join(' '), v.customer_name].filter(Boolean).join(' · ');

/** Everything the form shows once a vehicle is chosen: owner, usual contact, last visit, already in? */
export async function vehicleSummary(id) {
  const v = await db('vehicles')
    .join('customers', 'customers.id', 'vehicles.customer_id')
    .leftJoin('customer_contacts as contact', 'contact.id', 'vehicles.contact_id')
    .where('vehicles.id', id)
    .first('vehicles.id', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag', 'vehicles.type', 'vehicles.make', 'vehicles.model',
      'customers.id as customer_id', 'customers.name as customer_name', 'customers.number as customer_number',
      'contact.id as contact_id', 'contact.name as contact_name', 'contact.role as contact_role');
  if (!v) return null;
  const last = await db('checkins').where({ vehicle_id: id }).whereNot({ status: 'cancelled' })
    .orderBy('checked_in_at', 'desc').first('checked_in_at', 'odometer_km', 'number');
  const open = await openCheckin(db, id);
  return {
    id: v.id,
    label: vehicleOptionLabel(v),
    name: vehicleLabel(v),
    plate: v.reg_no,
    description: [v.make, v.model].filter(Boolean).join(' ') || typeLabel(v.type),
    owner: { id: v.customer_id, name: v.customer_name, number: v.customer_number },
    contact: v.contact_id ? { value: v.contact_id, label: contactLabel({ name: v.contact_name, role: v.contact_role, company: v.customer_name }) } : null,
    lastVisit: last ? { date: last.checked_in_at, odometer: last.odometer_km, number: last.number } : null,
    open: open ?? null,
  };
}

const contactLabel = (c) => [c.name, c.role, c.company].filter(Boolean).join(' · ');

/** "Brought in by" dropdown: contact people of any customer, found by name, phone or company. */
export async function lookupContacts(q) {
  const term = q.trim();
  if (term.length < 2) return [];
  const phone = normalizePhone(term);
  const rows = await db('customer_contacts as c')
    .join('customers', 'customers.id', 'c.customer_id')
    .where((w) => {
      w.where('c.name', 'like', `%${term}%`).orWhere('customers.name', 'like', `%${term}%`);
      if (phone) w.orWhere('c.phone', phone);
    })
    .orderBy('c.name').limit(20)
    .select('c.id', 'c.name', 'c.role', 'customers.name as company');
  return rows.map((c) => ({ value: c.id, label: contactLabel(c) }));
}

/** The option to show in the "Brought in by" dropdown when the form is shown again. */
export async function contactOption(id) {
  if (!id) return null;
  const c = await db('customer_contacts as c').join('customers', 'customers.id', 'c.customer_id')
    .where('c.id', id).first('c.id', 'c.name', 'c.role', 'customers.name as company');
  return c ? { value: c.id, label: contactLabel(c) } : null;
}
