import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let supervisor, manager, sales, home, siteB;
const day = localDay(new Date(Date.now() - 86_400_000)); // yesterday: a whole day of punches

before(async () => {
  // A site of its own: marking a whole day touches everyone at the site, and real staff must never be among them.
  const [homeId] = await db('sites').insert({ code: 'TSTATT', name: 'Test Attendance Site' });
  home = await db('sites').where({ id: homeId }).first();
  siteB = await db('sites').where({ code: 'SITEB' }).first();
  supervisor = await loginAs(app, await makeUser(76, ['supervisor'], { siteIds: [home.id, siteB.id] }));
  manager = await loginAs(app, await makeUser(77, ['manager']));
  sales = await loginAs(app, await makeUser(78, ['sales']));
});
after(cleanup);

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/employees')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}

/** The export as the ZKTeco software writes it: a title row, then the columns of the sample PDF. */
async function exportFile(rows) {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Transaction');
  ws.addRow(['Transaction']);
  ws.addRow(['First Name', 'Last Name', 'ID', 'Department', 'Date', 'Time', 'Weekday', 'Data Source', 'Device Name', 'Device Serial No.', 'Punch State']);
  for (const [first, last, id, time, device = 'TEST-HQ'] of rows) ws.addRow([first, last, id, 'JomeTech', day, time, '', 'Device', device, 'FF000T', '--']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function upload(agent, buffer, name = 'Transaction.xlsx') {
  const csrf = csrfFrom((await agent.get('/attendance/import')).text);
  return agent.post('/attendance/import').set('x-csrf-token', csrf).set('Accept', 'application/json').attach('file', buffer, name);
}

test('supervisors manage staff; only managers see and set the daily rate; sales can’t', async () => {
  await sales.get('/employees').expect(403);
  let res = await post(supervisor, '/employees', { name: '', site_id: home.id });
  assert.equal(res.status, 422);
  assert.match(res.text, /Enter their name/);
  assert.doesNotMatch(res.text, /Daily rate/, 'no pay box for supervisors');

  res = await post(supervisor, '/employees', { name: 'Test Welder Otieno', site_id: home.id, trade: 'Welder', clock_ids: '77901', daily_rate: '5,000' });
  assert.equal(res.status, 302, res.text);
  const e = await db('employees').where({ name: 'Test Welder Otieno' }).first();
  assert.match(e.number, /^EMP-\d{4}$/);
  assert.equal(e.daily_rate, null, 'a supervisor can’t set pay');

  await post(manager, `/employees/${e.id}`, { name: 'Test Welder Otieno', site_id: home.id, trade: 'Welder', clock_ids: '77901, 77902', daily_rate: '1,800' });
  const after = await db('employees').where({ id: e.id }).first();
  assert.equal(Number(after.daily_rate), 1800);
  assert.deepEqual(await db('employee_clock_ids').where({ employee_id: e.id }).orderBy('clock_id').pluck('clock_id'), ['77901', '77902']);
  assert.match((await manager.get('/employees')).text, /1,800\.00/);
  const forSupervisor = (await supervisor.get(`/employees/${e.id}`)).text;
  assert.doesNotMatch(forSupervisor, /1,800/, 'not on the page');
  assert.doesNotMatch(forSupervisor, /Daily rate/, 'not even in the history');

  // A supervisor's edit leaves the rate alone.
  await post(supervisor, `/employees/${e.id}`, { name: 'Test Welder Otieno', site_id: home.id, trade: 'Welder', clock_ids: '77901, 77902' });
  assert.equal(Number((await db('employees').where({ id: e.id }).first()).daily_rate), 1800);

  res = await post(supervisor, '/employees', { name: 'Test Someone Else', site_id: home.id, clock_ids: '77902' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Clock ID 77902 is already Test Welder Otieno’s/);
});

test('the export is imported; the same file twice adds nothing; unknown clock IDs are listed', async () => {
  const file = await exportFile([
    ['Test Welder', 'Otieno', '77901', '07:10'], ['Test Welder', 'Otieno', '77901', '13:00'], ['Test Welder', 'Otieno', '77901', '13:30'], ['Test Welder', 'Otieno', '77901', '17:05'],
    ['Test Kelvin', 'Mbuthia', '77961', '07:30'], ['Test Kelvin', 'Mbuthia', '77967', '13:01'],
    ['TEST GEORGE', 'ANDAYE', '77962', '07:39', 'TEST-B'], ['TEST GEORGE', 'ANDAYE', '77962', '07:41', 'TEST-B'],
  ]);
  let res = await upload(supervisor, file);
  assert.deepEqual(res.body, { go: '/attendance/import' });
  let page = (await supervisor.get('/attendance/import')).text;
  assert.match(page, /8 new punches imported/);
  assert.match(page, /TEST-HQ/);
  assert.match(page, /Test Kelvin Mbuthia/);
  assert.match(page, /Same name as clock ID 77967/, 'two IDs, one name');

  await upload(supervisor, file);
  assert.match((await supervisor.get('/attendance/import')).text, /0 new punches imported.*8 were already in/s);
  res = await upload(supervisor, Buffer.from('hello'), 'notes.csv');
  assert.match((await supervisor.get('/attendance/import')).text, /No ID, Date and Time columns were found/);

  // Machines get a site: managers set it, supervisors can't.
  const devices = await db('clock_devices').whereIn('name', ['TEST-HQ', 'TEST-B']).select('id', 'name');
  const id = (name) => devices.find((d) => d.name === name).id;
  assert.equal((await post(supervisor, `/attendance/machines/${id('TEST-HQ')}`, { site_id: home.id })).status, 403);
  await post(manager, `/attendance/machines/${id('TEST-HQ')}`, { site_id: home.id });
  await post(manager, `/attendance/machines/${id('TEST-B')}`, { site_id: siteB.id });
  assert.equal((await db('clock_devices').where({ id: id('TEST-HQ') }).first()).site_id, home.id);
});

test('unknown clock IDs become employees in one go: one person per name, at the machine’s site', async () => {
  const csrf = csrfFrom((await supervisor.get('/attendance/import')).text);
  const res = await supervisor.post('/attendance/clock-ids').type('form').send({
    _csrf: csrf,
    clock_id: ['77961', '77967', '77962'], clock_name: ['Test Kelvin Mbuthia', 'Test Kelvin Mbuthia', 'TEST GEORGE ANDAYE'],
    site_id: [home.id, home.id, siteB.id], choice: ['new', 'new', 'new'],
  });
  assert.equal(res.status, 302);
  const kelvin = await db('employees').where({ name: 'Test Kelvin Mbuthia' }).select('id');
  assert.equal(kelvin.length, 1, 'one person with both IDs');
  assert.deepEqual(await db('employee_clock_ids').where({ employee_id: kelvin[0].id }).orderBy('clock_id').pluck('clock_id'), ['77961', '77967']);
  const george = await db('employees').where({ name: 'Test George Andaye' }).first();
  assert.ok(george, 'capitals tidied');
  assert.equal(george.site_id, siteB.id, 'at the machine’s site');
});

test('the day is filled in from the punches; the supervisor changes it, saves and confirms', async () => {
  let page = (await supervisor.get(`/attendance?day=${day}&site=${home.id}`).expect(200)).text;
  assert.match(page, /Test Welder Otieno/);
  assert.match(page, /07:10/);
  assert.match(page, />9\.42</, 'hours, lunch excluded');
  assert.match(page, />5.52</, 'Kelvin: 07:30 and 13:01 only, so home at lunch');
  assert.doesNotMatch(page, /Test George Andaye/, 'works at Site B');

  const otieno = await db('employees').where({ name: 'Test Welder Otieno' }).first('id');
  const kelvin = await db('employees').where({ name: 'Test Kelvin Mbuthia' }).first('id');
  const grid = await db('employees').where({ site_id: home.id, is_active: true }).orderBy('name').pluck('id');
  // Confirming needs everyone at the site marked.
  let res = await post(supervisor, '/attendance', { site: home.id, day, action: 'confirm', row_employee: [otieno.id, kelvin.id], row_status: ['present', 'half'], row_note: ['', 'Left at lunch'] });
  const others = grid.filter((g) => ![otieno.id, kelvin.id].includes(g));
  if (others.length) {
    assert.match((await supervisor.get(`/attendance?day=${day}&site=${home.id}`)).text, /Mark everyone before confirming/);
    res = await post(supervisor, '/attendance', { site: home.id, day, action: 'confirm', row_employee: grid, row_status: grid.map((g) => (g === kelvin.id ? 'half' : g === otieno.id ? 'present' : 'absent')), row_note: grid.map(() => '') });
  }
  assert.equal(res.status, 302);
  const k = await db('attendance_days').where({ employee_id: kelvin.id, day }).first();
  assert.equal(k.status, 'half');
  assert.equal(k.note, 'Left at lunch');
  assert.equal(k.first_in.slice(0, 5), '07:30');
  assert.ok(await db('attendance_confirmations').where({ site_id: home.id, day }).first(), 'confirmed');

  // Locked: no more changes until a manager reopens it.
  page = (await supervisor.get(`/attendance?day=${day}&site=${home.id}`)).text;
  assert.match(page, /Confirmed by/);
  assert.doesNotMatch(page, /Reopen to change it/, 'supervisors can’t reopen');
  await post(supervisor, '/attendance', { site: home.id, day, row_employee: [kelvin.id], row_status: ['present'] });
  assert.equal((await db('attendance_days').where({ employee_id: kelvin.id, day }).first()).status, 'half');
  assert.equal((await post(supervisor, '/attendance/reopen', { site: home.id, day })).status, 403);
  await post(manager, '/attendance/reopen', { site: home.id, day });
  assert.equal(await db('attendance_confirmations').where({ site_id: home.id, day }).first(), undefined);

  // The employee's page shows the day.
  assert.match((await supervisor.get(`/employees/${kelvin.id}`)).text, /Half day[\s\S]*Left at lunch/);
});

test('a day with no punches imported suggests nothing; the last day marked can fill it', async () => {
  const page = (await supervisor.get(`/attendance?site=${home.id}`)).text; // today: after the day marked above
  assert.match(page, /No punches imported for this day/);
  assert.match(page, /Fill the empty ones from it/);
  assert.match((await supervisor.get(`/attendance?day=2099-01-01&site=${home.id}`)).text, /\(today\)/, 'no future days');
});
