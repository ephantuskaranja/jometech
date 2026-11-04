import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { seed } from '../db/seeds/06_job_types.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let admin, manager, supervisor, technician, sales, customer, originalDefault;

before(async () => {
  originalDefault = await db('job_types').where({ is_default: true, is_active: true }).first();
  admin = await loginAs(app, await makeUser(75, ['admin']));
  manager = await loginAs(app, await makeUser(76, ['manager']));
  supervisor = await loginAs(app, await makeUser(77, ['supervisor']));
  technician = await loginAs(app, await makeUser(78, ['technician']));
  sales = await loginAs(app, await makeUser(79, ['sales']));
  await post(sales, '/customers', { name: 'Wafula Transport', phone: '0700000821' });
  customer = await db('customers').where({ phone: '+254700000821' }).first();
});

after(async () => {
  await db('job_types').update({ is_default: false });
  await db('job_types').where({ id: originalDefault.id }).update({ is_default: true });
  const ids = await db('job_types').where('name', 'like', 'Test %').pluck('id');
  await db('audit_log').where({ entity: 'job_type' }).whereIn('entity_id', ids).delete();
  await db('jobs').whereIn('job_type_id', ids).update({ job_type_id: null });
  await db('job_types').whereIn('id', ids).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const idOf = (location) => Number(location.split('/')[2]);
const stepsOf = (jobId) => db('job_steps').where({ job_id: jobId }).orderBy('sort_order');

async function makeType(name, step, extra = {}) {
  const res = await post(admin, '/admin/job-types', { name, step, ...extra });
  assert.equal(res.status, 302, res.text);
  return db('job_types').where({ name, is_active: true }).first();
}
async function makeJob(jobTypeId) {
  const res = await post(supervisor, '/jobs', { customer_id: customer.id, job_type_id: jobTypeId ?? '', line_description: ['Repair floor'] });
  assert.equal(res.status, 302, res.text);
  return idOf(res.headers.location);
}

test('the starting lists are there; running the seed again changes nothing', async () => {
  const fabrication = await db('job_types').where({ name: 'New fabrication' }).first();
  assert.ok(fabrication, 'run: npm run db:seed');
  const names = await db('job_type_steps').where({ job_type_id: fabrication.id }).orderBy('sort_order').pluck('name');
  assert.equal(names[0], 'Vehicle Received');
  assert.ok(names.includes('Welding'));
  const before = await db('job_type_steps').count({ n: '*' });
  await seed(db);
  assert.deepEqual(await db('job_type_steps').count({ n: '*' }), before);
});

test('only an admin changes the steps', async () => {
  await admin.get('/admin/job-types').expect(200);
  for (const agent of [manager, supervisor, technician, sales]) await agent.get('/admin/job-types').expect(403);
  assert.equal((await post(supervisor, '/admin/job-types', { name: 'Test nope', step: ['A'] })).status, 403);
  assert.doesNotMatch((await supervisor.get('/')).text, /Job types &amp; steps/);
  assert.match((await admin.get('/')).text, /Job types &amp; steps/);
});

test('a step list needs a name and at least one step, with no repeats', async () => {
  let res = await post(admin, '/admin/job-types', { name: '', step: ['', ''] });
  assert.equal(res.status, 422);
  assert.match(res.text, /Give the job type a name/);
  assert.match(res.text, /Add at least one step/);
  res = await post(admin, '/admin/job-types', { name: 'Test repeats', step: ['Welding', 'welding'] });
  assert.equal(res.status, 422);
  assert.match(res.text, /is on the list twice/);
  res = await post(admin, '/admin/job-types', { name: 'New fabrication', step: ['Welding'] });
  assert.equal(res.status, 422);
  assert.match(res.text, /already a job type with this name/);
});

test('an admin adds, removes and reorders steps; only new jobs get the change', async () => {
  const type = await makeType('Test trailer', ['Cutting', 'Welding', 'Painting']);
  const firstJob = await makeJob(type.id);
  assert.deepEqual((await stepsOf(firstJob)).map((s) => s.name), ['Cutting', 'Welding', 'Painting']);

  const res = await post(admin, `/admin/job-types/${type.id}`, { name: 'Test trailer', step: ['Welding', 'Axle Fitting', '', 'Cutting'] });
  assert.equal(res.status, 302, res.text);
  assert.deepEqual(await db('job_type_steps').where({ job_type_id: type.id }).orderBy('sort_order').pluck('name'), ['Welding', 'Axle Fitting', 'Cutting']);
  assert.match((await admin.get(`/admin/job-types/${type.id}`)).text, /Cutting → Welding → Painting/, 'the history keeps the old order');

  assert.deepEqual((await stepsOf(firstJob)).map((s) => s.name), ['Cutting', 'Welding', 'Painting'], 'the running job keeps its own steps');
  assert.deepEqual((await stepsOf(await makeJob(type.id))).map((s) => s.name), ['Welding', 'Axle Fitting', 'Cutting']);
});

test('one button moves the job on; skip, undo, and the last step completes it', async () => {
  const type = await makeType('Test flow', ['Cutting', 'Welding', 'Painting']);
  const id = await makeJob(type.id);
  const job = async () => db('jobs').where({ id }).first();
  const [cutting, welding, painting] = await stepsOf(id);

  assert.equal((await post(supervisor, `/jobs/${id}/steps/${cutting.id}/done`)).status, 409, 'start the job first');
  await post(supervisor, `/jobs/${id}/start`);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Cutting done → Welding/);
  assert.match((await supervisor.get('/jobs')).text, /0 of 3 steps done/);
  assert.equal((await post(technician, `/jobs/${id}/steps/${cutting.id}/done`)).status, 403);

  await post(supervisor, `/jobs/${id}/steps/${cutting.id}/done`);
  // A double click on the old button changes nothing.
  const again = await post(supervisor, `/jobs/${id}/steps/${cutting.id}/done`);
  assert.equal(again.status, 302);
  assert.equal((await db('job_steps').where({ id: welding.id }).first()).status, 'pending');
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Welding done → Painting/);

  await post(supervisor, `/jobs/${id}/steps/${welding.id}/skip`);
  assert.equal((await db('job_steps').where({ id: welding.id }).first()).status, 'skipped');
  await post(supervisor, `/jobs/${id}/steps/undo`);
  assert.equal((await db('job_steps').where({ id: welding.id }).first()).status, 'pending');
  await post(supervisor, `/jobs/${id}/steps/${welding.id}/skip`);

  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Painting done → Job completed/);
  assert.equal((await post(supervisor, `/jobs/${id}/complete`)).status, 409, 'not while steps remain');
  await post(supervisor, `/jobs/${id}/steps/${painting.id}/done`);
  assert.equal((await job()).status, 'completed');
  assert.ok((await job()).completed_at);
  const page = (await supervisor.get(`/jobs/${id}`)).text;
  assert.match(page, /finished a step/);
  assert.match(page, /skipped a step/);

  // Reopening puts the last step back, so there is something left to do.
  await post(supervisor, `/jobs/${id}/reopen`);
  assert.equal((await job()).status, 'in_progress');
  assert.equal((await db('job_steps').where({ id: painting.id }).first()).status, 'pending');
  assert.equal((await db('job_steps').where({ id: cutting.id }).first()).status, 'done', 'earlier steps stay ticked');
});

test('the job card lists the steps and the job type', async () => {
  const type = await makeType('Test card', ['Cutting', 'Welding']);
  const id = await makeJob(type.id);
  const card = (await technician.get(`/jobs/${id}/print`).expect(200)).text;
  assert.match(card, /Production steps/);
  assert.match(card, /Test card/);
  assert.match(card, /Welding/);
});

test('from a proforma: the default type, or the one chosen', async () => {
  const accepted = async () => {
    const res = await post(sales, '/proformas', { customer_id: customer.id, proforma_date: localDay(), line_description: ['Tipper body'], line_price: ['900000'] });
    const id = idOf(res.headers.location);
    await post(sales, `/proformas/${id}/send`);
    await post(sales, `/proformas/${id}/accept`);
    return id;
  };
  let id = await accepted();
  assert.match((await sales.get(`/proformas/${id}`)).text, /name="job_type_id"/);
  await post(sales, `/proformas/${id}/job`);
  let job = await db('jobs').where({ proforma_id: id }).first();
  assert.equal(job.job_type_id, originalDefault.id);
  assert.ok((await stepsOf(job.id)).length > 0);

  const type = await makeType('Test proforma', ['Only Step']);
  id = await accepted();
  await post(sales, `/proformas/${id}/job`, { job_type_id: type.id });
  job = await db('jobs').where({ proforma_id: id }).first();
  assert.deepEqual((await stepsOf(job.id)).map((s) => s.name), ['Only Step']);
});

test('the job type can change until a step is ticked off', async () => {
  const a = await makeType('Test change A', ['One', 'Two']);
  const b = await makeType('Test change B', ['Alpha']);
  const id = await makeJob(a.id);
  const edit = (jobTypeId) => post(supervisor, `/jobs/${id}`, { customer_id: customer.id, job_type_id: jobTypeId, line_description: ['Repair floor'] });

  assert.equal((await edit(b.id)).status, 302);
  assert.deepEqual((await stepsOf(id)).map((s) => s.name), ['Alpha']);
  assert.equal((await edit(a.id)).status, 302);
  await post(supervisor, `/jobs/${id}/start`);
  const [first] = await stepsOf(id);
  await post(supervisor, `/jobs/${id}/steps/${first.id}/done`);

  const res = await edit(b.id);
  assert.equal(res.status, 422);
  assert.match(res.text, /can’t change now/);
  assert.deepEqual((await stepsOf(id)).map((s) => s.name), ['One', 'Two']);
  assert.equal((await post(supervisor, `/jobs/${id}`, { customer_id: customer.id, line_description: ['Repair floor'], instructions: 'Still editable' })).status, 302, 'the rest can still be edited');
});

test('a type can be removed, except the default; the default can move', async () => {
  assert.equal((await post(admin, `/admin/job-types/${originalDefault.id}/remove`)).status, 409);

  const type = await makeType('Test remove', ['One']);
  const id = await makeJob(type.id);
  await post(admin, `/admin/job-types/${type.id}/remove`);
  assert.equal((await db('job_types').where({ id: type.id }).first()).is_active, 0);
  assert.doesNotMatch((await admin.get('/admin/job-types')).text, new RegExp(`/admin/job-types/${type.id}"`));
  assert.equal((await post(supervisor, '/jobs', { customer_id: customer.id, job_type_id: type.id, line_description: ['X'] })).status, 422, 'no longer offered');
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Test remove/, 'the job keeps its name and steps');
  assert.equal((await stepsOf(id)).length, 1);

  const next = await makeType('Test default', ['One'], { is_default: '1' });
  assert.deepEqual(await db('job_types').where({ is_default: true }).pluck('id'), [next.id]);
  assert.deepEqual((await stepsOf(await makeJob())).map((s) => s.name), ['One'], 'a job with no type chosen gets the default');
  await db('job_types').update({ is_default: false });
  await db('job_types').where({ id: originalDefault.id }).update({ is_default: true });
});

test('a job made before steps existed can still be completed, and can be given a type', async () => {
  const id = await makeJob();
  await db('job_steps').where({ job_id: id }).delete();
  await db('jobs').where({ id }).update({ job_type_id: null });
  await post(supervisor, `/jobs/${id}/start`);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, /Mark completed/);
  await post(supervisor, `/jobs/${id}/complete`);
  assert.equal((await db('jobs').where({ id }).first()).status, 'completed');
  await post(supervisor, `/jobs/${id}/reopen`);
  assert.equal((await db('jobs').where({ id }).first()).status, 'in_progress');
  const res = await post(supervisor, `/jobs/${id}`, { customer_id: customer.id, job_type_id: originalDefault.id, line_description: ['Repair floor'] });
  assert.equal(res.status, 302, res.text);
  assert.ok((await stepsOf(id)).length > 0);
});
