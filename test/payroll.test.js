import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { weekStartOf, weekDays } from '../src/modules/payroll/service.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let manager, supervisor, sales, managerId, hq, welder, painter, payrollId;
const WEEK = '2026-03-02'; // a Monday, long past
const { days, payDay } = weekDays(WEEK);

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  manager = await loginAs(app, await makeUser(68, ['manager']));
  supervisor = await loginAs(app, await makeUser(69, ['supervisor']));
  sales = await loginAs(app, await makeUser(70, ['sales']));
  managerId = (await db('users').where({ phone: '+254700000068' }).first('id')).id;
  [welder] = await db('employees').insert({ number: 'EMP-T681', name: 'Test Payroll Welder', site_id: hq.id, daily_rate: 2000, mpesa_phone: '+254700000681', created_by: managerId });
  [painter] = await db('employees').insert({ number: 'EMP-T682', name: 'Test Payroll Painter', site_id: hq.id, created_by: managerId }); // no rate yet
  const statuses = { [welder]: ['present', 'present', 'half', 'present', 'present', 'present'], [painter]: ['present', 'absent', 'absent', 'absent', 'absent', 'off'] };
  for (const [employee_id, list] of Object.entries(statuses)) {
    await db('attendance_days').insert(list.map((status, i) => ({ employee_id: Number(employee_id), day: days[i], site_id: hq.id, status })));
  }
  // Five of the six days confirmed: Saturday still open.
  await db('attendance_confirmations').insert(days.slice(0, 5).map((day) => ({ site_id: hq.id, day, confirmed_by: managerId })));
});
after(async () => {
  await db('attendance_confirmations').where({ site_id: hq.id }).whereIn('day', days).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/payroll')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const status = async () => (await db('payrolls').where({ id: payrollId }).first()).status;
const slip = (employee_id) => db('payslips').where({ payroll_id: payrollId, employee_id }).first();
const binary = (req) => req.buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });

test('weeks run Monday to Saturday, paid on the Saturday', () => {
  assert.equal(weekStartOf('2026-03-04'), WEEK, 'a Wednesday');
  assert.equal(weekStartOf('2026-03-07'), WEEK, 'the Saturday');
  assert.equal(weekStartOf('2026-03-08'), WEEK, 'the Sunday belongs to the same Monday');
  assert.equal(weekStartOf(WEEK), WEEK);
  assert.equal(days.length, 6);
  assert.equal(payDay, '2026-03-07');
});

test('who can open payroll, and that every day must be confirmed first', async () => {
  await sales.get('/payroll').expect(403);
  await supervisor.get('/payroll').expect(200);
  assert.equal((await post(supervisor, '/payroll', { site: hq.id, week: WEEK })).status, 403, 'supervisors don’t prepare');

  const res = await post(manager, '/payroll', { site: hq.id, week: WEEK });
  assert.equal(res.status, 302);
  assert.match((await manager.get(res.headers.location)).text, new RegExp(`Not confirmed yet: ${payDay}`));
  assert.equal(await db('payrolls').where({ site_id: hq.id, week_start: WEEK }).first(), undefined);
});

test('prepared from confirmed attendance: days × rate, half days count ½, the rate is copied', async () => {
  await db('attendance_confirmations').insert({ site_id: hq.id, day: days[5], confirmed_by: managerId });
  const res = await post(manager, '/payroll', { site: hq.id, week: days[2] }); // any day of the week finds its Monday
  assert.equal(res.status, 302);
  payrollId = Number(res.headers.location.split('/')[2]);
  const p = await db('payrolls').where({ id: payrollId }).first();
  assert.match(p.number, /^PAY-2026-\d{4}$/);
  assert.equal(p.week_start, WEEK);
  assert.equal(p.pay_day, payDay);
  assert.equal(p.status, 'draft');

  const w = await slip(welder);
  assert.equal(Number(w.days), 5.5);
  assert.equal(Number(w.daily_rate), 2000);
  assert.equal(Number(w.base), 11000);
  assert.equal(Number(w.net), 11000);
  assert.equal(JSON.parse(w.days_detail)[days[2]].status, 'half');
  assert.equal((await slip(painter)).daily_rate, null);
  assert.equal(Number(p.total), 11000);

  assert.match((await post(manager, '/payroll', { site: hq.id, week: WEEK })).headers.location, /\/payroll\?/, 'one payroll per site per week');
});

test('adjustments need a reason; supervisors see the days and no money, and check them', async () => {
  let res = await post(manager, `/payroll/${payrollId}/slips/${(await slip(welder)).id}/adjustments`, { direction: 'deduct', amount: '500', reason: '' });
  assert.equal(Number((await slip(welder)).adjustments), 0, 'no reason, not saved');
  await post(manager, `/payroll/${payrollId}/slips/${(await slip(welder)).id}/adjustments`, { direction: 'deduct', amount: '1,500', reason: 'Advance 3 Mar' });
  await post(manager, `/payroll/${payrollId}/slips/${(await slip(welder)).id}/adjustments`, { direction: 'add', amount: '300', reason: 'Sunday work' });
  let w = await slip(welder);
  assert.equal(Number(w.adjustments), -1200);
  assert.equal(Number(w.net), 9800);
  assert.equal(Number((await db('payrolls').where({ id: payrollId }).first()).total), 9800);

  const page = (await supervisor.get(`/payroll/${payrollId}`).expect(200)).text;
  assert.match(page, /Test Payroll Welder/);
  assert.match(page, />5\.5</);
  assert.doesNotMatch(page, /2,000|9,800|11,000/, 'no money for supervisors');
  assert.doesNotMatch(page, /Advance 3 Mar/);
  assert.equal((await post(supervisor, `/payroll/${payrollId}/approve`)).status, 403);
  await supervisor.get(`/payroll/${payrollId}/register.xlsx`).expect(403);

  res = await post(supervisor, `/payroll/${payrollId}/check`);
  assert.equal(res.status, 302);
  assert.equal(await status(), 'checked');
});

test('approval needs everyone to have a rate; then it is locked', async () => {
  await post(manager, `/payroll/${payrollId}/approve`);
  assert.equal(await status(), 'checked', 'the painter has no rate');
  assert.match((await manager.get(`/payroll/${payrollId}`)).text, /Add a daily rate first/);

  // Rate added, back to draft, worked out again: the adjustments stay.
  await db('employees').where({ id: painter }).update({ daily_rate: 1500 });
  await post(manager, `/payroll/${payrollId}/draft`);
  await post(manager, `/payroll/${payrollId}/recalculate`);
  assert.equal(Number((await slip(painter)).net), 1500);
  assert.equal(Number((await slip(welder)).net), 9800, 'adjustments kept');
  assert.equal(Number((await db('payrolls').where({ id: payrollId }).first()).total), 11300);

  await manager.get(`/payroll/${payrollId}/slips/${(await slip(welder)).id}.pdf`).expect(409);
  await post(supervisor, `/payroll/${payrollId}/check`);
  await post(manager, `/payroll/${payrollId}/approve`);
  assert.equal(await status(), 'approved');

  // Locked: no adjustments, no recalculating; a later rate change doesn't touch it.
  await post(manager, `/payroll/${payrollId}/slips/${(await slip(welder)).id}/adjustments`, { direction: 'add', amount: '100', reason: 'Too late' });
  assert.equal(Number((await slip(welder)).net), 9800);
  await post(manager, `/payroll/${payrollId}/recalculate`);
  await db('employees').where({ id: welder }).update({ daily_rate: 9999 });
  assert.equal(Number((await slip(welder)).daily_rate), 2000);

  // Nor can the attendance it came from be reopened.
  await post(manager, '/attendance/reopen', { site: hq.id, day: days[1] });
  assert.ok(await db('attendance_confirmations').where({ site_id: hq.id, day: days[1] }).first(), 'still confirmed');
  assert.match((await manager.get(`/attendance?site=${hq.id}&day=${days[1]}`)).text, /on approved payroll PAY-/);
});

test('payslips: a small PDF and an Excel file; the register; for managers only', async () => {
  const w = await slip(welder);
  await supervisor.get(`/payroll/${payrollId}/slips/${w.id}.pdf`).expect(403);
  const pdf = await binary(manager.get(`/payroll/${payrollId}/slips/${w.id}.pdf`)).expect(200);
  assert.match(pdf.headers['content-type'], /pdf/);
  assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  assert.match(pdf.headers['content-disposition'], /Payslip 2026-03-02 - Test Payroll Welder\.pdf/);

  const xlsx = await binary(manager.get(`/payroll/${payrollId}/slips/${w.id}.xlsx`)).expect(200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx.body);
  const cells = book.worksheets[0].getSheetValues().flat().map(String);
  assert.ok(cells.includes('Test Payroll Welder'));
  assert.ok(cells.includes('Advance 3 Mar'));
  assert.ok(cells.includes('9800'));
  assert.ok(cells.includes('Half day'));

  const reg = await binary(manager.get(`/payroll/${payrollId}/register.xlsx`)).expect(200);
  const regBook = new ExcelJS.Workbook();
  await regBook.xlsx.load(reg.body);
  const regCells = regBook.worksheets[0].getSheetValues().flat().map(String);
  assert.ok(regCells.includes('Test Payroll Painter'));
  assert.ok(regCells.includes('11300'), 'the total');
  assert.match((await manager.get(`/payroll/${payrollId}`)).text, /Send on WhatsApp/);
});

test('paid one by one or all at once; then closed', async () => {
  await post(manager, `/payroll/${payrollId}/pay`, { slip: (await slip(welder)).id, method: 'mpesa', reference: 'TKX123' });
  const w = await slip(welder);
  assert.equal(w.paid_method, 'mpesa');
  assert.equal(w.paid_reference, 'TKX123');
  assert.equal(await status(), 'approved', 'the painter is still to be paid');

  await post(manager, `/payroll/${payrollId}/close`);
  assert.equal(await status(), 'approved', 'can’t close before everyone is paid');

  await post(manager, `/payroll/${payrollId}/pay`, { method: 'cash' });
  assert.equal((await slip(painter)).paid_method, 'cash');
  assert.equal((await slip(welder)).paid_method, 'mpesa', 'already paid: left alone');
  assert.equal(await status(), 'paid');

  await post(manager, `/payroll/${payrollId}/close`);
  assert.equal(await status(), 'closed');
  const list = (await manager.get('/payroll')).text;
  assert.match(list, /11,300\.00/);
  assert.doesNotMatch((await supervisor.get('/payroll')).text, /11,300/);
});
