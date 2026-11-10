import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { fmt } from '../src/core/format.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let reception, supervisor, sales, hq, visitorId, employeeId;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  reception = await loginAs(app, await makeUser(31, ['reception']));
  supervisor = await loginAs(app, await makeUser(32, ['supervisor']));
  sales = await loginAs(app, await makeUser(33, ['sales']));
  const by = await db('users').where({ name: 'Test reception' }).first('id');
  [visitorId] = await db('visitors').insert({ number: 'VIS-T-0031', site_id: hq.id, name: 'Test Privacy Visitor', phone: '+254700000531', id_no: '77031996', purpose: 'Delivery', arrived_at: new Date(), arrived_by: by.id });
  [employeeId] = await db('employees').insert({ number: 'EMP-T-P01', name: 'Test Privacy Worker', id_no: '77032996', mpesa_phone: '+254700000532', category: 'casual', site_id: hq.id, created_by: by.id });
});
after(async () => {
  await db('audit_log').where({ entity: 'visitor', entity_id: visitorId }).orWhere({ entity: 'employee', entity_id: employeeId }).delete();
  await db('visitors').where({ id: visitorId }).delete();
  await cleanup();
});

const reveal = async (agent, url) => {
  const csrf = csrfFrom((await agent.get('/account/password')).text);
  return agent.post(url).set('x-csrf-token', csrf).set('Accept', 'application/json');
};

test('masks: ID → ****last4, phone → 0712 ••• 678', () => {
  assert.equal(fmt.mask('29967996'), '****7996');
  assert.equal(fmt.mask('+254712345678', 'phone'), '0712 ••• 678');
  assert.equal(fmt.mask(null), '');
});

test('a visitor’s ID and phone are masked; Show gives them and the look is recorded', async () => {
  const page = (await reception.get(`/visitors/${visitorId}`)).text;
  assert.match(page, /\*\*\*\*1996/);
  assert.doesNotMatch(page, /77031996/, 'the full ID is not in the page');
  assert.doesNotMatch(page, /0700 000 531|254700000531/, 'nor the full phone');
  assert.doesNotMatch((await reception.get('/visitors')).text, /77031996|0700 000 531|254700000531/, 'nor on the register');

  const res = await reveal(reception, `/api/reveal/visitor/${visitorId}/id_no`);
  assert.equal(res.status, 200);
  assert.equal(res.body.value, '77031996');
  const entry = await db('audit_log').where({ entity: 'visitor', entity_id: visitorId, action: 'revealed' }).first();
  assert.equal(entry.summary, 'ID number');
  assert.match((await reception.get(`/visitors/${visitorId}`)).text, /viewed a hidden detail/);
});

test('Show only for those allowed to see the record, and only listed fields', async () => {
  assert.equal((await reveal(sales, `/api/reveal/visitor/${visitorId}/id_no`)).status, 404, 'sales don’t see visitors');
  assert.equal((await reveal(reception, `/api/reveal/employee/${employeeId}/id_no`)).status, 404, 'reception doesn’t see staff');
  assert.equal((await reveal(reception, `/api/reveal/visitor/${visitorId}/name`)).status, 404, 'not a hidden field');
  assert.equal((await reveal(reception, `/api/reveal/constructor/1/id_no`)).status, 404);
});

test('an employee’s ID and M-Pesa number are masked, in the details and the history', async () => {
  await db('audit_log').insert({ entity: 'employee', entity_id: employeeId, action: 'update', changes: JSON.stringify({ id_no: ['77032000', '77032996'] }) });
  const page = (await supervisor.get(`/employees/${employeeId}`)).text;
  assert.match(page, /\*\*\*\*2996/);
  assert.match(page, /0700 ••• 532/);
  assert.doesNotMatch(page, /77032996|77032000|0700 000 532/);
  const res = await reveal(supervisor, `/api/reveal/employee/${employeeId}/mpesa_phone`);
  assert.equal(res.body.value, '+254700000532');
});
