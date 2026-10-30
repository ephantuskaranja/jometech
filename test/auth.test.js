import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup, PASSWORD } from './helpers.js';

const app = createApp();
let adminPhone, techPhone, newPhone;

before(async () => {
  adminPhone = await makeUser(11, ['admin']);
  techPhone = await makeUser(12, ['technician']);
  newPhone = await makeUser(13, ['sales'], { mustChangePassword: true });
});
after(cleanup);

async function tryLogin(identifier, password) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), identifier, password });
  return { agent, res };
}

test('pages need login and send you back afterwards', async () => {
  const res = await request(app).get('/account/password').expect(302);
  assert.equal(res.headers.location, '/login?next=%2Faccount%2Fpassword');
});

test('logs in with the phone number in any common format', async () => {
  for (const format of ['0700000011', '+254 700 000 011', '700000011']) {
    const { res } = await tryLogin(format, PASSWORD);
    assert.equal(res.status, 302, format);
    assert.equal(res.headers.location, '/');
  }
});

test('wrong password shows one message and keeps the phone number', async () => {
  const { res } = await tryLogin(adminPhone, 'nope');
  assert.equal(res.status, 401);
  assert.match(res.text, /don’t match/);
  assert.match(res.text, /value="0700000011"/);
});

test('unknown phone gets the same message as a wrong password', async () => {
  const { res } = await tryLogin('0799999999', 'nope');
  assert.equal(res.status, 401);
  assert.match(res.text, /don’t match/);
});

test('five wrong passwords lock the account', async () => {
  const phone = await makeUser(14, ['sales']);
  for (let i = 0; i < 5; i++) await tryLogin(phone, 'wrong');
  const { res } = await tryLogin(phone, PASSWORD);
  assert.equal(res.status, 401);
  assert.match(res.text, /Too many wrong passwords/);
});

test('a form without the CSRF token is refused', async () => {
  const res = await request(app).post('/login').type('form').send({ identifier: adminPhone, password: PASSWORD });
  assert.equal(res.status, 403);
  assert.match(res.text, /This form has expired/);
});

test('menu shows only what the role may use', async () => {
  const admin = await loginAs(app, adminPhone);
  const tech = await loginAs(app, techPhone);
  const adminPage = (await admin.get('/').expect(200)).text;
  const techPage = (await tech.get('/').expect(200)).text;
  const menu = (html) => [...html.matchAll(/class="jt-nav-link[^"]*"[^>]*>\s*<i[^>]*><\/i><span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.ok(menu(adminPage).includes('Payroll'));
  assert.ok(menu(adminPage).includes('Settings &amp; backups'));
  assert.deepEqual(menu(techPage), ['Dashboard', 'Jobs']);
});

test('a new account must change its password first', async () => {
  const agent = await loginAs(app, newPhone);
  const res = await agent.get('/').expect(302);
  assert.equal(res.headers.location, '/account/password');

  const page = await agent.get('/account/password').expect(200);
  await agent.post('/account/password').type('form')
    .send({ _csrf: csrfFrom(page.text), current: PASSWORD, password: 'my-own-pass-9', confirm: 'my-own-pass-9' })
    .expect(302);
  await agent.get('/').expect(200);
  const { res: oldPassword } = await tryLogin(newPhone, PASSWORD);
  assert.equal(oldPassword.status, 401);
});

test('theme choice is saved to the account', async () => {
  const agent = await loginAs(app, adminPhone);
  const page = await agent.get('/');
  await agent.post('/account/theme').set('x-csrf-token', csrfFrom(page.text)).send({ theme: 'dark' }).expect(200);
  const user = await db('users').where({ phone: '+254700000011' }).first('theme');
  assert.equal(user.theme, 'dark');
  assert.match((await agent.get('/')).text, /data-user-theme="dark"/);
});

test('log out ends the session', async () => {
  const agent = await loginAs(app, adminPhone);
  const page = await agent.get('/');
  await agent.post('/logout').type('form').send({ _csrf: csrfFrom(page.text) }).expect(302);
  await agent.get('/').expect(302);
});
