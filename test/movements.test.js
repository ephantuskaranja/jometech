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
  const res = await hq.post('/check-in').type('form').send({ _csrf: csrf, purpose: 'repairs', vehicle_mode: 'existing', vehicle_id: await vehicleId(reg), no_arrival_reason: 'Test: not through the gate' });
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
  assert.match((await hq.get(`/check-in/${id}/send`)).text, /Who is driving it\?/);
  res = await post(hq, `/check-in/${id}/send`, { to_site_id: hqSite.id, driver_name: 'Juma Otieno' });
  assert.match((await hq.get(`/check-in/${id}/send`)).text, /Choose the site it is going to/);
  assert.equal(await openMove(id), undefined);
});

test('HQ sends a vehicle; it shows as on the way, and Site B sees it arriving', async () => {
  const id = (await db('checkins').where({ vehicle_id: await vehicleId('KZX 401A') }).first('id')).id;
  const res = await post(hq, `/check-in/${id}/send`, { to_site_id: bSite.id, driver_name: 'Juma Otieno', driver_phone: '0700 000 402', people: '3', odometer_out: '120,500' });
  assert.equal(res.status, 302);
  const move = await openMove(id);
  assert.match(move.number, /^MOV-\d{4}-\d{4}$/);
  assert.equal(move.odometer_out, 120500);
  assert.equal(move.driver_phone, '+254700000402');
  assert.equal(move.people, 3);

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

test('the move prints as a vehicle gate pass, at either site; the gate sees how many people', async () => {
  const id = (await db('checkins').where({ vehicle_id: await vehicleId('KZX 401A') }).first('id')).id;
  const move = await openMove(id);
  assert.match((await hq.get(`/check-in/${id}`)).text, new RegExp(`/movements/${move.id}/print`));
  const res = await hq.get(`/movements/${move.id}/print`).expect(200);
  assert.match(res.text, /Vehicle Gate Pass/);
  assert.match(res.text, new RegExp(move.number));
  assert.match(res.text, /KZX 401A/);
  assert.match(res.text, /Number of people:<\/span> 3/);
  assert.match(res.text, /Driver:<\/span> Juma Otieno/);
  assert.match(res.text, /company-stamp\.png/);
  await siteB.get(`/movements/${move.id}/print`).expect(200);
  // Someone at neither site can't
  const other = await db('sites').whereNotIn('id', [hqSite.id, bSite.id]).first('id');
  if (other) {
    const elsewhere = await loginAs(app, await makeUser(75, ['supervisor'], { siteIds: [other.id] }));
    await elsewhere.get(`/movements/${move.id}/print`).expect(404);
  }
  assert.match((await hq.get('/check-in/gate')).text, /People<\/dt><dd>3/);
});

test('it passes both gates before Site B can receive it', async () => {
  const id = (await db('checkins').where({ vehicle_id: await vehicleId('KZX 401A') }).first('id')).id;
  const move = await openMove(id);
  // Not received, and not logged in at Site B, before the HQ gate has cleared it out
  assert.equal((await post(siteB, `/movements/${move.id}/receive`)).status, 409);
  await post(siteB, `/movements/${move.id}/gate-in`);
  assert.equal((await openMove(id)).gate_in_at, null);
  // Only the sending site's gate clears it out
  assert.equal((await post(siteB, `/movements/${move.id}/gate-out`)).status, 403);
  assert.match((await hq.get('/check-in/gate')).text, /Cleared out to Site B/);
  assert.equal((await post(hq, `/movements/${move.id}/gate-out`)).status, 302);
  assert.ok((await openMove(id)).gate_out_at);
  // Once it has left the gate it can't be cancelled
  await post(hq, `/movements/${move.id}/cancel`);
  assert.equal((await openMove(id)).status, 'in_transit');
  // Site B's gate logs it in; HQ's gate can't
  assert.equal((await post(hq, `/movements/${move.id}/gate-in`)).status, 403);
  assert.match((await siteB.get('/check-in/gate')).text, /Logged in at the gate/);
  assert.equal((await post(siteB, `/movements/${move.id}/gate-in`, { gate_in_note: 'Arrived fine' })).status, 302);
  const logged = await openMove(id);
  assert.ok(logged.gate_in_at);
  assert.equal(logged.gate_in_note, 'Arrived fine');
});

test('a gate guard logs it in but can’t confirm it was received', async () => {
  const guard = await loginAs(app, await makeUser(74, ['gate'], { siteIds: [bSite.id] }));
  const id = (await db('checkins').where({ vehicle_id: await vehicleId('KZX 401A') }).first('id')).id;
  const move = await openMove(id);
  const csrf = csrfFrom((await guard.get('/check-in/gate')).text);
  const res = await guard.post(`/movements/${move.id}/receive`).type('form').send({ _csrf: csrf });
  assert.equal(res.status, 403);
  assert.equal((await openMove(id)).status, 'in_transit');
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
  assert.equal(move.people, 1, 'blank: the driver alone');
  assert.equal((await post(siteB, `/movements/${move.id}/cancel`)).status, 403);
  assert.equal((await post(hq, `/movements/${move.id}/cancel`)).status, 302);
  assert.equal((await db('vehicle_movements').where({ id: move.id }).first()).status, 'cancelled');
  assert.equal((await db('checkins').where({ id }).first()).site_id, hqSite.id, 'it stays at HQ');
  assert.equal((await post(siteB, `/movements/${move.id}/receive`)).status, 409);
  const print = await hq.get(`/movements/${move.id}/print`).expect(200);
  assert.match(print.text, /is-cancelled/);
  assert.doesNotMatch(print.text, /company-stamp\.png/);
});

test('Site B’s gate typing in a vehicle sent from HQ logs it in against the move, not as a new arrival', async () => {
  const id = (await db('checkins').where({ vehicle_id: await vehicleId('KZX 402A') }).first('id')).id;
  await post(hq, `/check-in/${id}/send`, { to_site_id: bSite.id, driver_name: 'Juma Otieno' });
  const move = await openMove(id);
  const arrivalsBefore = await db('vehicle_arrivals').count({ n: '*' }).first().then((r) => Number(r.n));
  const typeIn = () => post(siteB, '/gate/arrivals', { vehicle_text: 'kzx402a', driver_name: 'Juma Otieno', purpose: 'repairs' });

  // Not cleared out at HQ yet: the guard is told to call HQ's gate.
  let res = await typeIn();
  assert.equal(res.status, 422);
  assert.match(res.text, /hasn’t cleared it out yet/);
  // The gate page opens on its lists, the move among them; the arrival form opens from "Log a vehicle in".
  await post(hq, `/movements/${move.id}/gate-out`);
  const page = (await siteB.get('/check-in/gate')).text;
  assert.match(page, /To and from other sites/);
  assert.doesNotMatch(page, /Vehicle arriving/);
  assert.match(page, /href="\/check-in\/gate\?log=1"/);
  assert.match((await siteB.get('/check-in/gate?log=1')).text, /Vehicle arriving/);

  res = await typeIn();
  assert.equal(res.status, 302);
  assert.ok((await openMove(id)).gate_in_at, 'logged in against the move');
  assert.equal(await db('vehicle_arrivals').count({ n: '*' }).first().then((r) => Number(r.n)), arrivalsBefore, 'no new arrival');
  assert.match((await siteB.get('/check-in/gate')).text, new RegExp(`logged in against that move`));
});

test('“Send to another site” is a header action with its own page; Movements → “Send a vehicle” picks one', async () => {
  const owner = await db('customers').where({ phone: '+254700000401' }).first('id');
  await db('vehicles').insert({ reg_no: 'KZX 403A', customer_id: owner.id, type: 'truck' });
  const id = await checkInAtHq('KZX 403A');
  // The check-in page: the action in its header, opening the send page (no form inside the page's cards).
  const page = (await hq.get(`/check-in/${id}`)).text;
  assert.match(page, new RegExp(`href="/check-in/${id}/send"[^>]*>[\\s\\S]{0,80}Send to another site`));
  assert.doesNotMatch(page, /name="driver_name"/, 'the form is on its own page');
  const form = (await hq.get(`/check-in/${id}/send`)).text;
  assert.match(form, /Send KZX 403A to another site/);
  assert.match(form, /name="driver_name"/);
  // A problem brings the send page back with it.
  const res = await post(hq, `/check-in/${id}/send`, { to_site_id: bSite.id, driver_name: '' });
  assert.equal(res.headers.location, `/check-in/${id}/send`);
  assert.match((await hq.get(`/check-in/${id}/send`)).text, /Who is driving it\?/);
  // Movements → Send a vehicle lists it, linking to that page.
  assert.match((await hq.get('/check-in?show=moves')).text, /href="\/movements\/new"/);
  assert.match((await hq.get('/movements/new')).text, new RegExp(`href="/check-in/${id}/send"`));
  // Site B staff can't send HQ's vehicle.
  assert.equal((await siteB.get(`/check-in/${id}/send`)).status, 403);
});

test('each vehicle in the workshop has a highlighted Send button on the Check-in list', async () => {
  const owner = await db('customers').where({ phone: '+254700000401' }).first('id');
  await db('vehicles').insert({ reg_no: 'KZX 404A', customer_id: owner.id, type: 'truck' });
  const id = await checkInAtHq('KZX 404A');
  assert.match((await hq.get('/check-in')).text, new RegExp(`class="btn btn-send btn-sm text-nowrap" href="/check-in/${id}/send"`));
});
