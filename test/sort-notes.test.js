// Sheet row 57: lists say how they are sorted. History lists are newest first; queues (work due,
// people waiting) keep the oldest or soonest first; reference lists are A to Z.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeUser, loginAs, cleanup } from './helpers.js';

const app = createApp();
let admin;
before(async () => { admin = await loginAs(app, await makeUser(64, ['admin'])); });
after(cleanup);

const note = (html) => /class="jt-sort-note[^"]*"><i class="bi bi-sort-down"><\/i> ([^<]+)</.exec(html)?.[1];

test('each list says how it is sorted', async () => {
  const expect = {
    '/jobs': 'Newest first',
    '/jobs?show=completed': 'Latest completed first',
    '/jobs?show=all': 'Newest first',
    '/enquiries': 'A queue: soonest follow-up date first',
    '/proformas': 'Newest first',
    '/invoices': 'Drafts first, then newest issued first',
    '/check-in': 'Latest checked in first',
    '/customers': 'A to Z by name',
    '/visitors': 'A queue: longest here first',
    '/visitors?show=register': 'Latest first',
    '/purchase-orders': 'Newest first',
    '/qc': 'A queue: soonest due first',
  };
  for (const [url, text] of Object.entries(expect)) {
    const res = await admin.get(url);
    assert.equal(res.status, 200, url);
    assert.equal(note(res.text), text, url);
  }
});
