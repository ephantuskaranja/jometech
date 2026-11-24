import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import sharp from 'sharp';
import { checklist } from '../src/modules/qc/service.js';
import { seed } from '../db/seeds/08_qc_checklist.js';
import { FAB } from '../db/seeds/06_job_types.js';
import { makeUser, loginAs, csrfFrom, cleanup, checkedInVehicle } from './helpers.js';

const app = createApp();
const FAB_RE = FAB.replace(/[()]/g, '\\$&');
let admin, supervisor, technician, sales, customer, maintenance, repair, savedChecklist, savedQcStep, savedSignoffStep, savedReceiveStep;

before(async () => {
  admin = await loginAs(app, await makeUser(61, ['admin']));
  supervisor = await loginAs(app, await makeUser(62, ['supervisor']));
  technician = await loginAs(app, await makeUser(63, ['technician']));
  sales = await loginAs(app, await makeUser(64, ['sales']));
  await post(sales, '/customers', { name: 'QC Haulage Ltd', phone: '0700000861' });
  customer = await db('customers').where({ phone: '+254700000861' }).first();
  maintenance = await db('job_types').where({ name: 'Maintenance / other', is_active: true }).first();
  repair = await db('job_types').where({ name: 'Repair', is_active: true }).first();
  savedQcStep = maintenance.qc_step;
  savedSignoffStep = maintenance.signoff_step;
  savedReceiveStep = maintenance.receive_step;
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
  await db('job_types').where({ id: maintenance.id }).update({ receive_step: savedReceiveStep, qc_step: savedQcStep, signoff_step: savedSignoffStep });
  await db('audit_log').where({ entity: 'job_type', entity_id: maintenance.id }).whereIn('user_id', db('users').where('phone', 'like', '+25470000%').select('id')).delete();
  await cleanup();
});

let plate = 0;
/** A vehicle of the customer checked in at HQ: a job is opened only for one (sheet row 49). */
const arrived = () => checkedInVehicle(customer.id, `KJR 3${String(plate++).padStart(2, '0')}A`);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const idOf = (location) => Number(location.split('/')[2]);

/** A job (maintenance unless said) ticked up to its quality check step. */
async function jobAtQc(type = maintenance) {
  const res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: await arrived(), job_type_id: type.id, line_description: ['Service the tipper'] });
  const id = idOf(res.headers.location);
  await post(supervisor, `/jobs/${id}/start`);
  for (const step of await db('job_steps').where({ job_id: id }).orderBy('sort_order')) {
    if (step.is_qc) break;
    if (step.is_receive) continue; // ticked by the vehicle's check-in
    await post(supervisor, `/jobs/${id}/steps/${step.id}/done`);
  }
  return id;
}
const answers = (items, result, extra = {}) => ({ ...Object.fromEntries(items.map((i) => [`result_${i.id}`, result])), ...extra });
const itemsOf = (checkId) => db('qc_inspection_items').where({ inspection_id: checkId }).orderBy('sort_order');
const stepOf = (jobId, name) => db('job_steps').where({ job_id: jobId, name }).first();
const currentStep = (jobId) => db('job_steps').where({ job_id: jobId, status: 'pending' }).orderBy('sort_order').first();

test('the starting checklist is there; running the seed again changes nothing; job types point at Quality Inspection', async () => {
  const list = await checklist();
  assert.equal(list[0].name, 'Dimensions and fit');
  assert.equal(list.reduce((n, s) => n + s.items.length, 0), 22);
  await seed(db);
  assert.equal((await checklist()).length, list.length);
  assert.equal(maintenance.qc_step, 'Quality Inspection');
});

test('the quality check step can’t be ticked or skipped by hand; only a supervisor starts the check, and only at that step', async () => {
  const res = await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: await arrived(), job_type_id: maintenance.id, line_description: ['Weld a crack'] });
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
  assert.equal(res.status, 422, 'a maintenance job has no Painting step, so nowhere is chosen yet');
  assert.match(res.text, /Choose where every failed item is put right \(1\)/);

  res = await post(supervisor, `/qc/${first}`, { finish: '1', ...failing, [`note_${items[13].id}`]: 'Bare patch under the floor', [`redo_${items[13].id}`]: 'here' });
  assert.equal(res.status, 302);
  assert.equal((await db('qc_inspections').where({ id: first }).first()).status, 'failed');
  const qcStep = await db('job_steps').where({ job_id: id, is_qc: true }).first();
  assert.equal(qcStep.status, 'pending', 'put right at the check: the job stays at its quality check step');
  assert.equal((await currentStep(id)).id, qcStep.id);
  const report = (await supervisor.get(`/qc/${first}`)).text;
  assert.match(report, /Bare patch under the floor/);
  assert.match(report, /Put right at the quality check/);
  assert.doesNotMatch(report, /name="result_/, 'a finished check is read-only');
  assert.equal((await post(supervisor, `/qc/${first}`, { finish: '1', ...answers(items, 'pass') })).status, 409);

  res = await post(supervisor, `/jobs/${id}/qc`);
  const second = idOf(res.headers.location);
  assert.notEqual(second, first);
  assert.equal((await db('qc_inspections').where({ id: second }).first()).attempt, 2);
  const carried = await itemsOf(second);
  assert.equal(carried.filter((i) => i.result === 'pass').length, 21, 'what passed last time is filled in');
  assert.equal(carried[13].result, null, 'the failed item is left to check again');
  const repeat = (await supervisor.get(`/qc/${second}`)).text;
  assert.match(repeat, /Failed last time<\/span> <span class="text-body-secondary">Bare patch under the floor/);
  assert.match(repeat, /the 1 item that failed/);
  res = await post(supervisor, `/qc/${second}`, { finish: '1', ...answers(await itemsOf(second), 'na', { [`result_${(await itemsOf(second))[0].id}`]: 'pass' }) });
  assert.equal(res.headers.location, `/jobs/${id}`, 'a pass goes to the job, where the next step is');
  assert.match((await supervisor.get(`/qc/${second}`)).text, new RegExp(`href="/jobs/${id}/signoff"`), 'the customer’s sign-off is offered from the check too');
  assert.equal((await db('qc_inspections').where({ id: second }).first()).status, 'passed');
  assert.equal((await db('job_steps').where({ id: qcStep.id }).first()).status, 'done', 'a passed check ticks the step off');
  const job = (await supervisor.get(`/jobs/${id}`)).text;
  assert.match(job, /Customer sign-off<\/a>/, 'the job moved on to the customer’s sign-off');
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

test('a failed check reopens only the steps chosen for the failed items; the job then comes back to its quality check', async () => {
  const id = await jobAtQc(repair);
  const check = idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location);
  const items = await itemsOf(check);
  const welding = await stepOf(id, FAB);
  const painting = await stepOf(id, 'Painting');
  const weld = items.find((i) => i.section === 'Welding');
  const paint = items.find((i) => i.section === 'Paint and finish');
  const fit = items.find((i) => i.section === 'Dimensions and fit');
  const lights = items.find((i) => i.section === 'Electrical and accessories');
  assert.equal(weld.redo_step_id, welding.id, 'the section’s suggested step is chosen to start with');
  assert.equal(paint.redo_step_id, painting.id);
  assert.equal(fit.redo_step_id, welding.id, 'assembly is part of Fabrication');
  assert.equal(lights.redo_step_id, null, 'a Repair job has no Electrical / Accessories step');
  const page = (await supervisor.get(`/qc/${check}`)).text;
  assert.match(page, new RegExp(`<option value="${welding.id}" selected>${FAB_RE}: reopen this step`));
  assert.doesNotMatch(page, /Quality Inspection: reopen/, 'only steps before the check');

  const finishing = await stepOf(id, 'Finishing');
  let res = await post(supervisor, `/qc/${check}`, { finish: '1', ...answers(items, 'pass'),
    [`result_${weld.id}`]: 'fail', [`note_${weld.id}`]: 'Hinge weld cracked',
    [`result_${paint.id}`]: 'fail', [`note_${paint.id}`]: 'Runs on the tailgate',
    [`result_${fit.id}`]: 'fail', [`note_${fit.id}`]: 'Body 20 mm off centre', [`redo_${fit.id}`]: String(welding.id),
    [`redo_${items[1].id}`]: String((await stepOf(id, 'Customer Inspection')).id) }); // not a step before the check: ignored
  assert.equal(res.status, 302);
  assert.equal((await db('job_steps').where({ id: welding.id }).first()).status, 'pending');
  assert.equal((await db('job_steps').where({ id: welding.id }).first()).rework_qc_id, check);
  assert.equal((await db('job_steps').where({ id: painting.id }).first()).status, 'pending');
  assert.equal((await db('job_steps').where({ id: finishing.id }).first()).status, 'done', 'steps not chosen stay done');
  assert.equal((await currentStep(id)).id, welding.id, 'the job is back at Fabrication');

  let job = (await supervisor.get(`/jobs/${id}`)).text;
  assert.match(job, /Rework<\/span> from <a href="\/qc\/\d+">QC-/);
  assert.match(job, /Hinge weld cracked/);
  assert.match(job, /Body 20 mm off centre/);
  assert.match(job, new RegExp(`${FAB_RE} done → Painting`), 'the next step to do, skipping the ones still done');
  assert.equal((await post(supervisor, `/jobs/${id}/qc`)).status, 409, 'no new check until the rework is done');

  await post(supervisor, `/jobs/${id}/steps/${welding.id}/done`);
  res = await post(supervisor, `/jobs/${id}/steps/undo`);
  assert.equal((await currentStep(id)).id, welding.id, 'undo reopens the step just ticked, not the furthest one');
  await post(supervisor, `/jobs/${id}/steps/${welding.id}/done`);
  await post(supervisor, `/jobs/${id}/steps/${painting.id}/done`);
  assert.equal((await currentStep(id)).is_qc, 1, 'back at the quality check');
  assert.doesNotMatch((await supervisor.get(`/jobs/${id}`)).text, /Rework<\/span>/);
  const again = idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location);
  assert.equal((await db('qc_inspections').where({ id: again }).first()).attempt, 2);
  const logged = await db('audit_log').where({ entity: 'job', entity_id: id, action: 'steps_reworked' }).first();
  assert.match(logged.summary, new RegExp(`^${FAB_RE}, Painting \\(quality check QC-\\d{4}-\\d{4} failed\\)$`));
});

test('failed items take photos while the check is open; anyone who sees the report sees them', async () => {
  const id = await jobAtQc();
  const check = idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location);
  const [item] = await itemsOf(check);
  const jpeg = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#a33' } }).jpeg().toBuffer();
  const csrf = csrfFrom((await supervisor.get('/')).text);
  const add = (agent, buf = jpeg) => agent.post(`/qc/${check}/items/${item.id}/photos`).set('x-csrf-token', csrf).set('Accept', 'application/json').attach('photo', buf, 'defect.jpg');

  let res = await add(supervisor);
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.thumb, `/qc/${check}/photos/${res.body.id}/thumb.webp`);
  assert.equal((await supervisor.get(res.body.full)).headers['content-type'], 'image/webp');
  assert.equal((await add(supervisor, Buffer.from('nope'))).status, 422);
  for (let i = 0; i < 3; i++) await add(supervisor);
  res = await add(supervisor);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /up to 4 photos/);

  const photos = await db('qc_item_photos').where({ item_id: item.id }).orderBy('id');
  res = await supervisor.post(`/qc/${check}/items/${item.id}/photos/${photos[3].id}/delete`).set('x-csrf-token', csrf).set('Accept', 'application/json');
  assert.equal(res.status, 200);
  assert.equal(await db('qc_item_photos').where({ item_id: item.id }).count({ n: '*' }).then(([r]) => Number(r.n)), 3);

  const items = await itemsOf(check);
  await post(supervisor, `/qc/${check}`, { finish: '1', ...answers(items, 'pass'), [`result_${item.id}`]: 'fail', [`note_${item.id}`]: 'Dent on the side', [`redo_${item.id}`]: 'here' });
  assert.equal((await add(supervisor)).status, 409, 'a finished check’s photos don’t change');
  const report = (await sales.get(`/qc/${check}`)).text;
  assert.match(report, new RegExp(`/qc/${check}/photos/${photos[0].id}/thumb.webp`));
  assert.equal((await sales.get(`/qc/${check}/photos/${photos[0].id}.webp`)).status, 200);
  assert.equal((await post(technician, `/qc/${check}/items/${item.id}/photos/${photos[0].id}/delete`)).status, 403);
});

// Last: it replaces the checklist and turns off the maintenance quality check step (both put back in after()).
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
  const plain = idOf((await post(supervisor, '/jobs', { customer_id: customer.id, vehicle_id: await arrived(), job_type_id: maintenance.id, line_description: ['No check'] })).headers.location);
  assert.equal((await db('job_steps').where({ job_id: plain, is_qc: true }).count({ n: '*' }))[0].n, 0, 'no quality check step on new jobs');
});
