import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

// System → Roles. These tests change the Reception role, and put it back afterwards.

const app = createApp();
let admin, manager, reception, receptionRole, saved;

before(async () => {
  admin = await loginAs(app, await makeUser(61, ['sysadmin'])); // roles are the System Administrator's
  manager = await loginAs(app, await makeUser(62, ['manager']));
  reception = await loginAs(app, await makeUser(63, ['reception']));
  receptionRole = await db('roles').where({ key: 'reception' }).first();
  saved = await db('role_permissions').where({ role_id: receptionRole.id }).select('role_id', 'permission_id');
});

after(async () => {
  await db('role_permissions').where({ role_id: receptionRole.id }).delete();
  if (saved.length) await db('role_permissions').insert(saved);
  await db('audit_log').where({ entity: 'role', entity_id: receptionRole.id }).whereIn('user_id', db('users').where('phone', 'like', '+25470000%').select('id')).delete();
  await cleanup();
});

async function post(agent, url, fields) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const keysOf = async (roleId) => db('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', roleId).orderBy('p.key').pluck('p.key');

test('only the System Administrator sees and changes roles', async () => {
  const list = await admin.get('/admin/roles').expect(200);
  assert.match(list.text, /Reception/);
  assert.match(list.text, /Everything/, 'admin');
  assert.match((await admin.get('/')).text, /href="\/admin\/roles"/);
  await manager.get('/admin/roles').expect(403);
  assert.equal((await post(manager, `/admin/roles/${receptionRole.id}`, { permissions: ['visitors.view'] })).status, 403);
});

test('ticking a permission gives it to everyone with the role, from their next page', async () => {
  await reception.get('/visitors/expected/new').expect(200); // can book: starts with visitors.book
  await reception.get('/customers').expect(403);

  const page = await admin.get(`/admin/roles/${receptionRole.id}`).expect(200);
  assert.match(page.text, /value="customers\.manage"/);
  assert.match(page.text, /Back to the starting set/);

  const res = await post(admin, `/admin/roles/${receptionRole.id}`, { permissions: ['', 'visitors.receive', 'visitors.view', 'customers.manage', 'no.such.permission'] });
  assert.equal(res.status, 302);
  assert.deepEqual(await keysOf(receptionRole.id), ['customers.manage', 'visitors.receive', 'visitors.view']);
  await reception.get('/customers').expect(200);
  assert.equal((await reception.get('/visitors/expected/new')).status, 403, 'booking was taken away');

  const entry = await db('audit_log').where({ entity: 'role', entity_id: receptionRole.id, action: 'permissions_changed' }).orderBy('id', 'desc').first();
  assert.match(entry.summary, /Allowed: Add and edit customers and vehicles/);
  assert.match(entry.summary, /Taken away: Book expected visitors/);
  assert.match((await admin.get(`/admin/roles/${receptionRole.id}`)).text, /changed what this role can do/);
});

test('everything can be taken away; the admin role can’t be changed', async () => {
  await post(admin, `/admin/roles/${receptionRole.id}`, { permissions: '' });
  assert.deepEqual(await keysOf(receptionRole.id), []);

  const adminRole = await db('roles').where({ key: 'admin' }).first();
  const page = await admin.get(`/admin/roles/${adminRole.id}`).expect(200);
  assert.match(page.text, /Admins can do everything/);
  assert.doesNotMatch(page.text, /name="permissions"/);
  assert.equal((await post(admin, `/admin/roles/${adminRole.id}`, { permissions: [] })).status, 409);
});
