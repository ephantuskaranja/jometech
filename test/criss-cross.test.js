import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { weekDays } from '../src/modules/payroll/service.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

// Staff criss-cross the sites: a day is marked where it was worked, and a person is paid once, through their home site.
// Two sites of its own (TSTATT and TSTAT2), so real staff are never on the days these tests mark.

const app = createApp();
let manager, supervisorA, supervisorB, managerId, siteA, siteB, leon, homeOnly;
const WEEK = '2026-02-02'; // a Monday, long past
const { days } = weekDays(WEEK);
const friday = days[4];

before(async () => {
  const [a] = await db('sites').insert({ code: 'TSTATT', name: 'Test Site A' });
  const [b] = await db('sites').insert({ code: 'TSTAT2', name: 'Test Site B' });
  siteA = await db('sites').where({ id: a }).first();
  siteB = await db('sites').where({ id: b }).first();
  manager = await loginAs(app, await makeUser(63, ['manager']));
  supervisorA = await loginAs(app, await makeUser(64, ['supervisor'], { siteIds: [siteA.id] }));
  supervisorB = await loginAs(app, await makeUser(74, ['supervisor'], { siteIds: [siteB.id] }));
  managerId = (await db('users').where({ phone: '+254700000063' }).first('id')).id;
  [leon] = await db('employees').insert({ number: 'EMP-T631', name: 'Test Crisscross Leon', site_id: siteB.id, daily_rate: 1000, created_by: managerId });
  [homeOnly] = await db('employees').insert({ number: 'EMP-T632', name: 'Test Stays Home', site_id: siteA.id, daily_rate: 1000, created_by: managerId });
  await db('employee_clock_ids').insert([{ clock_id: 'T631', employee_id: leon }, { clock_id: 'T632', employee_id: homeOnly }]);
  const [deviceA] = await db('clock_devices').insert({ name: 'TEST-CROSS-A', site_id: siteA.id });
  const [deviceB] = await db('clock_devices').insert({ name: 'TEST-CROSS-B', site_id: siteB.id });
  const [importId] = await db('attendance_imports').insert({ file_name: 'test', created_by: managerId });
  const punch = (clock_id, day, time, device_id) => ({ clock_id, day, time, device_id, import_id: importId });
  // Leon on Friday: first punch at Site A, last at Site B, a full day between the two.
  await db('attendance_punches').insert([
    punch('T631', friday, '07:30:00', deviceA), punch('T631', friday, '13:00:00', deviceA), punch('T631', friday, '13:45:00', deviceB), punch('T631', friday, '17:05:00', deviceB),
    punch('T632', friday, '07:30:00', deviceA), punch('T632', friday, '17:05:00', deviceA),
  ]);
});

after(async () => {
  await db('attendance_confirmations').whereIn('site_id', [siteA.id, siteB.id]).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/payroll')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const grid = (agent, site, day) => agent.get(`/attendance?site=${site.id}&day=${day}`).expect(200);
const save = (agent, site, day, rows, action = 'save') => post(agent, '/attendance', {
  site: site.id, day, action, row_employee: rows.map((r) => r[0]), row_status: rows.map((r) => r[1]), row_note: rows.map(() => ''),
});

test('the day belongs to the site of the first punch; the other site sees it and can’t change it', async () => {
  const atA = (await grid(supervisorA, siteA, friday)).text;
  assert.match(atA, /Test Crisscross Leon/);
  assert.match(atA, new RegExp(`name="row_employee" value="${leon}"`), 'Site A marks him');
  assert.match(atA, />8\.83</, 'hours run across both machines, lunch excluded');

  const atB = (await grid(supervisorB, siteB, friday)).text;
  assert.match(atB, /Worked at Test Site A/);
  assert.doesNotMatch(atB, new RegExp(`name="row_employee" value="${leon}"`), 'nothing to post at his home site');

  // Even a form sent by hand can't move it.
  await save(supervisorB, siteB, friday, [[leon, 'absent']]);
  assert.equal(await db('attendance_days').where({ employee_id: leon, day: friday }).first(), undefined);
});

test('the site that worked him confirms; a saved day stays put; only one record per person per day', async () => {
  await save(supervisorA, siteA, friday, [[leon, 'present'], [homeOnly, 'present']], 'confirm');
  assert.ok(await db('attendance_confirmations').where({ site_id: siteA.id, day: friday }).first(), 'confirmed');
  await save(supervisorB, siteB, friday, [[leon, 'absent']]);
  const rows = await db('attendance_days').where({ employee_id: leon, day: friday });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].site_id, siteA.id);
  assert.equal(rows[0].status, 'present');
  assert.match((await grid(supervisorB, siteB, friday)).text, /Worked at Test Site A/);
});

test('he is paid once, on his home site’s payroll, which waits for the other site', async () => {
  const others = days.filter((d) => d !== friday);
  // Leon's home site confirms its own six days: he works there the other five.
  for (const day of others) await save(supervisorB, siteB, day, [[leon, 'present']], 'confirm');
  await save(supervisorB, siteB, friday, [], 'confirm');

  // Take back Site A's Friday: Site B's payroll must wait for it.
  await post(manager, '/attendance/reopen', { site: siteA.id, day: friday });
  let res = await post(manager, '/payroll', { site: siteB.id, week: WEEK });
  assert.match((await manager.get(res.headers.location)).text, /Waiting for it to confirm: Test Site A/);
  assert.equal(await db('payrolls').where({ site_id: siteB.id, week_start: WEEK }).first(), undefined);
  assert.match((await manager.get(`/payroll?site=${siteB.id}&week=${WEEK}`)).text, /staff worked at another site this week/);
  await save(supervisorA, siteA, friday, [[leon, 'present'], [homeOnly, 'present']], 'confirm');

  res = await post(manager, '/payroll', { site: siteB.id, week: WEEK });
  const payrollB = await db('payrolls').where({ site_id: siteB.id, week_start: WEEK }).first();
  assert.ok(payrollB, 'prepared');
  const slip = await db('payslips').where({ payroll_id: payrollB.id, employee_id: leon }).first();
  assert.equal(Number(slip.days), 6, 'five at home and Friday at Site A');
  assert.equal(Number(slip.net), 6000);
  assert.equal(JSON.parse(slip.days_detail)[friday].site, 'Test Site A');
  assert.match((await manager.get(`/payroll/${payrollB.id}`)).text, /Test Site A/, 'the slip says where');

  // Site A's payroll has its own person, not Leon.
  for (const day of others) await save(supervisorA, siteA, day, [[homeOnly, 'off']], 'confirm');
  await post(manager, '/payroll', { site: siteA.id, week: WEEK });
  const payrollA = await db('payrolls').where({ site_id: siteA.id, week_start: WEEK }).first();
  assert.ok(payrollA);
  const onA = await db('payslips').where({ payroll_id: payrollA.id }).pluck('employee_id');
  assert.deepEqual(onA, [homeOnly], 'Leon isn’t paid twice');
});

test('once his payroll is approved, the day at the other site can’t be reopened', async () => {
  const p = await db('payrolls').where({ site_id: siteB.id, week_start: WEEK }).first();
  await post(supervisorB, `/payroll/${p.id}/check`);
  await post(manager, `/payroll/${p.id}/approve`);
  assert.equal((await db('payrolls').where({ id: p.id }).first()).status, 'approved');
  await post(manager, '/attendance/reopen', { site: siteA.id, day: friday });
  assert.ok(await db('attendance_confirmations').where({ site_id: siteA.id, day: friday }).first(), 'still confirmed');
});

test('someone whose home site changes mid-week stays on the payroll they are already on', async () => {
  await db('employees').where({ id: leon }).update({ site_id: siteA.id });
  const a = await db('payrolls').where({ site_id: siteA.id, week_start: WEEK }).first();
  await post(manager, `/payroll/${a.id}/recalculate`);
  assert.deepEqual(await db('payslips').where({ payroll_id: a.id }).pluck('employee_id'), [homeOnly], 'still only on Site B’s');
  await db('employees').where({ id: leon }).update({ site_id: siteB.id });
});
