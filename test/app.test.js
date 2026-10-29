import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

test('dashboard renders inside the layout', async () => {
  const res = await request(app).get('/').expect(200);
  assert.match(res.text, /<title>Dashboard · Jome-Tech<\/title>/);
  assert.match(res.text, /id="sidebar"/);
  assert.match(res.text, /data-theme-value="dark"/);
  assert.match(res.text, /aria-current="page"/);
});

test('health check answers', async () => {
  const res = await request(app).get('/health').expect(200);
  assert.deepEqual(res.body, { ok: true });
});

test('unknown page shows the 404 page', async () => {
  const res = await request(app).get('/no-such-page').expect(404);
  assert.match(res.text, /Page not found/);
});

test('front-end libraries are served from node_modules', async () => {
  await request(app).get('/vendor/bootstrap/css/bootstrap.min.css').expect(200);
  await request(app).get('/vendor/bootstrap-icons/bootstrap-icons.min.css').expect(200);
  await request(app).get('/vendor/alpinejs/cdn.min.js').expect(200);
  await request(app).get('/vendor/fonts/archivo/600.css').expect(200);
});
