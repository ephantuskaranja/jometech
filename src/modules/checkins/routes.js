import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { VIEW_CUSTOMERS } from '../../core/access.js';
import { history } from '../../core/audit.js';
import { formatChassis, formatReg, vehicleLabel } from '../../core/vehicle-format.js';
import { check, httpError, optionalId, optionalPhone, optionalReading, optionalText } from '../../core/validate.js';
import { storagePath } from '../../core/storage.js';
import * as checkins from './service.js';
import * as movements from '../movements/service.js';
import { forCheckin, STATUSES as JOB_STATUSES } from '../jobs/service.js';
import { fmt } from '../../core/format.js';
import { config } from '../../config.js';
import * as customers from '../customers/service.js';
import { VEHICLE_TYPES, typeLabel } from '../vehicles/service.js';

export const router = Router();
const view = canAny(...VIEW_CUSTOMERS);
const manage = canAny('checkin.manage');

const ticked = z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean());
const odometer = optionalReading();

const checkinSchema = z.object({
  vehicle_mode: z.enum(['existing', 'new']).catch('existing'),
  vehicle_id: optionalId(),
  contact_id: optionalId(),
  brought_by_phone: optionalPhone(),
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
  vehicle_mode: 'existing', vehicle_id: '', contact_id: '', brought_by_phone: '', odometer_km: '', odometer_not_working: '', fuel_quarters: '', remarks: '',
  reg_no: '', chassis_no: '', issue_tag: '', customer_id: '', type: 'truck', make: '', model: '',
};

/**
 * "Brought in by" is a saved contact (an id) or, for anyone else, the name as typed:
 * the dropdown sends "name:Eunice Wairimu" (data-tom-free in public/js/app.js).
 */
function broughtByName(value) {
  const s = String(value ?? '');
  return s.startsWith('name:') ? s.slice(5).trim().replace(/\s+/g, ' ') : null;
}

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
    contact: broughtByName(values.contact_id) !== null
      ? { value: values.contact_id, label: `${broughtByName(values.contact_id)} (not a saved contact)` }
      : await checkins.contactOption(Number(values.contact_id) || null),
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
  const tab = ['out', 'moves'].includes(req.query.show) ? req.query.show : 'in';
  res.render('checkins/views/index', {
    title: 'Check-in',
    tab,
    list: tab === 'moves' ? [] : await checkins.listCheckins(req.site.id, tab === 'out' ? 'checked_out' : 'in_workshop'),
    moves: tab === 'moves' ? await movements.listMovements(req.site.id) : [],
    arriving: tab === 'in' ? await movements.arriving(req.site.id) : [],
    hasOtherSites: (await movements.otherSites(req.site.id)).length > 0,
    inCount: await checkins.countInWorkshop(req.site.id),
    vehicleLabel, daysIn: checkins.daysIn,
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
  const typedName = broughtByName(req.body.contact_id);
  const result = check(checkinSchema, { ...req.body, contact_id: typedName === null ? req.body.contact_id : '' });
  const errors = { ...result.errors };
  if (typedName !== null && (typedName.length < 2 || typedName.length > 100)) errors.contact_id = 'Type their full name (2 to 100 characters)';
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
    const brought = typedName ? { brought_by_name: typedName, brought_by_phone: result.data.brought_by_phone } : { brought_by_name: null, brought_by_phone: null };
    const { id, number } = await checkins.createCheckin({ ...result.data, ...brought, new_vehicle: newVehicle, items }, req);
    req.session.flash = { type: 'success', text: `Saved as ${number}. Now hand the device to the driver to confirm.` };
    res.redirect(`/check-in/${id}/sign`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(res, { status: 422, values, rows, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
});

router.get('/check-in/:id', view, async (req, res) => {
  const checkin = await loadCheckin(req);
  const manages = req.user.can('checkin.manage');
  const atSite = worksAt(req, checkin.site_id);
  const move = checkin.move;
  // A send or receive form that came back with problems (movements/routes.js) opens again with them.
  const moveForm = req.session.moveForm?.checkinId === checkin.id ? req.session.moveForm : null;
  delete req.session.moveForm;
  res.render('checkins/views/show', {
    title: checkin.number,
    checkin,
    vehicleLabel, typeLabel,
    status: checkins.STATUSES[checkin.status],
    fuel: checkins.fuelLabel(checkin.fuel_quarters),
    entries: await history('checkin', checkin.id),
    canConfirm: req.user.can('checkin.manage') && checkin.status === 'in_workshop' && !checkin.driver_signed_at && !checkin.not_signed_reason,
    canCheckOut: manages && atSite && checkin.status === 'in_workshop' && !move,
    daysIn: checkins.daysIn(checkin.checked_in_at, checkin.checked_out_at ?? new Date()),
    photos: photosFor(checkin, manages && checkin.status === 'in_workshop'),
    // Moving between sites
    move,
    sendTo: manages && atSite && checkin.status === 'in_workshop' && !move ? await movements.otherSites(checkin.site_id) : [],
    canReceive: Boolean(move) && manages && worksAt(req, move.to_site_id),
    canCancelMove: Boolean(move) && manages && worksAt(req, move.from_site_id),
    moveForm,
    jobs: await forCheckin(checkin.id), jobStatuses: JOB_STATUSES,
    canStartJob: req.user.can('jobs.manage') && checkin.status === 'in_workshop',
  });
});

router.post('/check-in/:id/check-out', manage, async (req, res) => {
  const checkin = await loadCheckin(req);
  if (!worksAt(req, checkin.site_id)) throw httpError(403, `Only staff at ${checkin.site_name} can check this vehicle out.`);
  await checkins.checkOut(checkin.id, req);
  req.session.flash = { type: 'success', text: `${vehicleLabel(checkin)} checked out (${checkin.number}).` };
  res.redirect(`/check-in/${checkin.id}`);
});

// The paper Truck Receiving Document, filled in: an A4 page to print or save as PDF.
router.get('/check-in/:id/print', view, async (req, res) => {
  const checkin = await loadCheckin(req);
  res.render('checkins/views/print', {
    layout: false,
    title: `${checkin.number} receiving note`,
    checkin, vehicleLabel, typeLabel,
    company: config.company,
    fuel: checkins.fuelLabel(checkin.fuel_quarters),
    printedAt: new Date(),
  });
});

// ---------- the driver confirms ----------

const signSchema = z.object({
  driver_name: z.string().trim().min(2, 'Type your full name').max(100, 'Use 100 characters or fewer'),
  driver_phone: optionalPhone(),
  driver_id_no: optionalText(20),
  signature: z.string().min(1, 'Sign in the box above').max(400_000, 'The signature is too large. Clear it and sign again.'),
});

/** "data:image/png;base64,…" from the signature pad → PNG bytes, or null. */
function signaturePng(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  return buf && checkins.isPng(buf) ? buf : null;
}

async function loadCheckin(req) {
  const checkin = await checkins.getCheckin(Number(req.params.id));
  if (!checkin) throw httpError(404, 'That check-in doesn’t exist.');
  // Staff see their own sites' check-ins, and vehicles on their way to them.
  checkin.move = await movements.openMovement(checkin.id);
  if (!worksAt(req, checkin.site_id) && !(checkin.move && worksAt(req, checkin.move.to_site_id))) {
    throw httpError(403, `${checkin.number} is at ${checkin.site_name}, which isn’t one of your sites.`);
  }
  return checkin;
}

/** Staff work only at their own sites (admins and managers: all sites). */
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

function renderSign(res, checkin, { status = 200, values, errors = {} }) {
  res.status(status).render('checkins/views/sign', {
    title: `Confirm ${checkin.number}`, checkin, values, errors, vehicleLabel, typeLabel,
    fuel: checkins.fuelLabel(checkin.fuel_quarters), reasons: checkins.NOT_SIGNED_REASONS,
    photos: photosFor(checkin, true), // staff photograph damage before handing over the device
  });
}

/** What the photos panel (views/photos.ejs) needs. */
function photosFor(checkin, canEdit) {
  return {
    url: `/check-in/${checkin.id}/photos`, max: checkins.MAX_PHOTOS, canEdit,
    photos: checkin.photos.map((id) => photoUrls(checkin.id, id)),
  };
}

router.get('/check-in/:id/sign', manage, async (req, res) => {
  const checkin = await loadCheckin(req);
  if (checkin.driver_signed_at || checkin.not_signed_reason) return res.redirect(`/check-in/${checkin.id}`);
  // Whoever was chosen as "brought in by" is most likely the person signing.
  const phone = checkin.contact_phone ?? checkin.brought_by_phone;
  renderSign(res, checkin, { values: { driver_name: checkin.contact_name ?? checkin.brought_by_name ?? '', driver_phone: phone ? fmt.phone(phone) : '', driver_id_no: '' } });
});

router.post('/check-in/:id/sign', manage, async (req, res) => {
  const checkin = await loadCheckin(req);
  const { data, errors } = check(signSchema, req.body);
  const allErrors = { ...errors };
  const png = data ? signaturePng(data.signature) : null;
  if (data && !png) allErrors.signature = 'The signature didn’t come through. Clear it and sign again.';
  if (Object.keys(allErrors).length) return renderSign(res, checkin, { status: 422, values: { ...req.body, signature: '' }, errors: allErrors });

  await checkins.signCheckin(checkin.id, { driver_name: data.driver_name, driver_phone: data.driver_phone, driver_id_no: data.driver_id_no, signature: png }, req);
  req.session.flash = { type: 'success', text: `Thank you. ${checkin.number} is confirmed by ${data.driver_name}.` };
  res.redirect(`/check-in/${checkin.id}`);
});

router.post('/check-in/:id/not-signed', manage, async (req, res) => {
  const checkin = await loadCheckin(req);
  const reason = String(req.body.reason === 'other' ? req.body.other_reason ?? '' : req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    return renderSign(res, checkin, {
      status: 422, values: { driver_name: '', driver_phone: '', driver_id_no: '', ...req.body, signature: '' },
      errors: { reason: 'Say why the driver didn’t sign (3 to 255 characters)' },
    });
  }
  await checkins.markNotSigned(checkin.id, reason, req);
  req.session.flash = { type: 'warning', text: `${checkin.number} saved without the driver’s signature.` };
  res.redirect(`/check-in/${checkin.id}`);
});

// The signature image: only for logged-in staff who can see check-ins.
router.get('/check-in/:id/signature.png', view, async (req, res) => {
  const checkin = await loadCheckin(req);
  if (!checkin.driver_signature_path) throw httpError(404, 'No signature for this check-in.');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(storagePath(checkin.driver_signature_path));
});

// ---------- photos ----------
// The page uploads one photo per request (already shrunk in the browser), so a
// dropped connection loses one photo, not all of them. Answers are JSON.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } }).single('photo');
const receivePhoto = (req, res) => new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve(req.file))));

function photoError(req, res, err) {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That photo is too large (over 15 MB).' });
  if (!err.expose) req.log.error(err);
  res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'The photo couldn’t be saved. Try again.' });
}

const photoUrls = (checkinId, photoId) => ({
  id: photoId,
  full: `/check-in/${checkinId}/photos/${photoId}.webp`,
  thumb: `/check-in/${checkinId}/photos/${photoId}/thumb.webp`,
});

router.post('/check-in/:id/photos', manage, async (req, res) => {
  try {
    const file = await receivePhoto(req, res);
    if (!file) throw httpError(422, 'Choose a photo to add.');
    const photoId = await checkins.addPhoto(Number(req.params.id), file.buffer, req);
    res.status(201).json(photoUrls(Number(req.params.id), photoId));
  } catch (err) {
    photoError(req, res, err);
  }
});

router.post('/check-in/:id/photos/:photoId/delete', manage, async (req, res) => {
  try {
    await checkins.deletePhoto(Number(req.params.id), Number(req.params.photoId), req);
    res.json({ ok: true });
  } catch (err) {
    photoError(req, res, err);
  }
});

async function sendPhoto(req, res, which) {
  const photo = await checkins.getPhoto(Number(req.params.id), Number(req.params.photoId));
  if (!photo) throw httpError(404, 'That photo doesn’t exist.');
  res.set('Cache-Control', 'private, max-age=604800, immutable'); // a photo never changes; a new one gets a new id
  res.type('image/webp').sendFile(storagePath(photo[which]));
}
router.get('/check-in/:id/photos/:photoId.webp', view, (req, res) => sendPhoto(req, res, 'path'));
router.get('/check-in/:id/photos/:photoId/thumb.webp', view, (req, res) => sendPhoto(req, res, 'thumb_path'));

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
