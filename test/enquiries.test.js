import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let sales, supervisor, customer, vehicle;

before(async () => {
  sales = await loginAs(app, await makeUser(91, ['sales']));
  supervisor = await loginAs(app, await makeUser(92, ['supervisor']));
  const csrf = csrfFrom((await sales.get('/customers/new')).text);
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Wekesa Hauliers', phone: '0700000701' });
  customer = await db('customers').where({ phone: '+254700000701' }).first();
  await sales.post('/vehicles').type('form').send({ _csrf: csrf, reg_no: 'KZW 701A', customer_id: customer.id, type: 'truck', make: 'Isuzu' });
  vehicle = await db('vehicles').where({ reg_no: 'KZW 701A' }).first();
});
after(cleanup);

async function post(url, fields) {
  const csrf = csrfFrom((await sales.get('/enquiries')).text);
  return sales.post(url).type('form').send({ _csrf: csrf, ...fields });
}
// Saving goes back to the list, so the new enquiry is found by its caller.
const newest = (callerName) => db('enquiries').where({ caller_name: callerName }).orderBy('id', 'desc').first().then((e) => e.id);

test('only sales and managers handle enquiries', async () => {
  await supervisor.get('/enquiries').expect(403);
  await sales.get('/enquiries').expect(200);
});

test('a new caller is a prospect: name, phone and what they want', async () => {
  let res = await post('/enquiries', { caller_name: 'Musa Hassan', work_type: '', description: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /so they can be called back/);
  assert.match(res.text, /Choose the type of enquiry/);
  assert.match(res.text, /Choose the body type/);
  assert.match(res.text, /Describe what they want/);

  res = await post('/enquiries', { caller_name: 'Musa Hassan', caller_phone: '0700 000 702', kind: 'fabrication', work_type: 'Tipper', description: '18 m³ tipper on a new FVZ', budget: '2,400,000', follow_up_on: localDay() });
  assert.equal(res.status, 302, res.text);
  assert.equal(res.headers.location, '/enquiries?show=follow', 'back to the list: due today');
  const e = await db('enquiries').where({ id: await newest('Musa Hassan') }).first();
  assert.match(e.number, /^ENQ-\d{4}-\d{4}$/);
  assert.equal(e.customer_id, null);
  assert.equal(e.status, 'open');
  assert.equal(Number(e.budget), 2400000);
  assert.equal(e.follow_up_on, localDay(), 'a DATE comes back as the day itself');

  const list = (await sales.get('/enquiries')).text;
  assert.match(list, /Musa Hassan/, 'due today: on the follow-up list');
  assert.match(list, /Prospect/);
});

test('an existing customer’s enquiry can name one of their vehicles, but not someone else’s', async () => {
  const other = await db('vehicles').whereNot({ customer_id: customer.id }).first('id');
  let res = await post('/enquiries', { customer_id: customer.id, caller_name: 'Driver Otieno', kind: 'repairs', work_type: 'Dropside', description: 'Tailgate hinge broken', vehicle_id: other?.id ?? 999999 });
  assert.equal(res.status, 422);
  res = await post('/enquiries', { customer_id: customer.id, caller_name: 'Driver Otieno', kind: 'repairs', work_type: 'Dropside', description: 'Tailgate hinge broken', vehicle_id: vehicle.id });
  assert.equal(res.status, 302, res.text);
  assert.equal(res.headers.location, '/enquiries?show=open');
  const page = (await sales.get(`/enquiries/${await newest('Driver Otieno')}`)).text;
  assert.match(page, /KZW 701A/);
  assert.match(page, /Wekesa Hauliers/);
  const opts = await sales.get(`/api/enquiries/vehicles?customer_id=${customer.id}`).expect(200);
  assert.equal(opts.body[0].value, vehicle.id);
});

test('a call-back note moves the follow-up date', async () => {
  const e = await db('enquiries').where({ caller_name: 'Musa Hassan' }).first();
  const next = new Date(Date.parse(`${localDay()}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
  await post(`/enquiries/${e.id}/notes`, { note: 'Wants a 20 ft version', follow_up_on: next });
  assert.equal((await db('enquiries').where({ id: e.id }).first()).follow_up_on, next);
  assert.doesNotMatch((await sales.get('/enquiries')).text, /Musa Hassan/, 'not due today any more');
  assert.match((await sales.get(`/enquiries/${e.id}`)).text, /Wants a 20 ft version/);
});

test('a prospect becomes a customer; a phone that is already a customer is linked instead', async () => {
  const e = await db('enquiries').where({ caller_name: 'Musa Hassan' }).first();
  await post(`/enquiries/${e.id}/make-customer`, {});
  const linked = await db('enquiries').where({ id: e.id }).first();
  const c = await db('customers').where({ id: linked.customer_id }).first();
  assert.equal(c.name, 'Musa Hassan');
  assert.equal(c.phone, '+254700000702');

  const res = await post('/enquiries', { caller_name: 'Wekesa', caller_phone: '0700 000 701', kind: 'fabrication', work_type: 'Trailer', description: 'Needs a 3-axle trailer' });
  assert.equal(res.status, 302, res.text);
  const id = await newest('Wekesa');
  assert.match((await sales.get(`/enquiries/${id}`)).text, /already belongs to/);
  await post(`/enquiries/${id}/make-customer`, {});
  assert.equal((await db('enquiries').where({ id }).first()).customer_id, customer.id, 'no duplicate customer');
});

test('closing as lost needs a reason; it can be reopened', async () => {
  const e = await db('enquiries').where({ caller_name: 'Wekesa' }).first();
  await post(`/enquiries/${e.id}/close`, { status: 'lost', lost_reason: '' });
  assert.equal((await db('enquiries').where({ id: e.id }).first()).status, 'open');
  await post(`/enquiries/${e.id}/close`, { status: 'lost', lost_reason: 'Price too high' });
  const lost = await db('enquiries').where({ id: e.id }).first();
  assert.equal(lost.status, 'lost');
  assert.equal(lost.lost_reason, 'Price too high');
  assert.equal(lost.follow_up_on, null);
  assert.match((await sales.get('/enquiries?show=closed')).text, /Price too high/);
  await post(`/enquiries/${e.id}/reopen`, {});
  assert.equal((await db('enquiries').where({ id: e.id }).first()).status, 'open');
});

test('search finds an enquiry by phone in any format', async () => {
  assert.match((await sales.get('/enquiries?q=0700000702')).text, /Musa Hassan/);
});

test('“Other” lets you type the kind of work, and adds it to the list', async () => {
  let res = await post('/enquiries', { caller_name: 'Kamau Farm', caller_phone: '0700 000 703', kind: 'fabrication', work_type: 'Other', other_work_type: '', description: 'Body for carrying cattle' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Say what kind of work/);
  res = await post('/enquiries', { caller_name: 'Kamau Farm', caller_phone: '0700 000 703', kind: 'fabrication', work_type: 'Other', other_work_type: 'Cattle body', save_work_type: '1', description: 'Body for carrying cattle' });
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('enquiries').where({ id: await newest('Kamau Farm') }).first()).work_type, 'Cattle body');
  const types = await db('enquiry_work_types').orderBy('sort_order').pluck('name');
  assert.ok(types.indexOf('Cattle body') > -1 && types.indexOf('Cattle body') < types.indexOf('Other'), 'added before Other');
  // Typed again in other capitals: not added twice
  await post('/enquiries', { caller_name: 'Kamau Farm', caller_phone: '0700 000 703', kind: 'fabrication', work_type: 'Other', other_work_type: 'cattle body', save_work_type: '1', description: 'Another one' });
  assert.equal((await db('enquiry_work_types').where({ name: 'Cattle body' })).length, 1);
  await db('enquiry_work_types').where({ name: 'Cattle body' }).delete(); // leave the list as the seed made it
});

test('the enquiry type is asked every time; a general enquiry needs no body type', async () => {
  let res = await post('/enquiries', { caller_name: 'Achieng Otieno', caller_phone: '0700 000 704', kind: 'meeting', work_type: 'Tipper', description: 'Asked about prices' });
  assert.equal(res.status, 422, 'only the listed types');
  assert.match(res.text, /Choose the type of enquiry/);
  assert.doesNotMatch(res.text, /Repair \/ modification/, 'the enquiry type covers repairs, so it is no longer a body type');
  res = await post('/enquiries', { caller_name: 'Achieng Otieno', caller_phone: '0700 000 704', kind: 'general', work_type: '', description: 'Asked what we make and our prices' });
  assert.equal(res.status, 302, res.text);
  const id = await newest('Achieng Otieno');
  const e = await db('enquiries').where({ id }).first();
  assert.equal(e.kind, 'general');
  assert.equal(e.work_type, null);
  assert.match((await sales.get(`/enquiries/${id}`)).text, /<h1 class="h3">General enquiry /);
  assert.match((await sales.get('/enquiries?q=Achieng')).text, /General enquiry/);
  // Work names both: "Fabrication · Tipper".
  await post('/enquiries', { caller_name: 'Achieng Otieno', caller_phone: '0700 000 704', kind: 'fabrication', work_type: 'Tipper', description: 'Wants a tipper after all' });
  assert.match((await sales.get(`/enquiries/${await newest('Achieng Otieno')}`)).text, /<h1 class="h3">Fabrication · Tipper /);
});

test('the form starts with an existing customer; picking one fills in their name and phone (sheet row 54)', async () => {
  const page = (await sales.get('/enquiries/new')).text;
  assert.match(page, /id="caller-existing" value="existing"[^>]*checked/, 'Existing customer is the first choice');
  assert.ok(page.indexOf('name="customer_id"') < page.indexOf('name="caller_name"'), 'the customer picker comes before the name');

  const caller = (await sales.get(`/api/enquiries/caller?customer_id=${customer.id}`).expect(200)).body;
  assert.equal(caller.name, 'Wekesa Hauliers');
  assert.equal(caller.phone, '0700 000 701');
  assert.equal(caller.vehicles[0].value, vehicle.id);
  await supervisor.get(`/api/enquiries/caller?customer_id=${customer.id}`).expect(403);

  // "Existing customer" with nobody picked: say so.
  let res = await post('/enquiries', { caller_mode: 'existing', caller_name: 'Someone', caller_phone: '0700000799', kind: 'general', work_type: '', description: 'Asked for prices' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the customer, or tap “New caller”/);

  // From a customer's page the phone is filled in too.
  assert.match((await sales.get(`/enquiries/new?customer_id=${customer.id}`)).text, /value="0700 000 701"[^>]*name="caller_phone"/);

  // "New caller" never links a customer, even one left in the picker.
  res = await post('/enquiries', { caller_mode: 'new', customer_id: customer.id, vehicle_id: vehicle.id, caller_name: 'Juma New', caller_phone: '0700000798', kind: 'general', work_type: '', description: 'Asked for prices' });
  assert.equal(res.status, 302, res.text);
  const e = await db('enquiries').where({ id: await newest('Juma New') }).first();
  assert.equal(e.customer_id, null);
  assert.equal(e.vehicle_id, null);
  // Editing it opens on "New caller".
  assert.match((await sales.get(`/enquiries/${e.id}/edit`)).text, /id="caller-new" value="new"[^>]*checked/);
});
