import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { workDays, jobDays, jobCosting } from '../src/modules/costing/service.js';
import * as invoices from '../src/modules/invoices/service.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let admin, manager, supervisor, sales, customer, managerId, hq;

before(async () => {
  admin = await loginAs(app, await makeUser(81, ['admin']));
  manager = await loginAs(app, await makeUser(82, ['manager']));
  supervisor = await loginAs(app, await makeUser(83, ['supervisor']));
  sales = await loginAs(app, await makeUser(84, ['sales']));
  managerId = (await db('users').where({ phone: '+254700000082' }).first('id')).id;
  hq = await db('sites').where({ code: 'HQ' }).first();
  await post(sales, '/customers', { name: 'Costing Movers Ltd', phone: '0700000881' });
  customer = await db('customers').where({ phone: '+254700000881' }).first();
});

after(async () => {
  const ids = db('users').where('phone', 'like', '+25470000%').select('id');
  const days = await db('closed_days').whereIn('created_by', ids).pluck('id');
  await db('audit_log').where({ entity: 'closed_day' }).whereIn('entity_id', days).delete();
  await db('closed_days').whereIn('id', days).delete();
  // The sharing test's own site: its running costs, payrolls, jobs (and their invoices), then the site.
  const site = await db('sites').where({ code: 'TSTCST' }).first('id');
  if (site) {
    const jobIds = await db('jobs').where({ site_id: site.id }).pluck('id');
    await db('running_costs').where({ site_id: site.id }).delete();
    await db('payrolls').where({ site_id: site.id }).delete();
    const invoiceIds = await db('invoices').whereIn('job_id', jobIds).pluck('id');
    await db('audit_log').where({ entity: 'invoice' }).whereIn('entity_id', invoiceIds).delete();
    await db('invoices').whereIn('id', invoiceIds).delete();
    await db('audit_log').where({ entity: 'job' }).whereIn('entity_id', jobIds).delete();
    await db('jobs').whereIn('id', jobIds).delete();
    await db('user_sites').where({ site_id: site.id }).delete();
    await db('sites').where({ id: site.id }).delete();
  }
  await db('audit_log').where({ entity: 'running_costs' }).whereIn('user_id', ids).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const idOf = (location) => Number(location.split('/')[2]);

test('work days are Monday to Saturday, both ends counted, less closed days', () => {
  assert.equal(workDays('2026-11-16', '2026-11-22'), 6, 'Mon 16 to Sun 22 Nov: the Sunday is left out');
  assert.equal(workDays('2026-11-16', '2026-11-16'), 1, 'started and finished the same day');
  assert.equal(workDays('2026-11-22', '2026-11-22'), 0, 'a Sunday alone');
  assert.equal(workDays('2026-11-16', '2026-11-29'), 12, 'two weeks');
  assert.equal(workDays('2026-11-16', '2026-11-22', new Set(['2026-11-18'])), 5, 'a closed Wednesday');
});

test('admins list closed days for every site or one; the same day can’t be closed twice', async () => {
  assert.equal((await manager.get('/admin/closed-days')).status, 403);
  let res = await post(admin, '/admin/closed-days', { day: '2099-12-25', site_id: '', reason: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Say why it was closed/);
  res = await post(admin, '/admin/closed-days', { day: '2099-12-25', site_id: '', reason: 'Christmas Day' });
  assert.equal(res.status, 302);
  res = await post(admin, '/admin/closed-days', { day: '2099-12-25', site_id: String(hq.id), reason: 'Christmas again' });
  assert.equal(res.status, 422);
  assert.match(res.text, /already closed at every site/);
  res = await post(admin, '/admin/closed-days', { day: '2099-12-26', site_id: String(hq.id), reason: 'Boxing Day at HQ' });
  assert.equal(res.status, 302);
  res = await post(admin, '/admin/closed-days', { day: '2099-12-26', site_id: '', reason: 'Boxing Day' });
  assert.equal(res.status, 422);
  assert.match(res.text, /already closed at one site/);

  const page = (await admin.get('/admin/closed-days')).text;
  assert.match(page, /Christmas Day · Every site/);
  assert.match(page, /Boxing Day at HQ · /);
  const boxing = await db('closed_days').where({ day: '2099-12-26' }).first();
  await post(admin, `/admin/closed-days/${boxing.id}/delete`);
  assert.equal(await db('closed_days').where({ id: boxing.id }).first(), undefined);
});

test('a job’s work days run from start to completion (or today), less Sundays and the site’s closed days', async () => {
  const id = idOf((await post(supervisor, '/jobs', { customer_id: customer.id, line_description: ['Build a dropside'] })).headers.location);
  const job = () => db('jobs').where({ id }).first();
  assert.equal(await jobDays(await job()), null, 'not started yet');
  // Started Monday 2 Nov (08:00 Nairobi), completed Saturday 14 Nov 2026.
  await db('jobs').where({ id }).update({ status: 'completed', started_at: new Date('2026-11-02T05:00:00Z'), completed_at: new Date('2026-11-14T12:00:00Z') });
  assert.deepEqual(await jobDays(await job()), { from: '2026-11-02', to: '2026-11-14', days: 12, open: false });
  await db('closed_days').insert({ day: '2026-11-04', site_id: hq.id, reason: 'Test: power cut all day', created_by: managerId });
  await db('closed_days').insert({ day: '2026-11-05', site_id: hq.id + 1000, reason: 'Test: another site', created_by: managerId }).catch(() => {});
  assert.equal((await jobDays(await job())).days, 11, 'HQ’s closed day is left out; another site’s isn’t');
  const open = await jobDays({ ...(await job()), completed_at: null }, '2026-11-16');
  assert.deepEqual(open, { from: '2026-11-02', to: '2026-11-16', days: 12, open: true }, 'an open job counts to today');
});

test('managers see what a job earned: price without VAT, materials, gross profit; the workshop and sales don’t', async () => {
  const id = idOf((await post(supervisor, '/jobs', { customer_id: customer.id, line_description: ['Tipper body'] })).headers.location);
  let page = (await manager.get(`/jobs/${id}`)).text;
  assert.match(page, /Job costing/);
  assert.match(page, /No price yet/);

  await invoices.createInvoice(id, { financier_id: null, notes: null, lines: [{ quantity: 1, unit: 'Unit', description: 'Tipper body', unit_price: 116000, amount: 116000 }] }, { user: { id: managerId } });
  page = (await manager.get(`/jobs/${id}`)).text;
  assert.match(page, /KES 100,000\.00/, 'KES 116,000 with VAT is 100,000 without');
  assert.match(page, /From the draft invoice: KES 116,000\.00 with VAT/);
  assert.match(page, /Gross profit<\/dt><dd class="jt-num">KES 100,000\.00/);
  assert.match(page, /100% margin/);
  assert.match(page, /Work days, wages and running costs start counting when the job is started/);

  assert.doesNotMatch((await supervisor.get(`/jobs/${id}`)).text, /Job costing/);
  assert.doesNotMatch((await sales.get(`/jobs/${id}`)).text, /Job costing/);
  assert.match((await admin.get(`/jobs/${id}`)).text, /Job costing/);
});

test('wages (approved weekly payroll) and running costs (monthly) are shared across a site’s jobs by work days', async () => {
  const [siteId] = await db('sites').insert({ code: 'TSTCST', name: 'Test Costing Site' });
  const insertJob = async (number, from, to) => (await db('jobs').insert({ number, customer_id: customer.id, site_id: siteId, status: 'completed',
    started_at: new Date(`${from}T05:00:00Z`), completed_at: new Date(`${to}T12:00:00Z`), created_by: managerId }))[0];
  const a = await insertJob('JOB-T-CST1', '2026-09-07', '2026-09-12'); // Mon–Sat: 6 days
  const b = await insertJob('JOB-T-CST2', '2026-09-07', '2026-09-09'); // Mon–Wed: 3 days
  const c = await insertJob('JOB-T-CST3', '2026-09-14', '2026-09-15'); // the next week: 2 days, no approved payroll
  await db('payrolls').insert([
    { number: 'PAY-T-CST1', site_id: siteId, week_start: '2026-09-07', pay_day: '2026-09-12', status: 'approved', total: 18000, prepared_by: managerId },
    { number: 'PAY-T-CST2', site_id: siteId, week_start: '2026-09-14', pay_day: '2026-09-19', status: 'draft', total: 50000, prepared_by: managerId },
  ]);

  // Running costs are entered on the page, at the site chosen at the top.
  const csrf = csrfFrom((await manager.get('/')).text);
  await manager.post('/account/site').type('form').send({ _csrf: csrf, site_id: siteId });
  assert.equal((await supervisor.get('/costing/running-costs')).status, 403);
  let res = await post(manager, '/costing/running-costs', { month: '2026-09', amount_electricity: '6,000', amount_rent: '5000', amount_other: '1000' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Say what the other cost was/);
  res = await post(manager, '/costing/running-costs', { month: '2026-09', amount_electricity: '6,000', note_electricity: 'KPLC', amount_rent: '5000', amount_other: '', amount_water: 'abc' });
  assert.equal(res.status, 422);
  res = await post(manager, '/costing/running-costs', { month: '2026-09', amount_electricity: '6,000', note_electricity: 'KPLC', amount_rent: '5000' });
  assert.equal(res.status, 302);
  const page = (await manager.get('/costing/running-costs?month=2026-09')).text;
  assert.match(page, /Test Costing Site/);
  assert.match(page, /Work days on jobs<\/dt><dd class="jt-num">11/);
  assert.match(page, /Per job-day<\/dt><dd class="jt-num">KES 1,000\.00/, '11,000 over 6 + 3 + 2 job-days');

  const costOf = async (id) => jobCosting(await db('jobs').where({ id }).first());
  const ca = await costOf(a);
  assert.equal(ca.running.amount, 6000, '6 days × 1,000');
  assert.equal(ca.wages.amount, 12000, 'the week’s 18,000 payroll over 9 job-days: 6 × 2,000');
  assert.deepEqual(ca.wages.missing, []);
  const cb = await costOf(b);
  assert.equal(cb.running.amount, 3000);
  assert.equal(cb.wages.amount, 6000);
  const cc = await costOf(c);
  assert.equal(cc.running.amount, 2000);
  assert.equal(cc.wages.amount, 0, 'a draft payroll isn’t counted');
  assert.deepEqual(cc.wages.missing, ['2026-09-14']);

  // With a price: net profit = price without VAT − materials − wages − running costs.
  await invoices.createInvoice(a, { financier_id: null, notes: null, lines: [{ quantity: 1, unit: 'Unit', description: 'Canopy', unit_price: 58000, amount: 58000 }] }, { user: { id: managerId } });
  const priced = await costOf(a);
  assert.equal(priced.price.exVat, 50000);
  assert.equal(priced.net, 32000, '50,000 − 0 − 12,000 − 6,000');
  assert.equal(priced.netMargin, 64);
  const job = (await manager.get(`/jobs/${a}`)).text;
  assert.match(job, /Wages, its share/);
  assert.match(job, /Net profit<\/dt><dd class="jt-num">KES 32,000\.00/);

  // October has no running costs entered yet: a job then says so.
  await db('jobs').where({ id: c }).update({ completed_at: new Date('2026-10-02T12:00:00Z') });
  assert.deepEqual((await costOf(c)).running.missing, ['2026-10']);
  assert.match((await manager.get(`/jobs/${c}`)).text, /Not entered for October 2026/);

  // The report: jobs completed in September at this site, and the Excel download.
  const report = (await manager.get(`/reports/job-costing?month=2026-09&site=${siteId}`)).text;
  assert.match(report, /JOB-T-CST1/);
  assert.match(report, /JOB-T-CST2/);
  assert.doesNotMatch(report, /JOB-T-CST3/, 'completed in October now');
  assert.match(report, /no price yet/);
  const xlsx = await manager.get(`/reports/job-costing.xlsx?month=2026-09&site=${siteId}`);
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers['content-disposition'], /job-costing-2026-09-TSTCST\.xlsx/);
  assert.equal((await sales.get('/reports/job-costing')).status, 403);
});
