import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { config } from '../src/config.js';
import { fileTitle } from '../src/modules/invoices/routes.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let manager, sales, customer, bank, vehicle, job, plainJob;
// No invoice issued yet on this database: the first one gets INVOICE_FIRST_NUMBER.
const fresh = !(await db('number_sequences').where({ seq_key: 'INV' }).first());

before(async () => {
  manager = await loginAs(app, await makeUser(95, ['manager']));
  sales = await loginAs(app, await makeUser(96, ['sales']));
  const csrf = csrfFrom((await manager.get('/customers/new')).text);
  await manager.post('/customers').type('form').send({ _csrf: csrf, name: 'Mike Test Wandeme', phone: '0700000831', address: 'P.O. Box 1-00100', town: 'Nairobi' });
  await manager.post('/customers').type('form').send({ _csrf: csrf, name: 'Test Co-operative Bank', phone: '0700000832', category: 'company', address: 'P.O. Box 48231-00100', town: 'Nairobi' });
  customer = await db('customers').where({ phone: '+254700000831' }).first();
  bank = await db('customers').where({ phone: '+254700000832' }).first();
  await manager.post('/vehicles').type('form').send({ _csrf: csrf, reg_no: 'KEA 831C', chassis_no: 'JALFRR90NR7005831', engine_no: '1hu 831', customer_id: customer.id, type: 'truck', make: 'Isuzu' });
  vehicle = await db('vehicles').where({ reg_no: 'KEA 831C' }).first();

  const hq = await db('sites').where({ code: 'HQ' }).first();
  const [proformaId] = await db('proformas').insert({ number: 'T831', base_no: 999831, customer_id: customer.id, vehicle_id: vehicle.id, proforma_date: localDay(), status: 'accepted', total: 480000 });
  await db('proforma_lines').insert({ proforma_id: proformaId, sort_order: 1, quantity: 1, unit: 'Unit', description: 'Open body on Isuzu FRR chassis', unit_price: 480000, amount: 480000 });
  [job] = await db('jobs').insert({ number: 'JOB-2026-8831', site_id: hq.id, customer_id: customer.id, vehicle_id: vehicle.id, proforma_id: proformaId, status: 'completed', completed_at: new Date() });
  await db('job_lines').insert({ job_id: job, sort_order: 1, quantity: 1, unit: 'Unit', description: 'Open body on Isuzu FRR chassis' });
  [plainJob] = await db('jobs').insert({ number: 'JOB-2026-8832', site_id: hq.id, customer_id: customer.id, status: 'in_progress', started_at: new Date() });
  await db('job_lines').insert({ job_id: plainJob, sort_order: 1, quantity: 2, unit: 'Pc', description: 'Test mudguards' });
});
after(cleanup);

async function post(url, fields) {
  const csrf = csrfFrom((await manager.get('/invoices')).text);
  return manager.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const lines = (description, price) => ({ line_quantity: ['1'], line_unit: ['Unit'], line_description: [description], line_price: [price] });
const idOf = (location) => Number(location.split('/')[2]);
const current = () => db('invoices').where({ job_id: job }).whereNot('status', 'cancelled').first();

test('only admins and managers invoice; sales no longer can', async () => {
  await sales.get('/invoices').expect(403);
  await sales.get(`/jobs/${job}/invoice`).expect(403);
  assert.doesNotMatch((await sales.get(`/jobs/${job}`)).text, /Make the invoice/);
  assert.match((await manager.get('/')).text, /href="\/invoices"/);
  assert.match((await manager.get(`/jobs/${job}`)).text, /Make the invoice/);
});

test('a new invoice starts from the proforma: lines and prices, or the job’s work without prices', async () => {
  const page = (await manager.get(`/jobs/${job}/invoice`).expect(200)).text;
  assert.match(page, /Open body on Isuzu FRR chassis/);
  assert.match(page, /480000/);
  const plain = (await manager.get(`/jobs/${plainJob}/invoice`).expect(200)).text;
  assert.match(plain, /Test mudguards/);
  assert.match(plain, /Enter the prices/);
  const res = await post(`/jobs/${plainJob}/invoice`, lines('Test mudguards', ''));
  assert.equal(res.status, 422);
  assert.match(res.text, /Line 1: enter the price/);
});

test('draft (no number) → edit → issue: numbered, dated today and locked; one invoice per job', async () => {
  let res = await post(`/jobs/${job}/invoice`, { financier_id: customer.id, ...lines('Open body on Isuzu FRR chassis', '480,000') });
  assert.equal(res.status, 422, 'the bank can’t be the customer');
  res = await post(`/jobs/${job}/invoice`, { financier_id: bank.id, ...lines('Open body on Isuzu FRR chassis', '480,000') });
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  let inv = await db('invoices').where({ id }).first();
  assert.equal(inv.number, null);
  assert.equal(inv.status, 'draft');
  assert.equal(Number(inv.total), 480000);

  assert.equal((await manager.get(`/jobs/${job}/invoice`)).headers.location, `/invoices/${id}`, 'opens the one it has');
  assert.equal((await post(`/jobs/${job}/invoice`, lines('Again', '1'))).status, 409);

  res = await post(`/invoices/${id}`, { financier_id: bank.id, ...lines('Open body on Isuzu FRR chassis', '480,000'), line_quantity: ['1', '1'], line_unit: ['Unit', 'Unit'],
    line_description: ['Open body on Isuzu FRR chassis', 'Extra: test toolbox'], line_price: ['480,000', '15,000'] });
  assert.equal(res.status, 302, res.text);
  assert.equal(Number((await db('invoices').where({ id }).first()).total), 495000);

  await post(`/invoices/${id}/issue`, {});
  inv = await db('invoices').where({ id }).first();
  assert.equal(inv.status, 'issued');
  assert.match(inv.number, /^\d+$/);
  if (fresh) assert.equal(inv.number, String(config.invoiceFirstNumber));
  assert.equal(inv.invoice_date, localDay());
  await manager.get(`/invoices/${id}/edit`).expect(409);
  assert.equal((await post(`/invoices/${id}/delete`, {})).status, 409, 'an issued invoice is cancelled, not deleted');
});

test('payments: deposit from the client, the rest from the bank; a mistake is voided, not deleted', async () => {
  const inv = await current();
  let res = await post(`/jobs/${job}/payments`, { amount: '0', method: 'mpesa', paid_on: localDay(), back: `/invoices/${inv.id}` });
  assert.equal(res.headers.location, `/invoices/${inv.id}`);
  assert.equal(await db('payments').where({ job_id: job }).count({ n: '*' }).then(([r]) => Number(r.n)), 0, 'nothing saved for 0');
  await post(`/jobs/${job}/payments`, { amount: '100', method: 'cash', paid_on: '2099-01-01' });
  assert.equal(await db('payments').where({ job_id: job }).count({ n: '*' }).then(([r]) => Number(r.n)), 0, 'nor for a future date');

  await post(`/jobs/${job}/payments`, { amount: '95,000', method: 'mpesa', reference: 'TST831ABC', payer: 'client', paid_on: localDay() });
  await post(`/jobs/${job}/payments`, { amount: '95,000', method: 'mpesa', reference: 'TST831ABC', payer: 'client', paid_on: localDay() });
  const twice = await db('payments').where({ job_id: job }).orderBy('id', 'desc').first();
  assert.match(twice.number, /^RCT-\d{4}-\d{4}$/);
  res = await post(`/payments/${twice.id}/void`, { reason: 'Entered twice', back: `/jobs/${job}` });
  assert.equal(res.headers.location, `/jobs/${job}`);
  assert.ok((await db('payments').where({ id: twice.id }).first()).voided_at);

  let page = (await manager.get(`/invoices/${inv.id}`)).text;
  assert.match(page, /Part paid/);
  assert.match(page, /400,000\.00/, 'balance after the deposit');
  assert.match(page, /Voided: Entered twice/);

  await post(`/jobs/${job}/payments`, { amount: '400,000', method: 'bank', reference: 'COOP-831', payer: 'financier', paid_on: localDay() });
  page = (await manager.get(`/invoices/${inv.id}`)).text;
  assert.match(page, />Paid</);
  const list = (await manager.get('/invoices?show=paid')).text;
  assert.match(list, new RegExp(`>${inv.number}<`));
  assert.doesNotMatch((await manager.get('/invoices?show=unpaid')).text, new RegExp(`>${inv.number}<`));
});

test('the printed invoice is like the paper one: customer & bank, vehicle numbers, deposit, eTIMS', async () => {
  const inv = await current();
  await post(`/invoices/${inv.id}/etims`, { etims_number: 'kra0831x' });
  assert.equal((await current()).etims_number, 'KRA0831X');
  const print = (await manager.get(`/invoices/${inv.id}/print`).expect(200)).text;
  assert.match(print, new RegExp(`>Invoice ${inv.number}<`));
  assert.match(print, new RegExp(`<title>Invoice ${inv.number} - Mike Test Wandeme &amp; Test Co-operative Bank</title>`), 'the PDF’s file name');
  assert.match(print, /Mike Test Wandeme &amp; Test Co-operative Bank/);
  assert.match(print, /P\.O\. Box 48231-00100/, 'the bank’s address');
  assert.match(print, /Chassis no: JALFRR90NR7005831/);
  assert.match(print, /Engine no: 1HU831/);
  assert.match(print, /Registration no: KEA 831C/);
  assert.match(print, /Deposit paid by client<\/td><th>95,000/);
  assert.match(print, /Amount payable by Test Co-operative Bank<\/th><th>NIL/);
  assert.match(print, /KRA eTIMS invoice no: <strong>KRA0831X/);
  assert.match(print, /01100210891001/, 'bank details');
});

test('the PDF’s file name stays short and has only characters a file name can have', () => {
  const long = 'A'.repeat(150);
  assert.ok(fileTitle({ number: '105', customer_name: long, financier_name: long }).length <= 110);
  assert.ok(fileTitle({ number: '105', customer_name: long }).length <= 110);
  assert.equal(fileTitle({ number: '106', customer_name: 'Smith/Jones "Haulage" Ltd', financier_name: null }), 'Invoice 106 - Smith Jones Haulage Ltd');
  assert.equal(fileTitle({ number: null, customer_name: 'Komu', financier_name: 'NCBA' }), 'Invoice draft - Komu & NCBA');
});

test('cancelling needs a reason; the job can then be invoiced again and keeps its payments', async () => {
  const inv = await current();
  await post(`/invoices/${inv.id}/cancel`, { reason: '' });
  assert.equal((await db('invoices').where({ id: inv.id }).first()).status, 'issued');
  await post(`/invoices/${inv.id}/cancel`, { reason: 'Test: wrong price' });
  assert.equal((await db('invoices').where({ id: inv.id }).first()).status, 'cancelled');
  assert.match((await manager.get(`/jobs/${job}`)).text, /Make the invoice/);
  const res = await post(`/jobs/${job}/invoice`, lines('Open body on Isuzu FRR chassis', '480,000'));
  assert.equal(res.status, 302);
  const page = (await manager.get(res.headers.location)).text;
  assert.match(page, new RegExp(`Replaces cancelled <a href="/invoices/${inv.id}">invoice ${inv.number}`));
  assert.match(page, /495,000\.00/, 'paid so far: the payments stayed on the job');
  // A draft can just be deleted.
  await post(`/invoices/${idOf(res.headers.location)}/delete`, {});
  assert.equal(await current(), undefined);
});

test('the period summary shows invoices issued and payments received', async () => {
  const page = (await manager.get('/reports/summary').expect(200)).text;
  assert.match(page, /Invoices issued/);
  assert.match(page, /TST831ABC/, 'the M-Pesa payment');
  assert.match(page, /COOP-831/, 'the bank payment');
  assert.doesNotMatch(page, /TST831ABC[\s\S]*TST831ABC/, 'the voided one is left out');
});

test('the bank list holds banks and banks already used on invoices, not other customers', async () => {
  const csrf = csrfFrom((await manager.get('/invoices')).text);
  const added = await manager.post('/api/customers').set('x-csrf-token', csrf)
    .send({ name: 'Test Equity Bank', phone: '0700000833', category: 'bank' }).expect(201);
  const all = (await manager.get('/api/banks').expect(200)).body.map((o) => o.label);
  assert.ok(all.some((l) => l.startsWith('Test Equity Bank')), 'a Bank / Financier customer');
  assert.ok(all.some((l) => l.startsWith('Test Co-operative Bank')), 'saved as a company, but already the bank on an invoice');
  assert.ok(!all.some((l) => l.startsWith('Mike Test Wandeme')), 'an ordinary customer is not a bank');
  const typed = (await manager.get('/api/banks?q=Test%20Equity').expect(200)).body;
  assert.deepEqual(typed.map((o) => o.value), [added.body.value]);
});
