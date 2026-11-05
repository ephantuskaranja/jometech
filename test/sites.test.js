import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { seed } from '../db/seeds/01_sites.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let admin, manager, supervisor, hq, siteB;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  siteB = await db('sites').where({ code: 'SITEB' }).first();
  admin = await loginAs(app, await makeUser(25, ['admin']));
  manager = await loginAs(app, await makeUser(26, ['manager']));
  supervisor = await loginAs(app, await makeUser(27, ['supervisor']));
});

after(async () => {
  await db('sites').whereIn('id', [hq.id, siteB.id]).update({ is_active: true });
  await db('sites').where({ id: siteB.id }).update({ name: siteB.name });
  const ids = await db('sites').where('name', 'like', 'Test %').pluck('id');
  await db('audit_log').where({ entity: 'site' }).whereIn('entity_id', [...ids, siteB.id]).delete();
  await db('jobs').whereIn('site_id', ids).delete();
  await db('user_sites').whereIn('site_id', ids).delete();
  await db('sites').whereIn('id', ids).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const site = (name) => db('sites').where({ name }).first();

test('only an admin manages sites', async () => {
  await admin.get('/admin/sites').expect(200);
  await manager.get('/admin/sites').expect(403);
  await supervisor.get('/admin/sites').expect(403);
  assert.equal((await post(manager, '/admin/sites', { name: 'Test nope' })).status, 403);
  assert.match((await admin.get('/')).text, /href="\/admin\/sites"/);
  assert.doesNotMatch((await supervisor.get('/')).text, /href="\/admin\/sites"/);
});

test('a new site only needs a name, and gets a code by itself', async () => {
  let res = await post(admin, '/admin/sites', { name: '', phone: 'nonsense' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Give the site a name/);
  assert.match(res.text, /Use a format like/);

  res = await post(admin, '/admin/sites', { name: 'Test Mombasa Road yard', address: 'Mombasa Road', phone: '0700 000 840' });
  assert.equal(res.status, 302, res.text);
  const s = await site('Test Mombasa Road yard');
  assert.equal(s.code, 'TESTMOMBAS');
  assert.equal(s.phone, '+254700000840');
  assert.equal(s.is_active, 1);

  // A second name starting the same way still gets its own code.
  await post(admin, '/admin/sites', { name: 'Test Mombasa Road annex' });
  assert.equal((await site('Test Mombasa Road annex')).code, 'TESTMOMBA2');

  res = await post(admin, '/admin/sites', { name: 'test mombasa road  yard' });
  assert.equal(res.status, 422);
  assert.match(res.text, /already a site/);
  assert.match(res.text, /Open that site/);
});

test('a new site can be used straight away, by those who cover all sites and by anyone given it', async () => {
  const s = await site('Test Mombasa Road yard');
  assert.match((await manager.get('/')).text, /Test Mombasa Road yard/, 'in the manager’s site switcher');
  assert.doesNotMatch((await supervisor.get('/')).text, /Test Mombasa Road yard/, 'a supervisor hasn’t been given it');
  assert.match((await admin.get('/admin/users/new')).text, /Test Mombasa Road yard/, 'it can be ticked for a user');
  assert.equal((await post(manager, '/account/site', { site_id: s.id })).status, 302);
  assert.match((await manager.get('/check-in')).text, /Test Mombasa Road yard|Check-in/);
  await post(manager, '/account/site', { site_id: hq.id });
});

test('a renamed site keeps its new name after a deploy runs the seed again', async () => {
  const res = await post(admin, `/admin/sites/${siteB.id}`, { name: 'Test Ruai North', address: '', phone: '' });
  assert.equal(res.status, 302, res.text);
  const before = await db('sites').count({ n: '*' });
  await seed(db);
  assert.equal((await db('sites').where({ id: siteB.id }).first()).name, 'Test Ruai North');
  assert.equal((await db('sites').where({ id: siteB.id }).first()).code, 'SITEB', 'the code never changes');
  assert.deepEqual(await db('sites').count({ n: '*' }), before, 'the old name doesn’t come back as a new site');
  assert.match((await admin.get(`/admin/sites/${siteB.id}`)).text, /Test Ruai North/, 'the change is in its history');
  await db('sites').where({ id: siteB.id }).update({ name: siteB.name });
});

test('a site with work still at it can’t be switched off, and the page says why', async () => {
  const s = await site('Test Mombasa Road yard');
  const [customerId] = await db('customers').insert({ number: 'CUS-T841', name: 'Test Haulier', phone: '+254700000841', category: 'individual' });
  const [jobId] = await db('jobs').insert({ number: 'JOB-2026-8841', site_id: s.id, customer_id: customerId, status: 'open' });
  await makeUser(28, ['supervisor'], { name: 'Test Only Here', siteIds: [s.id] });

  const page = (await admin.get(`/admin/sites/${s.id}`)).text;
  assert.match(page, /1 active job/);
  assert.match(page, /1 person who work only here: Test Only Here/);
  assert.doesNotMatch(page, /switch-off/, 'no button while it can’t be done');

  const res = await post(admin, `/admin/sites/${s.id}/switch-off`);
  assert.equal(res.status, 409, 'and refused if asked anyway');
  assert.match(res.text, /can’t be switched off yet/);
  assert.equal((await site('Test Mombasa Road yard')).is_active, 1);

  await db('jobs').where({ id: jobId }).update({ status: 'completed' });
  await db('users').where({ phone: '+254700000028' }).update({ is_active: false });
  assert.match((await admin.get(`/admin/sites/${s.id}`)).text, /switch-off/, 'nothing left in the way');
});

test('switching off hides a site everywhere; it can come back; nothing is lost', async () => {
  const s = await site('Test Mombasa Road yard');
  await post(manager, '/account/site', { site_id: s.id });
  await manager.get('/'); // shows (and clears) the “Now working at …” message, which names the site
  assert.equal((await post(admin, `/admin/sites/${s.id}/switch-off`)).status, 302);
  assert.equal((await site('Test Mombasa Road yard')).is_active, 0);
  assert.match((await admin.get('/admin/sites')).text, /Switched off/, 'still listed for admins');
  assert.doesNotMatch((await manager.get('/')).text, /Test Mombasa Road yard/, 'and gone from the switcher, even for someone working there');
  assert.doesNotMatch((await admin.get('/admin/users/new')).text, /Test Mombasa Road yard/);
  assert.equal(await db('jobs').where({ site_id: s.id }).count({ n: '*' }).then(([r]) => Number(r.n)), 1, 'its records stay');
  await manager.get('/jobs').expect(200);

  assert.equal((await post(admin, `/admin/sites/${s.id}/switch-on`)).status, 302);
  assert.equal((await site('Test Mombasa Road yard')).is_active, 1);
  assert.match((await manager.get('/')).text, /Test Mombasa Road yard/);
  await post(manager, '/account/site', { site_id: hq.id });
});

test('the only active site can’t be switched off', async () => {
  const others = await db('sites').where({ is_active: true }).whereNot({ id: hq.id }).pluck('id');
  try {
    await db('sites').whereIn('id', others).update({ is_active: false });
    const res = await post(admin, `/admin/sites/${hq.id}/switch-off`);
    assert.equal(res.status, 409);
    assert.match(res.text, /only active site/);
  } finally {
    await db('sites').whereIn('id', others).update({ is_active: true });
  }
});
