import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { makeUser, loginAs, cleanup } from './helpers.js';

const app = createApp();
let admin;
before(async () => { admin = await loginAs(app, await makeUser(1, ['admin'])); });
after(cleanup);

test('dashboard renders inside the layout', async () => {
  const res = await admin.get('/').expect(200);
  assert.match(res.text, /<title>Dashboard · Jome-Tech<\/title>/);
  assert.match(res.text, /id="sidebar"/);
  assert.match(res.text, /data-theme-value="dark"/);
  assert.match(res.text, /aria-current="page"/);
});

test('health check reports the database is up', async () => {
  const res = await request(app).get('/health').expect(200);
  assert.deepEqual(res.body, { ok: true, db: 'up' });
});

test('unknown page shows the 404 page', async () => {
  const res = await admin.get('/no-such-page').expect(404);
  assert.match(res.text, /Page not found/);
});

test('front-end libraries are served from node_modules', async () => {
  await request(app).get('/vendor/bootstrap/css/bootstrap.min.css').expect(200);
  await request(app).get('/vendor/bootstrap-icons/bootstrap-icons.min.css').expect(200);
  await request(app).get('/vendor/alpinejs/cdn.min.js').expect(200);
  await request(app).get('/vendor/fonts/archivo/600.css').expect(200);
});
