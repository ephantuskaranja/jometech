import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { config } from '../src/config.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let sales, supervisor, customer, other, vehicle;
// No proforma made yet on this database: the first one gets PROFORMA_FIRST_NUMBER.
const fresh = !(await db('number_sequences').where({ seq_key: 'PF' }).first());

before(async () => {
  sales = await loginAs(app, await makeUser(93, ['sales']));
  supervisor = await loginAs(app, await makeUser(94, ['supervisor']));
  const csrf = csrfFrom((await sales.get('/customers/new')).text);
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Komu Water Services', phone: '0700000801', town: 'Nakuru' });
  await sales.post('/customers').type('form').send({ _csrf: csrf, name: 'Otieno Farms', phone: '0700000802' });
  customer = await db('customers').where({ phone: '+254700000801' }).first();
  other = await db('customers').where({ phone: '+254700000802' }).first();
  await sales.post('/vehicles').type('form').send({ _csrf: csrf, reg_no: 'KZW 801A', customer_id: customer.id, type: 'truck', make: 'Sinotruk' });
  vehicle = await db('vehicles').where({ reg_no: 'KZW 801A' }).first();
});
after(cleanup);

async function post(url, fields) {
  const csrf = csrfFrom((await sales.get('/proformas')).text);
  return sales.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const bowser = {
  line_quantity: ['1', ''], line_unit: ['Unit', 'Unit'],
  line_description: ['Fabrication of 10,000-litre water bowser tank\n- Toolbox\n- Battery cover', ''],
  line_price: ['800,000', ''],
};
const idOf = (location) => Number(location.split('/')[2]);

test('only sales and managers make proformas', async () => {
  await supervisor.get('/proformas').expect(403);
  await sales.get('/proformas').expect(200);
});

test('a proforma needs a customer and at least one priced line; numbers continue the paper ones', async () => {
  let res = await post('/proformas', { customer_id: '', proforma_date: localDay(), line_description: ['Tipper body'], line_price: [''] });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the customer/);
  assert.match(res.text, /Line 1: enter the price/);

  res = await post('/proformas', { customer_id: customer.id, vehicle_id: vehicle.id, proforma_date: localDay(), ...bowser });
  assert.equal(res.status, 302, res.text);
  const p = await db('proformas').where({ id: idOf(res.headers.location) }).first();
  assert.match(p.number, /^\d+$/, 'a plain number like 490');
  if (fresh) assert.equal(p.number, String(config.proformaFirstNumber), 'starts at PROFORMA_FIRST_NUMBER');
  assert.equal(p.status, 'draft');
  assert.equal(Number(p.total), 800000);
  const lines = await db('proforma_lines').where({ proforma_id: p.id });
  assert.equal(lines.length, 1, 'the empty row is skipped');

  const page = (await sales.get(`/proformas/${p.id}`)).text;
  assert.match(page, /800,000\.00/);
  assert.match(page, /110,344\.83/, 'VAT inside 800,000 at 16%');
  const print = (await sales.get(`/proformas/${p.id}/print`).expect(200)).text;
  assert.match(print, new RegExp(`Proforma Invoice ${p.number}`));
  assert.match(print, /<li>Toolbox<\/li>/, '"- " lines print as bullets');
  assert.match(print, /01100210891001/, 'bank details');
  assert.match(print, /is-draft/);
});

test('a draft can be changed; once sent it is locked', async () => {
  const p = await db('proformas').where({ customer_id: customer.id }).first();
  let res = await post(`/proformas/${p.id}`, { customer_id: customer.id, proforma_date: localDay(), ...bowser, line_price: ['850,000', ''] });
  assert.equal(res.status, 302, res.text);
  assert.equal(Number((await db('proformas').where({ id: p.id }).first()).total), 850000);

  await post(`/proformas/${p.id}/send`, {});
  assert.equal((await db('proformas').where({ id: p.id }).first()).status, 'sent');
  res = await post(`/proformas/${p.id}`, { customer_id: customer.id, proforma_date: localDay(), ...bowser });
  assert.equal(res.status, 409);
  await sales.get(`/proformas/${p.id}/edit`).expect(409);
});

test('revising makes 490-R1 from the sent one, which is kept as replaced', async () => {
  const p = await db('proformas').where({ customer_id: customer.id, revision: 0 }).first();
  const res = await post(`/proformas/${p.id}/revise`, {});
  assert.equal(res.status, 302);
  const r1 = await db('proformas').where({ base_no: p.base_no, revision: 1 }).first();
  assert.equal(r1.number, `${p.number}-R1`);
  assert.equal(r1.status, 'draft');
  assert.equal(Number(r1.total), 850000, 'same lines as the one sent');
  assert.equal(res.headers.location, `/proformas/${r1.id}/edit`);
  const old = await db('proformas').where({ id: p.id }).first();
  assert.equal(old.status, 'replaced');
  assert.equal(old.replaced_by, r1.id);
  assert.match((await sales.get(`/proformas/${p.id}`)).text, new RegExp(`replaced by <a href="/proformas/${r1.id}"><strong>${r1.number}`));
  // A replaced one can't be revised again, or accepted
  assert.equal((await post(`/proformas/${p.id}/revise`, {})).status, 409);
  assert.equal((await post(`/proformas/${p.id}/accept`, {})).status, 409);
});

test('copying another proforma brings its lines and notes, for any customer', async () => {
  const source = await db('proformas').where({ customer_id: customer.id, revision: 1 }).first();
  await db('proformas').where({ id: source.id }).update({ notes: 'Delivery 3 weeks from deposit' });
  const form = (await sales.get(`/proformas/new?copy=${source.id}&customer_id=${other.id}`).expect(200)).text;
  assert.match(form, /Copied from proforma/);
  assert.match(form, /10,000-litre water bowser/);
  assert.match(form, /Delivery 3 weeks from deposit/);
  assert.match(form, /Otieno Farms/, 'the customer chosen stays');
  assert.match(form, /id="quick-add-customer"/, 'a new customer can be added without leaving the form');
  const found = await sales.get(`/api/proformas?q=${source.base_no}`).expect(200);
  assert.ok(found.body.some((o) => o.value === source.id));

  const res = await post('/proformas', { customer_id: other.id, proforma_date: localDay(), copied_from: source.number, ...bowser });
  assert.equal(res.status, 302, res.text);
  const copy = await db('proformas').where({ id: idOf(res.headers.location) }).first();
  assert.equal(copy.revision, 0, 'a copy gets its own new number');
  assert.notEqual(copy.base_no, source.base_no);
});

test('from an enquiry: a prospect becomes a customer; sent → "Proforma sent", accepted → won', async () => {
  const csrf = csrfFrom((await sales.get('/enquiries')).text);
  await sales.post('/enquiries').type('form').send({ _csrf: csrf, caller_name: 'Wanjiru Kamau', caller_phone: '0700 000 803', work_type: 'Tipper', description: '18 m³ tipper body' });
  const enquiry = await db('enquiries').where({ caller_name: 'Wanjiru Kamau' }).first();

  let res = await post(`/enquiries/${enquiry.id}/proforma`, {});
  assert.equal(res.headers.location, `/proformas/new?enquiry=${enquiry.id}`);
  const linked = await db('enquiries').where({ id: enquiry.id }).first();
  assert.ok(linked.customer_id, 'added as a customer');
  const form = (await sales.get(res.headers.location)).text;
  assert.match(form, /18 m³ tipper body/, 'starts with what they asked for');

  res = await post('/proformas', { enquiry_id: enquiry.id, customer_id: linked.customer_id, proforma_date: localDay(), line_description: ['18 m³ tipper body'], line_price: ['1,200,000'] });
  const id = idOf(res.headers.location);
  await post(`/proformas/${id}/send`, {});
  assert.equal((await db('enquiries').where({ id: enquiry.id }).first()).status, 'quoted');
  assert.match((await sales.get(`/enquiries/${enquiry.id}`)).text, new RegExp(`/proformas/${id}`));

  await post(`/proformas/${id}/accept`, {});
  assert.equal((await db('proformas').where({ id }).first()).status, 'accepted');
  assert.equal((await db('enquiries').where({ id: enquiry.id }).first()).status, 'won');
});

test('declined needs a reason and closes the enquiry as lost; revising it reopens the enquiry', async () => {
  const csrf = csrfFrom((await sales.get('/enquiries')).text);
  await sales.post('/enquiries').type('form').send({ _csrf: csrf, customer_id: customer.id, caller_name: 'Komu', work_type: 'Dropside', description: 'Dropside 20 ft' });
  const enquiry = await db('enquiries').where({ caller_name: 'Komu' }).first();
  let res = await post('/proformas', { enquiry_id: enquiry.id, customer_id: customer.id, proforma_date: localDay(), line_description: ['Dropside 20 ft'], line_price: ['600000'] });
  const id = idOf(res.headers.location);
  await post(`/proformas/${id}/send`, {});

  await post(`/proformas/${id}/decline`, { reason: '' });
  assert.equal((await db('proformas').where({ id }).first()).status, 'sent');
  await post(`/proformas/${id}/decline`, { reason: 'Price too high' });
  assert.equal((await db('proformas').where({ id }).first()).declined_reason, 'Price too high');
  let e = await db('enquiries').where({ id: enquiry.id }).first();
  assert.equal(e.status, 'lost');
  assert.equal(e.lost_reason, 'Price too high');

  res = await post(`/proformas/${id}/revise`, {});
  assert.equal(res.status, 302);
  e = await db('enquiries').where({ id: enquiry.id }).first();
  assert.equal(e.status, 'open', 'live again while the new price is worked out');
});
