import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup, checkedInVehicle } from './helpers.js';

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
let plate = 0;
/** A vehicle of this customer checked in at HQ: a job is opened only for one (sheet row 49). */
const arrived = (customerId) => checkedInVehicle(customerId, `KJR 7${String(plate++).padStart(2, '0')}A`);

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

test('a job is opened only for a vehicle checked in here; it needs the customer, the vehicle and the work', async () => {
  let res = await post(supervisor, '/jobs', { customer_id: '', line_description: [''] });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the customer/);
  assert.match(res.text, /Say what work is to be done/);

  res = await post(supervisor, '/jobs', { customer_id: customer.id, ...work });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the vehicle\. It must be checked in here first/);

  // Sheet row 49: not checked in, no job. The form says so, with a way to check it in.
  res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: vehicle.id, ...work });
  assert.equal(res.status, 422);
  assert.match(res.text, /KZW 811A isn’t checked in\. Check it in first, then open its job/);
  assert.ok(res.text.includes(`href="/check-in/new?vehicle_id=${vehicle.id}"`), 'a button to check it in');
  assert.equal((await db('jobs').where({ vehicle_id: vehicle.id })).length, 0);
  assert.match((await supervisor.get(`/jobs/new?customer_id=${customer.id}`)).text, /KZW 811A · Isuzu FRR \(not checked in\)/, 'offered, but greyed out');

  const inside = await arrived(customer.id);
  res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: inside, due_on: '2020-01-01', ...work });
  assert.equal(res.status, 422, 'a promise can’t be in the past');
  assert.match(res.text, /Promise a date from today on/);
  assert.match((await supervisor.get('/jobs/new')).text, new RegExp(`name="due_on"[^>]*min="${localDay()}"`));

  res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: inside, due_on: localDay(), ...work });
  assert.equal(res.status, 302, res.text);
  const job = await db('jobs').where({ id: idOf(res.headers.location) }).first();
  assert.match(job.number, /^JOB-\d{4}-\d{4,}$/);
  assert.equal(job.status, 'open');
  assert.equal(job.vehicle_id, inside);
  assert.equal(job.checkin_id, (await db('checkins').where({ vehicle_id: inside, status: 'in_workshop' }).first()).id, 'linked to its check-in');
  assert.equal(job.proforma_id, null);
  assert.equal(job.site_id, hq.id);
  assert.equal((await db('job_lines').where({ job_id: job.id })).length, 1, 'the empty row is skipped');

  const list = (await supervisor.get('/jobs')).text;
  assert.match(list, new RegExp(job.number));
  const page = (await supervisor.get(`/jobs/${job.id}`).expect(200)).text;
  assert.match(page, /Repair tipper floor/);

  // Its vehicle can be changed to another checked-in one, not taken off.
  res = await post(supervisor, `/jobs/${job.id}`, { customer_id: customer.id, vehicle_id: '', ...work });
  assert.equal(res.status, 422);
  assert.match(res.text, /not removed/);
  res = await post(supervisor, `/jobs/${job.id}`, { customer_id: customer.id, vehicle_id: vehicle.id, ...work });
  assert.equal(res.status, 422, 'nor changed to one not checked in');
  assert.match(res.text, /isn’t checked in/);
});

test('a supervisor (app user) and, optionally, a responsible employee who doesn’t use the app', async () => {
  const me = await db('users').where({ phone: '+254700000081' }).first('id');
  const inside = await arrived(customer.id);
  let res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: inside, supervisor_id: me.id, responsible_name: 'Otieno (welding foreman)', ...work });
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  const job = await db('jobs').where({ id }).first();
  assert.equal(job.supervisor_id, me.id);
  assert.equal(job.responsible_name, 'Otieno (welding foreman)');
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /<dt>Responsible<\/dt><dd>Otieno \(welding foreman\)/);
  assert.match((await supervisor.get(`/jobs/${id}/print`)).text, /Responsible:<\/span> Otieno \(welding foreman\)/);

  res = await post(supervisor, `/jobs/${id}`, { customer_id: customer.id, vehicle_id: inside, supervisor_id: me.id, responsible_name: '', ...work });
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
  const res = await post(supervisor, '/jobs', { customer_id: other.id, vehicle_id: await arrived(customer.id), ...work });
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

test('an accepted proforma becomes a job in one click once its vehicle is checked in, with no prices, and only once', async () => {
  // Priced for a vehicle only described: it is chosen once it has been checked in.
  const proformaId = await acceptedProforma(other.id);
  const proforma = await db('proformas').where({ id: proformaId }).first();
  let jobs = (await supervisor.get('/jobs')).text;
  assert.match(jobs, /Accepted proformas waiting for a job/, 'the workshop can see what is waiting');
  assert.ok(jobs.includes(`href="/proformas/${proformaId}"`), 'with a link to choose its vehicle');
  let res = await post(sales, `/proformas/${proformaId}/job`);
  assert.equal(res.headers.location, `/proformas/${proformaId}`, 'no vehicle chosen: back to the proforma');
  assert.equal((await db('jobs').where({ proforma_id: proformaId })).length, 0);
  assert.match((await sales.get(`/proformas/${proformaId}`)).text, /has no vehicle on file\. Check the customer’s vehicle in here/);

  const inside = await arrived(other.id);
  assert.match((await sales.get(`/proformas/${proformaId}`)).text, /name="vehicle_id"/, 'now it can be chosen');
  res = await post(sales, `/proformas/${proformaId}/job`, { vehicle_id: inside });
  assert.equal(res.status, 302);
  const job = await db('jobs').where({ proforma_id: proformaId }).first();
  assert.equal(res.headers.location, `/jobs/${job.id}`);
  assert.equal(job.customer_id, other.id);
  assert.equal(job.vehicle_id, inside);
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

  // Priced for a vehicle on file that isn't checked in yet: it waits for the check-in.
  const waitingId = await acceptedProforma(customer.id, vehicle.id);
  jobs = (await supervisor.get('/jobs')).text;
  assert.match(jobs, /Waiting for KZW 811A to be checked in/);
  res = await post(sales, `/proformas/${waitingId}/job`);
  assert.equal(res.headers.location, `/proformas/${waitingId}`);
  assert.equal((await db('jobs').where({ proforma_id: waitingId })).length, 0);
  assert.match((await sales.get(`/proformas/${waitingId}`)).text, /KZW 811A isn’t checked in/);
  await db('proformas').where({ id: waitingId }).update({ status: 'declined' }); // out of the way of later tests
});

test('a proforma that isn’t accepted can’t become a job', async () => {
  const res = await post(sales, '/proformas', { customer_id: other.id, proforma_date: localDay(), line_description: ['Dropside'], line_price: ['500000'] });
  const id = idOf(res.headers.location);
  assert.equal((await post(sales, `/proformas/${id}/job`)).status, 409);
  assert.equal((await db('jobs').where({ proforma_id: id })).length, 0);
});

test('a job from a proforma keeps its customer and work when edited', async () => {
  const job = await db('jobs').where({ customer_id: other.id }).whereNotNull('proforma_id').first();
  const res = await post(supervisor, `/jobs/${job.id}`, { customer_id: customer.id, vehicle_id: job.vehicle_id, line_description: ['Something else'], instructions: 'Call before fitting' });
  assert.equal(res.status, 302, res.text);
  const after = await db('jobs').where({ id: job.id }).first();
  assert.equal(after.customer_id, other.id);
  assert.equal(after.instructions, 'Call before fitting');
  assert.equal(after.vehicle_description, 'Howo 6 wheeler', 'what the proforma described stays');
  const [line] = await db('job_lines').where({ job_id: job.id });
  assert.match(line.description, /water bowser/);
  assert.match((await supervisor.get(`/jobs/${job.id}`)).text, /Call before fitting/);
});

test('checked in, then its job: one job per vehicle, and the job follows the vehicle between sites', async () => {
  // Not in yet: the new-job page says so straight away.
  assert.match((await supervisor.get(`/jobs/new?vehicle_id=${vehicle.id}`)).text, /isn’t checked in\. Check it in first/);
  assert.doesNotMatch((await supervisor.get(`/vehicles/${vehicle.id}`)).text, /href="\/jobs\/new\?vehicle_id=/, 'no New job button on the vehicle');

  let res = await post(supervisor, '/check-in', { purpose: 'fabrication', vehicle_mode: 'existing', vehicle_id: vehicle.id, remarks: 'For the job', no_arrival_reason: 'Test: not through the gate' });
  assert.equal(res.status, 302, res.text);
  const checkin = await db('checkins').where({ vehicle_id: vehicle.id, status: 'in_workshop' }).first();
  res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: vehicle.id, ...work });
  assert.equal(res.status, 302, res.text);
  const job = await db('jobs').where({ id: idOf(res.headers.location) }).first();
  assert.equal(job.checkin_id, checkin.id);
  assert.match((await supervisor.get(`/check-in/${checkin.id}`)).text, new RegExp(`/jobs/${job.id}`), 'the check-in shows its job');
  assert.match((await supervisor.get(`/vehicles/${vehicle.id}`)).text, new RegExp(`/jobs/${job.id}`), 'the vehicle shows its job');

  // One running job per vehicle: a second one is refused, with a way to edit the one running.
  res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: vehicle.id, ...work });
  assert.equal(res.status, 422);
  assert.match(res.text, new RegExp(`already has job ${job.number}`));
  assert.match(res.text, new RegExp(`href="/jobs/${job.id}/edit"`));
  assert.match((await supervisor.get(`/jobs/new?vehicle_id=${vehicle.id}`)).text, /Add the work to that job instead/, 'said before the form is filled in');

  // Sent to Site B, through both gates, and received there: the job goes with it.
  res = await post(supervisor, `/check-in/${checkin.id}/send`, { to_site_id: siteB.id, driver_name: 'Otieno' });
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('jobs').where({ id: job.id }).first()).site_id, hq.id, 'still HQ’s until it arrives');
  const move = await db('vehicle_movements').where({ checkin_id: checkin.id, status: 'in_transit' }).first();
  assert.equal((await post(supervisor, `/movements/${move.id}/gate-out`)).status, 302);
  assert.equal((await post(siteBOnly, `/movements/${move.id}/gate-in`)).status, 302);
  res = await post(siteBOnly, `/movements/${move.id}/receive`);
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('jobs').where({ id: job.id }).first()).site_id, siteB.id);
  await siteBOnly.get(`/jobs/${job.id}`).expect(200);

  // A supervisor at both sites, working at HQ, is sent to Site B to open a job for a vehicle there.
  await post(supervisor, `/jobs/${job.id}/cancel`, { reason: 'Test: free the vehicle' });
  const page = (await supervisor.get(`/jobs/new?vehicle_id=${vehicle.id}`)).text;
  assert.match(page, /is checked in at Site B, not here/);
  assert.match(page, /Switch to Site B/);
  await post(supervisor, `/jobs/${job.id}/reopen`);

  // HQ-only staff can't open it now.
  await technician.get(`/jobs/${job.id}`).expect(403);
  await technician.get(`/jobs/${job.id}/print`).expect(403);
});

test('start, complete, reopen and cancel, in the right order', async () => {
  const res = await post(supervisor, '/jobs', { customer_id: other.id, vehicle_id: await arrived(other.id), ...work });
  const id = idOf(res.headers.location);
  const status = async () => (await db('jobs').where({ id }).first()).status;

  assert.equal((await post(supervisor, `/jobs/${id}/complete`)).status, 409, 'not started yet');
  await post(supervisor, `/jobs/${id}/start`);
  assert.equal(await status(), 'in_progress');
  assert.equal((await post(supervisor, `/jobs/${id}/start`)).status, 409, 'already started');
  assert.equal((await post(technician, `/jobs/${id}/complete`)).status, 403, 'a technician can’t close a job');

  assert.equal((await post(supervisor, `/jobs/${id}/complete`)).status, 409, 'its steps aren’t finished');
  for (const step of await db('job_steps').where({ job_id: id }).orderBy('sort_order')) {
    if (step.is_receive) { assert.equal(step.status, 'done', 'the check-in ticked it at the start'); continue; }
    if (step.is_signoff) {
      // So is the customer's sign-off step: here, no one was there to sign.
      assert.equal((await post(supervisor, `/jobs/${id}/steps/${step.id}/done`)).status, 409);
      await post(supervisor, `/jobs/${id}/signoff/not-signed`, { reason: 'other', other_reason: 'Owner approved by phone' });
      continue;
    }
    if (!step.is_qc) { await post(supervisor, `/jobs/${id}/steps/${step.id}/done`); continue; }
    // The quality check step is ticked off by a passed check, not by hand.
    assert.equal((await post(supervisor, `/jobs/${id}/steps/${step.id}/done`)).status, 409);
    const check = idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location);
    const items = await db('qc_inspection_items').where({ inspection_id: check }).pluck('id');
    await post(supervisor, `/qc/${check}`, { finish: '1', ...Object.fromEntries(items.map((i) => [`result_${i}`, 'pass'])) });
  }
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

test('the gate logs the vehicle in, it is checked in, then its job opens; Vehicle Received is ticked by the check-in, never by hand', async () => {
  const csrf = csrfFrom((await sales.get('/vehicles/new')).text);
  await sales.post('/vehicles').type('form').send({ _csrf: csrf, reg_no: 'KZW 812A', customer_id: other.id, type: 'truck', make: 'Isuzu' });
  await sales.post('/vehicles').type('form').send({ _csrf: csrf, reg_no: 'KZW 813A', customer_id: other.id, type: 'truck', make: 'Hino' });
  const late = await db('vehicles').where({ reg_no: 'KZW 812A' }).first();
  const step1 = (jobId) => db('job_steps').where({ job_id: jobId, sort_order: 1 }).first();

  // Not here yet: no job.
  let res = await post(supervisor, '/jobs', { customer_id: other.id, vehicle_id: late.id, ...work });
  assert.equal(res.status, 422);

  // It arrives: the gate logs it in, and the check-in is made from that.
  res = await post(gate, '/gate/arrivals', { vehicle_text: 'kzw812a', driver_name: 'Juma Otieno', driver_phone: '0700 000 819', purpose: 'repairs' });
  assert.equal(res.status, 302, res.text);
  const arrival = await db('vehicle_arrivals').where({ vehicle_id: late.id, status: 'waiting' }).first();
  assert.ok(arrival, 'the plate as typed finds the vehicle');
  const form = (await supervisor.get(`/check-in/new?vehicle_id=${late.id}`)).text;
  assert.match(form, new RegExp(`name="arrival_id" value="${arrival.id}"`), 'the check-in picks up the gate’s arrival');
  assert.match(form, /Juma Otieno/);
  res = await post(supervisor, '/check-in', { purpose: 'repairs', vehicle_mode: 'existing', vehicle_id: late.id, arrival_id: arrival.id, contact_id: 'name:Juma Otieno' });
  assert.equal(res.status, 302, res.text);
  const checkedIn = await db('vehicle_arrivals').where({ id: arrival.id }).first();
  assert.equal(checkedIn.status, 'checked_in');
  assert.equal((await db('checkins').where({ id: checkedIn.checkin_id }).first()).arrival_id, arrival.id);

  // Now its job opens; starting it ticks Vehicle Received from the check-in.
  res = await post(supervisor, '/jobs', { customer_id: other.id, vehicle_id: late.id, ...work });
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  const step = await step1(id);
  assert.equal(step.name, 'Vehicle Received');
  assert.equal(step.is_receive, 1);
  assert.equal(step.status, 'pending', 'not before the job starts');
  await post(supervisor, `/jobs/${id}/start`);
  assert.equal((await step1(id)).status, 'done');
  assert.equal((await step1(id)).finished_by, (await db('users').where({ phone: '+254700000081' }).first('id')).id);
  assert.equal((await post(supervisor, `/jobs/${id}/steps/undo`)).status, 409, 'only the check-in undoes it');
  const logged = await db('audit_log').where({ entity: 'job', entity_id: id, action: 'step_done' }).first();
  assert.match(logged.summary, /^Vehicle Received \(check-in CHK-/);
  await post(supervisor, `/jobs/${id}/cancel`, { reason: 'Test over' });
});

test('an older job with only a description waits until its vehicle is chosen; one with no vehicle skips the step', async () => {
  // Jobs opened before a checked-in vehicle was needed: made here by taking the vehicle off.
  const older = async (description) => {
    const res = await post(supervisor, '/jobs', { customer_id: other.id, vehicle_id: await arrived(other.id), ...work });
    const id = idOf(res.headers.location);
    await db('jobs').where({ id }).update({ vehicle_id: null, checkin_id: null, vehicle_description: description });
    await post(supervisor, `/jobs/${id}/start`);
    return id;
  };
  const chassis = await older('New Isuzu NQR chassis');
  const step = await db('job_steps').where({ job_id: chassis, sort_order: 1 }).first();
  assert.equal(step.status, 'pending');
  assert.equal((await post(supervisor, `/jobs/${chassis}/steps/${step.id}/skip`)).status, 409, 'a vehicle is coming');
  assert.match((await supervisor.get(`/jobs/${chassis}`)).text, /Once it is checked in, choose it on the job/);
  assert.match((await supervisor.get(`/jobs/${chassis}/edit`)).text, /name="vehicle_description"/, 'its description can still be changed');
  // The chassis arrives and is checked in (KZW 813A stands in for it); choosing it on the job ticks the step.
  const vehicle = await db('vehicles').where({ reg_no: 'KZW 813A' }).first();
  await post(supervisor, '/check-in', { purpose: 'repairs', vehicle_mode: 'existing', vehicle_id: vehicle.id, no_arrival_reason: 'Test: not through the gate' });
  const res = await post(supervisor, `/jobs/${chassis}`, { customer_id: other.id, vehicle_id: vehicle.id, ...work });
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('job_steps').where({ id: step.id }).first()).status, 'done');
  await post(supervisor, `/jobs/${chassis}/cancel`, { reason: 'Test over' });

  const none = await older(null);
  const first = await db('job_steps').where({ job_id: none, sort_order: 1 }).first();
  assert.match((await supervisor.get(`/jobs/${none}`)).text, /This job has no vehicle/);
  assert.equal((await post(supervisor, `/jobs/${none}/steps/${first.id}/done`)).status, 409);
  assert.equal((await post(supervisor, `/jobs/${none}/steps/${first.id}/skip`)).status, 302, 'no vehicle: nothing to receive');
  assert.equal((await db('job_steps').where({ id: first.id }).first()).status, 'skipped');
  await post(supervisor, `/jobs/${none}/cancel`, { reason: 'Test over' });
});

test('job types say whether the check-in ticks off their first step', async () => {
  const admin = await loginAs(app, await makeUser(85, ['admin']));
  const repair = await db('job_types').where({ name: 'Repair' }).first();
  assert.equal(repair.receive_step, 'Vehicle Received');
  const steps = await db('job_type_steps').where({ job_type_id: repair.id }).orderBy('sort_order').pluck('name');
  const form = { name: repair.name, step: steps, qc_step: repair.qc_step ?? '', signoff_step: repair.signoff_step ?? '' };
  let res = await post(admin, `/admin/job-types/${repair.id}`, form);
  assert.equal(res.status, 302);
  assert.equal((await db('job_types').where({ id: repair.id }).first()).receive_step, null, 'unticked');
  res = await post(admin, `/admin/job-types/${repair.id}`, { ...form, receive_first: '1' });
  assert.equal(res.status, 302);
  assert.equal((await db('job_types').where({ id: repair.id }).first()).receive_step, 'Vehicle Received');
  assert.match((await admin.get(`/admin/job-types/${repair.id}`)).text, /name="receive_first" value="1" checked/);
});
