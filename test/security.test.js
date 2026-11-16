import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { formatChassis } from '../src/core/vehicle-format.js';
import { hashPassword } from '../src/core/auth.js';
import { makeUser, loginAs, csrfFrom, cleanup, PASSWORD } from './helpers.js';

// The security check before go-live (2026-11-16): each test is one thing that was found and fixed.
// Records sit at HQ; "elsewhere" staff work only at the attendance tests' site TSTATT (removed by cleanup).

const app = createApp();
let admin, hqSupervisor, elsewhere, technicianRole, invoicePerm, hq, checkinId, invoiceId, jobId;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  const [other] = await db('sites').insert({ code: 'TSTATT', name: 'Test Site A' });
  admin = await loginAs(app, await makeUser(81, ['admin']));
  hqSupervisor = await loginAs(app, await makeUser(82, ['supervisor']));
  // A technician at the other site, given invoices for these tests (as an admin could on the Roles screen).
  technicianRole = await db('roles').where({ key: 'technician' }).first();
  invoicePerm = await db('permissions').where({ key: 'invoices.manage' }).first();
  await db('role_permissions').insert({ role_id: technicianRole.id, permission_id: invoicePerm.id });
  elsewhere = await loginAs(app, await makeUser(83, ['technician', 'supervisor'], { siteIds: [other] }));

  const managerId = (await db('users').where({ phone: '+254700000081' }).first('id')).id;
  const [customer] = await db('customers').insert({ number: 'CUS-T881', name: 'Test Security Haulage', phone: '+254700000881', category: 'company' });
  // Stored straight into the database, as an old import might have: the page must still show it as text.
  const [vehicle] = await db('vehicles').insert({ reg_no: null, chassis_no: '<img src=x onerror=alert(1)>', customer_id: customer, type: 'truck' });
  [checkinId] = await db('checkins').insert({ number: 'CHK-T-SEC1', site_id: hq.id, vehicle_id: vehicle, customer_id: customer, received_by: managerId, driver_name: 'Test Driver' });
  [jobId] = await db('jobs').insert({ number: 'JOB-2026-TSEC', site_id: hq.id, customer_id: customer, vehicle_id: vehicle, checkin_id: checkinId, status: 'open' });
  [invoiceId] = await db('invoices').insert({ job_id: jobId, site_id: hq.id, customer_id: customer, status: 'draft', total: 1000, invoice_date: '2026-11-16' });
});

after(async () => {
  await db('role_permissions').where({ role_id: technicianRole.id, permission_id: invoicePerm.id }).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}

test('check-in photos: only staff who may see the check-in get them, only its site changes them', async () => {
  assert.equal((await elsewhere.get(`/check-in/${checkinId}/photos/1.webp`)).status, 403);
  assert.equal((await elsewhere.get(`/check-in/${checkinId}/photos/1/thumb.webp`)).status, 403);
  const csrf = csrfFrom((await elsewhere.get('/')).text);
  const add = await elsewhere.post(`/check-in/${checkinId}/photos`).set('x-csrf-token', csrf).attach('photo', Buffer.from('not a photo'), 'x.jpg');
  assert.equal(add.status, 403);
  const del = await elsewhere.post(`/check-in/${checkinId}/photos/1/delete`).set('x-csrf-token', csrf);
  assert.equal(del.status, 403);
  assert.equal((await hqSupervisor.get(`/check-in/${checkinId}/photos/999999.webp`)).status, 404, 'its own site gets as far as "no such photo"');
});

test('a chassis number is shown as text, never as HTML', async () => {
  const page = await hqSupervisor.get('/check-in').expect(200);
  assert.match(page.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(page.text, /<img src=x/);
  assert.equal(formatChassis('<img src=x>'), 'IMGSRCX', 'new entries keep letters and digits only');
});

test('invoices and payments: staff see their own sites’ only', async () => {
  assert.equal((await elsewhere.get(`/invoices/${invoiceId}`)).status, 403);
  assert.equal((await elsewhere.get(`/jobs/${jobId}/invoice`)).status, 403);
  assert.doesNotMatch((await elsewhere.get('/invoices?show=all').expect(200)).text, /JOB-2026-TSEC/);
  assert.equal((await post(elsewhere, `/jobs/${jobId}/payments`, { amount: '100', paid_on: '2026-11-16', method: 'cash' })).status, 403);
  assert.equal(await db('payments').where({ job_id: jobId }).count('* as n').first().then((r) => Number(r.n)), 0);
  assert.equal((await admin.get(`/invoices/${invoiceId}`)).status, 200, 'all-site roles still see it');
});

test('someone given user management who isn’t an admin can’t make admins or change roles', async () => {
  const managerRole = await db('roles').where({ key: 'manager' }).first();
  const usersPerm = await db('permissions').where({ key: 'users.manage' }).first();
  await db('role_permissions').insert({ role_id: managerRole.id, permission_id: usersPerm.id });
  try {
    const manager = await loginAs(app, await makeUser(84, ['manager']));
    assert.equal((await manager.get('/admin/roles')).status, 403);
    assert.doesNotMatch((await manager.get('/')).text, /href="\/admin\/roles"/);

    const made = await post(manager, '/admin/users', { name: 'Test Would Be Admin', phone: '0700000085', roles: ['admin'], sites: [String(hq.id)] });
    assert.equal(made.status, 422);
    assert.match(made.text, /Only an admin can give or take away the Admin role/);

    const self = await db('users').where({ phone: '+254700000084' }).first('id');
    const promoted = await post(manager, `/admin/users/${self.id}`, { name: 'Test manager', phone: '0700000084', roles: ['manager', 'admin'], sites: [String(hq.id)] });
    assert.equal(promoted.status, 422, 'not even themselves');

    const adminId = (await db('users').where({ phone: '+254700000081' }).first('id')).id;
    assert.equal((await post(manager, `/admin/users/${adminId}/reset-password`)).status, 403);
    assert.equal((await post(manager, `/admin/users/${adminId}/status`, { active: '0' })).status, 403);
  } finally {
    await db('role_permissions').where({ role_id: managerRole.id, permission_id: usersPerm.id }).delete();
  }
});

test('a password reset or a switched-off account logs the person out everywhere', async () => {
  const phone = await makeUser(86, ['technician']);
  const phoneDevice = await loginAs(app, phone);
  const tablet = await loginAs(app, phone);
  const id = (await db('users').where({ phone: '+254700000086' }).first('id')).id;
  await phoneDevice.get('/').expect(200);

  await post(admin, `/admin/users/${id}/reset-password`);
  assert.match((await phoneDevice.get('/')).headers.location ?? '', /^\/login/);
  assert.match((await tablet.get('/')).headers.location ?? '', /^\/login/);

  // Switched off, then on again: the old login doesn't come back.
  await db('users').where({ id }).update({ password_hash: await hashPassword(PASSWORD), must_change_password: false });
  const laptop = await loginAs(app, phone);
  await laptop.get('/').expect(200);
  await post(admin, `/admin/users/${id}/status`, { active: '0' });
  await db('users').where({ id }).update({ is_active: true });
  assert.match((await laptop.get('/')).headers.location ?? '', /^\/login/);
});

test('changing your own password logs out your other devices, not this one', async () => {
  const phone = await makeUser(87, ['technician']);
  const here = await loginAs(app, phone);
  const there = await loginAs(app, phone);
  const csrf = csrfFrom((await here.get('/account/password')).text);
  await here.post('/account/password').type('form').send({ _csrf: csrf, current: PASSWORD, password: 'a-new-password-1', confirm: 'a-new-password-1' }).expect(302);
  await here.get('/').expect(200);
  assert.match((await there.get('/')).headers.location ?? '', /^\/login/);
});
