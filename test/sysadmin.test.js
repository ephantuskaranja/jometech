import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

// The System Administrator: the only one who can use Backups, Import data and Roles,
// and whose account no one else can change, reset or switch off.

const app = createApp();
let sysadmin, admin, sysadminId, adminId, hq;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first('id');
  sysadmin = await loginAs(app, await makeUser(10, ['sysadmin']));
  admin = await loginAs(app, await makeUser(11, ['admin']));
  sysadminId = (await db('users').where({ phone: '+254700000010' }).first('id')).id;
  adminId = (await db('users').where({ phone: '+254700000011' }).first('id')).id;
});

after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const rolesOf = (id) => db('user_roles').join('roles', 'roles.id', 'role_id').where({ user_id: id }).orderBy('roles.key').pluck('roles.key');

test('backups, import and roles are for the System Administrator only, not admins', async () => {
  for (const url of ['/admin/backups', '/admin/import', '/admin/roles']) {
    await sysadmin.get(url).expect(200);
    const res = await admin.get(url).expect(403);
    assert.match(res.text, /Only the System Administrator/);
  }
  assert.equal((await post(admin, '/admin/backups')).status, 403);
  const menu = (await admin.get('/')).text;
  for (const href of ['/admin/backups', '/admin/import', '/admin/roles']) {
    assert.doesNotMatch(menu, new RegExp(`href="${href}"`));
    assert.match((await sysadmin.get('/')).text, new RegExp(`href="${href}"`));
  }
  // Admins can still do everything else.
  await admin.get('/admin/users').expect(200);
  await admin.get('/admin/sites').expect(200);
});

test('an admin can see the System Administrator’s account but not change it', async () => {
  const page = (await admin.get(`/admin/users/${sysadminId}`).expect(200)).text;
  assert.match(page, /Only they can change it/);
  assert.doesNotMatch(page, /Reset password/);
  assert.doesNotMatch(page, /Switch off account/);

  assert.equal((await post(admin, `/admin/users/${sysadminId}/reset-password`)).status, 403);
  assert.equal((await post(admin, `/admin/users/${sysadminId}/status`, { active: '0' })).status, 403);
  assert.equal((await post(admin, `/admin/users/${sysadminId}`, { name: 'Taken Over', phone: '0700000010', roles: ['sales'], sites: [String(hq.id)] })).status, 403);
  const user = await db('users').where({ id: sysadminId }).first('name', 'is_active');
  assert.equal(user.is_active, 1);
  assert.notEqual(user.name, 'Taken Over');
  assert.deepEqual(await rolesOf(sysadminId), ['sysadmin']);
});

test('only the System Administrator can give the role, and it’s never offered to admins', async () => {
  assert.doesNotMatch((await admin.get('/admin/users/new')).text, /value="sysadmin"/);
  assert.match((await sysadmin.get('/admin/users/new')).text, /value="sysadmin"/);

  const made = await post(admin, '/admin/users', { name: 'Test Would Be Sysadmin', phone: '0700000012', roles: ['sysadmin'], sites: [String(hq.id)] });
  assert.equal(made.status, 422);
  assert.match(made.text, /Only the System Administrator can give or take away that role/);
  const self = await post(admin, `/admin/users/${adminId}`, { name: 'Test admin', phone: '0700000011', roles: ['admin', 'sysadmin'], sites: [String(hq.id)] });
  assert.equal(self.status, 422);
  assert.deepEqual(await rolesOf(adminId), ['admin']);

  // The System Administrator can make a second one, and take it away again.
  assert.equal((await post(sysadmin, `/admin/users/${adminId}`, { name: 'Test admin', phone: '0700000011', roles: ['admin', 'sysadmin'], sites: [String(hq.id)] })).status, 302);
  assert.deepEqual(await rolesOf(adminId), ['admin', 'sysadmin']);
  assert.equal((await post(sysadmin, `/admin/users/${adminId}`, { name: 'Test admin', phone: '0700000011', roles: ['admin'], sites: [String(hq.id)] })).status, 302);
  assert.deepEqual(await rolesOf(adminId), ['admin']);
});

test('the System Administrator can’t remove their own role or switch themselves off', async () => {
  const res = await post(sysadmin, `/admin/users/${sysadminId}`, { name: 'Test sysadmin', phone: '0700000010', roles: ['admin'], sites: [String(hq.id)] });
  assert.equal(res.status, 422);
  assert.match(res.text, /can’t remove your own System Administrator role/);
  await post(sysadmin, `/admin/users/${sysadminId}/status`, { active: '0' });
  assert.equal((await db('users').where({ id: sysadminId }).first('is_active')).is_active, 1);
  assert.deepEqual(await rolesOf(sysadminId), ['sysadmin']);
});

test('the System Administrator role can’t be edited on the Roles screen', async () => {
  const role = await db('roles').where({ key: 'sysadmin' }).first('id');
  assert.match((await sysadmin.get(`/admin/roles/${role.id}`).expect(200)).text, /only one who can use Backups/);
  assert.equal((await post(sysadmin, `/admin/roles/${role.id}`, { permissions: [] })).status, 409);
});
