import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { VIEW_CUSTOMERS, EDIT_VEHICLES } from '../../core/access.js';
import { history } from '../../core/audit.js';
import { formatChassis, formatReg } from '../../core/vehicle-format.js';
import { check, httpError, optionalId, optionalText } from '../../core/validate.js';
import * as vehicles from './service.js';
import * as customers from '../customers/service.js';

export const router = Router();
const view = canAny(...VIEW_CUSTOMERS);
const edit = canAny(...EDIT_VEHICLES);

const thisYear = new Date().getFullYear();

const vehicleSchema = z.object({
  reg_no: optionalText(20).transform((v) => v && formatReg(v)),
  chassis_no: optionalText(30).transform((v) => v && formatChassis(v)),
  customer_id: z.coerce.number({ message: 'Choose the customer' }).int().positive('Choose the customer'),
  contact_id: optionalId(),
  type: z.enum(vehicles.VEHICLE_TYPES.map((t) => t.value)).catch('truck'),
  make: optionalText(40),
  model: optionalText(60),
  year: z.union([z.literal(''), z.coerce.number().int().min(1950, 'Check the year').max(thisYear + 1, 'Check the year')])
    .optional().transform((v) => (v ? v : null)),
  body_type: optionalText(60),
  colour: optionalText(30),
  notes: optionalText(2000),
});
// Checked on its own (not as a Zod refine) so it shows together with the other errors.
const NEEDS_ID = 'Enter the reg number, or the chassis number if it has no plates yet';

const blank = { reg_no: '', chassis_no: '', customer_id: '', contact_id: '', type: 'truck', make: '', model: '', year: '', body_type: '', colour: '', notes: '' };

async function renderForm(res, { status = 200, vehicle = null, values, errors = {}, existingId = null }) {
  // The customer and contact dropdowns need their current choice as an option.
  const customer = values.customer_id ? await customers.getCustomer(Number(values.customer_id)) : null;
  const contacts = customer ? await customers.listContacts(customer.id) : [];
  res.status(status).render('vehicles/views/form', {
    title: vehicle ? `Edit ${vehicle.reg_no ?? vehicle.chassis_no}` : 'Add vehicle',
    vehicle, values, errors, customer, existingId,
    customerOption: customer ? [{ value: customer.id, label: `${customer.name} (${customer.number})` }] : [],
    contactOptions: contacts.map((c) => ({ value: c.id, label: [c.name, c.role].filter(Boolean).join(' · ') })),
    types: vehicles.VEHICLE_TYPES,
    categories: customers.CATEGORIES,
  });
}

async function loadVehicle(req) {
  const vehicle = await vehicles.getVehicle(Number(req.params.id));
  if (!vehicle) throw httpError(404, 'That vehicle doesn’t exist.');
  return vehicle;
}

/** Saves, or shows the form again with the problem next to the right field. */
async function save(req, res, vehicle) {
  const values = { ...blank, ...req.body };
  const result = check(vehicleSchema, req.body);
  const errors = { ...result.errors };
  if (!String(req.body.reg_no ?? '').trim() && !String(req.body.chassis_no ?? '').trim()) errors.reg_no ??= NEEDS_ID;
  if (Object.keys(errors).length) return renderForm(res, { status: 422, vehicle, values, errors });
  const { data } = result;
  try {
    const id = vehicle ? (await vehicles.updateVehicle(vehicle.id, data, req), vehicle.id) : await vehicles.createVehicle(data, req);
    const name = data.reg_no ?? data.chassis_no;
    req.session.flash = { type: 'success', text: vehicle ? `Saved changes to ${name}.` : `${name} added.` };
    res.redirect(`/vehicles/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(res, { status: 422, vehicle, values, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
}

router.get('/vehicles', view, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const type = vehicles.VEHICLE_TYPES.some((t) => t.value === req.query.type) ? req.query.type : '';
  res.render('vehicles/views/index', {
    title: 'Vehicles', list: await vehicles.listVehicles({ q, type }), q, type,
    types: vehicles.VEHICLE_TYPES, typeLabel: vehicles.typeLabel,
  });
});

router.get('/vehicles/new', edit, (req, res) => {
  // From a customer's page: ?customer_id=12 fills the customer in.
  renderForm(res, { values: { ...blank, customer_id: req.query.customer_id ?? '' } });
});

router.post('/vehicles', edit, (req, res) => save(req, res, null));

router.get('/vehicles/:id', view, async (req, res) => {
  const vehicle = await loadVehicle(req);
  res.render('vehicles/views/show', {
    title: vehicle.reg_no ?? vehicle.chassis_no,
    vehicle,
    entries: await history('vehicle', vehicle.id),
    typeLabel: vehicles.typeLabel,
    canEdit: EDIT_VEHICLES.some((p) => req.user.can(p)),
  });
});

router.get('/vehicles/:id/edit', edit, async (req, res) => {
  const vehicle = await loadVehicle(req);
  const values = Object.fromEntries(Object.keys(blank).map((k) => [k, vehicle[k] ?? '']));
  renderForm(res, { vehicle, values });
});

router.post('/vehicles/:id', edit, async (req, res) => save(req, res, await loadVehicle(req)));

// While typing: "KDA 123A is already registered to Mwangi Transporters. Open it"
router.get('/api/vehicles/check', view, async (req, res) => {
  const reg_no = req.query.reg ? formatReg(String(req.query.reg)) : null;
  const chassis_no = req.query.chassis ? formatChassis(String(req.query.chassis)) : null;
  const match = await vehicles.findDuplicate({ reg_no, chassis_no }, Number(req.query.except) || null);
  res.json({ match: match ?? null });
});
