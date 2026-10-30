import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { compact } from '../../core/vehicle-format.js';
import { httpError } from '../../core/validate.js';

export const VEHICLE_TYPES = [
  { value: 'truck', label: 'Truck' },
  { value: 'trailer', label: 'Trailer' },
  { value: 'semi_trailer', label: 'Semi-trailer' },
  { value: 'pickup', label: 'Pickup' },
  { value: 'van', label: 'Van' },
  { value: 'bus', label: 'Bus' },
  { value: 'other', label: 'Other' },
];
export const typeLabel = (value) => VEHICLE_TYPES.find((t) => t.value === value)?.label ?? value;

const COLUMNS = ['reg_no', 'chassis_no', 'temp_tag', 'customer_id', 'contact_id', 'type', 'make', 'model', 'year', 'body_type', 'colour', 'notes'];
const pick = (input) => Object.fromEntries(COLUMNS.filter((k) => k in input).map((k) => [k, input[k] ?? null]));

/** What the history shows for a vehicle: names, not ids. */
async function snapshot(trx, v) {
  const customer = v.customer_id ? await trx('customers').where({ id: v.customer_id }).first('name') : null;
  const contact = v.contact_id ? await trx('customer_contacts').where({ id: v.contact_id }).first('name') : null;
  return {
    reg_no: v.reg_no, chassis_no: v.chassis_no, temp_tag: v.temp_tag ?? null, customer: customer?.name ?? null, contact: contact?.name ?? null,
    type: typeLabel(v.type), make: v.make, model: v.model, year: v.year, body_type: v.body_type, colour: v.colour, notes: v.notes,
  };
}

/** `outer`: a transaction to join (check-in saves the new vehicle and the check-in together). */
export async function createVehicle(input, actor, outer = null) {
  const run = (fn) => (outer ? fn(outer) : db.transaction(fn));
  return run(async (trx) => {
    const row = pick(input);
    await checkRules(trx, row);
    const [id] = await trx('vehicles').insert({ ...row, created_by: actor?.user?.id ?? null });
    await audit(trx, actor, { entity: 'vehicle', id, action: 'create', after: await snapshot(trx, row) });
    return id;
  });
}

export async function updateVehicle(id, input, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('vehicles').where({ id }).first();
    if (!before) throw httpError(404, 'That vehicle no longer exists.');
    const row = pick(input);
    await checkRules(trx, row, id);
    await trx('vehicles').where({ id }).update(row);
    await audit(trx, actor, { entity: 'vehicle', id, action: 'update', before: await snapshot(trx, before), after: await snapshot(trx, { ...before, ...row }) });
  });
}

export async function getVehicle(id) {
  return db('vehicles')
    .join('customers', 'customers.id', 'vehicles.customer_id')
    .leftJoin('customer_contacts', 'customer_contacts.id', 'vehicles.contact_id')
    .where('vehicles.id', id)
    .first('vehicles.*', 'customers.name as customer_name', 'customers.number as customer_number', 'customers.phone as customer_phone',
      'customer_contacts.name as contact_name', 'customer_contacts.role as contact_role', 'customer_contacts.phone as contact_phone');
}

export async function listVehicles({ q = '', type = '' } = {}) {
  const query = db('vehicles')
    .join('customers', 'customers.id', 'vehicles.customer_id')
    .leftJoin('customer_contacts', 'customer_contacts.id', 'vehicles.contact_id')
    .orderBy('vehicles.reg_no')
    .limit(200)
    .select('vehicles.id', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag', 'vehicles.type', 'vehicles.make', 'vehicles.model', 'vehicles.body_type',
      'customers.id as customer_id', 'customers.name as customer_name', 'customer_contacts.name as contact_name');
  if (type) query.where('vehicles.type', type);
  const term = q.trim();
  if (term) {
    const key = compact(term);
    query.where((w) => {
      if (key) {
        w.whereRaw("REPLACE(`vehicles`.`reg_no`, ' ', '') LIKE ?", [`%${key}%`]).orWhere('vehicles.chassis_no', 'like', `%${key}%`)
          .orWhereRaw("REPLACE(`vehicles`.`temp_tag`, '-', '') LIKE ?", [`%${key}%`]);
      }
      w.orWhere('customers.name', 'like', `%${term}%`);
    });
  }
  return query;
}

/** Another vehicle already using this reg or chassis number (for the warning while typing). */
export async function findDuplicate({ reg_no, chassis_no }, exceptId = null) {
  if (!reg_no && !chassis_no) return null;
  const q = db('vehicles').join('customers', 'customers.id', 'vehicles.customer_id')
    .where((w) => {
      if (reg_no) w.orWhere('vehicles.reg_no', reg_no);
      if (chassis_no) w.orWhere('vehicles.chassis_no', chassis_no);
    })
    .first('vehicles.id', 'vehicles.reg_no', 'vehicles.chassis_no', 'customers.name as customer_name');
  if (exceptId) q.whereNot('vehicles.id', exceptId);
  return q;
}

// ---------- rules ----------

async function checkRules(trx, row, exceptId = null) {
  // The contact must belong to this vehicle's customer.
  if (row.contact_id) {
    const ok = await trx('customer_contacts').where({ id: row.contact_id, customer_id: row.customer_id }).first('id');
    if (!ok) throw Object.assign(httpError(422, 'Choose a contact person from this customer.'), { field: 'contact_id' });
  }
  for (const [field, label] of [['reg_no', 'reg number'], ['chassis_no', 'chassis number']]) {
    if (!row[field]) continue;
    const q = trx('vehicles').join('customers', 'customers.id', 'vehicles.customer_id').where(`vehicles.${field}`, row[field]);
    if (exceptId) q.whereNot('vehicles.id', exceptId);
    const taken = await q.first('vehicles.id', 'customers.name');
    if (taken) {
      throw Object.assign(httpError(409, `This ${label} is already registered, to ${taken.name}.`), { field, existingId: taken.id });
    }
  }
}
