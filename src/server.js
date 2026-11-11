import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './core/logger.js';
import { db, dbIsUp } from './core/db.js';
import { Cron } from 'croner';
import { markInterrupted, nightly } from './modules/backups/service.js';

const app = createApp();

const server = app.listen(config.port, async (err) => {
  if (err) throw err;
  logger.info(`${config.appName} running at http://localhost:${config.port}`);

  console.log(`Server starting on port ${config.port}`);
  // Say so straight away if the database settings in .env are wrong.
  if (await dbIsUp()) {
    logger.info(`Connected to MySQL database "${config.db.database}"`);
    await markInterrupted().catch((e) => logger.error(`Backups: ${e.message}`));
  } else logger.warn(`Cannot reach MySQL at ${config.db.host}:${config.db.port} as "${config.db.user}". Check the DB_* settings in .env`);
});

// Nightly database backup at 01:00 Nairobi time, then old nightly ones are cleared out (7 days, 4 weeks, 12 months).
// protect: a slow backup never overlaps the next run.
const nightlyBackup = new Cron('0 1 * * *', { timezone: config.timezone, protect: true, name: 'nightly-backup' }, nightly);

// Finish in-flight requests, then close the database pool, before exiting
// (systemd / PM2 send SIGTERM on restart).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    nightlyBackup.stop();
    server.close(async () => {
      await db.destroy();
      process.exit(0);
    });
  });
}
