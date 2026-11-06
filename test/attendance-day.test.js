import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/modules/attendance/day.js';
import { readDay, readTime, punchState, parseCsv } from '../src/modules/attendance/read-punches.js';

const rules = { fullDayHours: 7, halfDayHours: 3.5 };
const day = (...times) => summarize(times.map((t) => (Array.isArray(t) ? { time: t[0], state: t[1] } : { time: t, state: null })), rules);

test('a full day with lunch: lunch is not counted', () => {
  const d = day('07:09', '13:00', '13:30', '17:05');
  assert.equal(d.first_in, '07:09');
  assert.equal(d.last_out, '17:05');
  assert.equal(d.hours, 9.43);
  assert.equal(d.status, 'present');
  assert.equal(d.flag, null);
});

test('a punch pressed twice counts once (Michael Kimotho at 07:44 and 07:50 is two: six minutes apart)', () => {
  assert.deepEqual(day('07:44', '07:46', '17:00').punches, ['07:44', '17:00']);
  assert.deepEqual(day('07:44', '07:50', '17:00').punches, ['07:44', '07:50', '17:00']);
  assert.equal(day('07:44', '07:50', '17:00').first_in, '07:44');
});

test('home at lunch is a half day; arriving after lunch too', () => {
  assert.deepEqual([day('07:30', '13:00').status, day('07:30', '13:00').hours], ['half', 5.5]);
  assert.deepEqual([day('13:30', '17:15').status, day('13:30', '17:15').hours], ['half', 3.75]);
});

test('no evening punch is flagged, not guessed (the sample export was taken at 17:20)', () => {
  const d = day('07:09', '13:02', '13:39');
  assert.equal(d.flag, 'no_out');
  assert.equal(d.last_out, null);
  assert.equal(d.hours, null);
  assert.equal(day('07:09').flag, 'no_out');
});

test('a short day is absent, flagged for the supervisor', () => {
  const d = day('15:40', '17:00');
  assert.equal(d.status, 'absent');
  assert.equal(d.flag, 'short');
});

test('punch states decide when the machine gives them: 1 in, 3 lunch out, 4 lunch in, 2 out', () => {
  const d = day(['07:00', 1], ['12:30', 3], ['14:00', 4], ['16:00', 2]);
  assert.equal(d.hours, 7.5);
  assert.equal(d.status, 'present');
  assert.equal(day(['07:00', 1], ['12:30', 3]).last_out, '12:30', 'out for lunch and not back');
});

test('reading the export: dates, times and punch states', () => {
  assert.equal(readDay('2026-10-30'), '2026-10-30');
  assert.equal(readDay('30/10/2026'), '2026-10-30');
  assert.equal(readDay('31/02/2026'), null);
  assert.equal(readDay(new Date(Date.UTC(2026, 9, 30, 7, 9))), '2026-10-30');
  assert.equal(readTime('7:09'), '07:09:00');
  assert.equal(readTime('2026-10-30 13:02:41'), '13:02:41');
  assert.equal(readTime('01:30 PM'), '13:30:00');
  assert.equal(readTime(0.5), '12:00:00');
  assert.deepEqual(['1', '2', '3', '4', '--', 'Check In', 'Break Out', ''].map(punchState), [1, 2, 3, 4, null, 1, 3, null]);
  assert.deepEqual(parseCsv('a;b\n"x;1";"say ""hi"""'), [['a', 'b'], ['x;1', 'say "hi"']]);
});
