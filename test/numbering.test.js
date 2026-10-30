import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db.js';
import { nextNumber, NUMBER_FORMATS } from '../src/core/numbering.js';

// Test-only document types, so the real counters (JOB, CUS…) are never touched.
NUMBER_FORMATS.testYearly = { prefix: 'TST', yearly: true };
NUMBER_FORMATS.testPlain = { prefix: 'TSP', yearly: false };
const clear = () => db('number_sequences').whereIn('seq_key', ['TST', 'TSP']).delete();

before(clear);
after(async () => { await clear(); await db.destroy(); });

const take = (type, date) => db.transaction((trx) => nextNumber(trx, type, date));
const nov2026 = new Date('2026-11-02T08:00:00Z');

test('numbers count up, padded to four digits', async () => {
  assert.equal(await take('testYearly', nov2026), 'TST-2026-0001');
  assert.equal(await take('testYearly', nov2026), 'TST-2026-0002');
  assert.equal(await take('testPlain'), 'TSP-0001');
});

test('yearly numbers restart in January, Nairobi time', async () => {
  // 21:30 UTC on 31 December is already 00:30 on 1 January in Nairobi.
  assert.equal(await take('testYearly', new Date('2026-12-31T21:30:00Z')), 'TST-2027-0001');
  assert.equal(await take('testYearly', nov2026), 'TST-2026-0003');
});

test('a failed save gives its number back (no gaps)', async () => {
  await assert.rejects(db.transaction(async (trx) => {
    await nextNumber(trx, 'testPlain');
    throw new Error('save failed');
  }), /save failed/);
  assert.equal(await take('testPlain'), 'TSP-0002');
});

test('people saving at the same moment get different numbers', async () => {
  const numbers = await Promise.all(Array.from({ length: 8 }, () => db.transaction(async (trx) => {
    const n = await nextNumber(trx, 'testPlain');
    await new Promise((r) => setTimeout(r, 20)); // hold the transaction open a little
    return n;
  })));
  assert.deepEqual([...numbers].sort(), ['TSP-0003', 'TSP-0004', 'TSP-0005', 'TSP-0006', 'TSP-0007', 'TSP-0008', 'TSP-0009', 'TSP-0010']);
});

test('refuses to run outside a transaction', async () => {
  await assert.rejects(nextNumber(db, 'testPlain'), /must run inside db.transaction/);
});
