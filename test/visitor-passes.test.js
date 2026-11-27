import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

// Customer gate passes: reception at HQ sends a visitor to Site B; the HQ gate clears them out;
// Site B's gate finds the pass and signs them in from it.

const app = createApp();
let gateHQ, receptionHQ, gateB, hq, siteB;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  siteB = await db('sites').where({ code: 'SITEB' }).first();
  gateHQ = await loginAs(app, await makeUser(81, ['gate']));
  receptionHQ = await loginAs(app, await makeUser(82, ['reception']));
  gateB = await loginAs(app, await makeUser(83, ['gate'], { siteIds: [siteB.id] }));
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/account/password')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}

/** Posts and checks the status, showing the page on a surprise. */
async function postExpect(status, agent, url, fields) {
  const res = await post(agent, url, fields);
  assert.equal(res.status, status, `${url}: ${res.text.slice(0, 300)}`);
  return res;
}

/** A visitor signed in at HQ by the gate and received by reception. */
async function visitorAtHQ(phone, name) {
  await postExpect(302, gateHQ, '/visitors', { phone, name, purpose: 'Customer', host: 'Reception', company: 'Cyrus Transport' });
  const v = await db('visitors').where({ phone: `+254${phone.replace(/\D/g, '').slice(1)}`, site_id: hq.id }).orderBy('id', 'desc').first();
  await postExpect(302, receptionHQ, `/visitors/${v.id}/receive`);
  return v;
}

const passOf = (visitorId) => db('visitor_passes').where({ visitor_id: visitorId }).orderBy('id', 'desc').first();

test('reception sends a visitor to the other site; the gate can’t issue passes', async () => {
  const v = await visitorAtHQ('0700 000 601', 'Joseph Kinuthia');
  await gateHQ.get(`/visitors/${v.id}/send`).expect(403);

  const page = await receptionHQ.get(`/visitors/${v.id}`).expect(200);
  assert.match(page.text, /Send to another site/);
  const form = await receptionHQ.get(`/visitors/${v.id}/send`).expect(200);
  assert.match(form.text, new RegExp(`Going to[\\s\\S]*${siteB.name}`));

  const res = await post(receptionHQ, `/visitors/${v.id}/send`, { to_site_id: siteB.id, purpose: 'Other', other_purpose: 'Technician for Cyrus', host: 'Reception', people: '2', vehicle_reg: '' });
  assert.equal(res.status, 302);
  const pass = await passOf(v.id);
  assert.match(pass.number, /^CGP-\d{4}-\d{4}$/);
  assert.equal(pass.to_site_id, siteB.id);
  assert.equal(pass.purpose, 'Technician for Cyrus');
  assert.equal(pass.people, 2);
  assert.equal(res.headers.location, `/visitors/passes/${pass.id}`);

  // One open pass per visit.
  await postExpect(302, receptionHQ, `/visitors/${v.id}/send`, { to_site_id: siteB.id, purpose: 'Customer', host: 'Reception' });
  assert.equal(await db('visitor_passes').where({ visitor_id: v.id }).count({ n: '*' }).first().then((r) => Number(r.n)), 1);

  // HQ's register shows where they are going.
  assert.match((await gateHQ.get('/visitors').expect(200)).text, new RegExp(`To ${siteB.name}`));
});

test('the other site sees the pass coming, finds it by number or phone, and signs them in from it', async () => {
  const v = await db('visitors').where({ phone: '+254700000601', site_id: hq.id }).first();
  const pass = await passOf(v.id);

  let list = await gateB.get('/visitors/passes').expect(200);
  assert.match(list.text, /Joseph Kinuthia/);
  assert.match(list.text, /Not left yet/);

  // The HQ gate clears them out: the pass is on the way.
  await postExpect(302, gateHQ, `/visitors/${v.id}/clear`);
  assert.ok((await passOf(v.id)).left_at);
  list = await gateB.get('/visitors/passes').expect(200);
  assert.match(list.text, /On the way/);

  // Search: the last digits off the paper pass, or the phone.
  const digits = pass.number.slice(-4).replace(/^0+/, '');
  assert.match((await gateB.get(`/visitors/passes?q=${digits}`).expect(200)).text, new RegExp(pass.number));
  assert.match((await gateB.get('/visitors/passes?q=0700000601').expect(200)).text, new RegExp(pass.number));

  // Only the site it's going to signs them in from it.
  await gateHQ.get(`/visitors/new?pass=${pass.id}`).expect(404);
  const form = await gateB.get(`/visitors/new?pass=${pass.id}`).expect(200);
  assert.match(form.text, new RegExp(`with gate pass ${pass.number}`));
  assert.match(form.text, /value="Joseph Kinuthia"/);
  assert.match(form.text, new RegExp(`name="pass_no"[^>]*value="${pass.number}"|value="${pass.number}"[^>]*name="pass_no"`));

  await postExpect(302, gateB, '/visitors', { pass_id: pass.id, phone: '0700 000 601', name: 'Joseph Kinuthia', purpose: 'Other', other_purpose: 'Technician for Cyrus', host: 'Reception', people: '2', pass_no: pass.number });
  const arrived = await passOf(v.id);
  assert.equal(arrived.status, 'arrived');
  const visitB = await db('visitors').where({ id: arrived.arrived_visitor_id }).first();
  assert.equal(visitB.site_id, siteB.id);
  assert.equal(visitB.pass_no, pass.number);

  // Used once.
  await gateB.get(`/visitors/new?pass=${pass.id}`).expect(409);
  const page = await gateB.get(`/visitors/passes/${pass.id}`).expect(200);
  assert.match(page.text, /Arrived/);
  assert.match((await gateB.get(`/visitors/${visitB.id}`).expect(200)).text, new RegExp(`Came from[\\s\\S]*${hq.name}[\\s\\S]*${pass.number}`));
});

test('the pass prints like the paper one, with the approver and the times', async () => {
  const v = await db('visitors').where({ phone: '+254700000601', site_id: hq.id }).first();
  const pass = await passOf(v.id);
  const res = await receptionHQ.get(`/visitors/passes/${pass.id}/print`).expect(200);
  assert.match(res.text, /Customer Gate Pass/);
  assert.match(res.text, new RegExp(pass.number));
  assert.match(res.text, /Approved by:<\/span> Test reception/);
  assert.match(res.text, /company-stamp\.png/);
  assert.match(res.text, /Number of people:<\/span> 2/);
});

test('the sending site cancels a pass before they arrive; the other gate can’t', async () => {
  const v = await visitorAtHQ('0700 000 602', 'Mary Wairimu');
  await postExpect(302, receptionHQ, `/visitors/${v.id}/send`, { to_site_id: siteB.id, purpose: 'Customer', host: 'Reception' });
  const pass = await passOf(v.id);

  await postExpect(403, gateB, `/visitors/passes/${pass.id}/cancel`, { cancel_reason: 'Not coming' });
  await postExpect(302, receptionHQ, `/visitors/passes/${pass.id}/cancel`, { cancel_reason: 'x' });
  assert.equal((await passOf(v.id)).status, 'open', 'a reason is needed');
  await postExpect(302, receptionHQ, `/visitors/passes/${pass.id}/cancel`, { cancel_reason: 'Customer went home instead' });
  assert.equal((await passOf(v.id)).status, 'cancelled');
  await gateB.get(`/visitors/new?pass=${pass.id}`).expect(409);
  const print = await receptionHQ.get(`/visitors/passes/${pass.id}/print`).expect(200);
  assert.match(print.text, /is-cancelled/);
  assert.doesNotMatch(print.text, /company-stamp\.png/);

  // Cancelled: they can be sent again.
  assert.match((await receptionHQ.get(`/visitors/${v.id}`).expect(200)).text, /Send to another site/);
});

test('undoing a clear out puts the pass back to not left', async () => {
  const v = await visitorAtHQ('0700 000 603', 'Peter Otieno');
  await postExpect(302, receptionHQ, `/visitors/${v.id}/send`, { to_site_id: siteB.id, purpose: 'Customer', host: 'Reception' });
  await postExpect(302, gateHQ, `/visitors/${v.id}/clear`);
  assert.ok((await passOf(v.id)).left_at);
  await postExpect(302, gateHQ, `/visitors/${v.id}/undo-clear`);
  assert.equal((await passOf(v.id)).left_at, null);
});
