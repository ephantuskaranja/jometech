// Knex settings, used by both the app (src/core/db.js) and the
// `npm run db:*` commands. Connection details come from .env.
import { config } from './src/config.js';

export default {
  client: 'mysql2',
  connection: {
    ...config.db,
    charset: 'utf8mb4',
    // Dates are stored in UTC and shown in Nairobi time by the app.
    timezone: 'Z',
    connectTimeout: 5000,
    // DECIMAL columns (money, quantities) come back as strings so no cents are
    // lost to floating point. Convert them deliberately where you calculate.
  },
  pool: {
    min: 0,
    max: 10,
    // Make NOW() / CURRENT_TIMESTAMP use UTC too, matching `timezone: 'Z'`.
    afterCreate(conn, done) {
      conn.query("SET time_zone = '+00:00'", (err) => done(err, conn));
    },
  },
  // Fail fast when MySQL is down, instead of waiting the default 60 s.
  acquireConnectionTimeout: 10000,
  migrations: {
    directory: './db/migrations',
    tableName: 'knex_migrations',
    loadExtensions: ['.js'],
    stub: './db/migration.stub',
  },
  seeds: {
    directory: './db/seeds',
    loadExtensions: ['.js'],
  },
};
