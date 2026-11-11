// npm run db:restore -- <backup file>
//
// Puts a database backup back. Run it on the server with the app stopped:
//   sudo systemctl stop jometech
//   sudo -u jometech npm run db:restore -- BKP-2026-0012.sql.gz
//   sudo systemctl start jometech
//
// The file can be a name from System → Backups (looked for in storage/backups) or a full path.
// Before anything is replaced, a safety backup of the database as it is now is made.
// Then every table is dropped, the backup is loaded, and the migrations bring it up to this version of the app.
// Photos and files are restored by hand: see docs/DEPLOY.md, "Restoring a backup".
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../src/config.js';
import { db } from '../src/core/db.js';
import { backupDir, relist, restoreDatabase, startBackup, waitFor, getBackup } from '../src/modules/backups/service.js';

const say = (line = '') => stdout.write(`${line}\n`);

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    say('Which backup? e.g. npm run db:restore -- BKP-2026-0012.sql.gz');
    return 1;
  }
  const file = [arg, path.join(backupDir(), arg)].find((f) => existsSync(f));
  if (!file || !file.endsWith('.sql.gz')) {
    say(`No .sql.gz backup called "${arg}" here or in ${backupDir()}.`);
    return 1;
  }

  say(`This replaces EVERYTHING in the database "${config.db.database}" with ${path.basename(file)}.`);
  say('Anything entered since that backup is lost (a safety backup of it is made first).');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const typed = await rl.question(`Type the database name (${config.db.database}) to go ahead: `);
  rl.close();
  if (typed.trim() !== config.db.database) {
    say('Stopped. Nothing was changed.');
    return 1;
  }

  // An empty database (just created) has nothing to protect, and no backups table to record a safety backup in.
  const [[{ tables }]] = await db.raw('SELECT COUNT(*) AS tables FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  let made = null;
  if (Number(tables) === 0) {
    say('1/4 The database is empty: no safety backup needed.');
  } else {
    say('1/4 Safety backup of the database as it is now…');
    const safety = await startBackup({ kind: 'manual' });
    await waitFor(safety.id);
    made = await getBackup(safety.id);
    if (made.status !== 'done') {
      say(`    The safety backup failed (${made.error}). Stopped. Nothing was changed.`);
      return 1;
    }
    say(`    saved ${made.file_name}`);
  }

  say(`2/4 Loading ${path.basename(file)} (tables are emptied first)…`);
  await restoreDatabase(file);

  say('3/4 Bringing the tables up to this version of the app…');
  const [, done] = await db.migrate.latest();
  say(`    ${done.length ? `${done.length} update(s) applied` : 'already up to date'}`);

  say('4/4 Listing the backup files on disk again…');
  await relist();

  say(made ? `Done. If it went wrong, put the safety backup back: npm run db:restore -- ${made.file_name}` : 'Done.');
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => { say(`Restore failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
