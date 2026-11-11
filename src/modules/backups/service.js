import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { config } from '../../config.js';
import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { logger } from '../../core/logger.js';
import { httpError } from '../../core/validate.js';

// Backups (System → Backups, requirements §54).
// The database is dumped with mysqldump --single-transaction (people keep working), gzipped,
// into storage/backups. Optionally the stored files (photos, signatures) go in a .tar.gz beside it.
// Not encrypted (user's choice): downloading needs the admin's password again.

export const backupDir = () => path.join(config.storageDir, 'backups');
const SYSTEM = { user: null };
const PRE_DEPLOY = /^pre-deploy-\d{8}-\d{6}\.sql\.gz$/; // made by scripts/deploy.sh
const OURS = /^(BKP-(\d{4})-(\d+))\.sql\.gz$/;              // made here; unlisted only after a restore brought back an older list

/** Backups still running in this process, so tests (and the nightly job) can wait for one. */
const running = new Map();
export const waitFor = (id) => running.get(id) ?? Promise.resolve();

async function sha256Of(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Runs a program; rejects with the end of what it printed to stderr when it fails. */
function run(command, args, { stdout = null, stdin = null, cwd, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const piped = Promise.all([stdout ? stdout(child.stdout) : null, stdin ? stdin(child.stdin) : null]);
    child.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? `${command} wasn’t found. Set its path in .env (MYSQLDUMP_PATH / MYSQL_PATH).` : err.message)));
    child.on('close', (code) => {
      piped.then(() => (okCodes.includes(code) ? resolve() : reject(new Error(stderr.trim().split('\n').filter((l) => !/Using a password|\[Warning\]/i.test(l)).join(' ').slice(-500) || `${path.basename(command)} stopped with code ${code}`))), reject);
    });
  });
}

/** MySQL login details in a file only this user can read, never on the command line. */
async function withLoginFile(fn) {
  const file = path.join(os.tmpdir(), `jt-mysql-${randomBytes(8).toString('hex')}.cnf`);
  const { host, port, user, password } = config.db;
  const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  await writeFile(file, `[client]\nhost=${quote(host)}\nport=${port}\nuser=${quote(user)}\npassword=${quote(password)}\n`, { mode: 0o600 });
  try { return await fn(file); } finally { await rm(file, { force: true }); }
}

async function dumpDatabase(target) {
  await withLoginFile((login) => run(config.backups.mysqldump, [
    `--defaults-extra-file=${login}`, '--single-transaction', '--quick', '--routines', '--triggers', '--no-tablespaces',
    config.db.database,
  ], { stdout: (out) => pipeline(out, createGzip(), createWriteStream(target)) }));
}

/** Everything in storage except the backups themselves. tar runs inside the backup folder, so the archive name has no drive letter. */
async function archiveFiles(target) {
  await run('tar', ['-czf', path.basename(target), '-C', config.storageDir, '--exclude=./backups', '.'], {
    cwd: path.dirname(target),
    okCodes: [0, 1], // GNU tar: 1 = a file changed while being read (a photo saved meanwhile); the archive is still fine
  });
}

/**
 * Starts a backup in the background and returns its row id. Only one at a time.
 * @param {{ kind: 'manual' | 'nightly', withFiles?: boolean, actor?: object }} options
 */
export async function startBackup({ kind, withFiles = false, actor = SYSTEM }) {
  await mkdir(backupDir(), { recursive: true });
  const { id, number } = await db.transaction(async (trx) => {
    const busy = await trx('system_backups').where({ status: 'running' }).forUpdate().first('number');
    if (busy) throw httpError(409, `${busy.number} is still running. Wait for it to finish.`);
    const number = await nextNumber(trx, 'backup');
    const [id] = await trx('system_backups').insert({
      number, kind, with_files: withFiles, file_name: `${number}.sql.gz`, files_name: withFiles ? `${number}-files.tar.gz` : null,
      created_by: actor.user?.id ?? null,
    });
    await audit(trx, actor, { entity: 'backup', id, action: 'create', summary: `${number}${withFiles ? ' with photos and files' : ''}` });
    return { id, number };
  });
  const job = runBackup(id).finally(() => running.delete(id));
  running.set(id, job);
  return { id, number };
}

async function runBackup(id) {
  const row = await db('system_backups').where({ id }).first();
  const dbFile = path.join(backupDir(), row.file_name);
  const filesFile = row.files_name ? path.join(backupDir(), row.files_name) : null;
  try {
    await dumpDatabase(dbFile);
    const result = { size_bytes: (await stat(dbFile)).size, sha256: await sha256Of(dbFile) };
    if (filesFile) {
      await archiveFiles(filesFile);
      Object.assign(result, { files_size_bytes: (await stat(filesFile)).size, files_sha256: await sha256Of(filesFile) });
    }
    await db('system_backups').where({ id }).update({ ...result, status: 'done', finished_at: db.fn.now() });
    logger.info(`Backup ${row.number} done`);
  } catch (err) {
    for (const file of [dbFile, filesFile]) if (file) await rm(file, { force: true });
    await db('system_backups').where({ id }).update({ status: 'failed', error: String(err.message).slice(0, 1000), finished_at: db.fn.now() });
    logger.error(`Backup ${row.number} failed: ${err.message}`);
  }
}

/** On startup: a backup that was running when the app stopped will never finish. */
export async function markInterrupted() {
  const rows = await db('system_backups').where({ status: 'running' }).select('id', 'file_name', 'files_name');
  for (const r of rows) {
    if (running.has(r.id)) continue;
    for (const f of [r.file_name, r.files_name]) if (f) await rm(path.join(backupDir(), f), { force: true });
    await db('system_backups').where({ id: r.id }).update({ status: 'failed', error: 'The app restarted while this backup was running. Start another.', finished_at: db.fn.now() });
  }
}

/**
 * Keeps the table in step with the folder: lists the deploy script's own backups,
 * and forgets files that are gone (the deploy script keeps only its last 10).
 */
async function syncWithDisk() {
  await mkdir(backupDir(), { recursive: true });
  const onDisk = new Set(await readdir(backupDir()));
  const known = await db('system_backups').select('id', 'kind', 'file_name');
  const knownNames = new Set(known.map((r) => r.file_name));
  // Only the deploy script's own files are forgotten when gone; a missing manual or nightly file stays listed, so it shows.
  for (const r of known) {
    if (r.kind === 'pre_deploy' && !onDisk.has(r.file_name)) await db('system_backups').where({ id: r.id }).delete();
  }
  for (const name of onDisk) {
    const ours = OURS.exec(name);
    if ((!ours && !PRE_DEPLOY.test(name)) || knownNames.has(name)) continue;
    const file = path.join(backupDir(), name);
    const info = await stat(file);
    const row = { status: 'done', file_name: name, size_bytes: info.size, sha256: await sha256Of(file), started_at: info.mtime, finished_at: info.mtime };
    if (ours) {
      const [, number, year, count] = ours;
      const files = `${number}-files.tar.gz`;
      if (onDisk.has(files)) {
        const f = path.join(backupDir(), files);
        Object.assign(row, { with_files: true, files_name: files, files_size_bytes: (await stat(f)).size, files_sha256: await sha256Of(f) });
      }
      await db('system_backups').insert({ ...row, number, kind: 'manual' }).onConflict('file_name').ignore();
      // The counter came back with the old database: move it past this file, so the next backup doesn't reuse its number.
      await db.raw('INSERT INTO `number_sequences` (`seq_key`, `period`, `counter`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `counter` = GREATEST(`counter`, VALUES(`counter`))', ['BKP', year, Number(count)]);
    } else {
      await db('system_backups').insert({ ...row, kind: 'pre_deploy' }).onConflict('file_name').ignore();
    }
  }
}

/**
 * Puts a .sql.gz backup back (scripts/restore.js; the app should be stopped).
 * Every table is dropped first, so tables made after the backup don't linger; the caller then runs the migrations.
 */
export async function restoreDatabase(file) {
  await db.transaction(async (trx) => {
    await trx.raw('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await trx.raw('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    for (const { name } of tables) await trx.raw('DROP TABLE IF EXISTS ??', [name]);
    await trx.raw('SET FOREIGN_KEY_CHECKS = 1');
  });
  await withLoginFile((login) => run(config.backups.mysql, [`--defaults-extra-file=${login}`, config.db.database], {
    stdin: (input) => pipeline(createReadStream(file), createGunzip(), input),
  }));
}

/** After a restore: list the files on disk again (the restored list is older) and move the counter past them. */
export const relist = syncWithDisk;

export async function listBackups() {
  await syncWithDisk();
  return db('system_backups as b').leftJoin('users as u', 'u.id', 'b.created_by')
    .orderBy('b.started_at', 'desc').orderBy('b.id', 'desc')
    .select('b.*', 'u.name as created_name');
}

export const getBackup = (id) => db('system_backups').where({ id }).first();
export const isRunning = async () => Boolean(await db('system_backups').where({ status: 'running' }).first('id'));

/** Space left where backups are kept, for the page header. */
export async function diskSpace() {
  try {
    const s = await statfs(backupDir());
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

/** Full path of a backup's file; `which` = 'db' or 'files'. Null when it isn't there. */
export function filePath(backup, which) {
  const name = which === 'files' ? backup.files_name : backup.file_name;
  return backup.status === 'done' && name ? path.join(backupDir(), name) : null;
}

/** "Check": the file still matches the checksum taken when it was made, and unpacks without error. */
export async function checkBackup(id, actor) {
  const backup = await getBackup(id);
  if (!backup || backup.status !== 'done') throw httpError(404, 'That backup doesn’t exist.');
  const problems = [];
  for (const [which, sum] of [['db', backup.sha256], ['files', backup.files_sha256]]) {
    const file = filePath(backup, which);
    if (!file) continue;
    try {
      if (await sha256Of(file) !== sum) problems.push(which === 'db' ? 'the database file has changed since it was made' : 'the files archive has changed since it was made');
      await pipeline(createReadStream(file), createGunzip(), async (source) => { for await (const chunk of source) void chunk; });
    } catch (err) {
      problems.push(err.code === 'ENOENT' ? 'the file is missing' : 'the file is damaged and won’t unpack');
    }
  }
  const ok = problems.length === 0;
  await db.transaction(async (trx) => {
    await trx('system_backups').where({ id }).update({ checked_at: trx.fn.now(), check_ok: ok });
    await audit(trx, actor, { entity: 'backup', id, action: 'checked', summary: ok ? 'File is good' : problems.join('; ') });
  });
  return { ok, problems };
}

export async function deleteBackup(id, actor) {
  const backup = await getBackup(id);
  if (!backup) throw httpError(404, 'That backup doesn’t exist.');
  if (backup.status === 'running') throw httpError(409, 'Wait for it to finish first.');
  for (const name of [backup.file_name, backup.files_name]) if (name) await rm(path.join(backupDir(), name), { force: true });
  await db.transaction(async (trx) => {
    await trx('system_backups').where({ id }).delete();
    await audit(trx, actor, { entity: 'backup', id, action: 'delete', summary: backup.number ?? backup.file_name });
  });
}

const nairobi = (date, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, ...opts }).format(date);
const dayKey = (d) => nairobi(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
const monthKey = (d) => nairobi(d, { year: 'numeric', month: '2-digit' });
/** Monday of the week, as a day key. */
const weekKey = (d) => {
  const local = new Date(`${dayKey(d)}T00:00:00Z`);
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  return local.toISOString().slice(0, 10);
};

/**
 * Which nightly backups to keep: the newest of each of the last 7 days, 4 weeks and 12 months.
 * @param {{ id: number, started_at: Date }[]} rows newest first
 */
export function toKeep(rows, { days = 7, weeks = 4, months = 12 } = {}) {
  const keep = new Set();
  for (const [key, limit] of [[dayKey, days], [weekKey, weeks], [monthKey, months]]) {
    const seen = new Set();
    for (const r of rows) {
      const k = key(new Date(r.started_at));
      if (seen.has(k)) continue;
      if (seen.size === limit) break;
      seen.add(k);
      keep.add(r.id);
    }
  }
  return keep;
}

/** Clears out old nightly backups (manual and pre-deploy ones are left alone). Failed nightly rows go after a week. */
export async function applyRetention() {
  const rows = await db('system_backups').where({ kind: 'nightly', status: 'done' }).orderBy('started_at', 'desc').orderBy('id', 'desc').select('id', 'started_at');
  const keep = toKeep(rows);
  for (const r of rows) if (!keep.has(r.id)) await deleteBackup(r.id, SYSTEM);
  await db('system_backups').where({ kind: 'nightly', status: 'failed' }).where('started_at', '<', db.raw('NOW() - INTERVAL 7 DAY')).delete();
}

/** The nightly job: a database backup, then the clear-out. */
export async function nightly() {
  try {
    const { id } = await startBackup({ kind: 'nightly' });
    await waitFor(id);
    await applyRetention();
  } catch (err) {
    logger.error(`Nightly backup: ${err.message}`);
  }
}
