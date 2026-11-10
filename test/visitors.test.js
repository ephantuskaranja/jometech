import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup, PASSWORD } from './helpers.js';

const app = createApp();
let gate, reception, supervisor, hq, siteB;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  siteB = await db('sites').where({ code: 'SITEB' }).first();
  gate = await loginAs(app, await makeUser(81, ['gate'], { siteIds: [hq.id, siteB.id] }));
  reception = await loginAs(app, await makeUser(82, ['reception']));
  supervisor = await loginAs(app, await makeUser(83, ['supervisor']));
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/account/password')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}

const visitor = (fields) => ({ phone: '0700 000 501', name: 'Ann Wanjiku', purpose: 'Delivery', host: 'Reception', company: 'Mabati Rolling Mills', ...fields });

test('a guard with two sites chooses one at login and keeps it until logout', async () => {
  let res = await gate.get('/visitors');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/choose-site');
  const page = await gate.get('/choose-site');
  assert.match(page.text, /Which site are you at\?/);
  res = await gate.post('/choose-site').type('form').send({ _csrf: csrfFrom(page.text), site_id: hq.id });
  assert.equal(res.status, 302);

  assert.equal((await gate.get('/')).headers.location, '/visitors', 'the gate starts on the register');
  assert.match((await gate.get('/visitors')).text, /Chosen when you logged in/);
  await post(gate, '/account/site', { site_id: siteB.id });
  assert.match((await gate.get('/visitors')).text, /Visitors at HQ/, 'the site can’t be switched');
});

test('a receptionist with one site goes straight in; a guard with no site can’t log in', async () => {
  assert.equal((await reception.get('/')).headers.location, '/visitors');
  await makeUser(84, ['gate'], { siteIds: [] });
  const agent = (await import('supertest')).default.agent(app);
  const login = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(login.text), identifier: '0700000084', password: PASSWORD });
  assert.equal(res.status, 401);
  assert.match(res.text, /haven’t been given a site/);
});

test('signing in needs phone, name and purpose; “Other” needs a reason', async () => {
  let res = await post(gate, '/visitors', { phone: '', name: '', purpose: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Enter their phone number/);
  assert.match(res.text, /Enter the visitor’s name/);
  assert.match(res.text, /Choose why they are here/);
  res = await post(gate, '/visitors', visitor({ purpose: 'Other', other_purpose: '' }));
  assert.equal(res.status, 422);
  assert.match(res.text, /Say why they are here/);
});

test('gate signs in, reception receives, gate clears out', async () => {
  const res = await post(gate, '/visitors', visitor({ vehicle_reg: 'kda123a', people: '2' }));
  assert.equal(res.status, 302, res.text);
  const v = await db('visitors').where({ phone: '+254700000501' }).orderBy('id', 'desc').first();
  assert.match(v.number, /^VIS-\d{4}-\d{4}$/);
  assert.equal(v.status, 'arrived');
  assert.equal(v.site_id, hq.id);
  assert.equal(v.vehicle_reg, 'KDA 123A');
  assert.equal(v.people, 2);

  assert.match((await reception.get('/visitors')).text, /Ann Wanjiku/);
  assert.equal((await post(gate, `/visitors/${v.id}/receive`)).status, 403, 'the gate doesn’t receive');
  assert.equal((await post(reception, `/visitors/${v.id}/clear`)).status, 403, 'reception doesn’t clear out');

  assert.equal((await post(reception, `/visitors/${v.id}/receive`)).status, 302);
  assert.equal((await db('visitors').where({ id: v.id }).first()).status, 'received');
  assert.equal((await post(reception, `/visitors/${v.id}/receive`)).status, 409);

  assert.equal((await post(gate, `/visitors/${v.id}/clear`)).status, 302);
  const done = await db('visitors').where({ id: v.id }).first();
  assert.equal(done.status, 'cleared');
  assert.ok(done.cleared_at);
  assert.doesNotMatch((await gate.get('/visitors')).text, new RegExp(`href="/visitors/${v.id}"`), 'no longer on site');
  const page = (await gate.get(`/visitors/${v.id}`)).text;
  assert.match(page, /signed the visitor in/);
  assert.match(page, /confirmed the visitor was received/);
  assert.match(page, /cleared the visitor out/);
});

test('the gate can’t clear out a visitor reception hasn’t received: they show as pending confirmation', async () => {
  await post(gate, '/visitors', visitor({ name: 'Peter Kamau', phone: '0700 000 502', company: 'Kamau Motors' }));
  const v = await db('visitors').where({ phone: '+254700000502' }).first();
  let page = (await gate.get('/visitors')).text;
  assert.match(page, /Pending confirmation/);
  assert.match(page, /Waiting for reception/, 'no Clear out button yet');
  assert.match(page, /data-find="[^"]*peter kamau[^"]*kamau motors/, 'found by the live search');

  const res = await post(gate, `/visitors/${v.id}/clear`);
  assert.equal(res.status, 302);
  assert.equal((await db('visitors').where({ id: v.id }).first()).status, 'arrived', 'still on site');
  assert.match((await gate.get(res.headers.location)).text, /hasn’t been received at reception yet/);

  await post(reception, `/visitors/${v.id}/receive`);
  page = (await gate.get('/visitors')).text;
  assert.match(page, /by Test reception/, 'who received them, on the list');
  await post(gate, `/visitors/${v.id}/clear`);
  assert.equal((await db('visitors').where({ id: v.id }).first()).status, 'cleared');
  assert.match((await gate.get('/visitors?show=register')).text, /Registered/);
});

test('with nobody at reception, the guard can clear a visitor out with a reason, and it shows', async () => {
  await post(gate, '/visitors', visitor({ name: 'Mercy Atieno', phone: '0700 000 520' }));
  const v = await db('visitors').where({ phone: '+254700000520' }).first();
  assert.match((await gate.get('/visitors')).text, /Reception not available\?/);

  await post(gate, `/visitors/${v.id}/clear`, { override_reason: ' ' });
  assert.equal((await db('visitors').where({ id: v.id }).first()).status, 'arrived', 'a reason is needed');

  await post(gate, `/visitors/${v.id}/clear`, { override_reason: 'Reception closed after 5pm' });
  const done = await db('visitors').where({ id: v.id }).first();
  assert.equal(done.status, 'cleared');
  assert.equal(done.received_at, null, 'not marked as received');
  assert.equal(done.override_reason, 'Reception closed after 5pm');
  assert.match((await gate.get('/visitors?show=register')).text, /Cleared without reception[\s\S]*Reception closed after 5pm/);
  assert.match((await gate.get(`/visitors/${v.id}`)).text, /Cleared without reception/);
  const entry = await db('audit_log').where({ entity: 'visitor', entity_id: v.id, action: 'visitor_cleared' }).first();
  assert.match(entry.summary, /without reception confirming: Reception closed after 5pm/);
});

test('reception signing in a walk-in receives them at once', async () => {
  await post(reception, '/visitors', visitor({ name: 'Grace Achieng', phone: '0700 000 503', purpose: 'Interview' }));
  const v = await db('visitors').where({ phone: '+254700000503' }).first();
  assert.equal(v.status, 'received');
  assert.ok(v.received_at);
});

test('a returning visitor is found by phone', async () => {
  const res = await gate.get('/api/visitors/last?phone=0700000501').expect(200);
  assert.equal(res.body.name, 'Ann Wanjiku');
  assert.equal(res.body.company, 'Mabati Rolling Mills');
});

test('someone still on site from an earlier day is flagged', async () => {
  await post(gate, '/visitors', visitor({ name: 'John Mutua', phone: '0700 000 504' }));
  const v = await db('visitors').where({ phone: '+254700000504' }).first();
  await db('visitors').where({ id: v.id }).update({ arrived_at: new Date(Date.now() - 2 * 86_400_000) });
  assert.match((await gate.get('/visitors')).text, /Still on site since/);
});

test('the register finds visitors by phone; supervisors only look', async () => {
  const found = (await supervisor.get('/visitors?show=register&q=0700000501')).text;
  assert.match(found, /Ann Wanjiku/);
  assert.equal((await supervisor.get('/visitors/new')).status, 403);
  const v = await db('visitors').where({ phone: '+254700000504' }).first();
  assert.equal((await post(supervisor, `/visitors/${v.id}/clear`)).status, 403);
});

test('“Who are they seeing?” is Reception (the default) or a staff member at the site', async () => {
  const form = (await gate.get('/visitors/new')).text;
  assert.match(form, /<option value="Reception" selected>Reception<\/option>/, 'Reception is the default');
  assert.match(form, /<option value="Test reception">Test reception<\/option>/, 'staff at the site are listed');
  let res = await post(gate, '/visitors', visitor({ phone: '0700 000 509', name: 'Joseph Mutua', host: 'Peter Kioko' }));
  assert.equal(res.status, 422, 'someone not on the list: reception sends them on');
  assert.match(res.text, /Choose someone from the list, or Reception/);
  res = await post(gate, '/visitors', visitor({ phone: '0700 000 509', name: 'Joseph Mutua', host: 'Test reception' }));
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('visitors').where({ name: 'Joseph Mutua' }).first()).host, 'Test reception');
});

test('permanent employees at the site are on the “Who are they seeing?” list, with their trade; casuals are not', async () => {
  const by = await db('users').where({ name: 'Test reception' }).first('id'); // so the test cleanup removes the employee
  await db('employees').insert([
    { number: 'EMP-T-V01', name: 'Test Welder Kamau', trade: 'Welder', category: 'permanent', site_id: hq.id, created_by: by.id },
    { number: 'EMP-T-V04', name: 'Test Casual Mwangi', trade: 'Helper', category: 'casual', site_id: hq.id, created_by: by.id },
    { number: 'EMP-T-V02', name: 'Test Painter Away', trade: 'Painter', category: 'permanent', site_id: siteB.id, created_by: by.id },
    { number: 'EMP-T-V03', name: 'Test Fitter Gone', trade: 'Fitter', category: 'permanent', site_id: hq.id, is_active: false, created_by: by.id },
  ]);
  const form = (await gate.get('/visitors/new')).text;
  assert.match(form, /<option value="Test Welder Kamau">Test Welder Kamau · Welder<\/option>/);
  assert.doesNotMatch(form, /Test Painter Away/, 'works at another site');
  assert.doesNotMatch(form, /Test Fitter Gone/, 'no longer working here');
  assert.doesNotMatch(form, /Test Casual Mwangi/, 'casuals change too often to list');
  assert.match(form, /<option value="Reception" selected>/, 'Reception is still the default');
  const res = await post(gate, '/visitors', visitor({ phone: '0700 000 510', name: 'Esther Njeri', host: 'Test Welder Kamau' }));
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('visitors').where({ name: 'Esther Njeri' }).first()).host, 'Test Welder Kamau');
});

test('ID numbers are kept in one format, and one ID number belongs to one person', async () => {
  let res = await post(gate, '/visitors', visitor({ phone: '0700 000 530', name: 'Lucy Wairimu', id_no: '77 053-001' }));
  assert.equal(res.status, 302, res.text);
  assert.equal((await db('visitors').where({ phone: '+254700000530' }).first()).id_no, '77053001');

  res = await post(gate, '/visitors', visitor({ phone: '0700 000 531', name: 'Brian Otieno', id_no: '77053001' }));
  assert.equal(res.status, 422, 'someone else’s ID number');
  assert.match(res.text, /This ID number is Lucy Wairimu’s/);

  res = await post(gate, '/visitors', visitor({ phone: '0700 000 530', name: 'lucy  wairimu', id_no: '77053001' }));
  assert.equal(res.status, 302, 'the same person again (any spacing or capitals) is fine');
  res = await post(gate, '/visitors', visitor({ phone: '0700 000 532', name: 'Tom', id_no: '12' }));
  assert.match(res.text, /Use the digits/);
});

test('a phone used before under another name is a question: the guard confirms a different person', async () => {
  let res = await post(gate, '/visitors', visitor({ phone: '0700 000 530', name: 'Kevin Mwangi' }));
  assert.equal(res.status, 422);
  assert.match(res.text, /This phone was used by (Lucy Wairimu|lucy  wairimu)/);
  assert.match(res.text, /name="confirm_phone"/);
  res = await post(gate, '/visitors', visitor({ phone: '0700 000 530', name: 'Kevin Mwangi', confirm_phone: '1' }));
  assert.equal(res.status, 302, res.text);
});
