import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import * as invoices from '../src/modules/invoices/service.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let supervisor, manager, gate, managerId, hq, customer, owing, paidUp;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** A vehicle in the workshop with one job on this visit. */
async function visit(reg, jobStatus) {
  const [vehicle] = await db('vehicles').insert({ reg_no: reg, chassis_no: `JALT${reg.replace(/\s/g, '')}`, engine_no: 'ENG851', customer_id: customer, type: 'truck', make: 'Isuzu' });
  const [checkin] = await db('checkins').insert({ number: `CHK-T-${reg.replace(/\s/g, '')}`, site_id: hq.id, vehicle_id: vehicle, customer_id: customer, received_by: managerId, driver_name: 'Peter Kamau' });
  await db('checkin_items').insert({ checkin_id: checkin, sort_order: 1, description: 'Spare wheel', quantity: 1 });
  const [job] = await db('jobs').insert({ number: `JOB-2026-T${reg.slice(4, 7)}`, site_id: hq.id, customer_id: customer, vehicle_id: vehicle, checkin_id: checkin, status: jobStatus });
  await db('job_lines').insert({ job_id: job, sort_order: 1, quantity: 1, unit: 'Unit', description: 'Dropside body 14 ft\n- Toolbox' });
  return { checkin, job };
}

/** An issued invoice for the job, with some of it paid. */
async function invoiced(job, total, paid) {
  const actor = { user: { id: managerId } };
  const { id } = await invoices.createInvoice(job, { financier_id: null, notes: null, lines: [{ quantity: 1, unit: 'Unit', description: 'Dropside body', unit_price: total, amount: total }] }, actor);
  await invoices.issueInvoice(id, actor);
  if (paid) await invoices.recordPayment(job, { paid_on: localDay(), amount: paid, method: 'mpesa', reference: 'TST851', payer: 'client', notes: null }, actor);
}

before(async () => {
  supervisor = await loginAs(app, await makeUser(97, ['supervisor']));
  manager = await loginAs(app, await makeUser(98, ['manager']));
  gate = await loginAs(app, await makeUser(89, ['gate']));
  managerId = (await db('users').where({ phone: '+254700000098' }).first('id')).id;
  hq = await db('sites').where({ code: 'HQ' }).first();
  [customer] = await db('customers').insert({ number: 'CUS-T851', name: 'Test Release Haulage', phone: '+254700000851', category: 'company' });
  owing = await visit('KEB 851C', 'in_progress');
  paidUp = await visit('KEB 852C', 'completed');
  await invoiced(paidUp.job, 50000, 50000);
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/check-in')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const release = (agent, checkin, fields = {}) => post(agent, `/check-in/${checkin}/release`, { collector_name: 'Peter Kamau', collector_phone: '0700 000 852', signature: PNG, ...fields });

test('unfinished work blocks the release: no button, no form, no saving', async () => {
  const page = (await supervisor.get(`/check-in/${owing.checkin}`)).text;
  assert.match(page, /Release checklist/);
  assert.match(page, /Not finished: JOB-2026-T851/);
  assert.match(page, /disabled title="The release checklist isn’t complete"/);
  assert.equal((await supervisor.get(`/check-in/${owing.checkin}/release`)).headers.location, `/check-in/${owing.checkin}`);
  assert.equal((await release(supervisor, owing.checkin)).status, 409);
  assert.equal((await db('checkins').where({ id: owing.checkin }).first()).status, 'in_workshop');
});

test('the balance owing is red; only managers see the amount and can allow the release', async () => {
  await db('jobs').where({ id: owing.job }).update({ status: 'completed', completed_at: new Date() });
  await invoiced(owing.job, 100000, 40000);
  const forSupervisor = (await supervisor.get(`/check-in/${owing.checkin}`)).text;
  assert.match(forSupervisor, /Balance owing: invoice \d+/);
  assert.doesNotMatch(forSupervisor, /60,000/, 'no amounts for the workshop');
  assert.doesNotMatch(forSupervisor, /allow-release/);
  assert.equal((await post(supervisor, `/check-in/${owing.checkin}/allow-release`, { reason: 'On credit' })).status, 403);

  const forManager = (await manager.get(`/check-in/${owing.checkin}`)).text;
  assert.match(forManager, /KES 60,000\.00 owing/);
  await post(manager, `/check-in/${owing.checkin}/allow-release`, { reason: '' });
  assert.equal((await db('checkins').where({ id: owing.checkin }).first()).release_allowed_at, null, 'a reason is needed');

  await post(manager, `/check-in/${owing.checkin}/allow-release`, { reason: 'On credit: paying by 30 Nov' });
  await post(manager, `/check-in/${owing.checkin}/withdraw-release`);
  assert.equal((await release(supervisor, owing.checkin)).status, 409, 'withdrawn: blocked again');
  await post(manager, `/check-in/${owing.checkin}/allow-release`, { reason: 'On credit: paying by 30 Nov' });
  assert.match((await supervisor.get(`/check-in/${owing.checkin}`)).text, /allowed the release .*On credit: paying by 30 Nov/);
});

test('allowed: the collector signs and the vehicle leaves; the note says “on credit” with no amounts', async () => {
  await supervisor.get(`/check-in/${owing.checkin}/release`).expect(200);
  let res = await release(supervisor, owing.checkin, { signature: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Sign in the box above/);
  res = await release(supervisor, owing.checkin);
  assert.equal(res.status, 302, res.text);

  const c = await db('checkins').where({ id: owing.checkin }).first();
  assert.equal(c.status, 'released', 'still inside until the gate clears it');
  assert.equal(c.checked_out_at, null);
  const r = await db('vehicle_releases').where({ checkin_id: owing.checkin }).first();
  assert.match(r.number, /^RN-\d{4}-\d{4}$/);
  assert.equal(r.collector_phone, '+254700000852');
  assert.equal(Boolean(r.on_approval), true);
  assert.equal((await release(supervisor, owing.checkin)).status, 409, 'once only');

  const note = (await supervisor.get(`/check-in/${owing.checkin}/release-note`).expect(200)).text;
  assert.match(note, /Vehicle Release Note/);
  assert.match(note, new RegExp(r.number));
  assert.match(note, /Released on credit/);
  assert.doesNotMatch(note, /100,000|60,000|40,000/, 'status only, no amounts');
  assert.match(note, /Peter Kamau/);
  assert.match(note, /ENG851/, 'engine number');
  assert.match(note, /Dropside body 14 ft/);
  assert.match(note, /Spare wheel/);
  assert.match(note, /approval of Test manager/);
  assert.match(note, new RegExp(`/check-in/${owing.checkin}/release-signature.png`));
  await supervisor.get(`/check-in/${owing.checkin}/release-signature.png`).expect(200);
  const page = (await supervisor.get(`/check-in/${owing.checkin}`)).text;
  assert.match(page, /Collected by <strong>Peter Kamau/);
  assert.match(page, /Released: waiting at the gate/);
  assert.match(note, /Cleared at the gate by:<\/span> \n/, 'blank until the gate clears it');
});

test('the gate sees released vehicles, clears them out, and is named on the release note', async () => {
  const sales = await loginAs(app, await makeUser(90, ['sales']));
  await sales.get('/gate/vehicles').expect(403);
  let res = await gate.get('/gate/vehicles');
  if (res.status === 302) { // a guard chooses the site at login
    const page = await gate.get('/choose-site');
    await gate.post('/choose-site').type('form').send({ _csrf: csrfFrom(page.text), site_id: hq.id });
    res = await gate.get('/gate/vehicles');
  }
  assert.equal(res.status, 200);
  assert.match(res.text, /KEB 851C/);
  assert.match(res.text, /Peter Kamau/);
  assert.match(res.text, /RN-\d{4}-\d{4}/);
  assert.match(res.text, /href="\/gate\/vehicles"/, 'in the guard’s menu');

  const csrf = csrfFrom(res.text);
  res = await gate.post(`/check-in/${owing.checkin}/clear`).type('form').send({ _csrf: csrf });
  assert.equal(res.headers.location, '/gate/vehicles');
  const c = await db('checkins').where({ id: owing.checkin }).first();
  assert.equal(c.status, 'checked_out');
  assert.ok(c.checked_out_at);
  assert.equal(c.checked_out_by, (await db('users').where({ phone: '+254700000089' }).first('id')).id);
  await gate.get('/gate/vehicles'); // shows (and clears) the "KEB 851C cleared out" message
  assert.doesNotMatch((await gate.get('/gate/vehicles')).text, /KEB 851C/);
  assert.equal((await gate.post(`/check-in/${owing.checkin}/clear`).type('form').send({ _csrf: csrf })).status, 409, 'once only');
  assert.equal((await gate.post(`/check-in/${paidUp.checkin}/clear`).type('form').send({ _csrf: csrf })).status, 409, 'not released yet');

  const note = (await supervisor.get(`/check-in/${owing.checkin}/release-note`)).text;
  assert.match(note, /Cleared at the gate by:<\/span> Test gate/);
  assert.match((await supervisor.get(`/check-in/${owing.checkin}`)).text, /Cleared at the gate by Test gate/);
});

test('all green: released without anyone’s approval, the note says “paid in full”', async () => {
  const page = (await supervisor.get(`/check-in/${paidUp.checkin}`)).text;
  assert.match(page, />Ready</);
  assert.equal((await release(supervisor, paidUp.checkin)).status, 302);
  // A supervisor can clear it out too, when no guard is on duty.
  assert.match((await supervisor.get(`/check-in/${paidUp.checkin}`)).text, /Cleared out at the gate/);
  assert.equal((await post(supervisor, `/check-in/${paidUp.checkin}/clear`, { back: 'checkin' })).headers.location, `/check-in/${paidUp.checkin}`);
  assert.equal((await db('checkins').where({ id: paidUp.checkin }).first()).status, 'checked_out');
  const r = await db('vehicle_releases').where({ checkin_id: paidUp.checkin }).first();
  assert.equal(Boolean(r.on_approval), false);
  const note = (await supervisor.get(`/check-in/${paidUp.checkin}/release-note`)).text;
  assert.match(note, /Paid in full/);
  assert.doesNotMatch(note, /approval of/);
});
