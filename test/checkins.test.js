import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { regLooksUsual } from '../src/core/vehicle-format.js';
import { storagePath } from '../src/core/storage.js';
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let supervisor, sales, owner, dealer, salesman, vehicle;

before(async () => {
  supervisor = await loginAs(app, await makeUser(61, ['supervisor']));
  sales = await loginAs(app, await makeUser(62, ['sales']));
  const page = await sales.get('/customers/new');
  const csrf = csrfFrom(page.text);
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Wanjiru Kamau', phone: '0700000301' });
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Rift Motors', phone: '0700000302', category: 'company', contact_name: 'Brian Otieno', contact_role: 'Salesman' });
  owner = await db('customers').where({ phone: '+254700000301' }).first();
  dealer = await db('customers').where({ phone: '+254700000302' }).first();
  salesman = await db('customer_contacts').where({ customer_id: dealer.id }).first();
  await sales.post('/vehicles').type('form').send({ _csrf: csrf, reg_no: 'KZY 300C', customer_id: owner.id, type: 'truck', make: 'Isuzu' });
  vehicle = await db('vehicles').where({ reg_no: 'KZY 300C' }).first();
});
after(cleanup);

async function checkIn(fields) {
  const page = await supervisor.get('/check-in/new');
  return supervisor.post('/check-in').type('form').send({ _csrf: csrfFrom(page.text), ...fields });
}

test('sales staff can’t check vehicles in', async () => {
  await sales.get('/check-in/new').expect(403);
});

test('an existing vehicle is checked in with another company’s salesman, readings and items', async () => {
  const res = await checkIn({
    vehicle_mode: 'existing', vehicle_id: vehicle.id, contact_id: salesman.id, odometer_km: '245,300', fuel_quarters: '2',
    item_description: ['Spare wheel', '', 'Toolbox'], item_quantity: ['2', '1', ''], remarks: 'Dent on left door',
  });
  assert.equal(res.status, 302, res.text);
  const c = await db('checkins').where({ vehicle_id: vehicle.id }).first();
  assert.match(c.number, /^CHK-\d{4}-\d{4}$/);
  assert.equal(c.customer_id, owner.id, 'owner comes from the vehicle');
  assert.equal(c.contact_id, salesman.id);
  assert.equal(c.odometer_km, 245300);
  assert.equal(c.fuel_quarters, 2);
  assert.equal(c.status, 'in_workshop');
  const items = await db('checkin_items').where({ checkin_id: c.id }).orderBy('sort_order').select('description', 'quantity');
  assert.deepEqual(items.map((i) => ({ ...i })), [{ description: 'Spare wheel', quantity: 2 }, { description: 'Toolbox', quantity: 1 }]);

  const page = (await supervisor.get(`/check-in/${c.id}`)).text;
  assert.match(page, /Brian Otieno/);
  assert.match(page, /of <a href="\/customers\/\d+">Rift Motors/);
  assert.match(page, /245,300 km/);
});

test('a vehicle already in the workshop can’t be checked in twice', async () => {
  const res = await checkIn({ vehicle_mode: 'existing', vehicle_id: vehicle.id });
  assert.equal(res.status, 422);
  assert.match(res.text, /Already in the workshop/);
});

test('it shows in the workshop list', async () => {
  const page = (await supervisor.get('/check-in')).text;
  assert.match(page, /KZY 300C/);
});

test('a new trailer without numbers gets a temporary JTT tag', async () => {
  const res = await checkIn({ vehicle_mode: 'new', issue_tag: '1', customer_id: owner.id, type: 'trailer', contact_id: salesman.id });
  assert.equal(res.status, 302, res.text);
  const c = await db('checkins').orderBy('id', 'desc').first();
  const v = await db('vehicles').where({ id: c.vehicle_id }).first();
  assert.match(v.temp_tag, /^JTT-\d{4}-\d{4}$/);
  assert.equal(v.reg_no, null);
  assert.equal(v.contact_id, null, 'another company’s salesman is not saved as the vehicle’s usual contact');
  // Found by the tag typed without dashes
  const found = await supervisor.get(`/api/check-in/vehicles?q=${v.temp_tag.replace(/-/g, '').toLowerCase()}`);
  assert.equal(found.body[0]?.value, v.id);
});

test('a new vehicle needs a number or a tag, and an owner', async () => {
  const res = await checkIn({ vehicle_mode: 'new', type: 'truck' });
  assert.equal(res.status, 422);
  assert.match(res.text, /or tick “issue a temporary tag”/);
  assert.match(res.text, /Choose the owner/);
});

test('a new vehicle with a reg that already exists is refused', async () => {
  const res = await checkIn({ vehicle_mode: 'new', reg_no: 'kzy300c', customer_id: owner.id, type: 'truck' });
  assert.equal(res.status, 422);
  assert.match(res.text, /already registered/);
});

test('no vehicle chosen, bad quantity: both explained', async () => {
  const res = await checkIn({ vehicle_mode: 'existing', item_description: 'Jack', item_quantity: 'two' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the vehicle/);
  assert.match(res.text, /Check the quantity for “Jack”/);
});

test('the vehicle summary gives the owner, usual contact and last visit', async () => {
  const res = await supervisor.get(`/api/check-in/vehicles/${vehicle.id}`).expect(200);
  assert.equal(res.body.owner.name, 'Wanjiru Kamau');
  assert.equal(res.body.lastVisit.odometer, 245300);
  assert.ok(res.body.open, 'already in the workshop');
});

test('contacts of any company can be found for “brought in by”', async () => {
  const res = await supervisor.get('/api/check-in/contacts?q=rift').expect(200);
  assert.ok(res.body.some((c) => c.value === salesman.id && /Rift Motors/.test(c.label)));
});

test('usual Kenyan plates pass; others only warn', () => {
  for (const reg of ['KDA 123A', 'ZF 1234', 'GKB 123A']) assert.ok(regLooksUsual(reg), reg);
  for (const reg of ['KDA 12A', 'UAX 123B', 'CD 12K']) assert.ok(!regLooksUsual(reg), reg);
});

// ---------- the driver confirms ----------

// A real 1×1 PNG, as the signature pad would send (much smaller, same format).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function freshCheckin(reg) {
  const page = await sales.get('/vehicles/new');
  await sales.post('/vehicles').type('form').send({ _csrf: csrfFrom(page.text), reg_no: reg, customer_id: owner.id, type: 'truck' });
  const v = await db('vehicles').where({ reg_no: reg }).first();
  const res = await checkIn({ vehicle_mode: 'existing', vehicle_id: v.id, contact_id: salesman.id, item_description: 'Jack', item_quantity: '1' });
  assert.equal(res.status, 302, res.text);
  assert.match(res.headers.location, /\/check-in\/\d+\/sign$/, 'goes straight to the signing screen');
  return Number(/\/check-in\/(\d+)\/sign/.exec(res.headers.location)[1]);
}

async function sign(id, fields) {
  const page = await supervisor.get(`/check-in/${id}/sign`);
  return supervisor.post(`/check-in/${id}/sign`).type('form').send({ _csrf: csrfFrom(page.text), ...fields });
}

test('the signing screen shows the items and suggests the person who brought it', async () => {
  const id = await freshCheckin('KZY 301C');
  const page = (await supervisor.get(`/check-in/${id}/sign`)).text;
  assert.match(page, /Confirm delivery/);
  assert.match(page, /Jack/);
  assert.match(page, /value="Brian Otieno"/);
  assert.match((await supervisor.get('/check-in')).text, /Driver to sign/);
});

test('the driver signs: name, phone and the signature image are kept', async () => {
  const id = await freshCheckin('KZY 302C');
  const res = await sign(id, { driver_name: 'Brian Otieno', driver_phone: '0700 000 333', driver_id_no: '23456789', signature: PNG });
  assert.equal(res.status, 302, res.text);
  const c = await db('checkins').where({ id }).first();
  assert.equal(c.driver_name, 'Brian Otieno');
  assert.equal(c.driver_phone, '+254700000333');
  assert.ok(c.driver_signed_at);
  assert.match(c.driver_signature_path, /^signatures\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/);

  const img = await supervisor.get(`/check-in/${id}/signature.png`).expect(200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.match((await supervisor.get(`/check-in/${id}`)).text, /Signed /);

    // Brought in by someone who isn't a contact: the signed name stands in
  await db('checkins').where({ id }).update({ contact_id: null });
  assert.match((await supervisor.get(`/check-in/${id}`)).text, /Not saved as a contact/);
  assert.match((await supervisor.get('/check-in')).text, /Brian Otieno/);

  // Only once
  const csrf = csrfFrom((await supervisor.get(`/check-in/${id}`)).text);
  const again = await supervisor.post(`/check-in/${id}/sign`).type('form').send({ _csrf: csrf, driver_name: 'Someone Else', signature: PNG });
  assert.equal(again.status, 409);
});

test('the signature image needs a login', async () => {
  const c = await db('checkins').whereNotNull('driver_signature_path').orderBy('id', 'desc').first('id');
  const res = await (await import('supertest')).default(app).get(`/check-in/${c.id}/signature.png`);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/login/);
});

test('no name, no signature, or something that isn’t a PNG is refused', async () => {
  const id = await freshCheckin('KZY 303C');
  let res = await sign(id, { driver_name: '', signature: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Type your full name/);
  assert.match(res.text, /Sign in the box above/);
  res = await sign(id, { driver_name: 'Brian Otieno', signature: 'data:image/png;base64,PHN2Zz48L3N2Zz4=' });
  assert.equal(res.status, 422);
  assert.match(res.text, /didn’t come through/);
  assert.equal((await db('checkins').where({ id }).first()).driver_signed_at, null);
});

test('staff can save it without a signature, with a reason', async () => {
  const id = await freshCheckin('KZY 304C');
  const page = await supervisor.get(`/check-in/${id}/sign`);
  let res = await supervisor.post(`/check-in/${id}/not-signed`).type('form').send({ _csrf: csrfFrom(page.text), reason: 'other', other_reason: '' });
  assert.equal(res.status, 422);
  res = await supervisor.post(`/check-in/${id}/not-signed`).type('form').send({ _csrf: csrfFrom(page.text), reason: 'Driver left before signing' });
  assert.equal(res.status, 302);
  assert.equal((await db('checkins').where({ id }).first()).not_signed_reason, 'Driver left before signing');
  // The signing screen now just leads back to the check-in
  const back = await supervisor.get(`/check-in/${id}/sign`);
  assert.equal(back.status, 302);
});

// ---------- photos ----------

// An 800 × 400 camera photo whose orientation tag says "turn 90°", as phones send them.
const cameraPhoto = () => sharp({ create: { width: 800, height: 400, channels: 3, background: '#c33' } })
  .jpeg().withMetadata({ orientation: 6 }).toBuffer();

async function addPhoto(id, buffer, name = 'photo.jpg') {
  const csrf = csrfFrom((await supervisor.get(`/check-in/${id}`)).text);
  return supervisor.post(`/check-in/${id}/photos`).set('x-csrf-token', csrf).set('Accept', 'application/json').attach('photo', buffer, name);
}

test('a photo is turned upright, shrunk to WebP with a thumbnail, and stripped of its EXIF data', async () => {
  const id = await freshCheckin('KZY 305C');
  const res = await addPhoto(id, await cameraPhoto());
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.thumb, `/check-in/${id}/photos/${res.body.id}/thumb.webp`);

  const row = await db('checkin_photos').where({ checkin_id: id }).first();
  assert.match(row.path, /^photos\/\d{4}\/\d{2}\/[0-9a-f]+\.webp$/);
  const full = await sharp(readFileSync(storagePath(row.path))).metadata(); // a buffer: sharp would keep the file open (Windows can't delete it)
  assert.equal(full.format, 'webp');
  assert.deepEqual([full.width, full.height], [400, 800], 'turned upright');
  assert.equal(full.exif, undefined, 'no EXIF (location) kept');
  const thumb = await sharp(readFileSync(storagePath(row.thumb_path))).metadata();
  assert.deepEqual([thumb.width, thumb.height], [320, 320]);

  const img = await supervisor.get(res.body.full).expect(200);
  assert.equal(img.headers['content-type'], 'image/webp');
  const page = (await supervisor.get(`/check-in/${id}`)).text;
  assert.match(page, /added a photo/);
});

test('something that isn’t a photo is refused', async () => {
  const id = await freshCheckin('KZY 306C');
  const res = await addPhoto(id, Buffer.from('not really a picture'), 'photo.jpg');
  assert.equal(res.status, 422);
  assert.match(res.body.error, /isn’t a photo/);
  assert.equal((await db('checkin_photos').where({ checkin_id: id })).length, 0);
});

test('up to 10 photos per check-in', async () => {
  const id = await freshCheckin('KZY 307C');
  await db('checkin_photos').insert(Array.from({ length: 10 }, () => ({ checkin_id: id, path: 'photos/none.webp', thumb_path: 'photos/none.webp', bytes: 1 })));
  const res = await addPhoto(id, await cameraPhoto());
  assert.equal(res.status, 409);
  assert.match(res.body.error, /up to 10 photos/);
});

test('a photo can be deleted, and its files go with it', async () => {
  const id = await freshCheckin('KZY 308C');
  const added = await addPhoto(id, await cameraPhoto());
  const row = await db('checkin_photos').where({ id: added.body.id }).first();
  const csrf = csrfFrom((await supervisor.get(`/check-in/${id}`)).text);
  const del = () => supervisor.post(`/check-in/${id}/photos/${row.id}/delete`).set('x-csrf-token', csrf).set('Accept', 'application/json');
  assert.equal((await del()).status, 200);
  assert.equal(await db('checkin_photos').where({ id: row.id }).first(), undefined);
  assert.equal(existsSync(storagePath(row.path)), false);
  assert.equal(existsSync(storagePath(row.thumb_path)), false);
  assert.equal((await del()).status, 404);
});

test('photos need a login to see, and check-in rights to add', async () => {
  const p = await db('checkin_photos').whereNot({ path: 'photos/none.webp' }).orderBy('id', 'desc').first();
  const anon = await (await import('supertest')).default(app).get(`/check-in/${p.checkin_id}/photos/${p.id}.webp`);
  assert.equal(anon.status, 302);
  const csrf = csrfFrom((await sales.get('/customers')).text);
  const res = await sales.post(`/check-in/${p.checkin_id}/photos`).set('x-csrf-token', csrf).attach('photo', await cameraPhoto(), 'photo.jpg');
  assert.equal(res.status, 403);
});

// ---------- check out and the receiving note ----------

// Checking out: the release (the person collecting signs; no jobs on these visits, so nothing to check),
// then clearing it at the gate, which supervisors can do too.
async function checkOut(id) {
  const csrf = csrfFrom((await supervisor.get(`/check-in/${id}`)).text);
  const res = await supervisor.post(`/check-in/${id}/release`).type('form').send({ _csrf: csrf, collector_name: 'Brian Otieno', signature: PNG });
  if (res.status !== 302) return res;
  return supervisor.post(`/check-in/${id}/clear`).type('form').send({ _csrf: csrf });
}

test('checking out moves the vehicle to “Checked out” and locks the check-in', async () => {
  const id = await freshCheckin('KZY 309C');
  assert.equal((await checkOut(id)).status, 302);
  const c = await db('checkins').where({ id }).first();
  assert.equal(c.status, 'checked_out');
  assert.ok(c.checked_out_at);
  assert.ok(c.checked_out_by);

  const page = (await supervisor.get(`/check-in/${id}`)).text;
  assert.match(page, /Checked out /);
  assert.match(page, /cleared it out at the gate/);
  assert.doesNotMatch((await supervisor.get('/check-in')).text, /KZY 309C/);
  assert.match((await supervisor.get('/check-in?show=out')).text, /KZY 309C/);

  // Locked: no second check-out, no signature, no photos
  assert.equal((await checkOut(id)).status, 409);
  assert.equal((await sign(id, { driver_name: 'Brian Otieno', signature: PNG })).status, 409);
  assert.equal((await db('checkins').where({ id }).first()).driver_signed_at, null);
  assert.equal((await addPhoto(id, await cameraPhoto())).status, 409);

  // The same vehicle can come back in
  const v = await db('vehicles').where({ reg_no: 'KZY 309C' }).first();
  const again = await checkIn({ vehicle_mode: 'existing', vehicle_id: v.id });
  assert.equal(again.status, 302, again.text);
});

test('sales staff can’t check a vehicle out', async () => {
  const c = await db('checkins').where({ status: 'in_workshop' }).orderBy('id', 'desc').first('id');
  const csrf = csrfFrom((await sales.get('/customers')).text);
  const res = await sales.post(`/check-in/${c.id}/release`).type('form').send({ _csrf: csrf, collector_name: 'Brian Otieno', signature: PNG });
  assert.equal(res.status, 403);
});

test('the receiving note follows the paper form, with the signature', async () => {
  const id = await freshCheckin('KZY 310C');
  await sign(id, { driver_name: 'Brian Otieno', driver_phone: '0700 000 333', signature: PNG });
  const html = (await supervisor.get(`/check-in/${id}/print`).expect(200)).text;
  assert.match(html, /Truck Receiving Document/);
  assert.match(html, /Jome-Tech Engineering Ltd/);
  assert.match(html, /Brian Otieno/);
  assert.match(html, /Rift Motors/, 'company name: the salesman’s company');
  assert.match(html, /Wanjiru Kamau/, 'client name: the owner');
  assert.match(html, new RegExp(`/check-in/${id}/signature.png`));
  assert.equal((html.match(/<td class="no">/g) ?? []).length, 10, 'ten item lines, like the paper form');
  assert.doesNotMatch(html, /jt-sidebar/, 'no app menu on the printed page');
});

test('the vehicles list splits vehicles by where they are now', async () => {
  const page = await sales.get('/vehicles/new');
  await sales.post('/vehicles').type('form').send({ _csrf: csrfFrom(page.text), reg_no: 'KZY 311C', customer_id: owner.id, type: 'truck' });
  const id = (await db('checkins').join('vehicles', 'vehicles.id', 'checkins.vehicle_id').where({ 'vehicles.reg_no': 'KZY 310C' }).first('checkins.id')).id;
  await checkOut(id);
  await sales.get('/customers'); // shows (and clears) the "KZY 311C added." message

  const tab = async (place) => (await sales.get(`/vehicles${place ? `?place=${place}` : ''}`).expect(200)).text;
  const inNow = await tab('');
  assert.match(inNow, /In the workshop/);
  assert.match(inNow, /KZY 302C/, 'checked in, not out');
  assert.doesNotMatch(inNow, /KZY 310C|KZY 311C/);
  assert.match(await tab('left'), /KZY 310C/);
  const fresh = await tab('new');
  assert.match(fresh, /KZY 311C/);
  assert.doesNotMatch(fresh, /KZY 310C/);
  assert.match(await tab('all'), /KZY 311C/);
  assert.match((await sales.get('/vehicles?q=kzy311c').expect(200)).text, /KZY 311C/, 'a search looks through all vehicles');
});

test('“brought in by” can be anyone: a typed name and phone, not saved as a contact', async () => {
  const page = await sales.get('/vehicles/new');
  await sales.post('/vehicles').type('form').send({ _csrf: csrfFrom(page.text), reg_no: 'KZY 312C', customer_id: owner.id, type: 'truck' });
  const v = await db('vehicles').where({ reg_no: 'KZY 312C' }).first();
  const contactsBefore = (await db('customer_contacts').count({ n: '*' }))[0].n;

  let res = await checkIn({ vehicle_mode: 'existing', vehicle_id: v.id, contact_id: 'name: E' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Type their full name/);

  res = await checkIn({ vehicle_mode: 'existing', vehicle_id: v.id, contact_id: 'name:Eunice  Wairimu', brought_by_phone: '0700 000 334' });
  assert.equal(res.status, 302, res.text);
  const c = await db('checkins').where({ vehicle_id: v.id }).first();
  assert.equal(c.contact_id, null);
  assert.equal(c.brought_by_name, 'Eunice Wairimu');
  assert.equal(c.brought_by_phone, '+254700000334');
  assert.equal((await db('customer_contacts').count({ n: '*' }))[0].n, contactsBefore, 'no contact added');

  assert.match((await supervisor.get(`/check-in/${c.id}/sign`)).text, /value="Eunice Wairimu"/, 'the signing screen suggests her');
  const show = (await supervisor.get(`/check-in/${c.id}`)).text;
  assert.match(show, /Eunice Wairimu/);
  assert.match(show, /Not saved as a contact/);
  assert.match((await supervisor.get('/check-in')).text, /Eunice Wairimu/);
  assert.match((await supervisor.get(`/check-in/${c.id}/print`)).text, /Eunice Wairimu/);
});

test('a vehicle’s page lists its visits', async () => {
  const v = await db('vehicles').where({ reg_no: 'KZY 309C' }).first();
  const page = (await sales.get(`/vehicles/${v.id}`).expect(200)).text;
  assert.match(page, /Visits/);
  const numbers = await db('checkins').where({ vehicle_id: v.id }).pluck('number');
  assert.equal(numbers.length, 2, 'checked out, then back in');
  for (const n of numbers) assert.match(page, new RegExp(n));
  assert.match(page, /In the workshop/, 'the current visit shows its status');
});
