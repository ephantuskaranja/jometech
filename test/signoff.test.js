import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { checklist as releaseChecklist } from '../src/modules/checkins/release.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let admin, supervisor, technician, sales, customer, repair, savedTypes;

// A 1 × 1 PNG, as the signature pad sends it.
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

before(async () => {
  admin = await loginAs(app, await makeUser(71, ['admin']));
  supervisor = await loginAs(app, await makeUser(72, ['supervisor']));
  technician = await loginAs(app, await makeUser(73, ['technician']));
  sales = await loginAs(app, await makeUser(74, ['sales']));
  await post(sales, '/customers', { name: 'Signoff Transporters', phone: '0700000871' });
  customer = await db('customers').where({ phone: '+254700000871' }).first();
  repair = await db('job_types').where({ name: 'Repair', is_active: true }).first();
  savedTypes = await db('job_types').select('id', 'qc_step', 'signoff_step');
});

after(async () => {
  for (const t of savedTypes) await db('job_types').where({ id: t.id }).update({ qc_step: t.qc_step, signoff_step: t.signoff_step });
  await db('audit_log').where({ entity: 'job_type', entity_id: repair.id }).whereIn('user_id', db('users').where('phone', 'like', '+25470000%').select('id')).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const idOf = (location) => Number(location.split('/')[2]);
const currentStep = (jobId) => db('job_steps').where({ job_id: jobId, status: 'pending' }).orderBy('sort_order').first();
const stepOf = (jobId, name) => db('job_steps').where({ job_id: jobId, name }).first();

/** Ticks the current steps off until the quality check; passes it if `pass`. */
async function tickTo(id, { pass = true } = {}) {
  for (let step = await currentStep(id); step && !step.is_qc && !step.is_signoff; step = await currentStep(id)) {
    await post(supervisor, `/jobs/${id}/steps/${step.id}/done`);
  }
  if (!pass || !(await currentStep(id))?.is_qc) return;
  const check = idOf((await post(supervisor, `/jobs/${id}/qc`)).headers.location);
  const items = await db('qc_inspection_items').where({ inspection_id: check }).pluck('id');
  await post(supervisor, `/qc/${check}`, { finish: '1', ...Object.fromEntries(items.map((i) => [`result_${i}`, 'pass'])) });
  return check;
}

/** A Repair job at its customer sign-off step, with its passed check. */
async function jobAtSignoff() {
  const res = await post(supervisor, '/jobs', { customer_id: customer.id, job_type_id: repair.id, line_description: ['Rebuild the tailgate'] });
  const id = idOf(res.headers.location);
  await post(supervisor, `/jobs/${id}/start`);
  const check = await tickTo(id);
  return { id, check };
}

test('job types sign off at Customer Inspection; that step can’t be ticked by hand; the customer signs on the device', async () => {
  assert.equal(repair.signoff_step, 'Customer Inspection');
  const { id, check } = await jobAtSignoff();
  const step = await currentStep(id);
  assert.equal(step.is_signoff, 1);
  assert.equal(step.name, 'Customer Inspection');
  assert.equal((await post(supervisor, `/jobs/${id}/steps/${step.id}/done`)).status, 409);
  assert.equal((await post(supervisor, `/jobs/${id}/steps/${step.id}/skip`)).status, 409);
  assert.match((await supervisor.get(`/jobs/${id}`)).text, new RegExp(`href="/jobs/${id}/signoff"`));

  const page = (await supervisor.get(`/jobs/${id}/signoff`)).text;
  assert.match(page, /Rebuild the tailgate/);
  assert.match(page, new RegExp(`href="/qc/${check}"`), 'shows the passed check');
  assert.equal((await technician.get(`/jobs/${id}/signoff`)).status, 403);

  let res = await post(supervisor, `/jobs/${id}/signoff`, { signer_role: 'driver', signer_name: 'Peter Otieno', signature: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Sign in the box above/);
  res = await post(supervisor, `/jobs/${id}/signoff`, { signer_role: 'driver', signer_name: 'Peter Otieno', signer_phone: '0700000872', signature: SIGNATURE });
  assert.equal(res.status, 302);

  const so = await db('customer_signoffs').where({ job_id: id }).first();
  assert.equal(so.outcome, 'accepted');
  assert.equal(so.signer_role, 'driver');
  assert.equal(so.qc_id, check);
  assert.match(so.signature_path, /^signatures\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/);
  assert.equal((await db('job_steps').where({ id: step.id }).first()).status, 'done');
  assert.equal((await db('jobs').where({ id }).first()).status, 'completed', 'sign-off was the last step');

  const job = (await supervisor.get(`/jobs/${id}`)).text;
  assert.match(job, /Peter Otieno \(driver\)/);
  assert.equal((await sales.get(`/signoffs/${so.id}/signature.png`)).headers['content-type'], 'image/png');
  const report = (await supervisor.get(`/qc/${check}/print`)).text;
  assert.match(report, new RegExp(`/signoffs/${so.id}/signature.png`));
  assert.match(report, /Peter Otieno \(driver, for the customer\)/);
  assert.equal((await supervisor.get(`/jobs/${id}/signoff`)).status, 409, 'nothing left to sign');
});

test('no one there to sign: recorded with a reason, and the step is ticked off', async () => {
  const { id, check } = await jobAtSignoff();
  let res = await post(supervisor, `/jobs/${id}/signoff/not-signed`, { reason: 'other', other_reason: 'x' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Say why no one signed/);
  res = await post(supervisor, `/jobs/${id}/signoff/not-signed`, { reason: 'The vehicle left on a low-loader / tow truck' });
  assert.equal(res.status, 302);
  const so = await db('customer_signoffs').where({ job_id: id }).first();
  assert.equal(so.outcome, 'not_signed');
  assert.equal(so.signature_path, null);
  assert.equal((await db('jobs').where({ id }).first()).status, 'completed');
  assert.match((await supervisor.get(`/qc/${check}/print`)).text, /Not signed: The vehicle left on a low-loader/);
});

test('concerns send the job back to the chosen steps and its quality check; after a new check the customer looks again', async () => {
  const { id, check } = await jobAtSignoff();
  const painting = await stepOf(id, 'Painting');
  const qcStep = await db('job_steps').where({ job_id: id, is_qc: true }).first();
  const signoffStep = await currentStep(id);

  let res = await post(supervisor, `/jobs/${id}/signoff/concerns`, { signer_role: 'customer', signer_name: 'Grace Wanjiru', concerns: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Say what the customer isn’t happy with/);
  res = await post(supervisor, `/jobs/${id}/signoff/concerns`, {
    signer_role: 'customer', signer_name: 'Grace Wanjiru', concerns: 'Paint scratched by the rear light', redo: [String(painting.id), String(signoffStep.id)],
  });
  assert.equal(res.status, 302);
  assert.equal((await db('job_steps').where({ id: painting.id }).first()).status, 'pending');
  assert.equal((await db('job_steps').where({ id: qcStep.id }).first()).status, 'pending', 'the quality check is done again');
  assert.equal((await db('job_steps').where({ id: signoffStep.id }).first()).status, 'pending');
  assert.equal((await stepOf(id, 'Finishing')).status, 'done', 'steps not chosen stay done');
  assert.equal((await currentStep(id)).id, painting.id);
  assert.equal((await db('customer_signoffs').where({ job_id: id }).first()).outcome, 'concerns');

  let job = (await supervisor.get(`/jobs/${id}`)).text;
  assert.match(job, /customer’s concerns/);
  assert.match(job, /Grace Wanjiru:<\/span> Paint scratched by the rear light/);
  assert.equal((await supervisor.get(`/jobs/${id}/signoff`)).status, 409, 'not at the sign-off step now');

  const again = await tickTo(id);
  assert.notEqual(again, check);
  assert.equal((await db('qc_inspections').where({ id: again }).first()).attempt, 2);
  assert.equal((await currentStep(id)).id, signoffStep.id, 'back at the customer’s sign-off');
  const page = (await supervisor.get(`/jobs/${id}/signoff`)).text;
  assert.match(page, /Put right since the last look/);
  assert.match(page, new RegExp(`href="/qc/${again}"`), 'shows the new check');

  // Concerns with no steps chosen: only the quality check is done again.
  await post(supervisor, `/jobs/${id}/signoff/concerns`, { signer_role: 'driver', signer_name: 'Sam Kiprop', concerns: 'Reflector sticker missing' });
  assert.equal((await currentStep(id)).id, qcStep.id);
});

test('the release checklist shows the passed quality check', async () => {
  const { id, check } = await jobAtSignoff();
  const [checkin] = await db('checkins').whereNotNull('id').orderBy('id', 'desc').limit(1).pluck('id');
  const job = await db('jobs').where({ id }).first('checkin_id');
  await db('jobs').where({ id }).update({ checkin_id: checkin });
  try {
    const list = await releaseChecklist(checkin);
    const qc = list.items.find((i) => i.key === 'qc');
    const number = (await db('qc_inspections').where({ id: check }).first()).number;
    assert.ok(qc, 'a line for the quality check');
    assert.match(qc.detail, new RegExp(number));
  } finally {
    await db('jobs').where({ id }).update({ checkin_id: job.checkin_id });
  }
});

test('a job type’s customer sign-off comes after its quality check', async () => {
  const steps = await db('job_type_steps').where({ job_type_id: repair.id }).orderBy('sort_order').pluck('name');
  let res = await post(admin, `/admin/job-types/${repair.id}`, { name: repair.name, step: steps, qc_step: 'Quality Inspection', signoff_step: 'Welding' });
  assert.equal(res.status, 422);
  assert.match(res.text, /The customer signs at a step after the quality check/);
  res = await post(admin, `/admin/job-types/${repair.id}`, { name: repair.name, step: steps, qc_step: 'Quality Inspection', signoff_step: '' });
  assert.equal(res.status, 302);
  assert.equal((await db('job_types').where({ id: repair.id }).first()).signoff_step, null);
  const plain = idOf((await post(supervisor, '/jobs', { customer_id: customer.id, job_type_id: repair.id, line_description: ['No sign-off'] })).headers.location);
  assert.equal(Number((await db('job_steps').where({ job_id: plain, is_signoff: true }).count({ n: '*' }))[0].n), 0);
});
