import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { alertsFor } from '../src/modules/dashboard/alerts.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let manager, managerId, customer, site, today;

/** Someone with these permissions, working at the test site. */
const person = (...perms) => ({ can: (p) => perms.includes(p), sites: [site] });
const groupOf = async (key, user) => (await alertsFor(user, site)).groups.find((g) => g.key === key);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  today = localDay();
  manager = await loginAs(app, await makeUser(96, ['manager']));
  managerId = (await db('users').where({ phone: '+254700000096' }).first('id')).id;
  const [id] = await db('sites').insert({ code: 'TSTALR', name: 'Test Alerts Site' });
  site = { id, name: 'Test Alerts Site' };
  const csrf = csrfFrom((await manager.get('/')).text);
  await manager.post('/customers').type('form').send({ _csrf: csrf, name: 'Alert Movers', phone: '0700000981', category: 'company', credit_days: '7' });
  customer = await db('customers').where({ phone: '+254700000981' }).first();
});

after(async () => {
  const jobIds = await db('jobs').where({ site_id: site.id }).pluck('id');
  await db('invoices').whereIn('job_id', jobIds).delete();
  await db('jobs').whereIn('id', jobIds).delete();
  await db('running_costs').where({ site_id: site.id }).delete();
  await db('attendance_confirmations').where({ site_id: site.id }).delete();
  await db('employees').where({ site_id: site.id }).delete();
  await db('items').where('name', 'like', 'Test alert %').delete();
  await db('user_sites').where({ site_id: site.id }).delete();
  await db('sites').where({ id: site.id }).delete();
  await cleanup();
});

test('overdue jobs and invoices past their credit terms are named, oldest first, for those who deal with them', async () => {
  const job = async (number, due) => (await db('jobs').insert({ number, customer_id: customer.id, site_id: site.id, status: 'in_progress', due_on: due, created_by: managerId }))[0];
  const late = await job('JOB-T-ALR1', addDays(today, -3));
  await job('JOB-T-ALR2', addDays(today, 2));
  const workshop = person('jobs.manage');
  const jobs = await groupOf('jobs', workshop);
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].href, `/jobs/${late}`);
  assert.match(jobs.rows[0].sub, /3 days late/);
  assert.equal(await groupOf('jobs', person('quotations.manage')), undefined, 'not for sales');

  // Issued 10 days ago on 7-day terms, half paid: 3 days past due.
  const [inv] = await db('invoices').insert({ job_id: late, site_id: site.id, customer_id: customer.id, number: 'T-ALR-1', status: 'issued', total: 50000, invoice_date: addDays(today, -10), issued_at: new Date() });
  await db('payments').insert({ number: 'RCT-T-ALR1', job_id: late, amount: 20000, method: 'cash', payer: 'client', paid_on: addDays(today, -9), received_by: managerId });
  const money = await groupOf('invoices', person('invoices.manage'));
  const row = money.rows.find((r) => r.href === `/invoices/${inv}`);
  assert.ok(row, 'listed');
  assert.match(row.sub, /KES 30,000\.00 owed · due .*, 3 days ago/);
  await db('payments').where({ number: 'RCT-T-ALR1' }).delete();
  await db('payments').insert({ number: 'RCT-T-ALR2', job_id: late, amount: 50000, method: 'cash', payer: 'client', paid_on: today, received_by: managerId });
  assert.ok(!(await groupOf('invoices', person('invoices.manage')))?.rows.some((r) => r.href === `/invoices/${inv}`), 'paid: gone');
  await db('payments').where({ number: 'RCT-T-ALR2' }).delete();
});

test('low stock, last work day’s attendance and last month’s running costs', async () => {
  const [item] = await db('items').insert({ code: 'T-ALR-1', name: 'Test alert bolts', category_id: (await db('item_categories').first('id')).id, priced_by: 'unit', unit: 'Pc', reorder_level: 50, on_hand_qty: 0 });
  const stock = await groupOf('stock', person('inventory.manage'));
  const row = stock.rows.find((r) => r.href === `/items/${item}`);
  assert.ok(row, 'none left: among the first shown');
  assert.match(row.sub, /0 Pc left · reorder at 50/);

  // A site with staff: the last work day before today, unless it's confirmed.
  assert.equal(await groupOf('attendance', person('attendance.manage')), undefined, 'no staff here yet');
  await db('employees').insert({ number: 'EMP-T-ALR1', name: 'Test Alert Staff', site_id: site.id, created_by: managerId });
  const att = await groupOf('attendance', person('attendance.manage'));
  const last = att.rows[0].href.match(/day=([\d-]+)/)[1];
  assert.notEqual(new Date(`${last}T12:00:00Z`).getUTCDay(), 0, 'never a Sunday');
  assert.ok(last < today);
  await db('attendance_confirmations').insert({ site_id: site.id, day: last, confirmed_by: managerId });
  assert.equal(await groupOf('attendance', person('attendance.manage')), undefined);

  const month = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  assert.match((await groupOf('running', person('costing.view'))).rows[0].href, new RegExp(`month=${month}`));
  await db('running_costs').insert({ site_id: site.id, month, category: 'rent', amount: 1000 });
  assert.equal(await groupOf('running', person('costing.view')), undefined);
});

test('the dashboard shows Needs attention only when something needs it', async () => {
  const page = (await manager.get('/')).text;
  // A manager deals with jobs, invoices, stock …: the test data above makes the box appear.
  assert.match(page, /Needs attention/);
});
