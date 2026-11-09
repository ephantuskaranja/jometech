import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let hq, siteB, hqSite, bSite, vehicleId;

before(async () => {
  hqSite = await db('sites').where({ code: 'HQ' }).first();
  bSite = await db('sites').where({ code: 'SITEB' }).first();
  assert.ok(bSite, 'run: npm run db:seed (adds Site B)');
  hq = await loginAs(app, await makeUser(71, ['supervisor']));
  siteB = await loginAs(app, await makeUser(72, ['supervisor'], { siteIds: [bSite.id] }));
  const sales = await loginAs(app, await makeUser(73, ['sales']));
  const csrf = csrfFrom((await sales.get('/customers/new')).text);
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Kiprop Transport', phone: '0700000401' });
  const owner = await db('customers').where({ phone: '+254700000401' }).first();
  for (const reg of ['KZX 401A', 'KZX 402A']) await sales.post('/vehicles').type('form').send({ _csrf: csrf, reg_no: reg, customer_id: owner.id, type: 'truck' });
  vehicleId = (reg) => db('vehicles').where({ reg_no: reg }).first('id').then((v) => v.id);
});
after(cleanup);

async function checkInAtHq(reg) {
  const csrf = csrfFrom((await hq.get('/check-in/new')).text);
  const res = await hq.post('/check-in').type('form').send({ _csrf: csrf, purpose: 'repairs', vehicle_mode: 'existing', vehicle_id: await vehicleId(reg) });
  assert.equal(res.status, 302, res.text);
  return Number(/\/check-in\/(\d+)/.exec(res.headers.location)[1]);
}

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/check-in')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}

const openMove = (checkinId) => db('vehicle_movements').where({ checkin_id: checkinId, status: 'in_transit' }).first();

test('sending needs a driver, and a different site', async () => {
  const id = await checkInAtHq('KZX 401A');
  let res = await post(hq, `/check-in/${id}/send`, { to_site_id: bSite.id, driver_name: '' });
  assert.equal(res.status, 302);
  assert.match((await hq.get(`/check-in/${id}`)).text, /Who is driving it\?/);
  res = await post(hq, `/check-in/${id}/send`, { to_site_id: hqSite.id, driver_name: 'Juma Otieno' });
  assert.match((await hq.get(`/check-in/${id}`)).text, /Choose the site it is going to/);
  assert.equal(await openMove(id), undefined);
});

test('HQ sends a vehicle; it shows as on the way, and Site B sees it arriving', async () => {
  const id = (await db('checkins').where({ vehicle_id: await vehicleId('KZX 401A') }).first('id')).id;
  const res = await post(hq, `/check-in/${id}/send`, { to_site_id: bSite.id, driver_name: 'Juma Otieno', driver_phone: '0700 000 402', odometer_out: '120,500' });
  assert.equal(res.status, 302);
  const move = await openMove(id);
  assert.match(move.number, /^MOV-\d{4}-\d{4}$/);
  assert.equal(move.odometer_out, 120500);
  assert.equal(move.driver_phone, '+254700000402');

  assert.match((await hq.get('/check-in')).text, /On the way to Site B/);
  assert.match((await hq.get(`/check-in/${id}`)).text, /sent it to another site/);
  const bList = (await siteB.get('/check-in')).text;
  assert.match(bList, /On the way to Site B/);
  assert.match(bList, /KZX 401A/);

  // Not yet: HQ can't receive it, nobody can check it out, it can't be sent twice
  assert.equal((await post(hq, `/movements/${move.id}/receive`)).status, 403);
  assert.equal((await post(hq, `/check-in/${id}/release`)).status, 409);
  await post(hq, `/check-in/${id}/send`, { to_site_id: bSite.id, driver_name: 'Juma Otieno' });
  assert.equal((await db('vehicle_movements').where({ checkin_id: id })).length, 1);
});

test('Site B receives it: the check-in moves to Site B’s workshop list', async () => {
  const id = (await db('checkins').where({ vehicle_id: await vehicleId('KZX 401A') }).first('id')).id;
  const move = await openMove(id);
  const res = await post(siteB, `/movements/${move.id}/receive`, { odometer_in: '120 545' });
  assert.equal(res.status, 302);
  const done = await db('vehicle_movements').where({ id: move.id }).first();
  assert.equal(done.status, 'received');
  assert.equal(done.odometer_in, 120545);
  assert.equal((await db('checkins').where({ id }).first()).site_id, bSite.id);

  assert.match((await siteB.get('/check-in')).text, /KZX 401A/);
  assert.doesNotMatch((await hq.get('/check-in')).text, /KZX 401A/);
  assert.equal((await hq.get(`/check-in/${id}`)).status, 403, 'HQ-only staff no longer see it');
  assert.match((await siteB.get(`/check-in/${id}`)).text, /received it/);
  assert.match((await siteB.get('/check-in?show=moves')).text, /Received/);
});

test('a move that never left can be cancelled by the sending site only', async () => {
  const id = await checkInAtHq('KZX 402A');
  await post(hq, `/check-in/${id}/send`, { to_site_id: bSite.id, driver_name: 'Juma Otieno' });
  const move = await openMove(id);
  assert.equal((await post(siteB, `/movements/${move.id}/cancel`)).status, 403);
  assert.equal((await post(hq, `/movements/${move.id}/cancel`)).status, 302);
  assert.equal((await db('vehicle_movements').where({ id: move.id }).first()).status, 'cancelled');
  assert.equal((await db('checkins').where({ id }).first()).site_id, hqSite.id, 'it stays at HQ');
  assert.equal((await post(siteB, `/movements/${move.id}/receive`)).status, 409);
});
