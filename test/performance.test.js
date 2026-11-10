import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, cleanup } from './helpers.js';

// Keeps pages light: each main page may run at most this many database queries
// (for a manager, who sees the most). If a change goes over, make the page do less
// work (one query for several counts, no query inside a loop) before raising a limit.
const BUDGET = {
  '/': 30,
  '/visitors': 10,
  '/jobs': 10,
  '/check-in': 10,
  '/enquiries': 8,
  '/proformas': 8,
  '/invoices': 8,
  '/customers': 8,
  '/inventory': 10,
  '/purchase-orders': 8,
  '/employees': 8,
  '/attendance': 16,
  '/reports/summary': 30,
};

const app = createApp();
let agent;
let queries = 0;
const countQuery = () => { queries += 1; };

before(async () => {
  agent = await loginAs(app, await makeUser(39, ['manager']));
  db.on('query', countQuery);
});
after(async () => {
  db.off('query', countQuery);
  await cleanup();
});

for (const [url, limit] of Object.entries(BUDGET)) {
  test(`${url} stays within ${limit} database queries`, async () => {
    await agent.get(url).expect(200); // warm up: first-time lookups aren't the page's cost
    queries = 0;
    await agent.get(url).expect(200);
    assert.ok(queries <= limit, `${url} ran ${queries} queries (limit ${limit})`);
  });
}

test('CSS and JS links carry a version, and versioned files are cached for a year', async () => {
  const page = (await agent.get('/')).text;
  const css = /href="(\/css\/app\.css\?v=[^"]+)"/.exec(page)?.[1];
  assert.ok(css, 'app.css is linked with ?v=');
  assert.match((await agent.get(css)).headers['cache-control'], /max-age=31536000, immutable/);
  assert.equal((await agent.get('/css/app.css')).headers['cache-control'], 'no-cache', 'unversioned: checked each time');
});
