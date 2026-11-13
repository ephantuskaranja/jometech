import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { checklist } from '../src/modules/qc/service.js';
import { seed } from '../db/seeds/08_qc_checklist.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let admin, supervisor, technician, sales, customer, maintenance, savedChecklist, savedQcStep;

before(async () => {
  admin = await loginAs(app, await makeUser(61, ['admin']));
  supervisor = await loginAs(app, await makeUser(62, ['supervisor']));
  technician = await loginAs(app, await makeUser(63, ['technician']));
  sales = await loginAs(app, await makeUser(64, ['sales']));
  await post(sales, '/customers', { name: 'QC Haulage Ltd', phone: '0700000861' });
  customer = await db('customers').where({ phone: '+254700000861' }).first();
  maintenance = await db('job_types').where({ name: 'Maintenance / other', is_active: true }).first();
  savedQcStep = maintenance.qc_step;
  savedChecklist = await checklist();
});

after(async () => {
  // Put the checklist and the job type back as they were.
  await db('qc_checklist_sections').delete();
  for (const [i, s] of savedChecklist.entries()) {
    const [id] = await db('qc_checklist_sections').insert({ sort_order: i + 1, name: s.name, rework_step: s.rework_step });
    await db('qc_checklist_items').insert(s.items.map((text, j) => ({ section_id: id, sort_order: j + 1, text })));
  }
  await db('audit_log').where({ entity: 'qc_checklist' }).where('created_at', '>=', db.raw('NOW() - INTERVAL 1 HOUR')).whereIn('user_id', db('users').where('phone', 'like', '+25470000%').select('id')).delete();
  await db('job_types').where({ id: maintenance.id }).update({ qc_step: savedQcStep });
  await db('audit_log').where({ entity: 'job_type', entity_id: maintenance.id }).whereIn('user_id', db('users').where('phone', 'like', '+25470000%').select('id')).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const idOf = (location) => Number(location.split('/')[2]);

/** A maintenance job ticked up to its quality check step. */
async function jobAtQc() {
  const res = await post(supervisor, '/jobs', { customer_id: customer.id, job_type_id: maintenance.id, line_description: ['Service the tipper'] });
  const id = idOf(res.headers.location);
  await post(supervisor, `/jobs/${id}/start`);
  for (const step of await db('job_steps').where({ job_id: id }).orderBy('sort_order')) {
    if (step.is_qc) break;
    await post(supervisor, `/jobs/${id}/steps/${step.id}/done`);
  }
  return id;
}
const answers = (items, result, extra = {}) => ({ ...Object.fromEntries(items.map((i) => [`result_${i.id}`, result])), ...extra });
const itemsOf = (checkId) => db('qc_inspection_items').where({ inspection_id: checkId }).orderBy('sort_order');

test('the starting checklist is there; running the seed again changes nothing; job types point at Quality Inspection', async () => {
  const list = await checklist();
  assert.equal(list[0].name, 'Dimensions and fit');
  assert.equal(list.reduce((n, s) => n + s.items.length, 0), 22);
  await seed(db);
  assert.equal((await checklist()).length, list.length);
  assert.equal(maintenance.qc_step, 'Quality Inspection');
});

test('the quality check step can’t be ticked or skipped by hand; only a supervisor starts the check, and only at that step', async () => {
  const res = await post(supervisor, '/jobs', { customer_id: customer.id, job_type_id: maintenance.id, line_description: ['Weld a crack'] });
  const early = idOf(res.headers.location);
  await post(supervisor, `/jobs/${early}/start`);
  assert.equal((await post(supervisor, `/jobs/${early}/qc`)).status, 409, 'not at the quality check step yet');

  const id = await jobAtQc();
  const step = await db('job_steps').where({ job_id: id, is_qc: true }).first();
  assert.equal((await post(supervisor, `/jobs/${id}/steps/${step.id}/done`)).status, 409);
  assert.equal((await post(supervisor, `/jobs/${id}/steps/${step.id}/skip`)).status, 409);
  const page = (await supervisor.get(`/jobs/${id}`)).text;
  assert.match(page, /Start quality check/);
  assert.doesNotMatch(page, /Skip: doesn’t apply/);
  assert.equal((await post(technician, `/jobs/${id}/qc`)).status, 403);
  assert.match((await supervisor.get('/qc')).text, new RegExp(`/jobs/${id}"`), 'on the To check list');
});

test('a check saves as you go, needs every item answered and every failure explained, then fails; the next attempt passes and moves the job on', async () => {
  const id = await jobAtQc();
  let res = await post(supervisor, `/jobs/${id}/qc`);
  const first = idOf(res.headers.location);
  const check = await db('qc_inspections').where({ id: first }).first();
  assert.match(check.number, /^QC-\d{4}-\d{4}$/);
  assert.equal(check.attempt, 1);
  assert.equal(idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location), first, 'starting again carries on with the open check');

  const items = await itemsOf(first);
  assert.equal(items.length, 22);
  res = await post(supervisor, `/qc/${first}`, { [`result_${items[0].id}`]: 'pass', remarks: 'Halfway' });
  assert.equal(res.status, 302);
  assert.equal((await itemsOf(first))[0].result, 'pass', 'saved for later');

  res = await post(supervisor, `/qc/${first}`, { finish: '1', [`result_${items[0].id}`]: 'pass' });
  assert.equal(res.status, 422);
  assert.match(res.text, /21 items not answered yet/);

  const failing = answers(items, 'pass', { [`result_${items[13].id}`]: 'fail' });
  res = await post(supervisor, `/qc/${first}`, { finish: '1', ...failing });
  assert.equal(res.status, 422);
  assert.match(res.text, /Say what is wrong for every failed item/);

  res = await post(supervisor, `/qc/${first}`, { finish: '1', ...failing, [`note_${items[13].id}`]: 'Bare patch under the floor' });
  assert.equal(res.status, 302);
  assert.equal((await db('qc_inspections').where({ id: first }).first()).status, 'failed');
  const qcStep = await db('job_steps').where({ job_id: id, is_qc: true }).first();
  assert.equal(qcStep.status, 'pending', 'the job stays at its quality check step');
  const report = (await supervisor.get(`/qc/${first}`)).text;
  assert.match(report, /Bare patch under the floor/);
  assert.doesNotMatch(report, /name="result_/, 'a finished check is read-only');
  assert.equal((await post(supervisor, `/qc/${first}`, { finish: '1', ...answers(items, 'pass') })).status, 409);

  res = await post(supervisor, `/jobs/${id}/qc`);
  const second = idOf(res.headers.location);
  assert.notEqual(second, first);
  assert.equal((await db('qc_inspections').where({ id: second }).first()).attempt, 2);
  await post(supervisor, `/qc/${second}`, { finish: '1', ...answers(await itemsOf(second), 'na', { [`result_${(await itemsOf(second))[0].id}`]: 'pass' }) });
  assert.equal((await db('qc_inspections').where({ id: second }).first()).status, 'passed');
  assert.equal((await db('job_steps').where({ id: qcStep.id }).first()).status, 'done', 'a passed check ticks the step off');
  const job = (await supervisor.get(`/jobs/${id}`)).text;
  assert.match(job, /Customer Inspection done/, 'the job moved on to the next step');
  assert.match(job, /Quality checks[\s\S]*Passed[\s\S]*Failed/);
});

test('a check started by mistake can be cancelled; reports print, filled in and blank, with the customer’s signature line', async () => {
  const id = await jobAtQc();
  const check = idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location);
  assert.equal((await supervisor.get(`/qc/${check}/print`)).status, 200);
  await post(supervisor, `/qc/${check}/cancel`);
  assert.equal((await db('qc_inspections').where({ id: check }).first()).status, 'cancelled');
  const again = idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location);
  assert.equal((await db('qc_inspections').where({ id: again }).first()).attempt, 1, 'a cancelled check doesn’t count as an attempt');

  const blank = (await technician.get(`/qc-form/print?job=${id}`)).text;
  assert.match(blank, /Quality inspection report/);
  assert.match(blank, /Customer<\/div>[\s\S]*at customer inspection/);
  assert.match(blank, /Mounted firmly on the chassis/);
  assert.match(blank, /QC Haulage Ltd/);
  assert.equal((await sales.get(`/qc/${again}`)).status, 200, 'anyone who sees jobs sees the report');
});

test('admins edit the checklist; new checks use it, earlier ones keep theirs; job types choose their quality check step', async () => {
  const id = await jobAtQc();
  const old = idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location);

  assert.equal((await supervisor.get('/admin/qc-checklist')).status, 403);
  let res = await post(admin, '/admin/qc-checklist', { checklist: JSON.stringify([{ name: 'Paint', rework_step: 'Painting', items: [] }]) });
  assert.equal(res.status, 422);
  assert.match(res.text, /“Paint” has no items/);
  res = await post(admin, '/admin/qc-checklist', { checklist: JSON.stringify([{ name: 'Paint', rework_step: 'Painting', items: ['Even coat', ' '] }, { name: '', items: [] }]) });
  assert.equal(res.status, 302, res.text);
  const now = await checklist();
  assert.deepEqual(now.map((s) => [s.name, s.rework_step, s.items]), [['Paint', 'Painting', ['Even coat']]]);
  assert.equal((await itemsOf(old)).length, 22, 'the check already started keeps its list');

  res = await post(admin, `/admin/job-types/${maintenance.id}`, { name: maintenance.name, step: ['Vehicle Received', 'Work Carried Out', 'Quality Inspection'], qc_step: 'Nope' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose one of the steps above/);
  res = await post(admin, `/admin/job-types/${maintenance.id}`, { name: maintenance.name, step: ['Vehicle Received', 'Inspection / Measurement', 'Work Carried Out', 'Quality Inspection', 'Customer Inspection'], qc_step: '' });
  assert.equal(res.status, 302);
  assert.equal((await db('job_types').where({ id: maintenance.id }).first()).qc_step, null);
  const plain = idOf((await post(supervisor, '/jobs', { customer_id: customer.id, job_type_id: maintenance.id, line_description: ['No check'] })).headers.location);
  assert.equal((await db('job_steps').where({ job_id: plain, is_qc: true }).count({ n: '*' }))[0].n, 0, 'no quality check step on new jobs');
});
