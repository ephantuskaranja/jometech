import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { forPeriod } from '../src/modules/invoices/service.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

// A customer paid more than invoiced on one job; that credit goes towards the next job.

const app = createApp();
let manager, customer, oldJob, newJob, otherJob;

before(async () => {
  manager = await loginAs(app, await makeUser(95, ['manager']));
  const csrf = csrfFrom((await manager.get('/customers/new')).text);
  await manager.post('/customers').type('form').send({ _csrf: csrf, name: 'Test Credit Customer', phone: '0700000841' });
  customer = await db('customers').where({ phone: '+254700000841' }).first();
  const hq = await db('sites').where({ code: 'HQ' }).first();
  const job = async (number, total) => {
    const [id] = await db('jobs').insert({ number, site_id: hq.id, customer_id: customer.id, status: 'in_progress', started_at: new Date() });
    await db('job_lines').insert({ job_id: id, sort_order: 1, quantity: 1, unit: 'Unit', description: 'Test work' });
    if (total) {
      await db('invoices').insert({ job_id: id, customer_id: customer.id, site_id: hq.id, status: 'draft', total, invoice_date: localDay() });
    }
    return id;
  };
  oldJob = await job('JOB-2026-8841', 100000);
  newJob = await job('JOB-2026-8842', 50000);
  otherJob = await job('JOB-2026-8843', null); // no invoice: nothing to put credit against
});
after(cleanup);

async function post(url, fields) {
  const csrf = csrfFrom((await manager.get('/invoices')).text);
  return manager.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const pay = (jobId, amount, extra = {}) => post(`/jobs/${jobId}/payments`, { amount, method: 'mpesa', payer: 'client', paid_on: localDay(), reference: '', notes: '', ...extra });
const paid = async (jobId) => Number((await db('payments').where({ job_id: jobId }).whereNull('voided_at').sum({ s: 'amount' }).first()).s ?? 0);

test('nothing is offered while the customer has no credit', async () => {
  const page = (await manager.get(`/jobs/${newJob}`)).text;
  assert.doesNotMatch(page, /Use credit/);
});

test('credit from an overpaid job is offered on the next one, and used', async () => {
  await pay(oldJob, '130000', { confirm_excess: '1', excess_reason: 'Deposit for the next job' });
  assert.equal(await paid(oldJob), 130000);

  const page = (await manager.get(`/jobs/${newJob}`)).text;
  assert.match(page, /The customer has KES 30,000\.00 of credit/);
  assert.match(page, /JOB-2026-8841/);
  assert.match(page, /value="30,000\.00"/, 'offers all of it: less than is owed');

  // Not more than the credit, nor more than is owed.
  await post(`/jobs/${newJob}/payments/credit`, { amount: '40000' });
  assert.equal(await paid(newJob), 0);
  await post(`/jobs/${otherJob}/payments/credit`, { amount: '1000' });
  assert.equal(await paid(otherJob), 0, 'no invoice there');

  const res = await post(`/jobs/${newJob}/payments/credit`, { amount: '30,000' });
  assert.equal(res.status, 302);
  assert.equal(await paid(newJob), 30000);
  assert.equal(await paid(oldJob), 100000, 'the old job is now paid exactly');
  const [minus, plus] = await db('payments').whereIn('job_id', [oldJob, newJob]).where({ method: 'credit' }).orderBy('id');
  assert.equal(Number(minus.amount), -30000);
  assert.equal(plus.linked_payment_id, minus.id);
  assert.equal(minus.linked_payment_id, plus.id);
  assert.match(plus.notes, /Credit from JOB-2026-8841/);

  const after = (await manager.get(`/jobs/${newJob}`)).text;
  assert.doesNotMatch(after, /Use credit/, 'none left');
  assert.match(after, /From the customer’s credit/);
  assert.equal((await manager.get(`/customers/${customer.id}`)).text.includes('Credit held'), false);

  // Not money received: left out of the period's payments.
  const period = await forPeriod({ start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000), from: localDay(), to: localDay() }, null);
  assert.ok(!period.received.some((p) => p.method === 'credit'));
});

test('voiding either half of a credit move voids both', async () => {
  const plus = await db('payments').where({ job_id: newJob, method: 'credit' }).first();
  await post(`/payments/${plus.id}/void`, { reason: 'Customer wants a refund instead', back: `/jobs/${newJob}` });
  assert.equal(await paid(newJob), 0);
  assert.equal(await paid(oldJob), 130000, 'the credit is back on the old job');
  assert.match((await manager.get(`/jobs/${newJob}`)).text, /The customer has KES 30,000\.00 of credit/);
});
