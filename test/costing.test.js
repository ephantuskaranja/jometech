import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { workDays, jobDays } from '../src/modules/costing/service.js';
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
  assert.match(page, /Work days start counting when the job is started/);

  assert.doesNotMatch((await supervisor.get(`/jobs/${id}`)).text, /Job costing/);
  assert.doesNotMatch((await sales.get(`/jobs/${id}`)).text, /Job costing/);
  assert.match((await admin.get(`/jobs/${id}`)).text, /Job costing/);
});
