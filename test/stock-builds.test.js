// Sheet row 58, step b: stock builds. A body built for stock, before anyone buys it: its chassis is
// checked in with "No customer yet", its job can draw materials without a proforma, and it can't be
// invoiced or released until a customer is assigned. The built-in stock owner stays out of customer lists.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let supervisor, store, admin, stock;
const checkinIds = [];

before(async () => {
  supervisor = await loginAs(app, await makeUser(61, ['supervisor']));
  store = await loginAs(app, await makeUser(62, ['storekeeper']));
  admin = await loginAs(app, await makeUser(63, ['admin']));
  stock = await db('customers').where({ is_stock: true }).first();
});
after(async () => {
  // The stock owner isn't a test customer (no test phone), so its test vehicles and jobs go here.
  const jobIds = await db('jobs').whereIn('checkin_id', checkinIds).pluck('id');
  const vehicleIds = await db('checkins').whereIn('id', checkinIds).pluck('vehicle_id');
  await db('audit_log').where({ entity: 'job' }).whereIn('entity_id', jobIds).delete();
  await db('jobs').whereIn('id', jobIds).delete();
  await db('audit_log').where({ entity: 'checkin' }).whereIn('entity_id', checkinIds).delete();
  await db('checkins').whereIn('id', checkinIds).delete();
  await db('audit_log').where({ entity: 'vehicle' }).whereIn('entity_id', vehicleIds).delete();
  await db('vehicles').whereIn('id', vehicleIds).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}

test('the built-in stock owner exists and stays out of customer lists, pickers and search', async () => {
  assert.ok(stock, 'made by the migration');
  assert.equal(stock.name, 'Stock build: awaiting customer');
  assert.doesNotMatch((await admin.get('/customers')).text, /Stock build: awaiting customer/);
  assert.doesNotMatch((await admin.get('/api/customers?q=Stock')).text, /Stock build/);
  assert.doesNotMatch((await admin.get('/api/customers?q=CUS-STOCK')).text, /Stock build/);
  // Not a real customer: it can't be edited.
  const res = await post(admin, `/customers/${stock.id}`, { name: 'Renamed', phone: '0700000699', category: 'company', credit_days: '0' });
  assert.equal(res.status, 409);
  assert.equal((await db('customers').where({ id: stock.id }).first()).name, 'Stock build: awaiting customer');
});

test('a chassis checked in with “No customer yet” belongs to stock; its job is a stock build stores can issue to', async () => {
  const res = await post(supervisor, '/check-in', {
    vehicle_mode: 'new', issue_tag: '1', type: 'truck', make: 'Isuzu', model: 'FVZ', stock_build: '1', customer_id: '',
    purpose: 'fabrication', no_arrival_reason: 'Test: bought chassis, delivered by the dealer',
  });
  assert.equal(res.status, 302, res.text.slice(0, 500));
  const checkinId = Number(/\/check-in\/(\d+)/.exec(res.headers.location)[1]);
  checkinIds.push(checkinId);
  const checkin = await db('checkins').where({ id: checkinId }).first();
  const vehicle = await db('vehicles').where({ id: checkin.vehicle_id }).first();
  assert.equal(vehicle.customer_id, stock.id);
  assert.match(vehicle.temp_tag, /^JTT-/);

  // The new-job form offers to open a stock build.
  assert.ok((await supervisor.get('/jobs/new')).text.includes(`/jobs/new?customer_id=${stock.id}"`));
  const job = await post(supervisor, '/jobs', { customer_id: stock.id, vehicle_id: vehicle.id, line_quantity: ['1'], line_unit: ['Unit'], line_description: ['Build 24ft high-side body'] });
  assert.equal(job.status, 302, job.text.slice(0, 500));
  const jobId = Number(job.headers.location.split('/')[2]);
  const row = await db('jobs').where({ id: jobId }).first();
  assert.equal(row.stock_build, 1);
  assert.ok(row.materials_allowed_at, 'stores can issue without a proforma');

  const page = (await supervisor.get(`/jobs/${jobId}`)).text;
  assert.match(page, /Stock build/);
  const storePage = (await store.get(`/jobs/${jobId}`)).text;
  assert.match(storePage, /stores issue materials to it without a proforma/);
  assert.match(storePage, new RegExp(`href="/jobs/${jobId}/issue"`), 'Issue materials straight away');
  assert.doesNotMatch(page, /Stores can’t issue materials yet/);
  assert.doesNotMatch(page, /Make proforma|Match a proforma/, 'no customer to price it for yet');
  assert.match((await supervisor.get('/jobs?show=stock')).text, new RegExp(row.number));
  assert.doesNotMatch((await supervisor.get('/jobs?show=stock')).text, /No jobs/);

  // Stores get past the job check (failing only on the made-up stock line).
  const issue = await post(store, `/jobs/${jobId}/issue`, { issued_on: localDay(), line_balance_id: ['999999'], line_label: ['Any'], line_quantity: ['1'] });
  assert.equal(issue.status, 422);
  assert.match(issue.text, /isn’t in stock at this site/);

  // No invoice and no release while there is no customer.
  const inv = await admin.get(`/jobs/${jobId}/invoice`);
  assert.equal(inv.status, 302);
  assert.equal((await post(admin, `/jobs/${jobId}/invoice`, { line_quantity: ['1'], line_description: ['Body'], line_price: ['100'] })).status, 409);
  const rel = await supervisor.get(`/check-in/${checkinId}/release`);
  assert.equal(rel.status, 302);
  assert.match((await supervisor.get(`/check-in/${checkinId}`)).text, /stock build with no customer yet/);
});

test('the Stock value report lists stock builds waiting for a buyer; selling one assigns the customer everywhere', async () => {
  const checkinId = checkinIds[0];
  const job = await db('jobs').where({ checkin_id: checkinId }).first();
  const report = (await admin.get('/reports/stock-value')).text;
  assert.match(report, /Stock builds awaiting a customer/);
  assert.match(report, new RegExp(`href="/jobs/${job.id}"`));
  assert.match(report, /Being built/);

  // Offered on the job to supervisors (and sales); stores can't.
  assert.match((await supervisor.get(`/jobs/${job.id}`)).text, /Assign customer/);
  assert.doesNotMatch((await store.get(`/jobs/${job.id}`)).text, /Assign customer/);
  assert.equal((await post(store, `/jobs/${job.id}/assign-customer`, { customer_id: stock.id })).status, 403);

  // Not to the stock owner itself, and not to nobody.
  await post(supervisor, `/jobs/${job.id}/assign-customer`, { customer_id: stock.id });
  await post(supervisor, `/jobs/${job.id}/assign-customer`, { customer_id: '' });
  assert.equal((await db('jobs').where({ id: job.id }).first()).customer_id, stock.id);

  const [buyerId] = await db('customers').insert({ number: 'CUS-T614', name: 'Mwangi Haulage', phone: '+254700000614', category: 'company' });
  const res = await post(supervisor, `/jobs/${job.id}/assign-customer`, { customer_id: buyerId });
  assert.equal(res.status, 302);
  const sold = await db('jobs').where({ id: job.id }).first();
  assert.equal(sold.customer_id, buyerId);
  assert.equal(sold.stock_build, 1, 'still known as built for stock');
  assert.equal((await db('vehicles').where({ id: sold.vehicle_id }).first()).customer_id, buyerId);
  assert.equal((await db('checkins').where({ id: checkinId }).first()).customer_id, buyerId);

  const page = (await supervisor.get(`/jobs/${job.id}`)).text;
  assert.match(page, /Mwangi Haulage/);
  assert.match(page, /Bought as a stock build/);
  assert.match(page, /Stock build sold to Mwangi Haulage/, 'in the history');
  assert.doesNotMatch(page, /Assign customer/);
  // Sold once: assigning again is refused.
  await post(supervisor, `/jobs/${job.id}/assign-customer`, { customer_id: buyerId });
  assert.match((await supervisor.get(`/jobs/${job.id}`)).text, /already has a customer/);

  // Now it is priced, invoiced and released like any job; it leaves the report.
  assert.ok((await admin.get(`/jobs/${job.id}`)).text.includes(`/proformas/new?job=${job.id}"`), 'Make proforma for the buyer');
  assert.equal((await admin.get(`/jobs/${job.id}/invoice`)).status, 200);
  assert.doesNotMatch((await supervisor.get(`/check-in/${checkinId}`)).text, /stock build with no customer yet/);
  assert.doesNotMatch((await admin.get('/reports/stock-value')).text, new RegExp(`href="/jobs/${job.id}"`));
  assert.doesNotMatch((await supervisor.get('/jobs?show=stock')).text, new RegExp(sold.number));
});

test('a stock build made from scratch needs no vehicle: just what is being built', async () => {
  // The form, opened as a stock build, asks what is being built; the chassis is optional.
  const form = (await supervisor.get(`/jobs/new?customer_id=${stock.id}`)).text;
  assert.match(form, /What is being built/);
  assert.match(form, /None: built from scratch/);

  let res = await post(supervisor, '/jobs', { customer_id: stock.id, vehicle_id: '', vehicle_description: '', line_quantity: ['1'], line_unit: ['Unit'], line_description: ['Build trailer'] });
  assert.equal(res.status, 422, 'says what is being built');
  assert.match(res.text, /Say what is being built/);

  res = await post(supervisor, '/jobs', { customer_id: stock.id, vehicle_id: '', vehicle_description: '40ft flatbed trailer', line_quantity: ['1'], line_unit: ['Unit'], line_description: ['Build 40ft flatbed trailer'] });
  assert.equal(res.status, 302, res.text.slice(0, 400));
  const id = Number(res.headers.location.split('/')[2]);
  const job = await db('jobs').where({ id }).first();
  assert.equal(job.vehicle_id, null);
  assert.equal(job.vehicle_description, '40ft flatbed trailer');
  assert.equal(job.stock_build, 1);
  assert.ok(job.materials_allowed_at);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Built from scratch, no chassis/);
  assert.match((await admin.get('/reports/stock-value')).text, /40ft flatbed trailer/);

  // A customer's job still needs a checked-in vehicle.
  const [ownerId] = await db('customers').insert({ number: 'CUS-T615', name: 'Kariuki Movers', phone: '+254700000615', category: 'company' });
  res = await post(supervisor, '/jobs', { customer_id: ownerId, vehicle_id: '', vehicle_description: 'Something', line_quantity: ['1'], line_unit: ['Unit'], line_description: ['Work'] });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the vehicle/);

  await db('audit_log').where({ entity: 'job', entity_id: id }).delete();
  await db('jobs').where({ id }).delete();
});
