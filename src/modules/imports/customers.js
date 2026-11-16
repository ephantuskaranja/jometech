import { db } from '../../core/db.js';
import { normalizePhone, formatPhone } from '../../core/phone.js';
import { formatReg, formatChassis, formatKraPin } from '../../core/vehicle-format.js';
import { CATEGORIES, CREDIT_TERMS, createCustomer } from '../customers/service.js';
import { VEHICLE_TYPES, createVehicle } from '../vehicles/service.js';
import { template as makeTemplate } from './sheet.js';

// Import: customers and their vehicles. Same rules as the forms: phones and KRA PINs tidied, reg and
// chassis numbers formatted. Someone already on file (same phone) or a vehicle already registered is
// skipped, never duplicated. A vehicle belongs to the customer with that phone, in the file or the app.

export const KIND = 'customers';
export const TITLE = 'Customers and vehicles';

const CUSTOMER_FIELDS = { name: 'Name', phone: 'Phone', category: 'Category', kra_pin: 'KRA PIN', email: 'Email', town: 'Town', address: 'Address', credit: 'Credit terms', notes: 'Notes' };
const VEHICLE_FIELDS = { customer_phone: 'Customer phone', reg_no: 'Reg no', chassis_no: 'Chassis no', type: 'Type', make: 'Make', model: 'Model', year: 'Year', body_type: 'Body type', colour: 'Colour', notes: 'Notes' };
export const SHEETS = [
  { name: 'Customers', fields: CUSTOMER_FIELDS, label: 'customer' },
  { name: 'Vehicles', fields: VEHICLE_FIELDS, label: 'vehicle' },
];

export function template() {
  return makeTemplate([
    { name: 'Customers', columns: [['Name', 30, true], ['Phone', 16, true, true], ['Category', 16], ['KRA PIN', 14, false, true], ['Email', 26], ['Town', 16], ['Address', 30], ['Credit terms', 14], ['Notes', 30]],
      example: ['Mwangi Haulage Ltd', '0712 345 678', 'Company', 'P051234567X', 'info@mwangi.co.ke', 'Thika', 'Thika Road, Plot 12', '30 days', ''] },
    { name: 'Vehicles', columns: [['Customer phone', 16, true, true], ['Reg no', 12, false, true], ['Chassis no', 22, false, true], ['Type', 14], ['Make', 14], ['Model', 16], ['Year', 8], ['Body type', 16], ['Colour', 12], ['Notes', 30]],
      example: ['0712 345 678', 'KDA 123A', 'JALFVR34N7000123', 'Truck', 'Isuzu', 'FVR 34', '2019', 'Tipper', 'White', ''] },
  ], [
    ['Customers', 'One row per customer. Name and phone are needed. A phone already in the app is skipped (the customer is already there).'],
    ['Category', `${CATEGORIES.map((c) => c.label).join(', ')}. Empty = Individual.`],
    ['Credit terms', `${CREDIT_TERMS.map((c) => c.label).join(', ')}. Empty = Cash.`],
    ['KRA PIN', 'Optional. Looks like A123456789B.'],
    ['Vehicles', 'One row per vehicle. Customer phone links it to its owner: a customer in this file or already in the app. A reg number or a chassis number is needed (chassis only for a new vehicle with no plates).'],
    ['Type', `${VEHICLE_TYPES.map((t) => t.label).join(', ')}. Empty = Truck.`],
    ['Phones', 'Type them as you would dial: 0712 345 678. If Excel dropped the 0 (712345678), that’s fine too.'],
  ]);
}

const pickFrom = (list, text, fallback) => {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return { value: fallback };
  const found = list.find((x) => String(x.value).toLowerCase() === t || x.label.toLowerCase() === t || x.label.toLowerCase().startsWith(t));
  return found ? { value: found.value } : { error: `“${text}” isn’t one of: ${list.map((x) => x.label).join(', ')}` };
};
const limit = (s, n) => (s ? String(s).slice(0, n) : null);

/** "30 days", "30", "Cash" or empty → 30 / 30 / 0 / 0; anything else isn't one of the terms. */
function creditDays(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t || t === 'cash') return { value: 0 };
  const days = Number(t.replace(/\s*days?$/, ''));
  return CREDIT_TERMS.some((c) => c.value === days) ? { value: days } : { error: `“${text}” isn’t one of: ${CREDIT_TERMS.map((c) => c.label).join(', ')}` };
}

/**
 * Checks every row. Each row gets status 'add' | 'skip' | 'error', a message and the clean data.
 * @param {{ Customers: object[], Vehicles: object[] }} sheets rows from readSheet
 */
export async function check(sheets) {
  const customers = [];
  const phones = new Map(); // phone → 'file' | existing customer
  const pins = new Set();
  for (const r of sheets.Customers ?? []) {
    const problems = [];
    const name = r.name.replace(/\s+/g, ' ').trim();
    if (name.length < 2) problems.push('Name is missing');
    const phone = normalizePhone(r.phone);
    if (!phone) problems.push(r.phone ? `“${r.phone}” isn’t a phone number` : 'Phone is missing');
    const category = pickFrom(CATEGORIES, r.category, 'individual');
    if (category.error) problems.push(`Category: ${category.error}`);
    const credit = creditDays(r.credit);
    if (credit.error) problems.push(`Credit terms: ${credit.error}`);
    const kraPin = r.kra_pin ? formatKraPin(r.kra_pin) : null;
    if (r.kra_pin && !kraPin) problems.push(`KRA PIN “${r.kra_pin}” should look like A123456789B`);
    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) problems.push(`“${r.email}” isn’t an email address`);
    const data = { name: limit(name, 150), phone, category: category.value, kra_pin: kraPin, email: limit(r.email, 150) || null,
      town: limit(r.town, 80), address: limit(r.address, 255), credit_days: credit.value ?? 0, notes: limit(r.notes, 2000) };

    let status = 'add';
    let message = '';
    if (problems.length) { status = 'error'; message = problems.join('; '); }
    else if (phones.has(phone)) { status = 'error'; message = `Phone ${formatPhone(phone)} is already on row ${phones.get(phone).row} of this sheet`; }
    else {
      const existing = await db('customers').where({ phone }).first('id', 'name', 'number');
      if (existing) { status = 'skip'; message = `Already in the app: ${existing.name} (${existing.number})`; data.existing_id = existing.id; }
      else if (kraPin && (pins.has(kraPin) || await db('customers').where({ kra_pin: kraPin }).first('id'))) { status = 'error'; message = `KRA PIN ${kraPin} already belongs to another customer`; }
    }
    if (phone && !phones.has(phone)) phones.set(phone, { row: r.row, status });
    if (kraPin && status === 'add') pins.add(kraPin);
    customers.push({ row: r.row, status, message, data, show: [name, phone ? formatPhone(phone) : r.phone, CATEGORIES.find((c) => c.value === data.category)?.label] });
  }

  const vehicles = [];
  const plates = new Map();
  for (const r of sheets.Vehicles ?? []) {
    const problems = [];
    const ownerPhone = normalizePhone(r.customer_phone);
    let owner = null;
    if (!ownerPhone) problems.push(r.customer_phone ? `“${r.customer_phone}” isn’t a phone number` : 'Customer phone is missing');
    else {
      const inFile = phones.get(ownerPhone);
      if (inFile && inFile.status === 'error') problems.push(`Its customer (row ${inFile.row}) has a problem`);
      else if (inFile) owner = { phone: ownerPhone };
      else {
        const existing = await db('customers').where({ phone: ownerPhone }).first('id', 'name');
        if (existing) owner = { phone: ownerPhone, id: existing.id };
        else problems.push(`No customer with phone ${formatPhone(ownerPhone)} in this file or the app`);
      }
    }
    const regNo = r.reg_no ? formatReg(r.reg_no) : null;
    const chassisNo = r.chassis_no ? formatChassis(r.chassis_no) : null;
    if (!regNo && !chassisNo) problems.push('Give the reg number, or the chassis number');
    const type = pickFrom(VEHICLE_TYPES, r.type, 'truck');
    if (type.error) problems.push(`Type: ${type.error}`);
    const year = r.year ? Number(r.year) : null;
    if (r.year && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1)) problems.push(`Check the year “${r.year}”`);
    const data = { owner_phone: ownerPhone, customer_id: owner?.id ?? null, reg_no: regNo, chassis_no: chassisNo, type: type.value,
      make: limit(r.make, 40), model: limit(r.model, 60), year, body_type: limit(r.body_type, 60), colour: limit(r.colour, 30), notes: limit(r.notes, 2000) };

    let status = 'add';
    let message = '';
    if (problems.length) { status = 'error'; message = problems.join('; '); }
    else {
      const seen = [regNo, chassisNo].filter(Boolean).find((p) => plates.has(p));
      if (seen) { status = 'error'; message = `${seen} is already on row ${plates.get(seen)} of this sheet`; }
      else {
        const existing = await db('vehicles as v').join('customers as c', 'c.id', 'v.customer_id')
          .where((w) => { if (regNo) w.orWhere('v.reg_no', regNo); if (chassisNo) w.orWhere('v.chassis_no', chassisNo); })
          .first('v.reg_no', 'v.chassis_no', 'c.name');
        if (existing) { status = 'skip'; message = `Already registered, to ${existing.name}`; }
      }
    }
    for (const p of [regNo, chassisNo].filter(Boolean)) if (!plates.has(p)) plates.set(p, r.row);
    vehicles.push({ row: r.row, status, message, data, show: [regNo ?? chassisNo ?? '', [data.make, data.model].filter(Boolean).join(' '), ownerPhone ? formatPhone(ownerPhone) : r.customer_phone] });
  }
  return { Customers: customers, Vehicles: vehicles };
}

/** Adds the rows marked 'add'. Returns what was added and any rows that failed on the way. */
export async function run(sheets, actor) {
  const ids = new Map();
  const failed = [];
  let customersAdded = 0;
  let vehiclesAdded = 0;
  for (const c of sheets.Customers) {
    if (c.status === 'skip') ids.set(c.data.phone, c.data.existing_id);
    if (c.status !== 'add') continue;
    // Added in the app since the preview? Then it's there already.
    const since = await db('customers').where({ phone: c.data.phone }).first('id');
    if (since) { ids.set(c.data.phone, since.id); continue; }
    try {
      const { existing_id: _, ...data } = c.data;
      const { id } = await createCustomer(data, actor);
      ids.set(c.data.phone, id);
      customersAdded++;
    } catch (err) {
      failed.push(`Customers row ${c.row}: ${err.message}`);
    }
  }
  for (const v of sheets.Vehicles) {
    if (v.status !== 'add') continue;
    const customerId = v.data.customer_id ?? ids.get(v.data.owner_phone) ?? (await db('customers').where({ phone: v.data.owner_phone }).first('id'))?.id;
    if (!customerId) { failed.push(`Vehicles row ${v.row}: its customer wasn’t added`); continue; }
    try {
      const { owner_phone: _, ...data } = v.data;
      await createVehicle({ ...data, customer_id: customerId }, actor);
      vehiclesAdded++;
    } catch (err) {
      failed.push(`Vehicles row ${v.row}: ${err.message}`);
    }
  }
  return { summary: `${customersAdded} customer${customersAdded === 1 ? '' : 's'} and ${vehiclesAdded} vehicle${vehiclesAdded === 1 ? '' : 's'} added`, failed };
}
