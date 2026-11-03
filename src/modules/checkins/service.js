import sharp from 'sharp';
import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { compact, vehicleLabel } from '../../core/vehicle-format.js';
import { normalizePhone } from '../../core/phone.js';
import { httpError } from '../../core/validate.js';
import { saveFile, removeFile } from '../../core/storage.js';
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
      // Anyone else who brought it: kept here, not added to a customer's contacts.
      brought_by_name: input.contact_id ? null : input.brought_by_name ?? null,
      brought_by_phone: input.contact_id ? null : input.brought_by_phone ?? null,
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

// ---------- the driver confirms ----------

/** Quick reasons when the person delivering the vehicle doesn't sign. */
export const NOT_SIGNED_REASONS = [
  'Driver left before signing',
  'Driver refused to sign',
  'Delivered by a towing company',
  'Dropped off after hours',
];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when the buffer really is a PNG (not just named one). */
export const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > PNG_MAGIC.length && buf.subarray(0, 8).equals(PNG_MAGIC);

/** A check-in can be signed (or marked not signed) once, while it is open. */
async function openForConfirmation(trx, id) {
  const checkin = await trx('checkins').where({ id }).forUpdate().first('id', 'number', 'status', 'driver_signed_at', 'not_signed_reason');
  if (!checkin) throw httpError(404, 'That check-in doesn’t exist.');
  if (checkin.driver_signed_at || checkin.not_signed_reason) throw httpError(409, `${checkin.number} has already been confirmed.`);
  if (checkin.status !== 'in_workshop') throw httpError(409, `${checkin.number} is no longer open.`);
  return checkin;
}

/**
 * The driver typed their name and signed on the device.
 * @param {{ driver_name: string, driver_phone: string|null, driver_id_no: string|null, signature: Buffer }} input
 */
export async function signCheckin(id, input, actor) {
  const rel = await saveFile('signatures', input.signature, 'png');
  try {
    await db.transaction(async (trx) => {
      const checkin = await openForConfirmation(trx, id);
      await trx('checkins').where({ id }).update({
        driver_name: input.driver_name, driver_phone: input.driver_phone, driver_id_no: input.driver_id_no,
        driver_signature_path: rel, driver_signed_at: trx.fn.now(),
      });
      await audit(trx, actor, { entity: 'checkin', id, action: 'signed', summary: `${input.driver_name} signed for ${checkin.number}` });
    });
  } catch (err) {
    await removeFile(rel); // not saved: don't leave the image behind
    throw err;
  }
}

/** Staff record why there is no signature. */
export async function markNotSigned(id, reason, actor) {
  await db.transaction(async (trx) => {
    const checkin = await openForConfirmation(trx, id);
    await trx('checkins').where({ id }).update({ not_signed_reason: reason });
    await audit(trx, actor, { entity: 'checkin', id, action: 'not_signed', summary: `Not signed: ${reason} (${checkin.number})` });
  });
}

// ---------- photos ----------

export const MAX_PHOTOS = 10;
// What sharp can read that a phone or camera produces ('heif' covers AVIF; iPhone HEIC needs converting first).
const PHOTO_FORMATS = ['jpeg', 'png', 'webp', 'heif', 'tiff'];
const NOT_A_PHOTO = 'That file isn’t a photo we can read. Use a JPEG, PNG or WebP picture.';

/**
 * A phone photo → a 1280 px WebP to view and a 320 px square thumbnail.
 * Turned upright by the camera's orientation tag. sharp writes no metadata
 * unless asked, so location and other EXIF data are dropped.
 */
export async function processPhoto(buffer) {
  const meta = await sharp(buffer).metadata().catch(() => null);
  if (!meta || !PHOTO_FORMATS.includes(meta.format)) throw httpError(422, NOT_A_PHOTO);
  const upright = sharp(buffer, { failOn: 'error' }).rotate();
  try {
    const [full, thumb] = await Promise.all([
      upright.clone().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
      upright.clone().resize({ width: 320, height: 320, fit: 'cover' }).webp({ quality: 70 }).toBuffer(),
    ]);
    return { full, thumb };
  } catch {
    throw httpError(422, NOT_A_PHOTO);
  }
}

async function photoCount(q, id) {
  const [{ count }] = await q('checkin_photos').where({ checkin_id: id }).count({ count: '*' });
  return Number(count);
}
const tooMany = () => httpError(409, `A check-in can have up to ${MAX_PHOTOS} photos. Delete one to add another.`);

/** Photos can be added or deleted while the vehicle is in the workshop. */
async function openForPhotos(trx, id) {
  const checkin = await trx('checkins').where({ id }).forUpdate().first('id', 'number', 'status');
  if (!checkin) throw httpError(404, 'That check-in doesn’t exist.');
  if (checkin.status !== 'in_workshop') throw httpError(409, `${checkin.number} is no longer open.`);
  return checkin;
}

/** Saves one photo; returns its id. */
export async function addPhoto(id, buffer, actor) {
  if ((await photoCount(db, id)) >= MAX_PHOTOS) throw tooMany(); // before the slow part
  const { full, thumb } = await processPhoto(buffer);
  const files = [];
  try {
    files.push(await saveFile('photos', full, 'webp'), await saveFile('photos', thumb, 'webp'));
    return await db.transaction(async (trx) => {
      const checkin = await openForPhotos(trx, id);
      if ((await photoCount(trx, id)) >= MAX_PHOTOS) throw tooMany();
      const [photoId] = await trx('checkin_photos').insert({
        checkin_id: id, path: files[0], thumb_path: files[1], bytes: full.length + thumb.length, uploaded_by: actor.user.id,
      });
      await audit(trx, actor, { entity: 'checkin', id, action: 'photo_added', summary: `Photo added to ${checkin.number}` });
      return photoId;
    });
  } catch (err) {
    for (const rel of files) await removeFile(rel); // not saved: don't leave the images behind
    throw err;
  }
}

export async function deletePhoto(id, photoId, actor) {
  const photo = await db.transaction(async (trx) => {
    const checkin = await openForPhotos(trx, id);
    const row = await trx('checkin_photos').where({ id: photoId, checkin_id: id }).first();
    if (!row) throw httpError(404, 'That photo has already been deleted.');
    await trx('checkin_photos').where({ id: photoId }).delete();
    await audit(trx, actor, { entity: 'checkin', id, action: 'photo_deleted', summary: `Photo deleted from ${checkin.number}` });
    return row;
  });
  await removeFile(photo.path);
  await removeFile(photo.thumb_path);
}

export function getPhoto(id, photoId) {
  return db('checkin_photos').where({ id: photoId, checkin_id: id }).first('id', 'path', 'thumb_path');
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
    .leftJoin('users as releaser', 'releaser.id', 'checkins.checked_out_by')
    .where('checkins.id', id)
    .first('checkins.*',
      'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag', 'vehicles.type', 'vehicles.make', 'vehicles.model',
      'customers.name as customer_name', 'customers.number as customer_number', 'customers.phone as customer_phone',
      'contact.name as contact_name', 'contact.role as contact_role', 'contact.phone as contact_phone',
      'contact_company.id as contact_company_id', 'contact_company.name as contact_company',
      'receiver.name as received_by_name', 'sites.name as site_name', 'releaser.name as checked_out_by_name');
  if (!checkin) return null;
  checkin.items = await db('checkin_items').where({ checkin_id: id }).orderBy('sort_order').select('description', 'quantity');
  checkin.photos = await db('checkin_photos').where({ checkin_id: id }).orderBy('id').pluck('id');
  return checkin;
}

/**
 * A site's check-ins for the workshop list: those still in the workshop (oldest
 * arrival last), or the 100 most recently checked out.
 */
export async function listCheckins(siteId, status = 'in_workshop') {
  const out = status === 'checked_out';
  return db('checkins')
    .join('vehicles', 'vehicles.id', 'checkins.vehicle_id')
    .join('customers', 'customers.id', 'checkins.customer_id')
    .leftJoin('customer_contacts as contact', 'contact.id', 'checkins.contact_id')
    // A vehicle on its way to another site stays on this list until it is received there.
    .leftJoin('vehicle_movements as move', (j) => j.on('move.checkin_id', 'checkins.id').andOnVal('move.status', 'in_transit'))
    .leftJoin('sites as move_to', 'move_to.id', 'move.to_site_id')
    .where({ 'checkins.status': status, 'checkins.site_id': siteId })
    .orderBy(out ? 'checkins.checked_out_at' : 'checkins.checked_in_at', 'desc')
    .limit(out ? 100 : 200)
    .select('checkins.id', 'checkins.number', 'checkins.checked_in_at', 'checkins.checked_out_at', 'checkins.driver_signed_at', 'checkins.not_signed_reason',
      'move_to.name as moving_to',
      'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag', 'vehicles.make', 'vehicles.model', 'customers.name as customer_name',
      // Not a saved contact: the name typed at check-in, else the one given when signing.
      db.raw('COALESCE(contact.name, checkins.brought_by_name, checkins.driver_name) as contact_name'));
}

export async function countInWorkshop(siteId) {
  const [{ count }] = await db('checkins').where({ status: 'in_workshop', site_id: siteId }).count({ count: '*' });
  return Number(count);
}

/** "Today", "1 day", "12 days": how long a vehicle has been (or was) in the workshop. */
export function daysIn(from, to = new Date()) {
  const days = Math.floor((new Date(to) - new Date(from)) / 86_400_000);
  return days < 1 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`;
}

/** The vehicle has left the workshop. After this the check-in can't be signed or given photos. */
export async function checkOut(id, actor) {
  await db.transaction(async (trx) => {
    const checkin = await trx('checkins').join('vehicles', 'vehicles.id', 'checkins.vehicle_id').where('checkins.id', id).forUpdate()
      .first('checkins.id', 'checkins.number', 'checkins.status', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag');
    if (!checkin) throw httpError(404, 'That check-in doesn’t exist.');
    if (checkin.status !== 'in_workshop') throw httpError(409, `${checkin.number} is no longer in the workshop.`);
    if (await trx('vehicle_movements').where({ checkin_id: id, status: 'in_transit' }).first('id')) {
      throw httpError(409, `${vehicleLabel(checkin)} is on its way to another site. That site receives it first.`);
    }
    await trx('checkins').where({ id }).update({ status: 'checked_out', checked_out_at: trx.fn.now(), checked_out_by: actor.user.id });
    await audit(trx, actor, { entity: 'checkin', id, action: 'checked_out', summary: `Checked out ${vehicleLabel(checkin)} (${checkin.number})` });
  });
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
