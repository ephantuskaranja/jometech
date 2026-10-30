import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let admin, adminId, siteId;

before(async () => {
  const phone = await makeUser(21, ['admin']);
  admin = await loginAs(app, phone);
  adminId = (await db('users').where({ phone: '+254700000021' }).first('id')).id;
  siteId = (await db('sites').where({ code: 'MAIN' }).first('id')).id;
});
after(cleanup);

/** POSTs a form as the admin, with a fresh CSRF token from `pagePath`. */
async function submit(agent, pagePath, action, fields) {
  const page = await agent.get(pagePath);
  return agent.post(action).type('form').send({ _csrf: csrfFrom(page.text), ...fields });
}

test('only users.manage can open the users screen', async () => {
  const tech = await loginAs(app, await makeUser(22, ['technician']));
  const res = await tech.get('/admin/users');
  assert.equal(res.status, 403);
  assert.match(res.text, /don&#39;t have access/);
  await admin.get('/admin/users').expect(200);
});

test('the add form starts with the least access at your site', async () => {
  const res = await admin.get('/admin/users/new').expect(200);
  assert.match(res.text, /value="technician" checked/);
  assert.match(res.text, new RegExp(`value="${siteId}" checked`));
});

test('adding a user shows a temporary password that works once', async () => {
  const res = await submit(admin, '/admin/users/new', '/admin/users', {
    name: 'Wanjiru Mwangi', phone: '0700 000 023', roles: 'storekeeper', sites: String(siteId),
  });
  assert.equal(res.status, 302);
  const page = await admin.get(res.headers.location).expect(200);
  const temp = /<code>([a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4})<\/code>/.exec(page.text)?.[1];
  assert.ok(temp, 'temporary password shown');

  // Not shown again on the next visit.
  assert.doesNotMatch((await admin.get(res.headers.location)).text, /Temporary password for/);

  // They can log in with it, and must choose their own password first.
  const agent = await loginAs(app, '0700000023', temp);
  assert.equal((await agent.get('/')).headers.location, '/account/password');
});

test('form errors keep what was typed', async () => {
  const res = await submit(admin, '/admin/users/new', '/admin/users', { name: 'Otieno', phone: '0712', roles: [] });
  assert.equal(res.status, 422);
  assert.match(res.text, /Use a format like 0712 345 678/);
  assert.match(res.text, /Choose at least one role/);
  assert.match(res.text, /value="Otieno"/);
});

test('a phone number can only belong to one person', async () => {
  const res = await submit(admin, '/admin/users/new', '/admin/users', {
    name: 'Someone Else', phone: '+254700000021', roles: 'sales', sites: String(siteId),
  });
  assert.equal(res.status, 422);
  assert.match(res.text, /already belongs to Test admin/);
});

test('search finds people by name or phone in any format', async () => {
  const byName = await admin.get('/admin/users?q=wanjiru').expect(200);
  assert.match(byName.text, /Wanjiru Mwangi/);
  const byPhone = await admin.get('/admin/users?q=0700 000 023').expect(200);
  assert.match(byPhone.text, /Wanjiru Mwangi/);
  const none = await admin.get('/admin/users?q=zzzz').expect(200);
  assert.match(none.text, /No one matches/);
});

test('editing changes roles and sites', async () => {
  const user = await db('users').where({ phone: '+254700000023' }).first('id');
  const res = await submit(admin, `/admin/users/${user.id}`, `/admin/users/${user.id}`, {
    name: 'Wanjiru Mwangi', phone: '0700000023', roles: ['storekeeper', 'sales'], sites: String(siteId),
  });
  assert.equal(res.status, 302);
  const roles = await db('user_roles').join('roles', 'roles.id', 'role_id').where({ user_id: user.id }).orderBy('roles.key').pluck('key');
  assert.deepEqual(roles, ['sales', 'storekeeper']);
});

test('you can’t remove your own admin role or switch yourself off', async () => {
  const res = await submit(admin, `/admin/users/${adminId}`, `/admin/users/${adminId}`, {
    name: 'Test admin', phone: '0700000021', roles: 'sales', sites: String(siteId),
  });
  assert.equal(res.status, 422);
  assert.match(res.text, /can’t remove your own Admin role/);

  await submit(admin, `/admin/users/${adminId}`, `/admin/users/${adminId}/status`, { active: '0' });
  const me = await db('users').where({ id: adminId }).first('is_active');
  assert.equal(me.is_active, 1);
});

test('switching someone off logs them out and stops login', async () => {
  const phone = await makeUser(24, ['sales']);
  const victim = await loginAs(app, phone);
  await victim.get('/').expect(200);
  const user = await db('users').where({ phone: '+254700000024' }).first('id');

  await submit(admin, `/admin/users/${user.id}`, `/admin/users/${user.id}/status`, { active: '0' }).then((r) => assert.equal(r.status, 302));
  await victim.get('/').expect(302); // logged out

  const page = await request.agent(app).get('/login');
  const login = await request(app).post('/login').set('Cookie', page.headers['set-cookie'])
    .type('form').send({ _csrf: csrfFrom(page.text), identifier: phone, password: 'workshop-test-1' });
  assert.equal(login.status, 401);
  assert.match(login.text, /switched off/);
});

test('reset password gives a new temporary password and unlocks', async () => {
  const user = await db('users').where({ phone: '+254700000023' }).first('id');
  await db('users').where({ id: user.id }).update({ locked_until: new Date(Date.now() + 600000) });
  const res = await submit(admin, `/admin/users/${user.id}`, `/admin/users/${user.id}/reset-password`, {});
  const page = await admin.get(res.headers.location);
  assert.match(page.text, /Temporary password for Wanjiru Mwangi/);
  const after = await db('users').where({ id: user.id }).first('locked_until', 'must_change_password');
  assert.equal(after.locked_until, null);
  assert.equal(after.must_change_password, 1);
});

test('UI kit page renders every partial', async () => {
  const res = await admin.get('/dev/ui').expect(200);
  for (const piece of ['jt-choice', 'jt-pill', 'jt-plate', 'data-tom-select', 'jt-savebar', 'invalid-feedback', 'jt-auto']) {
    assert.match(res.text, new RegExp(piece), piece);
  }
  const json = await admin.get('/dev/ui/suppliers?q=steel').expect(200);
  assert.ok(json.body.length > 0);
});
