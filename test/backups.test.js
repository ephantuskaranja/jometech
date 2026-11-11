import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Backups go to a folder of their own, so the app's real storage/backups is never touched.
// Set before the app (and its config) is loaded.
const storage = mkdtempSync(path.join(os.tmpdir(), 'jt-backups-test-'));
process.env.STORAGE_DIR = storage;
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { db } = await import('../src/core/db.js');
const backups = await import('../src/modules/backups/service.js');
const { makeUser, loginAs, csrfFrom, cleanup, PASSWORD } = await import('./helpers.js');

const app = createApp();
const canDump = spawnSync(config.backups.mysqldump, ['--version']).status === 0;
const needsDump = canDump ? {} : { skip: `${config.backups.mysqldump} not found (set MYSQLDUMP_PATH)` };
let admin, manager, existing, auditBefore;

before(async () => {
  existing = await db('system_backups').pluck('id');
  auditBefore = (await db('audit_log').max('id as m').first()).m ?? 0;
  admin = await loginAs(app, await makeUser(34, ['admin']));
  manager = await loginAs(app, await makeUser(40, ['manager']));
});

after(async () => {
  // Only what this file made: backups that weren't there before, and backup history written since.
  await db('audit_log').where({ entity: 'backup' }).where('id', '>', auditBefore).delete();
  await db('system_backups').whereNotIn('id', existing).delete();
  rmSync(storage, { recursive: true, force: true });
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const mkdirp = (dir) => mkdirSync(dir, { recursive: true });
const latest = () => db('system_backups').whereNotIn('id', existing).orderBy('id', 'desc').first();

test('only admins see Backups', async () => {
  await admin.get('/admin/backups').expect(200);
  await manager.get('/admin/backups').expect(403);
  assert.equal((await post(manager, '/admin/backups')).status, 403);
  assert.match((await admin.get('/')).text, /href="\/admin\/backups"/);
  assert.doesNotMatch((await manager.get('/')).text, /href="\/admin\/backups"/);
});

test('Back up now: the database, and the photos and files when ticked', needsDump, async () => {
  mkdirp(path.join(storage, 'photos'));
  writeFileSync(path.join(storage, 'photos', 'test.txt'), 'a photo');
  const res = await post(admin, '/admin/backups', { with_files: '1' });
  assert.equal(res.status, 302);
  const started = await latest();
  assert.equal(started.kind, 'manual');
  await backups.waitFor(started.id);

  const b = await latest();
  assert.equal(b.status, 'done', b.error);
  assert.ok(b.size_bytes > 1000 && b.sha256.length === 64);
  assert.ok(existsSync(path.join(storage, 'backups', b.file_name)));
  assert.ok(existsSync(path.join(storage, 'backups', b.files_name)), 'photos and files beside it');
  const tar = spawnSync('tar', ['-tzf', b.files_name], { cwd: path.join(storage, 'backups'), encoding: 'utf8' });
  assert.match(tar.stdout, /photos\/test\.txt/);
  assert.doesNotMatch(tar.stdout, /backups\//, 'backups aren’t backed up inside themselves');

  const page = (await admin.get('/admin/backups')).text;
  assert.match(page, new RegExp(b.number));
  assert.match(page, /with photos and files/);
});

test('Check finds a damaged file', needsDump, async () => {
  const b = await latest();
  let res = await post(admin, `/admin/backups/${b.id}/check`);
  assert.equal(res.status, 302);
  assert.equal((await latest()).check_ok, 1);

  appendFileSync(path.join(storage, 'backups', b.file_name), 'junk');
  await post(admin, `/admin/backups/${b.id}/check`);
  assert.equal((await latest()).check_ok, 0);
  res = await admin.get('/admin/backups');
  assert.match(res.text, /has a problem: the database file has changed/);
});

test('download and delete need the password again, and are recorded', needsDump, async () => {
  const b = await latest();
  let res = await post(admin, `/admin/backups/${b.id}/download`, { which: 'db', password: 'wrong-one' });
  assert.equal(res.status, 302);
  assert.match((await admin.get('/admin/backups')).text, /Wrong password\. Nothing was downloaded/);

  res = await post(admin, `/admin/backups/${b.id}/download`, { which: 'files', password: PASSWORD });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], new RegExp(`${b.number}-files\\.tar\\.gz`));
  assert.ok(await db('audit_log').where({ entity: 'backup', entity_id: b.id, action: 'downloaded' }).first());

  await post(admin, `/admin/backups/${b.id}/delete`, { password: 'wrong-one' });
  assert.ok(await backups.getBackup(b.id), 'still there');
  res = await post(admin, `/admin/backups/${b.id}/delete`, { password: PASSWORD });
  assert.equal(res.status, 302);
  assert.equal(await backups.getBackup(b.id), undefined);
  assert.ok(!existsSync(path.join(storage, 'backups', b.file_name)));
  assert.ok(!existsSync(path.join(storage, 'backups', b.files_name)));
});

test('one backup at a time; one left running by a restart is marked failed', async () => {
  const [id] = await db('system_backups').insert({ number: 'BKP-TEST-RUN', kind: 'manual', status: 'running', file_name: 'BKP-TEST-RUN.sql.gz' });
  let res = await post(admin, '/admin/backups');
  assert.equal(res.status, 302);
  assert.match((await admin.get('/admin/backups')).text, /BKP-TEST-RUN is still running/);
  assert.deepEqual((await admin.get('/api/admin/backups/running')).body, { running: true });

  await backups.markInterrupted();
  const row = await backups.getBackup(id);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /app restarted/);
});

test('the deploy script’s backups are listed, and dropped from the list once the file is gone', async () => {
  mkdirp(path.join(storage, 'backups'));
  const name = 'pre-deploy-20261111-010203.sql.gz';
  writeFileSync(path.join(storage, 'backups', name), 'x');
  assert.match((await admin.get('/admin/backups')).text, /Before an app update/);
  assert.equal((await db('system_backups').where({ file_name: name }).first()).kind, 'pre_deploy');
  rmSync(path.join(storage, 'backups', name));
  await admin.get('/admin/backups');
  assert.equal(await db('system_backups').where({ file_name: name }).first(), undefined);
});

test('nightly clear-out keeps the newest of the last 7 days, 4 weeks and 12 months', () => {
  // One backup a night at 01:00 Nairobi (22:00 UTC the day before) for 400 nights, newest first.
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push({ id: 1000 - i, started_at: new Date(Date.UTC(2026, 10, 10, 22) - i * 86_400_000) });
  const keep = backups.toKeep(rows);
  for (let i = 0; i < 7; i++) assert.ok(keep.has(rows[i].id), `night ${i} kept`);
  assert.ok(keep.size <= 23, `${keep.size} kept`);
  assert.ok(!keep.has(rows[399].id), 'over a year old: gone');
  const months = new Set([...keep].map((id) => rows.find((r) => r.id === id).started_at.toISOString().slice(0, 7)));
  assert.ok(months.size >= 12, 'one for each of the last 12 months');
});
