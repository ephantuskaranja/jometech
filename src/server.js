import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './core/logger.js';
import { db, dbIsUp } from './core/db.js';

const app = createApp();

const server = app.listen(config.port, async (err) => {
  if (err) throw err;
  logger.info(`${config.appName} running at http://localhost:${config.port}`);
  // Say so straight away if the database settings in .env are wrong.
  if (await dbIsUp()) logger.info(`Connected to MySQL database "${config.db.database}"`);
  else logger.warn(`Cannot reach MySQL at ${config.db.host}:${config.db.port} as "${config.db.user}". Check the DB_* settings in .env`);
});

// Finish in-flight requests, then close the database pool, before exiting
// (systemd / PM2 send SIGTERM on restart).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await db.destroy();
      process.exit(0);
    });
  });
}
