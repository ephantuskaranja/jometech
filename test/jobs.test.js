import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let sales, supervisor, technician, gate, siteBOnly, customer, other, vehicle, hq, siteB;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  siteB = await db('sites').where({ code: 'SITEB' }).first();
  sales = await loginAs(app, await makeUser(80, ['sales']));
  supervisor = await loginAs(app, await makeUser(81, ['supervisor'], { siteIds: [hq.id, siteB.id] }));
  technician = await loginAs(app, await makeUser(82, ['technician']));
  gate = await loginAs(app, await makeUser(83, ['gate']));
  siteBOnly = await loginAs(app, await makeUser(84, ['supervisor'], { siteIds: [siteB.id] }));
  const csrf = csrfFrom((await sales.get('/customers/new')).text);
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Kamau Haulage', phone: '0700000811' });
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Achieng Farms', phone: '0700000812' });
  customer = await db('customers').where({ phone: '+254700000811' }).first();
  other = await db('customers').where({ phone: '+254700000812' }).first();
  await sales.post('/vehicles').type('form').send({ _csrf: csrf, reg_no: 'KZW 811A', customer_id: customer.id, type: 'truck', make: 'Isuzu', model: 'FRR' });
  vehicle = await db('vehicles').where({ reg_no: 'KZW 811A' }).first();
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const work = { line_quantity: ['1', ''], line_unit: ['Unit', ''], line_description: ['Repair tipper floor\n- Replace rear hinge', ''] };
const idOf = (location) => Number(location.split('/')[2]);

async function acceptedProforma(customerId, vehicleId = null) {
  let res = await post(sales, '/proformas', { customer_id: customerId, vehicle_id: vehicleId ?? '', vehicle_description: vehicleId ? '' : 'Howo 6 wheeler', proforma_date: localDay(), line_description: ['Fabrication of water bowser\n- Toolbox'], line_price: ['987,654'], line_quantity: ['1'], line_unit: ['Unit'] });
  const id = idOf(res.headers.location);
  await post(sales, `/proformas/${id}/send`);
  res = await post(sales, `/proformas/${id}/accept`);
  assert.equal(res.status, 302);
  return id;
}

test('who can do what', async () => {
  await gate.get('/jobs').expect(403);
  await technician.get('/jobs').expect(200);
  await sales.get('/jobs').expect(200);
  await technician.get('/jobs/new').expect(403);
  await sales.get('/jobs/new').expect(403);
  await supervisor.get('/jobs/new').expect(200);
  assert.equal((await post(sales, '/jobs', { customer_id: customer.id, ...work })).status, 403);
});

test('a job can start with no proforma and no vehicle; it needs a customer and the work', async () => {
  let res = await post(supervisor, '/jobs', { customer_id: '', line_description: [''] });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the customer/);
  assert.match(res.text, /Say what work is to be done/);

  res = await post(supervisor, '/jobs', { customer_id: customer.id, due_on: localDay(), ...work });
  assert.equal(res.status, 302, res.text);
  const job = await db('jobs').where({ id: idOf(res.headers.location) }).first();
  assert.match(job.number, /^JOB-\d{4}-\d{4,}$/);
  assert.equal(job.status, 'open');
  assert.equal(job.vehicle_id, null);
  assert.equal(job.proforma_id, null);
  assert.equal(job.site_id, hq.id);
  assert.equal((await db('job_lines').where({ job_id: job.id })).length, 1, 'the empty row is skipped');

  const list = (await supervisor.get('/jobs')).text;
  assert.match(list, new RegExp(job.number));
  const page = (await supervisor.get(`/jobs/${job.id}`).expect(200)).text;
  assert.match(page, /Repair tipper floor/);
  assert.match(page, /Not chosen yet/);
});

test('a supervisor (app user) and, optionally, a responsible employee who doesn’t use the app', async () => {
  const me = await db('users').where({ phone: '+254700000081' }).first('id');
  let res = await post(supervisor, '/jobs', { customer_id: customer.id, supervisor_id: me.id, responsible_name: 'Otieno (welding foreman)', ...work });
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  const job = await db('jobs').where({ id }).first();
  assert.equal(job.supervisor_id, me.id);
  assert.equal(job.responsible_name, 'Otieno (welding foreman)');
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /<dt>Responsible<\/dt><dd>Otieno \(welding foreman\)/);
  assert.match((await supervisor.get(`/jobs/${id}/print`)).text, /Responsible:<\/span> Otieno \(welding foreman\)/);

  res = await post(supervisor, `/jobs/${id}`, { customer_id: customer.id, supervisor_id: me.id, responsible_name: '', ...work });
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('jobs').where({ id }).first()).responsible_name, null, 'not mandatory');
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Responsible/, 'the change is in the history');
});

test('with no supervisors at the site, admins are pointed to Users', async () => {
  const admin = await loginAs(app, await makeUser(79, ['admin']));
  const someone = await db('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').join('users as u', 'u.id', 'ur.user_id')
    .whereIn('r.key', ['supervisor', 'manager']).where('u.is_active', true).first('u.id');
  const form = (await admin.get('/jobs/new')).text;
  assert.match(form, /name="supervisor_id"[^>]*data-tom-select/, 'searchable');
  if (!someone) assert.match(form, /No supervisors at .* yet\. <a href="\/admin\/users\/new">Add one under Users/);
});

test('a vehicle must be the customer’s own', async () => {
  const res = await post(supervisor, '/jobs', { customer_id: other.id, vehicle_id: vehicle.id, ...work });
  assert.equal(res.status, 422);
  assert.match(res.text, /one of this customer/);
});

test('the job card prints the details and blank sections to fill in', async () => {
  const job = await db('jobs').where({ customer_id: customer.id }).first();
  const card = (await technician.get(`/jobs/${job.id}/print`).expect(200)).text;
  assert.match(card, new RegExp(job.number));
  assert.match(card, /<li>Replace rear hinge<\/li>/, '"- " lines print as bullets');
  assert.match(card, /Work log/);
  assert.match(card, /Materials used/);
  assert.match(card, /Approved for release/);
});

test('an accepted proforma becomes a job in one click, with no prices, and only once', async () => {
  const proformaId = await acceptedProforma(other.id);
  const proforma = await db('proformas').where({ id: proformaId }).first();

  assert.match((await supervisor.get('/jobs')).text, /Accepted proformas waiting for a job/, 'the workshop can see what is waiting');
  let res = await post(sales, `/proformas/${proformaId}/job`);
  assert.equal(res.status, 302);
  const job = await db('jobs').where({ proforma_id: proformaId }).first();
  assert.equal(res.headers.location, `/jobs/${job.id}`);
  assert.equal(job.customer_id, other.id);
  assert.equal(job.vehicle_description, 'Howo 6 wheeler');
  assert.doesNotMatch((await supervisor.get('/jobs')).text, new RegExp(`/proformas/${proformaId}/job`), 'no longer waiting');

  const lines = await db('job_lines').where({ job_id: job.id });
  assert.equal(lines.length, 1);
  assert.match(lines[0].description, /water bowser/);
  assert.equal(lines[0].unit_price, undefined);

  for (const url of [`/jobs/${job.id}`, `/jobs/${job.id}/print`]) {
    assert.doesNotMatch((await technician.get(url).expect(200)).text, /987,654/, `${url} shows no price`);
  }
  assert.doesNotMatch((await technician.get(`/jobs/${job.id}`)).text, new RegExp(`/proformas/${proformaId}"`), 'no link to a page they can’t open');
  assert.match((await sales.get(`/proformas/${proformaId}`)).text, new RegExp(`/jobs/${job.id}`), 'the proforma links to its job');

  res = await post(sales, `/proformas/${proformaId}/job`);
  assert.equal(res.headers.location, `/jobs/${job.id}`, 'asking again opens the same job');
  assert.equal((await db('jobs').where({ proforma_id: proformaId })).length, 1);
  assert.equal(proforma.status, 'accepted');
});

test('a proforma that isn’t accepted can’t become a job', async () => {
  const res = await post(sales, '/proformas', { customer_id: other.id, proforma_date: localDay(), line_description: ['Dropside'], line_price: ['500000'] });
  const id = idOf(res.headers.location);
  assert.equal((await post(sales, `/proformas/${id}/job`)).status, 409);
  assert.equal((await db('jobs').where({ proforma_id: id })).length, 0);
});

test('a job from a proforma keeps its customer and work when edited', async () => {
  const job = await db('jobs').where({ customer_id: other.id }).whereNotNull('proforma_id').first();
  const res = await post(supervisor, `/jobs/${job.id}`, { customer_id: customer.id, line_description: ['Something else'], instructions: 'Call before fitting', vehicle_description: 'Howo 6 wheeler' });
  assert.equal(res.status, 302, res.text);
  const after = await db('jobs').where({ id: job.id }).first();
  assert.equal(after.customer_id, other.id);
  assert.equal(after.instructions, 'Call before fitting');
  const [line] = await db('job_lines').where({ job_id: job.id });
  assert.match(line.description, /water bowser/);
  assert.match((await supervisor.get(`/jobs/${job.id}`)).text, /Call before fitting/);
});

test('a vehicle added later links its check-in; a later check-in links too; the job follows the vehicle', async () => {
  // The vehicle isn't in yet: chosen on the job, no check-in to link.
  const job = await db('jobs').where({ customer_id: customer.id }).whereNull('proforma_id').first();
  let res = await post(supervisor, `/jobs/${job.id}`, { customer_id: customer.id, vehicle_id: vehicle.id, ...work });
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('jobs').where({ id: job.id }).first()).checkin_id, null);

  // It arrives: the check-in finds the job.
  res = await post(supervisor, '/check-in', { purpose: 'fabrication', vehicle_mode: 'existing', vehicle_id: vehicle.id, remarks: 'For the job' });
  assert.equal(res.status, 302, res.text);
  const checkin = await db('checkins').where({ vehicle_id: vehicle.id, status: 'in_workshop' }).first();
  assert.equal((await db('jobs').where({ id: job.id }).first()).checkin_id, checkin.id);
  assert.match((await supervisor.get(`/check-in/${checkin.id}`)).text, new RegExp(`/jobs/${job.id}`), 'the check-in shows its job');
  assert.match((await supervisor.get(`/vehicles/${vehicle.id}`)).text, new RegExp(`/jobs/${job.id}`), 'the vehicle shows its job');

  // A new job for a vehicle already here links at once.
  res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: vehicle.id, ...work });
  const second = await db('jobs').where({ id: idOf(res.headers.location) }).first();
  assert.equal(second.checkin_id, checkin.id);

  // Sent to Site B and received there: both jobs go with it.
  res = await post(supervisor, `/check-in/${checkin.id}/send`, { to_site_id: siteB.id, driver_name: 'Otieno' });
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('jobs').where({ id: job.id }).first()).site_id, hq.id, 'still HQ’s until it arrives');
  const move = await db('vehicle_movements').where({ checkin_id: checkin.id, status: 'in_transit' }).first();
  res = await post(siteBOnly, `/movements/${move.id}/receive`);
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('jobs').where({ id: job.id }).first()).site_id, siteB.id);
  assert.equal((await db('jobs').where({ id: second.id }).first()).site_id, siteB.id);
  await siteBOnly.get(`/jobs/${job.id}`).expect(200);

  // HQ-only staff can't open it now.
  await technician.get(`/jobs/${job.id}`).expect(403);
  await technician.get(`/jobs/${job.id}/print`).expect(403);
});

test('start, complete, reopen and cancel, in the right order', async () => {
  const res = await post(supervisor, '/jobs', { customer_id: other.id, ...work });
  const id = idOf(res.headers.location);
  const status = async () => (await db('jobs').where({ id }).first()).status;

  assert.equal((await post(supervisor, `/jobs/${id}/complete`)).status, 409, 'not started yet');
  await post(supervisor, `/jobs/${id}/start`);
  assert.equal(await status(), 'in_progress');
  assert.equal((await post(supervisor, `/jobs/${id}/start`)).status, 409, 'already started');
  assert.equal((await post(technician, `/jobs/${id}/complete`)).status, 403, 'a technician can’t close a job');

  assert.equal((await post(supervisor, `/jobs/${id}/complete`)).status, 409, 'its steps aren’t finished');
  for (const step of await db('job_steps').where({ job_id: id }).orderBy('sort_order')) await post(supervisor, `/jobs/${id}/steps/${step.id}/done`);
  assert.equal(await status(), 'completed');
  assert.equal((await post(supervisor, `/jobs/${id}`, { customer_id: other.id, ...work })).status, 409, 'a completed job is locked');
  await supervisor.get(`/jobs/${id}/edit`).expect(409);
  assert.match((await supervisor.get('/jobs?show=completed')).text, new RegExp(`/jobs/${id}"`));

  await post(supervisor, `/jobs/${id}/reopen`);
  assert.equal(await status(), 'in_progress', 'it had started, so back to in progress');

  await post(supervisor, `/jobs/${id}/cancel`, { reason: '' });
  assert.equal(await status(), 'in_progress', 'cancelling needs a reason');
  await post(supervisor, `/jobs/${id}/cancel`, { reason: 'Customer changed their mind' });
  const job = await db('jobs').where({ id }).first();
  assert.equal(job.status, 'cancelled');
  assert.equal(job.cancelled_reason, 'Customer changed their mind');
  assert.match((await supervisor.get(`/jobs/${id}/print`)).text, /is-cancelled/);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Customer changed their mind/);
});

test('jobs are found by number, in the jobs list and the top-bar search', async () => {
  const job = await db('jobs').where({ customer_id: other.id }).first();
  assert.match((await supervisor.get(`/jobs?q=${job.number}`)).text, new RegExp(`/jobs/${job.id}"`));
  const { body } = await supervisor.get(`/api/search?q=${job.number}`).expect(200);
  assert.ok(body.results.some((r) => r.url === `/jobs/${job.id}`));
  const found = await siteBOnly.get(`/api/search?q=${job.number}`).expect(200);
  assert.ok(!found.body.results.some((r) => r.url === `/jobs/${job.id}`), 'only jobs at the user’s own sites');
});
