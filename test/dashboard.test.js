import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeUser, loginAs, cleanup } from './helpers.js';

const app = createApp();
const as = {};

before(async () => {
  as.manager = await loginAs(app, await makeUser(15, ['manager']));
  as.storekeeper = await loginAs(app, await makeUser(16, ['storekeeper']));
  as.sales = await loginAs(app, await makeUser(17, ['sales']));
  as.supervisor = await loginAs(app, await makeUser(18, ['supervisor']));
  as.technician = await loginAs(app, await makeUser(19, ['technician']));
});
after(cleanup);

const page = async (who) => (await as[who].get('/').expect(200)).text;

test('the storekeeper sees stores numbers only: no sales, no build progress', async () => {
  const html = await page('storekeeper');
  assert.match(html, /Low stock/);
  assert.match(html, /Goods to receive/);
  assert.match(html, /href="\/inventory\?show=low"/, 'each number opens its list');
  assert.doesNotMatch(html, /Build progress|skeleton/i);
  assert.doesNotMatch(html, /Unpaid invoices|Open enquiries|Proformas/);
  assert.doesNotMatch(html, /Workshop at|Active jobs/, 'seeing jobs isn’t working in the workshop');
  assert.match(html, /New purchase order/);
});

test('sales see enquiries and proformas; not invoices, stores or people', async () => {
  const html = await page('sales');
  assert.match(html, /Follow up today/);
  assert.match(html, /Proformas awaiting reply/);
  assert.doesNotMatch(html, /Unpaid invoices|Low stock|Payroll|Staff here/);
});

test('the supervisor sees the workshop, attendance and visitors at their site', async () => {
  const html = await page('supervisor');
  assert.match(html, /Workshop at HQ/);
  assert.match(html, /Overdue/);
  assert.match(html, /Today’s attendance/);
  assert.match(html, /Visitors at HQ/);
  assert.doesNotMatch(html, /Unpaid invoices|Low stock|Payroll to approve/);
});

test('the manager sees every area, with approvals', async () => {
  const html = await page('manager');
  for (const s of ['Workshop at', 'Sales', 'Stores', 'People', 'Unpaid invoices', 'KES', 'Orders to approve', 'Payroll to approve']) assert.match(html, new RegExp(s));
});

test('a technician sees their workshop’s jobs', async () => {
  const html = await page('technician');
  assert.match(html, /Active jobs/);
  assert.doesNotMatch(html, /Sales|Stores|People/);
});
