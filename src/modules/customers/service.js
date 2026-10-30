import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { normalizePhone } from '../../core/phone.js';
import { compact } from '../../core/vehicle-format.js';
import { httpError } from '../../core/validate.js';

export const CATEGORIES = [
  { value: 'individual', label: 'Individual' },
  { value: 'company', label: 'Company' },
  { value: 'government', label: 'Government' },
  { value: 'ngo', label: 'NGO' },
];
export const categoryLabel = (value) => CATEGORIES.find((c) => c.value === value)?.label ?? value;

export const CREDIT_TERMS = [
  { value: 0, label: 'Cash' },
  { value: 7, label: '7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
  { value: 60, label: '60 days' },
];
export const creditLabel = (days) => CREDIT_TERMS.find((c) => c.value === Number(days))?.label ?? `${days} days`;

/** What the history shows for a customer. */
function snapshot(c) {
  return {
    name: c.name,
    category: categoryLabel(c.category),
    phone: c.phone,
    email: c.email,
    kra_pin: c.kra_pin,
    town: c.town,
    address: c.address,
    credit_days: creditLabel(c.credit_days),
    notes: c.notes,
  };
}
const contactText = (c) => [c.name, c.role, c.phone].filter(Boolean).join(' · ');

const COLUMNS = ['name', 'category', 'phone', 'email', 'kra_pin', 'town', 'address', 'credit_days', 'notes'];
const pick = (input) => Object.fromEntries(COLUMNS.filter((k) => k in input).map((k) => [k, input[k] ?? null]));

/**
 * Adds a customer, numbered CUS-0001…, optionally with a first contact person.
 * @returns {Promise<{ id: number, number: string }>}
 */
export async function createCustomer(input, actor, { contact = null } = {}) {
  return db.transaction(async (trx) => {
    await assertKraPinFree(trx, input.kra_pin);
    const number = await nextNumber(trx, 'customer');
    const row = { credit_days: 0, ...pick(input), number, created_by: actor?.user?.id ?? null };
    const [id] = await trx('customers').insert(row);
    await audit(trx, actor, { entity: 'customer', id, action: 'create', after: { number, ...snapshot(row) } });

    if (contact?.name) {
      await trx('customer_contacts').insert({ customer_id: id, ...contact });
      await audit(trx, actor, { entity: 'customer', id, action: 'contact_added', summary: contactText(contact) });
    }
    return { id, number };
  });
}

export async function updateCustomer(id, input, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('customers').where({ id }).first();
    if (!before) throw httpError(404, 'That customer no longer exists.');
    await assertKraPinFree(trx, input.kra_pin, id);
    const changes = pick(input);
    await trx('customers').where({ id }).update(changes);
    await audit(trx, actor, { entity: 'customer', id, action: 'update', before: snapshot(before), after: snapshot({ ...before, ...changes }) });
  });
}

export async function getCustomer(id) {
  return db('customers').where({ id }).first();
}

export async function listCustomers({ q = '', category = '' } = {}) {
  const query = db('customers')
    .leftJoin('vehicles', 'vehicles.customer_id', 'customers.id')
    .groupBy('customers.id')
    .select('customers.id', 'customers.number', 'customers.name', 'customers.category', 'customers.phone', 'customers.town', 'customers.created_at')
    .count('vehicles.id as vehicle_count')
    .orderBy('customers.name')
    .limit(200);
  if (category) query.where('customers.category', category);
  const term = q.trim();
  if (term) {
    const phone = normalizePhone(term);
    query.where((w) => {
      w.where('customers.name', 'like', `%${term}%`)
        .orWhere('customers.number', 'like', `%${term}%`)
        .orWhere('customers.kra_pin', term.toUpperCase());
      if (phone) w.orWhere('customers.phone', phone);
    });
  }
  return query;
}

/** Customers already using this phone number (for the "Existing customer?" warning). */
export async function findByPhone(phone, exceptId = null) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const q = db('customers').where({ phone: normalized }).select('id', 'number', 'name');
  if (exceptId) q.whereNot({ id: exceptId });
  return q;
}

/** For searchable dropdowns: [{ value, label }] */
export async function lookupCustomers(q) {
  const term = q.trim();
  if (term.length < 2) return [];
  const phone = normalizePhone(term);
  const rows = await db('customers')
    .where((w) => {
      w.where('name', 'like', `%${term}%`).orWhere('number', 'like', `%${term}%`);
      if (phone) w.orWhere('phone', phone);
    })
    .orderBy('name').limit(20).select('id', 'name', 'number', 'category');
  return rows.map((c) => ({ value: c.id, label: `${c.name} (${c.number})`, category: c.category }));
}

// ---------- Contacts ----------

export async function listContacts(customerId) {
  return db('customer_contacts').where({ customer_id: customerId }).orderBy('name');
}

export async function addContact(customerId, contact, actor) {
  await db.transaction(async (trx) => {
    const [id] = await trx('customer_contacts').insert({ customer_id: customerId, ...contact });
    await audit(trx, actor, { entity: 'customer', id: customerId, action: 'contact_added', summary: contactText(contact) });
    return id;
  });
}

export async function updateContact(customerId, contactId, contact, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('customer_contacts').where({ id: contactId, customer_id: customerId }).first();
    if (!before) throw httpError(404, 'That contact no longer exists.');
    await trx('customer_contacts').where({ id: contactId }).update(contact);
    const was = contactText(before);
    const now = contactText({ ...before, ...contact });
    if (was !== now) await audit(trx, actor, { entity: 'customer', id: customerId, action: 'contact_changed', before: { contact: was }, after: { contact: now } });
  });
}

export async function removeContact(customerId, contactId, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('customer_contacts').where({ id: contactId, customer_id: customerId }).first();
    if (!before) return;
    await trx('customer_contacts').where({ id: contactId }).delete(); // vehicles linked to them keep working (contact set to none)
    await audit(trx, actor, { entity: 'customer', id: customerId, action: 'contact_removed', summary: contactText(before) });
  });
}

// ---------- Vehicles of a customer ----------

export async function vehiclesOf(customerId) {
  return db('vehicles')
    .leftJoin('customer_contacts', 'customer_contacts.id', 'vehicles.contact_id')
    .where('vehicles.customer_id', customerId)
    .orderBy('vehicles.reg_no')
    .select('vehicles.*', 'customer_contacts.name as contact_name');
}

// ---------- Global search ----------

/** Top-bar search: vehicles by reg / chassis, customers by name / phone / number / KRA PIN. */
export async function globalSearch(q, { limit = 8 } = {}) {
  const term = q.trim();
  if (term.length < 2) return { vehicles: [], customers: [] };
  const key = compact(term);
  const phone = normalizePhone(term);

  const vehicles = key.length >= 2 ? await db('vehicles')
    .join('customers', 'customers.id', 'vehicles.customer_id')
    .where((w) => {
      w.whereRaw("REPLACE(`vehicles`.`reg_no`, ' ', '') LIKE ?", [`%${key}%`])
        .orWhere('vehicles.chassis_no', 'like', `%${key}%`);
    })
    .orderBy('vehicles.reg_no').limit(limit)
    .select('vehicles.id', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.make', 'vehicles.model', 'customers.name as customer_name') : [];

  const customers = await db('customers')
    .where((w) => {
      w.where('name', 'like', `%${term}%`).orWhere('number', term.toUpperCase()).orWhere('kra_pin', term.toUpperCase());
      if (phone) w.orWhere('phone', phone);
    })
    .orderBy('name').limit(limit)
    .select('id', 'number', 'name', 'phone', 'category');

  return { vehicles, customers };
}

// ---------- checks ----------

async function assertKraPinFree(trx, kraPin, exceptId) {
  if (!kraPin) return;
  const q = trx('customers').where({ kra_pin: kraPin });
  if (exceptId) q.whereNot({ id: exceptId });
  const taken = await q.first('name', 'number');
  if (taken) throw Object.assign(httpError(409, `This KRA PIN already belongs to ${taken.name} (${taken.number}).`), { field: 'kra_pin' });
}
