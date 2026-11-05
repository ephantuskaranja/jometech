import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { periodOf } from '../src/modules/reports/service.js';
import { makeUser, loginAs, cleanup } from './helpers.js';

const app = createApp();
let admin, manager, supervisor, storekeeper, hq, siteB, done, late, bolt, issueId;

const daysAgo = (n) => localDay(new Date(Date.now() - n * 86_400_000));

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  siteB = await db('sites').where({ code: 'SITEB' }).first();
  admin = await loginAs(app, await makeUser(85, ['admin']));
  manager = await loginAs(app, await makeUser(86, ['manager']));
  supervisor = await loginAs(app, await makeUser(87, ['supervisor']));
  storekeeper = await loginAs(app, await makeUser(88, ['storekeeper']));

  const [customerId] = await db('customers').insert({ number: 'CUS-T885', name: 'Test Summary Haulier', phone: '+254700000885', category: 'individual' });
  const job = async (fields) => (await db('jobs').where({ id: (await db('jobs').insert({ site_id: hq.id, customer_id: customerId, ...fields }))[0] }).first());
  done = await job({ number: 'JOB-2026-8885', status: 'completed', started_at: new Date(Date.now() - 3 * 86_400_000), completed_at: new Date(), due_on: daysAgo(1) });
  late = await job({ number: 'JOB-2026-8886', status: 'in_progress', started_at: new Date(), due_on: daysAgo(2), vehicle_description: 'Test FRR tipper' });
  await db('audit_log').insert([
    { entity: 'job', entity_id: done.id, action: 'job_completed' },
    { entity: 'job', entity_id: late.id, action: 'step_done', summary: 'Test welding' },
  ]);

  const category = await db('item_categories').first('id');
  [bolt] = await db('items').insert({ code: 'ITM-T885', name: 'Test Summary U-bolt', category_id: category.id, unit: 'Pc', reorder_level: 10, on_hand_qty: 2 });
  [issueId] = await db('material_issues').insert({ number: 'ISS-2026-8885', job_id: late.id, site_id: hq.id, issued_on: localDay() });
  await db('material_issue_lines').insert({ issue_id: issueId, item_id: bolt, quantity: 4, stock_qty: 4, unit_cost: 1250, value: 5000 });
});

after(async () => {
  await db('material_issues').where({ id: issueId }).delete(); // lines go with it
  await db('items').where({ id: bolt }).delete();
  await cleanup();
});

test('only admins and managers see the summary, and it is in their menu', async () => {
  assert.match((await admin.get('/reports/summary').expect(200)).text, /Summary · /);
  assert.match((await manager.get('/').expect(200)).text, /href="\/reports\/summary"/);
  await supervisor.get('/reports/summary').expect(403);
  await storekeeper.get('/reports/summary.xlsx').expect(403);
  assert.doesNotMatch((await supervisor.get('/').expect(200)).text, /href="\/reports\/summary"/);
});

test('today: what changed, what was completed (late), what is overdue, what was issued', async () => {
  const page = (await manager.get('/reports/summary').expect(200)).text;
  assert.match(page, /JOB-2026-8885/);
  assert.match(page, /Test welding/, 'the step that was done');
  assert.match(page, />Late</, 'completed after its due date');
  assert.match(page, /Test FRR tipper/, 'overdue now, with its vehicle');
  assert.match(page, /Test Summary U-bolt <span class="text-body-secondary">· 4 Pc/);
  assert.match(page, /5,000\.00/);
  assert.match(page, /Test Summary U-bolt<\/a>/, 'low stock now');
});

test('another period or site leaves out what happened today, but “now” sections stay', async () => {
  const yesterday = (await manager.get('/reports/summary?period=yesterday').expect(200)).text;
  assert.doesNotMatch(yesterday, /JOB-2026-8885/);
  assert.match(yesterday, /JOB-2026-8886/, 'still overdue now');
  const atSiteB = (await manager.get(`/reports/summary?site=${siteB.id}`).expect(200)).text;
  assert.doesNotMatch(atSiteB, /JOB-2026-888[56]/);
  assert.match(atSiteB, /Summary · .*[\s\S]*Site B/);
});

test('the Excel download has a sheet per section', async () => {
  const res = await manager.get('/reports/summary.xlsx?period=week')
    .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); })
    .expect(200);
  assert.match(res.headers['content-type'], /spreadsheetml/);
  assert.match(res.headers['content-disposition'], /summary-.*\.xlsx/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.body);
  assert.deepEqual(book.worksheets.map((w) => w.name).slice(0, 4), ['Summary', 'Job changes', 'Jobs completed', 'Overdue now']);
  const values = (name) => book.getWorksheet(name).getSheetValues().flat().map(String);
  assert.ok(values('Jobs completed').includes('JOB-2026-8885'));
  assert.ok(values('Issued to jobs').includes('Test Summary U-bolt'));
});

test('periods: weeks start on Monday; chosen dates are put in order and stop at today', () => {
  const thu = '2026-11-05';
  assert.deepEqual([periodOf({ period: 'week' }, thu).from, periodOf({ period: 'week' }, thu).to], ['2026-11-02', thu]);
  assert.deepEqual([periodOf({ period: 'month' }, thu).from], ['2026-11-01']);
  const last = periodOf({ period: 'last_month' }, '2026-03-15');
  assert.deepEqual([last.from, last.to], ['2026-02-01', '2026-02-28']);
  const custom = periodOf({ period: 'custom', from: '2026-11-04', to: '2026-10-01' }, thu);
  assert.deepEqual([custom.from, custom.to], ['2026-10-01', '2026-11-04']);
  const future = periodOf({ period: 'custom', from: '2026-11-01', to: '2027-01-01' }, thu);
  assert.equal(future.to, thu);
  assert.equal(periodOf({ period: 'nonsense' }, thu).key, 'today');
  assert.equal(periodOf({ period: 'custom', from: '2020-01-01', to: thu }, thu).from, '2025-11-05', 'a year at most');
});
