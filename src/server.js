import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './core/logger.js';

const app = createApp();

const server = app.listen(config.port, (err) => {
  if (err) throw err;
  logger.info(`${config.appName} running at http://localhost:${config.port}`);
});

// Finish in-flight requests before exiting (systemd / PM2 send SIGTERM on restart).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
