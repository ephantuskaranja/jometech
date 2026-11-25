// The guides in the app: the user guide for everyone logged in, the test guide for admins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { makeUser, loginAs, cleanup } from './helpers.js';

const app = createApp();
let gate, admin;

before(async () => {
  gate = await loginAs(app, await makeUser(95, ['gate']));
  admin = await loginAs(app, await makeUser(96, ['admin']));
});
after(cleanup);

test('the user guide opens for anyone logged in, from the menu', async () => {
  await request(app).get('/help/user-guide').expect(302); // to the login page
  const res = await gate.get('/help/user-guide').expect(200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /^inline/);
  const home = (await gate.get('/')).text;
  assert.match(home, /href="\/help\/user-guide" target="_blank"/);
  assert.doesNotMatch(home, /\/help\/test-guide/);
});

test('the test guide is for admins only', async () => {
  await gate.get('/help/test-guide').expect(403);
  const res = await admin.get('/help/test-guide').expect(200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match((await admin.get('/')).text, /href="\/help\/test-guide"/);
  await admin.get('/help/nothing-here').expect(404);
});
