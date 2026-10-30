import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { regLooksUsual } from '../src/core/vehicle-format.js';
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

  const page = (await supervisor.get(res.headers.location)).text;
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
