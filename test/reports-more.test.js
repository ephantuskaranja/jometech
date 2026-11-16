import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let manager, sales, managerId, site, customer, month;

before(async () => {
  month = localDay().slice(0, 7);
  manager = await loginAs(app, await makeUser(85, ['manager']));
  sales = await loginAs(app, await makeUser(86, ['sales']));
  managerId = (await db('users').where({ phone: '+254700000085' }).first('id')).id;
  const [id] = await db('sites').insert({ code: 'TSTREP', name: 'Test Reports Site' });
  site = id;
  const csrf = csrfFrom((await manager.get('/')).text);
  await manager.post('/customers').type('form').send({ _csrf: csrf, name: 'Report Haulage', phone: '0700000851', category: 'company' });
  customer = await db('customers').where({ phone: '+254700000851' }).first();
});

after(async () => {
  const jobIds = await db('jobs').where({ site_id: site }).pluck('id');
  await db('payments').whereIn('job_id', jobIds).delete();
  await db('invoices').whereIn('job_id', jobIds).delete();
  await db('jobs').whereIn('id', jobIds).delete();
  const itemIds = await db('items').where('name', 'like', 'Test report %').pluck('id');
  await db('stock_balances').whereIn('item_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  await db('payrolls').where({ site_id: site }).delete();
  await db('user_sites').where({ site_id: site }).delete();
  await db('sites').where({ id: site }).delete();
  await cleanup();
});

const page = (path, extra = '') => manager.get(`/reports/${path}?site=${site}&month=${month}${extra}`);

test('sales: invoiced in the month, what came in, and what is still owed, by customer', async () => {
  const [job] = await db('jobs').insert({ number: 'JOB-T-REP1', customer_id: customer.id, site_id: site, status: 'completed', created_by: managerId });
  await db('invoices').insert({ job_id: job, site_id: site, customer_id: customer.id, number: 'T-REP-1', status: 'issued', total: 116000, invoice_date: `${month}-01`, issued_at: new Date() });
  await db('payments').insert({ number: 'RCT-T-REP1', job_id: job, amount: 40000, method: 'mpesa', payer: 'client', paid_on: localDay(), received_by: managerId });
  const res = await page('sales');
  assert.equal(res.status, 200);
  assert.match(res.text, /KES 116,000\.00/);
  assert.match(res.text, /M-Pesa 40,000\.00/);
  assert.match(res.text, /Still owed on these[\s\S]*KES 76,000\.00/);
  assert.match(res.text, /Report Haulage/);
  assert.equal((await sales.get('/reports/sales')).status, 403, 'managers and admins only');
});

test('stock value: quantity × average cost, plates in sq ft, low stock marked', async () => {
  const category = (await db('item_categories').first('id')).id;
  const [plate] = await db('items').insert({ code: 'T-REP-1', name: 'Test report plate', category_id: category, priced_by: 'area', unit: 'sq ft', thickness_mm: 3, avg_cost: 90, on_hand_qty: 96, reorder_level: 200 });
  await db('stock_balances').insert({ site_id: site, item_id: plate, size_key: '8x4ft', quantity: 3, length: 8, width: 4, size_unit: 'ft', area_sq_ft: 32 });
  const res = await page('stock-value');
  assert.match(res.text, /Stock value[\s\S]*KES 8,640\.00/, '3 sheets × 32 sq ft × 90');
  assert.match(res.text, /3 × 8 × 4 ft/);
  assert.match(res.text, />Low</);
});

test('labour: approved payrolls paid in the month count as wages; purchases and the Excel download', async () => {
  const sat = (() => { const d = new Date(`${month}-01T12:00:00Z`); while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const mon = new Date(Date.parse(`${sat}T12:00:00Z`) - 5 * 86_400_000).toISOString().slice(0, 10);
  await db('payrolls').insert({ number: 'PAY-T-REP1', site_id: site, week_start: mon, pay_day: sat, status: 'approved', total: 42000, prepared_by: managerId });
  const res = await page('labour');
  assert.match(res.text, /Wages[\s\S]*KES 42,000\.00/);
  assert.match(res.text, /PAY-T-REP1/);
  assert.equal((await page('purchases')).status, 200);

  const xlsx = await manager.get(`/reports/sales.xlsx?site=${site}&month=${month}`);
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers['content-disposition'], new RegExp(`sales-${month}-TSTREP\\.xlsx`));
});
