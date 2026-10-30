// Needs the MySQL database from .env with migrations run (npm run db:migrate).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db.js';

after(() => db.destroy());

test('connects to MySQL in UTC', async () => {
  const [[row]] = await db.raw("SELECT @@session.time_zone AS tz, DATABASE() AS name");
  assert.equal(row.tz, '+00:00');
  assert.ok(row.name);
});

test('migrations are up to date', async () => {
  const [, pending] = await db.migrate.list();
  assert.deepEqual(pending, [], 'run: npm run db:migrate');
});

test('sites table has the starter site', async () => {
  const site = await db('sites').where({ code: 'MAIN' }).first();
  assert.ok(site, 'run: npm run db:seed');
  assert.equal(site.is_active, 1);
});

test('the six built-in roles are seeded', async () => {
  const keys = (await db('roles').orderBy('id').select('key')).map((r) => r.key);
  assert.deepEqual(keys, ['admin', 'manager', 'supervisor', 'sales', 'storekeeper', 'technician']);
});
