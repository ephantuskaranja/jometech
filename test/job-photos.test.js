import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let supervisor, technician, sales, jobId, jpeg;

before(async () => {
  supervisor = await loginAs(app, await makeUser(76, ['supervisor']));
  technician = await loginAs(app, await makeUser(77, ['technician']));
  sales = await loginAs(app, await makeUser(78, ['sales']));
  const csrf = csrfFrom((await sales.get('/')).text);
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Photo Hauliers', phone: '0700000761' });
  const customer = await db('customers').where({ phone: '+254700000761' }).first();
  const repair = await db('job_types').where({ name: 'Repair', is_active: true }).first();
  const res = await post(supervisor, '/jobs', { customer_id: customer.id, job_type_id: repair.id, line_description: ['Repair the tipper'] });
  jobId = Number(res.headers.location.split('/')[2]);
  await post(supervisor, `/jobs/${jobId}/start`);
  jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3a6' } }).jpeg().toBuffer();
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
async function upload(agent, buf = jpeg) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(`/jobs/${jobId}/photos`).set('x-csrf-token', csrf).set('Accept', 'application/json').attach('photo', buf, 'work.jpg');
}

test('photos are filed under the step the job is at; anyone who sees the job sees them', async () => {
  let res = await upload(technician);
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.thumb, `/jobs/${jobId}/photos/${res.body.id}/thumb.webp`);
  const first = await db('job_photos').where({ id: res.body.id }).first();
  assert.equal(first.step_name, 'Vehicle Received');

  const step = await db('job_steps').where({ job_id: jobId, name: 'Vehicle Received' }).first();
  await post(supervisor, `/jobs/${jobId}/steps/${step.id}/done`);
  res = await upload(supervisor);
  assert.equal((await db('job_photos').where({ id: res.body.id }).first()).step_name, 'Inspection / Measurement');

  const page = (await sales.get(`/jobs/${jobId}`)).text;
  assert.match(page, /Progress photos/);
  assert.match(page, /2 photos/);
  assert.match(page, new RegExp(`/jobs/${jobId}/photos/${first.id}/thumb.webp`));
  assert.equal((await sales.get(`/jobs/${jobId}/photos/${first.id}.webp`)).headers['content-type'], 'image/webp');
  assert.equal((await upload(sales)).status, 403, 'sales look, they don’t take them');
  assert.equal((await upload(supervisor, Buffer.from('nope'))).status, 422);
});

test('photos can be deleted while the job is open; a completed job’s photos are kept as they are', async () => {
  const [p] = await db('job_photos').where({ job_id: jobId }).orderBy('id');
  const csrf = csrfFrom((await supervisor.get('/')).text);
  await db('jobs').where({ id: jobId }).update({ status: 'completed' });
  let res = await supervisor.post(`/jobs/${jobId}/photos/${p.id}/delete`).set('x-csrf-token', csrf).set('Accept', 'application/json');
  assert.equal(res.status, 409);
  assert.equal((await upload(supervisor)).status, 409);
  assert.doesNotMatch((await supervisor.get(`/jobs/${jobId}`)).text, /title="Take a photo"/, 'no camera on a completed job');
  await db('jobs').where({ id: jobId }).update({ status: 'in_progress' });
  res = await supervisor.post(`/jobs/${jobId}/photos/${p.id}/delete`).set('x-csrf-token', csrf).set('Accept', 'application/json');
  assert.equal(res.status, 200);
  assert.equal(await db('job_photos').where({ id: p.id }).first(), undefined);
});
