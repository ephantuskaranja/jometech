import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import * as invoices from '../src/modules/invoices/service.js';
import { getJob } from '../src/modules/jobs/service.js';
import { makeUser, loginAs, csrfFrom, cleanup, checkedInVehicle } from './helpers.js';

const app = createApp();
let manager, supervisor, sales, customer, managerId, jobId;

before(async () => {
  manager = await loginAs(app, await makeUser(91, ['manager']));
  supervisor = await loginAs(app, await makeUser(92, ['supervisor']));
  sales = await loginAs(app, await makeUser(93, ['sales']));
  managerId = (await db('users').where({ phone: '+254700000091' }).first('id')).id;
  await post(sales, '/customers', { name: 'Variation Hauliers', phone: '0700000891' });
  customer = await db('customers').where({ phone: '+254700000891' }).first();
  // A job from an accepted proforma of KES 100,000.
  const res = await post(sales, '/proformas', { customer_id: customer.id, proforma_date: localDay(), line_description: ['Dropside body'], line_price: ['100000'] });
  const proformaId = Number(res.headers.location.split('/')[2]);
  await post(sales, `/proformas/${proformaId}/send`);
  await post(sales, `/proformas/${proformaId}/accept`);
  await post(sales, `/proformas/${proformaId}/job`, { vehicle_id: await checkedInVehicle(customer.id, 'KJR 601A') });
  jobId = (await db('jobs').where({ proforma_id: proformaId }).first('id')).id;
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const add = (agent, fields) => post(agent, `/jobs/${jobId}/variations`, { quantity: '1', unit: 'Unit', agreed_by: 'Peter Mwangi', agreed_on: localDay(), ...fields });
const list = () => db('job_variations').where({ job_id: jobId }).orderBy('seq');

test('sales record extra work with its price and who agreed it; the workshop sees the work, not the price', async () => {
  assert.equal((await add(supervisor, { description: 'Toolbox', unit_price: '5800' })).status, 403);
  let res = await add(sales, { description: 'Toolbox on the left', unit_price: '' });
  assert.equal(res.status, 302);
  assert.equal((await list()).length, 0, 'no price: not saved');
  res = await add(sales, { description: 'Toolbox on the left', unit_price: '5800', agreed_on: '2099-01-01' });
  assert.equal((await list()).length, 0, 'agreed in the future: not saved');

  res = await add(sales, { description: 'Toolbox on the left', quantity: '2', unit: 'Pc', unit_price: '5,800' });
  assert.equal(res.headers.location, `/jobs/${jobId}#variations`);
  const [v1] = await list();
  assert.equal(v1.seq, 1);
  assert.equal(Number(v1.amount), 11600);

  const salesPage = (await sales.get(`/jobs/${jobId}`)).text;
  assert.match(salesPage, /V1<\/span>/);
  assert.match(salesPage, /KES 11,600\.00/);
  const floor = (await supervisor.get(`/jobs/${jobId}`)).text;
  assert.match(floor, /2 Pc: Toolbox on the left/);
  assert.doesNotMatch(floor, /11,600/, 'no price for the workshop');
  assert.doesNotMatch(floor, /Add extra work/);
  assert.match((await supervisor.get(`/jobs/${jobId}/print`)).text, /V1:<\/strong> <span style="white-space: pre-line">Toolbox on the left/, 'on the job card');

  const due = await invoices.amountDue(jobId);
  assert.equal(due.total, 111600, 'before an invoice, payments are checked against the proforma plus variations');
  assert.match(due.against, /and variations/);
});

test('the invoice includes agreed variations; a draft follows changes; an issued invoice must be redone', async () => {
  const job = await getJob(jobId);
  const lines = await invoices.startFor(job);
  assert.deepEqual(lines.map((l) => l.description), ['Dropside body', 'Variation V1: Toolbox on the left']);
  const { id } = await invoices.createInvoice(jobId, { financier_id: null, notes: null, lines: lines.map((l) => ({ ...l, amount: l.quantity * l.unit_price })) }, { user: { id: managerId } });
  assert.equal(Number((await db('invoices').where({ id }).first()).total), 111600);

  await add(sales, { description: 'Mud flaps', unit_price: '3000' });
  assert.equal(Number((await db('invoices').where({ id }).first()).total), 114600, 'the draft gets V2 at once');
  const v2 = (await list())[1];
  let res = await post(sales, `/jobs/${jobId}/variations/${v2.id}/cancel`, { reason: '' });
  assert.equal((await db('job_variations').where({ id: v2.id }).first()).status, 'agreed', 'a reason is needed');
  await post(sales, `/jobs/${jobId}/variations/${v2.id}/cancel`, { reason: 'Customer changed their mind' });
  assert.equal((await db('job_variations').where({ id: v2.id }).first()).status, 'cancelled');
  assert.equal(Number((await db('invoices').where({ id }).first()).total), 111600, 'and loses it on cancelling');
  assert.match((await sales.get(`/jobs/${jobId}`)).text, /Cancelled: Customer changed their mind/);

  await invoices.issueInvoice(id, { user: { id: managerId } });
  res = await add(sales, { description: 'Reflectors', unit_price: '1500' });
  assert.equal(res.status, 302);
  const page = (await sales.get(`/jobs/${jobId}`)).text;
  assert.match(page, /V3/);
  const v1 = (await list())[0];
  res = await post(sales, `/jobs/${jobId}/variations/${v1.id}/cancel`, { reason: 'Not wanted' });
  assert.equal(res.status, 409, 'an issued invoice counts it');
  assert.match(res.text, /Cancel the invoice first/);
});
