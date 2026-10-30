import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { VIEW_CUSTOMERS } from '../../core/access.js';
import { history } from '../../core/audit.js';
import { formatChassis, formatReg, vehicleLabel } from '../../core/vehicle-format.js';
import { check, httpError, optionalId, optionalText } from '../../core/validate.js';
import * as checkins from './service.js';
import * as customers from '../customers/service.js';
import { VEHICLE_TYPES, typeLabel } from '../vehicles/service.js';

export const router = Router();
const view = canAny(...VIEW_CUSTOMERS);
const manage = canAny('checkin.manage');

const ticked = z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean());
// "123,456" and "123 456 km" are both 123456.
const odometer = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/[^\d]/g, '') : v),
  z.union([z.literal(''), z.coerce.number().int().max(9_999_999, 'Check the reading')]).optional().transform((v) => (v === '' || v === undefined ? null : v)),
);

const checkinSchema = z.object({
  vehicle_mode: z.enum(['existing', 'new']).catch('existing'),
  vehicle_id: optionalId(),
  contact_id: optionalId(),
  odometer_km: odometer,
  odometer_not_working: ticked,
  fuel_quarters: z.union([z.literal(''), z.coerce.number().int().min(0).max(4)]).optional().catch('').transform((v) => (v === '' || v === undefined ? null : v)),
  remarks: optionalText(2000),
});

// Only checked when "New vehicle" is chosen.
const newVehicleSchema = z.object({
  reg_no: optionalText(20).transform((v) => v && formatReg(v)),
  chassis_no: optionalText(30).transform((v) => v && formatChassis(v)),
  issue_tag: ticked,
  customer_id: z.coerce.number({ message: 'Choose the owner' }).int().positive('Choose the owner'),
  type: z.enum(VEHICLE_TYPES.map((t) => t.value)).catch('truck'),
  make: optionalText(40),
  model: optionalText(60),
});

const blank = {
  vehicle_mode: 'existing', vehicle_id: '', contact_id: '', odometer_km: '', odometer_not_working: '', fuel_quarters: '', remarks: '',
  reg_no: '', chassis_no: '', issue_tag: '', customer_id: '', type: 'truck', make: '', model: '',
};

/** Item rows arrive as two lists, item_description and item_quantity; empty rows are skipped. */
function readItems(body) {
  const descriptions = [].concat(body.item_description ?? []);
  const quantities = [].concat(body.item_quantity ?? []);
  const rows = descriptions.map((d, i) => ({ description: String(d ?? '').trim(), quantity: String(quantities[i] ?? '').trim() }));
  const items = [];
  let error = null;
  for (const row of rows) {
    if (!row.description) continue;
    const qty = row.quantity === '' ? 1 : Number(row.quantity);
    if (row.description.length > 120) error ??= `Keep “${row.description.slice(0, 30)}…” to 120 characters`;
    else if (!Number.isInteger(qty) || qty < 1 || qty > 999) error ??= `Check the quantity for “${row.description}” (1 to 999)`;
    else items.push({ description: row.description, quantity: qty });
  }
  return { rows, items, error };
}

async function renderForm(res, { status = 200, values, rows = [], errors = {}, existingId = null }) {
  const vehicle = values.vehicle_mode !== 'new' && values.vehicle_id ? await checkins.vehicleSummary(Number(values.vehicle_id)) : null;
  const owner = values.vehicle_mode === 'new' && values.customer_id ? await customers.getCustomer(Number(values.customer_id)) : null;
  res.status(status).render('checkins/views/form', {
    title: 'New check-in',
    values, errors, existingId, vehicle,
    rows: rows.length ? rows : [{ description: '', quantity: '1' }],
    contact: await checkins.contactOption(Number(values.contact_id) || null),
    ownerOption: owner ? [{ value: owner.id, label: `${owner.name} (${owner.number})` }] : [],
    presets: await checkins.itemPresets(),
    fuelLevels: checkins.FUEL_LEVELS,
    types: VEHICLE_TYPES,
    categories: customers.CATEGORIES,
  });
}

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) before checking a vehicle in.');
}

router.get('/check-in', view, async (req, res) => {
  needSite(req);
  res.render('checkins/views/index', {
    title: 'Check-in',
    list: await checkins.listInWorkshop(req.site.id),
    vehicleLabel,
    canCheckIn: req.user.can('checkin.manage'),
  });
});

router.get('/check-in/new', manage, async (req, res) => {
  needSite(req);
  // From a vehicle's page: ?vehicle_id=12 fills the vehicle in, with its usual contact.
  const values = { ...blank };
  const vehicle = req.query.vehicle_id ? await checkins.vehicleSummary(Number(req.query.vehicle_id)) : null;
  if (vehicle) Object.assign(values, { vehicle_id: vehicle.id, contact_id: vehicle.contact?.value ?? '' });
  renderForm(res, { values });
});

router.post('/check-in', manage, async (req, res) => {
  needSite(req);
  const values = { ...blank, ...req.body };
  const { rows, items, error: itemsError } = readItems(req.body);
  const result = check(checkinSchema, req.body);
  const errors = { ...result.errors };
  let newVehicle = null;

  if (result.data?.vehicle_mode === 'new' || values.vehicle_mode === 'new') {
    const v = check(newVehicleSchema, req.body);
    Object.assign(errors, v.errors);
    // From the raw input, so it shows even when other fields are wrong too.
    const typed = (k) => String(req.body[k] ?? '').trim();
    if (!['1', 'on'].includes(req.body.issue_tag) && !typed('reg_no') && !typed('chassis_no')) {
      errors.reg_no ??= 'Enter the reg or chassis number, or tick “issue a temporary tag”';
    }
    newVehicle = v.data;
  } else if (!result.data?.vehicle_id) {
    errors.vehicle_id ??= 'Choose the vehicle, or switch to “New vehicle”';
  }
  if (itemsError) errors.items = itemsError;
  if (Object.keys(errors).length) return renderForm(res, { status: 422, values, rows, errors });

  try {
    const { id, number } = await checkins.createCheckin({ ...result.data, new_vehicle: newVehicle, items }, req);
    req.session.flash = { type: 'success', text: `Checked in: ${number}.` };
    res.redirect(`/check-in/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(res, { status: 422, values, rows, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
});

router.get('/check-in/:id', view, async (req, res) => {
  const checkin = await checkins.getCheckin(Number(req.params.id));
  if (!checkin) throw httpError(404, 'That check-in doesn’t exist.');
  res.render('checkins/views/show', {
    title: checkin.number,
    checkin,
    vehicleLabel, typeLabel,
    status: checkins.STATUSES[checkin.status],
    fuel: checkins.fuelLabel(checkin.fuel_quarters),
    entries: await history('checkin', checkin.id),
  });
});

// ---------- lookups used by the form ----------

router.get('/api/check-in/vehicles', manage, async (req, res) => {
  res.json(await checkins.lookupVehicles(String(req.query.q ?? '')));
});

router.get('/api/check-in/vehicles/:id', manage, async (req, res) => {
  const summary = await checkins.vehicleSummary(Number(req.params.id));
  if (!summary) return res.status(404).json({ error: 'Not found' });
  res.json(summary);
});

router.get('/api/check-in/contacts', manage, async (req, res) => {
  res.json(await checkins.lookupContacts(String(req.query.q ?? '')));
});
