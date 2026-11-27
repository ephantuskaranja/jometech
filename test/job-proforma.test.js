// Sheet row 49, part B: the job can come before the price. "Make proforma" on a running job; once the
// customer accepts it, it becomes that job's proforma (no second job), and only then do stores issue
// materials, unless a supervisor (or above) allows it early, saying why.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup, checkedInVehicle } from './helpers.js';

const app = createApp();
let sales, supervisor, store, technician, customer;

before(async () => {
  sales = await loginAs(app, await makeUser(90, ['sales']));
  supervisor = await loginAs(app, await makeUser(91, ['supervisor']));
  store = await loginAs(app, await makeUser(92, ['storekeeper']));
  technician = await loginAs(app, await makeUser(93, ['technician']));
  const csrf = csrfFrom((await sales.get('/customers/new')).text);
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Wanjiru Transporters', phone: '0700000911' });
  customer = await db('customers').where({ phone: '+254700000911' }).first();
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const idOf = (location) => Number(location.split('/')[2]);
let plate = 0;
const arrived = () => checkedInVehicle(customer.id, `KJR 8${String(plate++).padStart(2, '0')}A`);

/** A job opened on a checked-in vehicle, with no proforma yet. */
async function runningJob() {
  const vehicleId = await arrived();
  const res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: vehicleId, line_quantity: ['1'], line_unit: ['Unit'], line_description: ['Repair tipper floor'] });
  assert.equal(res.status, 302, res.text);
  return { id: idOf(res.headers.location), vehicleId };
}

/** The proforma form as "Make proforma" fills it, priced and saved. */
async function proformaFor(jobId, fields = {}) {
  const res = await post(sales, '/proformas', {
    for_job_id: jobId, customer_id: customer.id, proforma_date: localDay(),
    line_quantity: ['1', '2'], line_unit: ['Unit', 'Pcs'], line_description: ['Repair tipper floor', 'New mud flaps'], line_price: ['150,000', '4,000'], ...fields,
  });
  return res;
}

// Stores try to issue: the job's state is checked before anything is taken from stock.
const tryIssue = (jobId) => post(store, `/jobs/${jobId}/issue`, { issued_on: localDay(), line_balance_id: ['999999'], line_label: ['Any'], line_quantity: ['1'] });

test('a job with no accepted proforma: stores can’t issue to it, and the job page says why', async () => {
  const { id } = await runningJob();
  const job = await db('jobs').where({ id }).first();
  assert.equal(job.materials_allowed_at, null, 'a new job waits for its price');

  let res = await store.get(`/jobs/${id}/issue`);
  assert.equal(res.status, 302, 'the form sends stores back to the job');
  assert.equal(res.headers.location, `/jobs/${id}`);
  res = await tryIssue(id);
  assert.equal(res.status, 409);
  assert.match(res.text, /waiting for the customer to accept its proforma/);
  assert.equal(await db('material_issues').where({ job_id: id }).first('id'), undefined);

  // The job picker on the stores page greys it out.
  assert.match((await store.get('/stores/issue')).text, new RegExp(`value="${id}" disabled>[^<]*proforma not accepted yet`));

  const page = (await store.get(`/jobs/${id}`)).text;
  assert.match(page, /Stores can’t issue materials yet/);
  assert.doesNotMatch(page, new RegExp(`href="/jobs/${id}/issue"`), 'no Issue materials button');
  assert.match((await sales.get(`/jobs/${id}`)).text, new RegExp(`href="/proformas/new\\?job=${id}"`), 'sales can make the proforma');
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Allow materials now/, 'a supervisor can allow it early');
  assert.doesNotMatch((await store.get(`/jobs/${id}`)).text, /Allow materials now/);
});

test('Make proforma: filled in from the job; accepted, it becomes the job’s proforma and stores can issue', async () => {
  const { id, vehicleId } = await runningJob();
  const form = await sales.get(`/proformas/new?job=${id}`);
  assert.equal(form.status, 200);
  assert.match(form.text, new RegExp(`name="for_job_id" value="${id}"`));
  assert.match(form.text, new RegExp(`name="vehicle_id" value="${vehicleId}"`));
  assert.match(form.text, /Repair tipper floor/, 'the job’s work, to price');
  assert.match(form.text, /Wanjiru Transporters/);

  // The customer and vehicle are the job's, whatever the form sends.
  const other = await db('customers').insert({ number: 'CUS-T912', name: 'Someone Else', phone: '+254700000912', category: 'individual' });
  let res = await proformaFor(id, { customer_id: other[0], vehicle_id: '' });
  assert.equal(res.status, 302, res.text);
  const pid = Number(res.headers.location.split('/')[2]);
  let p = await db('proformas').where({ id: pid }).first();
  assert.equal(p.for_job_id, id);
  assert.equal(p.customer_id, customer.id);
  assert.equal(p.vehicle_id, vehicleId);

  // One being prepared at a time: Make proforma again leads to it.
  res = await sales.get(`/proformas/new?job=${id}`);
  assert.equal(res.headers.location, `/proformas/${pid}`);
  res = await proformaFor(id);
  assert.equal(res.status, 422);
  assert.match(res.text, /already has proforma/);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, new RegExp(`${p.number}[\\s\\S]*Draft, not sent yet`));

  await post(sales, `/proformas/${pid}/send`);
  res = await post(sales, `/proformas/${pid}/accept`);
  assert.equal(res.status, 302);
  const job = await db('jobs').where({ id }).first();
  assert.equal(job.proforma_id, pid, 'it is now the job’s proforma');
  assert.equal(await db('jobs').where({ proforma_id: pid }).count({ n: '*' }).then(([r]) => Number(r.n)), 1, 'no second job');
  const lines = await db('job_lines').where({ job_id: id }).orderBy('sort_order').pluck('description');
  assert.deepEqual(lines, ['Repair tipper floor', 'New mud flaps'], 'the job’s work is what was agreed');
  assert.match((await sales.get(`/proformas/${pid}`)).text, new RegExp(`Open job ${job.number}`));
  assert.doesNotMatch((await supervisor.get('/jobs')).text, new RegExp(`/proformas/${pid}"`), 'not waiting for a job');

  // The agreed work is fixed now: an edit keeps the proforma's lines.
  await post(supervisor, `/jobs/${id}`, { customer_id: customer.id, vehicle_id: vehicleId, line_description: ['Something else'] });
  assert.deepEqual(await db('job_lines').where({ job_id: id }).orderBy('sort_order').pluck('description'), ['Repair tipper floor', 'New mud flaps']);

  // Stores can issue now: the request gets past the job and fails only on the made-up stock line.
  res = await tryIssue(id);
  assert.equal(res.status, 422);
  assert.match(res.text, /isn’t in stock at this site/);
  assert.match((await store.get(`/jobs/${id}`)).text, new RegExp(`href="/jobs/${id}/issue"`));

  // No second proforma for it.
  res = await sales.get(`/proformas/new?job=${id}`);
  assert.equal(res.headers.location, `/proformas/${pid}`);
  p = await db('proformas').where({ id: pid }).first();
  assert.equal(p.status, 'accepted');
});

test('a revision of the job’s proforma stays with the job; declined, the job keeps waiting', async () => {
  const { id } = await runningJob();
  let res = await proformaFor(id);
  const pid = Number(res.headers.location.split('/')[2]);
  await post(sales, `/proformas/${pid}/send`);
  await post(sales, `/proformas/${pid}/decline`, { reason: 'Price too high' });
  assert.equal((await db('jobs').where({ id }).first()).proforma_id, null);
  assert.equal((await tryIssue(id)).status, 409, 'still waiting');

  res = await post(sales, `/proformas/${pid}/revise`);
  const rid = Number(res.headers.location.split('/')[2]);
  assert.equal((await db('proformas').where({ id: rid }).first()).for_job_id, id);
  await post(sales, `/proformas/${rid}/send`);
  await post(sales, `/proformas/${rid}/accept`);
  assert.equal((await db('jobs').where({ id }).first()).proforma_id, rid);
});

test('a supervisor allows materials early, saying why; others can’t', async () => {
  const { id } = await runningJob();
  assert.equal((await post(store, `/jobs/${id}/allow-materials`, { reason: 'Fleet customer' })).status, 403);
  assert.equal((await post(sales, `/jobs/${id}/allow-materials`, { reason: 'Fleet customer' })).status, 403);
  assert.equal((await post(technician, `/jobs/${id}/allow-materials`, { reason: 'Fleet customer' })).status, 403);

  await post(supervisor, `/jobs/${id}/allow-materials`, { reason: '' });
  assert.equal((await db('jobs').where({ id }).first()).materials_allowed_at, null, 'a reason is needed');

  await post(supervisor, `/jobs/${id}/allow-materials`, { reason: 'Fleet customer on account, LPO coming' });
  const job = await db('jobs').where({ id }).first();
  assert.notEqual(job.materials_allowed_at, null);
  assert.equal(job.materials_allowed_reason, 'Fleet customer on account, LPO coming');
  assert.equal((await tryIssue(id)).status, 422, 'past the job check');
  const page = (await store.get(`/jobs/${id}`)).text;
  assert.match(page, /Allowed before a proforma was accepted, by Test supervisor: Fleet customer on account, LPO coming/);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /let stores issue materials before the proforma is accepted/, 'in the history');
});

test('an accepted proforma started as a job (quote first) lets stores issue straight away', async () => {
  const vehicleId = await arrived();
  let res = await post(sales, '/proformas', { customer_id: customer.id, vehicle_id: vehicleId, proforma_date: localDay(), line_quantity: ['1'], line_unit: ['Unit'], line_description: ['New tipper body'], line_price: ['900,000'] });
  const pid = Number(res.headers.location.split('/')[2]);
  await post(sales, `/proformas/${pid}/send`);
  await post(sales, `/proformas/${pid}/accept`);
  res = await post(sales, `/proformas/${pid}/job`);
  const job = await db('jobs').where({ proforma_id: pid }).first();
  assert.ok(job, res.text);
  assert.equal((await tryIssue(job.id)).status, 422, 'past the job check');
});

/** A proforma sales made on its own (quote first), sent and accepted, with no job yet. */
async function acceptedProforma(fields = {}) {
  const res = await post(sales, '/proformas', {
    customer_id: customer.id, proforma_date: localDay(),
    line_quantity: ['1'], line_unit: ['Unit'], line_description: ['Build 20ft cargo body'], line_price: ['380,000'], ...fields,
  });
  assert.equal(res.status, 302, res.text);
  const pid = idOf(res.headers.location);
  await post(sales, `/proformas/${pid}/send`);
  assert.equal((await post(sales, `/proformas/${pid}/accept`)).status, 302);
  return db('proformas').where({ id: pid }).first();
}

test('sheet row 58: a job opened without a proforma is matched to one the customer already accepted', async () => {
  const p = await acceptedProforma();
  const { id, vehicleId } = await runningJob();

  // Offered on the job, to supervisors and sales; not to stores.
  const page = (await supervisor.get(`/jobs/${id}`)).text;
  assert.match(page, /Match a proforma \(\d+\)/);
  assert.match(page, new RegExp(`value="${p.id}"[^>]*>${p.number}`));
  assert.doesNotMatch(page, new RegExp(`KES 380,000`), 'no prices for the workshop');
  assert.match((await sales.get(`/jobs/${id}`)).text, /KES 380,000/, 'sales see what it is worth');
  assert.doesNotMatch((await store.get(`/jobs/${id}`)).text, /Match a proforma/);
  assert.equal((await post(store, `/jobs/${id}/match-proforma`, { proforma_id: p.id })).status, 403);

  // Another customer's accepted proforma can't be matched.
  const [otherId] = await db('customers').insert({ number: 'CUS-T913', name: 'Other Fleet', phone: '+254700000913', category: 'individual' });
  const theirs = await acceptedProforma({ customer_id: otherId });
  await post(supervisor, `/jobs/${id}/match-proforma`, { proforma_id: theirs.id });
  assert.equal((await db('jobs').where({ id }).first()).proforma_id, null);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /is for another customer/);

  const res = await post(supervisor, `/jobs/${id}/match-proforma`, { proforma_id: p.id });
  assert.equal(res.status, 302);
  const job = await db('jobs').where({ id }).first();
  assert.equal(job.proforma_id, p.id);
  assert.deepEqual(await db('job_lines').where({ job_id: id }).orderBy('sort_order').pluck('description'), ['Build 20ft cargo body']);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Matched to proforma/, 'in the history');
  assert.doesNotMatch((await supervisor.get('/jobs')).text, new RegExp(`/proformas/${p.id}"`), 'no longer waiting for a job');

  // Stores can issue now (past the job check, failing only on the made-up stock line).
  const issue = await tryIssue(id);
  assert.equal(issue.status, 422);
  assert.match(issue.text, /isn’t in stock at this site/);

  // Used once: another job can't take it, and this job can't take a second.
  const second = await runningJob();
  assert.doesNotMatch((await supervisor.get(`/jobs/${second.id}`)).text, new RegExp(`value="${p.id}"`));
  await post(supervisor, `/jobs/${second.id}/match-proforma`, { proforma_id: p.id });
  assert.equal((await db('jobs').where({ id: second.id }).first()).proforma_id, null);
  const another = await acceptedProforma();
  await post(supervisor, `/jobs/${id}/match-proforma`, { proforma_id: another.id });
  assert.equal((await db('jobs').where({ id }).first()).proforma_id, p.id);

  // A proforma for one vehicle isn't offered for another vehicle's job.
  const forVehicle = await acceptedProforma({ vehicle_id: vehicleId });
  assert.doesNotMatch((await supervisor.get(`/jobs/${second.id}`)).text, new RegExp(`value="${forVehicle.id}"`));
});
