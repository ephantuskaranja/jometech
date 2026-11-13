import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay, nextDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let gate, reception, sales, supervisor, storekeeper, hq;
const today = localDay();
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  gate = await loginAs(app, await makeUser(81, ['gate']));
  reception = await loginAs(app, await makeUser(82, ['reception']));
  sales = await loginAs(app, await makeUser(83, ['sales']));
  supervisor = await loginAs(app, await makeUser(84, ['supervisor']));
  storekeeper = await loginAs(app, await makeUser(85, ['storekeeper']));
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/account/password')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}

const booking = (fields) => ({ expected_on: today, expected_time: '10:30', name: 'Peter Otieno', phone: '0700 000 601', company: 'Bamburi Haulage',
  purpose: 'Collecting a vehicle', host: 'Reception', vehicle_reg: 'kcb456b', notes: 'With two turnboys: Ken, Ali', ...fields });
const lastBooking = () => db('visitor_bookings').orderBy('id', 'desc').first();

test('reception, sales and supervisors book; the gate and stores can’t', async () => {
  for (const agent of [reception, sales, supervisor]) {
    assert.equal((await agent.get('/visitors/expected/new')).status, 200);
  }
  assert.equal((await gate.get('/visitors/expected/new')).status, 403);
  assert.equal((await post(gate, '/visitors/expected', booking())).status, 403);
  assert.equal((await storekeeper.get('/visitors/expected')).status, 403);
  assert.equal((await post(sales, '/visitors/expected', booking())).status, 302);
  const b = await lastBooking();
  assert.match(b.number, /^BKG-\d{4}-\d{4}$/);
  assert.equal(b.status, 'expected');
  assert.equal(b.site_id, hq.id);
  assert.equal(b.vehicle_reg, 'KCB 456B');
  assert.equal(b.phone, '+254700000601');
  assert.equal(b.expected_time, '10:30');
});

test('a booking needs a name, a reason and today or later; phone and time are optional', async () => {
  let res = await post(reception, '/visitors/expected', booking({ name: '', purpose: '', expected_on: yesterday }));
  assert.equal(res.status, 422);
  assert.match(res.text, /Enter the name of the person coming/);
  assert.match(res.text, /Choose why they are coming/);
  res = await post(reception, '/visitors/expected', booking({ expected_on: yesterday }));
  assert.match(res.text, /Choose today or a later day/);
  res = await post(reception, '/visitors/expected', booking({ purpose: 'Other', other_purpose: '' }));
  assert.match(res.text, /Say why they are coming/);
  res = await post(reception, '/visitors/expected', booking({ name: 'Mary Achieng', phone: '', expected_time: '', purpose: 'Interview', expected_on: nextDay(today) }));
  assert.equal(res.status, 302, res.text);
  const b = await lastBooking();
  assert.equal(b.phone, null);
  assert.equal(b.expected_time, null);
});

test('the gate sees today’s bookings, signs one in from the booking, and it can’t be used twice', async () => {
  await post(reception, '/visitors/expected', booking({ name: 'Grace Njeri', phone: '0700 000 602' }));
  const b = await lastBooking();
  const list = await gate.get('/visitors/expected');
  assert.match(list.text, /Grace Njeri/);
  assert.match(list.text, new RegExp(`/visitors/new\\?booking=${b.id}`));
  assert.doesNotMatch(list.text, /Mary Achieng/, 'tomorrow’s booking isn’t on today’s list');
  assert.match((await gate.get('/visitors/expected?show=upcoming')).text, /Mary Achieng/);

  const form = await gate.get(`/visitors/new?booking=${b.id}`);
  assert.equal(form.status, 200);
  assert.match(form.text, /Expected: booked by/);
  assert.match(form.text, /value="Grace Njeri"/);
  assert.match(form.text, new RegExp(`name="booking_id" value="${b.id}"`));

  const res = await post(gate, '/visitors', { phone: '0700 000 602', name: 'Grace Njeri', purpose: 'Collecting a vehicle', host: 'Reception', booking_id: b.id });
  assert.equal(res.status, 302, res.text);
  const after = await db('visitor_bookings').where({ id: b.id }).first();
  assert.equal(after.status, 'arrived');
  const v = await db('visitors').where({ id: after.visitor_id }).first();
  assert.equal(v.name, 'Grace Njeri');
  assert.equal(v.status, 'arrived', 'still goes through reception as usual');
  assert.match((await gate.get(`/visitors/${v.id}`)).text, new RegExp(b.number));

  assert.equal((await gate.get(`/visitors/new?booking=${b.id}`)).status, 409);
  assert.equal((await post(gate, '/visitors', { phone: '0700 000 602', name: 'Grace Njeri', purpose: 'Delivery', host: 'Reception', booking_id: b.id })).status, 409);
  await post(reception, `/visitors/expected/${b.id}/cancel`, { cancel_reason: 'Too late' });
  assert.equal((await db('visitor_bookings').where({ id: b.id }).first()).status, 'arrived', 'an arrived booking can’t be cancelled');
});

test('changing and cancelling a booking, with history', async () => {
  await post(sales, '/visitors/expected', booking({ name: 'John Kamau', phone: '' }));
  const b = await lastBooking();
  assert.equal((await post(sales, `/visitors/expected/${b.id}`, booking({ name: 'John Kamau', phone: '', expected_time: '14:00' }))).status, 302);
  assert.equal((await lastBooking()).expected_time, '14:00');

  await post(sales, `/visitors/expected/${b.id}/cancel`, { cancel_reason: '' });
  assert.equal((await lastBooking()).status, 'expected', 'a reason is needed');
  await post(sales, `/visitors/expected/${b.id}/cancel`, { cancel_reason: 'Customer postponed' });
  const done = await lastBooking();
  assert.equal(done.status, 'cancelled');
  assert.equal(done.cancel_reason, 'Customer postponed');
  const page = (await sales.get(`/visitors/expected/${b.id}`)).text;
  assert.match(page, /Customer postponed/);
  assert.match(page, /Booking changed: expected time/);
  assert.equal((await post(sales, `/visitors/expected/${b.id}`, booking({ name: 'Changed' }))).status, 409);
});

test('an expected booking whose day passed shows as a no-show', async () => {
  await post(reception, '/visitors/expected', booking({ name: 'Late Larry', phone: '' }));
  const b = await lastBooking();
  await db('visitor_bookings').where({ id: b.id }).update({ expected_on: yesterday });
  const past = (await reception.get('/visitors/expected?show=past')).text;
  assert.match(past, /Late Larry/);
  assert.match(past, /No-show/);
});

test('dashboards: expected today for the gate and sales; reception and sales get a book button', async () => {
  assert.match((await gate.get('/')).text, /Expected today/);
  assert.match((await reception.get('/')).text, /Book a visitor/);
  const salesHome = (await sales.get('/')).text;
  assert.match(salesHome, /Expected today/);
  assert.match(salesHome, /Book a visitor/);
});
