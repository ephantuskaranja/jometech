import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let sales, tech, supervisor;

before(async () => {
  sales = await loginAs(app, await makeUser(41, ['sales']));
  tech = await loginAs(app, await makeUser(42, ['technician']));
  supervisor = await loginAs(app, await makeUser(43, ['supervisor']));
});
after(cleanup);

async function submit(agent, pagePath, action, fields) {
  const page = await agent.get(pagePath);
  return agent.post(action).type('form').send({ _csrf: csrfFrom(page.text), ...fields });
}
const customerByPhone = (phone) => db('customers').where({ phone }).first();

test('who can see and add customers', async () => {
  assert.equal((await tech.get('/customers')).status, 403);
  await supervisor.get('/customers').expect(200);                  // can look (check-in)
  assert.equal((await supervisor.get('/customers/new')).status, 403); // but not add here
  await sales.get('/customers/new').expect(200);
});

test('a name and phone are enough; the number and terms are filled in', async () => {
  const res = await submit(sales, '/customers/new', '/customers', { name: 'John Kariuki', phone: '0700 000 101' });
  assert.equal(res.status, 302);
  const c = await customerByPhone('+254700000101');
  assert.match(c.number, /^CUS-\d{4}$/);
  assert.equal(c.category, 'individual');
  assert.equal(c.credit_days, 0);
  const page = await sales.get(res.headers.location).expect(200);
  assert.match(page.text, new RegExp(`added as ${c.number}`));
});

test('a company can be added with its contact person in one go', async () => {
  const res = await submit(sales, '/customers/new', '/customers', {
    name: 'Rift Valley Haulage', phone: '0700000102', category: 'company', kra_pin: 'p051234567x',
    contact_name: 'Daniel Kibet', contact_role: 'Salesman', contact_phone: '0700 000 103',
  });
  assert.equal(res.status, 302);
  const c = await customerByPhone('+254700000102');
  assert.equal(c.kra_pin, 'P051234567X');
  const contacts = await db('customer_contacts').where({ customer_id: c.id });
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone, '+254700000103');
});

test('mistakes are explained and what was typed is kept', async () => {
  const res = await submit(sales, '/customers/new', '/customers', { name: 'X', phone: '0712', kra_pin: '1234' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Enter the customer’s name/);
  assert.match(res.text, /Use a format like 0712 345 678/);
  assert.match(res.text, /A KRA PIN looks like A123456789B/);
  assert.match(res.text, /value="0712"/);
});

test('an existing phone number is pointed out', async () => {
  const res = await sales.get('/api/customers/check-phone?phone=0700%20000%20101').expect(200);
  assert.equal(res.body.matches.length, 1);
  assert.equal(res.body.matches[0].name, 'John Kariuki');
});

test('contacts can be added, changed and removed, and history records it', async () => {
  const c = await customerByPhone('+254700000102');
  await submit(sales, `/customers/${c.id}?tab=contacts`, `/customers/${c.id}/contacts`, { name: 'Grace Wambui', role: 'Accounts', phone: '0700000104' });
  const grace = await db('customer_contacts').where({ customer_id: c.id, name: 'Grace Wambui' }).first();
  await submit(sales, `/customers/${c.id}?tab=contacts`, `/customers/${c.id}/contacts/${grace.id}`, { name: 'Grace Wambui', role: 'Fleet manager', phone: '0700000104' });
  await submit(sales, `/customers/${c.id}?tab=contacts`, `/customers/${c.id}/contacts/${grace.id}/delete`, {});
  assert.equal(await db('customer_contacts').where({ id: grace.id }).first(), undefined);

  const page = (await sales.get(`/customers/${c.id}?tab=history`)).text;
  for (const action of ['contact added', 'contact changed', 'contact removed']) assert.match(page, new RegExp(action));
});

test('editing a customer is recorded field by field', async () => {
  const c = await customerByPhone('+254700000101');
  const res = await submit(sales, `/customers/${c.id}/edit`, `/customers/${c.id}`, { name: 'John Kariuki', phone: '0700000101', category: 'individual', town: 'Nakuru', credit_days: '30' });
  assert.equal(res.status, 302);
  const page = (await sales.get(`/customers/${c.id}?tab=history`)).text;
  assert.match(page, /Town<\/span>\s*<span class="jt-changes-old">—<\/span> <i class="bi bi-arrow-right"><\/i> Nakuru/);
  assert.match(page, /Payment terms<\/span>\s*<span class="jt-changes-old">Cash<\/span> <i class="bi bi-arrow-right"><\/i> 30 days/);
});

test('a KRA PIN can only belong to one customer', async () => {
  const res = await submit(sales, '/customers/new', '/customers', { name: 'Copycat Ltd', phone: '0700000105', category: 'company', kra_pin: 'P051234567X' });
  assert.equal(res.status, 422);
  assert.match(res.text, /already belongs to Rift Valley Haulage/);
});

test('the list searches by name, phone and number', async () => {
  const c = await customerByPhone('+254700000102');
  for (const q of ['rift', '0700 000 102', c.number]) {
    assert.match((await sales.get(`/customers?q=${encodeURIComponent(q)}`)).text, /Rift Valley Haulage/, q);
  }
});
