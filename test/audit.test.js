import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db.js';
import { audit, diff, history } from '../src/core/audit.js';

// Rows written here use a made-up entity so they never mix with real history.
const ENTITY = 'test_thing';
after(async () => {
  await db('audit_log').where({ entity: ENTITY }).delete();
  await db.destroy();
});

test('diff lists only the fields that changed', () => {
  assert.deepEqual(
    diff({ name: 'Kamau', phone: '+254712345678', roles: ['Sales'] }, { name: 'Kamau N.', phone: '+254712345678', roles: ['Sales'] }),
    { name: ['Kamau', 'Kamau N.'] },
  );
});

test('diff never includes passwords or noise fields', () => {
  const changes = diff(
    { password_hash: 'a', updated_at: new Date(1), name: 'x' },
    { password_hash: 'b', updated_at: new Date(2), name: 'x' },
  );
  assert.deepEqual(changes, {});
});

test('diff treats empty text as empty and ignores list order', () => {
  assert.deepEqual(diff({ email: null, sites: ['B', 'A'] }, { email: '', sites: ['A', 'B'] }), {});
});

test('an update that changes nothing is not recorded', async () => {
  await db.transaction((trx) => audit(trx, { user: null }, { entity: ENTITY, id: 1, action: 'update', before: { a: 1 }, after: { a: 1 } }));
  assert.equal((await history(ENTITY, 1)).length, 0);
});

test('history comes back newest first with the changes', async () => {
  await db.transaction((trx) => audit(trx, { user: null }, { entity: ENTITY, id: 2, action: 'create', after: { name: 'Box body' } }));
  await db.transaction((trx) => audit(trx, { user: null, ip: '10.0.0.5' }, { entity: ENTITY, id: 2, action: 'update', before: { name: 'Box body' }, after: { name: 'Box body 16 ft' } }));
  const entries = await history(ENTITY, 2);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'update');
  assert.deepEqual(entries[0].changes, { name: ['Box body', 'Box body 16 ft'] });
  assert.equal(entries[0].by, null); // system
});

test('a change rolled back leaves no history', async () => {
  await assert.rejects(db.transaction(async (trx) => {
    await audit(trx, { user: null }, { entity: ENTITY, id: 3, action: 'create', after: { name: 'x' } });
    throw new Error('save failed');
  }));
  assert.equal((await history(ENTITY, 3)).length, 0);
});
