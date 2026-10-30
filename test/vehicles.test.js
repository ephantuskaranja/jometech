import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let supervisor, customer, otherCustomer, contact;

before(async () => {
  supervisor = await loginAs(app, await makeUser(51, ['supervisor'])); // checks vehicles in, so may add them
  const sales = await loginAs(app, await makeUser(52, ['sales']));
  const page = await sales.get('/customers/new');
  await sales.post('/customers').type('form').send({ _csrf: csrfFrom(page.text), name: 'Lakeview Logistics', phone: '0700000201', category: 'company', contact_name: 'Ali Hassan', contact_role: 'Salesman' });
  await sales.post('/customers').type('form').send({ _csrf: csrfFrom(page.text), name: 'Other Owner', phone: '0700000202' });
  customer = await db('customers').where({ phone: '+254700000201' }).first();
  otherCustomer = await db('customers').where({ phone: '+254700000202' }).first();
  contact = await db('customer_contacts').where({ customer_id: customer.id }).first();
});
after(cleanup);

async function addVehicle(fields) {
  const page = await supervisor.get('/vehicles/new');
  return supervisor.post('/vehicles').type('form').send({ _csrf: csrfFrom(page.text), ...fields });
}

test('the reg is tidied and the contact who brings it in is kept', async () => {
  const res = await addVehicle({ reg_no: 'kzz-901a', customer_id: customer.id, contact_id: contact.id, type: 'truck', make: 'Isuzu' });
  assert.equal(res.status, 302);
  const v = await db('vehicles').where({ reg_no: 'KZZ 901A' }).first();
  assert.equal(v.contact_id, contact.id);
  const page = (await supervisor.get(res.headers.location)).text;
  assert.match(page, /Ali Hassan/);
  assert.match(page, /Lakeview Logistics/);
});

test('a trailer with only a chassis number is fine', async () => {
  const res = await addVehicle({ chassis_no: 'trl-sk3 20 0999', customer_id: customer.id, type: 'trailer' });
  assert.equal(res.status, 302);
  assert.ok(await db('vehicles').where({ chassis_no: 'TRLSK3200999' }).first());
});

test('reg or chassis is required, and so is the customer', async () => {
  const res = await addVehicle({ type: 'truck' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Enter the reg number, or the chassis number/);
  assert.match(res.text, /Choose the customer/);
});

test('the same reg can’t be registered twice', async () => {
  const res = await addVehicle({ reg_no: 'KZZ901A', customer_id: otherCustomer.id, type: 'truck' });
  assert.equal(res.status, 422);
  assert.match(res.text, /already registered, to Lakeview Logistics/);
  const check = await supervisor.get('/api/vehicles/check?reg=kzz%20901%20a').expect(200);
  assert.equal(check.body.match.customer_name, 'Lakeview Logistics');
});

test('a contact from another customer is refused', async () => {
  const res = await addVehicle({ reg_no: 'KZZ 902A', customer_id: otherCustomer.id, contact_id: contact.id, type: 'truck' });
  assert.equal(res.status, 422);
  assert.match(res.text, /contact person from this customer/);
});

test('a customer can be added in place from the vehicle form', async () => {
  const page = await supervisor.get('/vehicles/new');
  const res = await supervisor.post('/api/customers').set('x-csrf-token', csrfFrom(page.text)).set('Accept', 'application/json')
    .send({ name: 'Walk-in Owner', phone: '0700 000 203', category: 'individual' });
  assert.equal(res.status, 201);
  assert.match(res.body.label, /^Walk-in Owner \(CUS-\d{4}\)$/);
});

test('moving a vehicle to a new owner shows in its history', async () => {
  const v = await db('vehicles').where({ reg_no: 'KZZ 901A' }).first();
  const page = await supervisor.get(`/vehicles/${v.id}/edit`);
  await supervisor.post(`/vehicles/${v.id}`).type('form')
    .send({ _csrf: csrfFrom(page.text), reg_no: 'KZZ 901A', customer_id: otherCustomer.id, type: 'truck', make: 'Isuzu' }).expect(302);
  const show = (await supervisor.get(`/vehicles/${v.id}`)).text;
  assert.match(show, /Owner<\/span>\s*<span class="jt-changes-old">Lakeview Logistics<\/span> <i class="bi bi-arrow-right"><\/i> Other Owner/);
  assert.match(show, /Brought in by<\/span>\s*<span class="jt-changes-old">Ali Hassan<\/span>/);
});

test('global search finds a vehicle typed any way, and customers by phone', async () => {
  const byReg = await supervisor.get('/api/search?q=kzz901').expect(200);
  assert.equal(byReg.body.results[0].plate, 'KZZ 901A');
  const byPhone = await supervisor.get('/api/search?q=0700000201').expect(200);
  assert.ok(byPhone.body.results.some((r) => r.title === 'Lakeview Logistics'));
  // Exactly one result: Enter goes straight to it.
  const enter = await supervisor.get('/search?q=KZZ%20901A');
  assert.equal(enter.status, 302);
  assert.match(enter.headers.location, /^\/vehicles\/\d+$/);
});
