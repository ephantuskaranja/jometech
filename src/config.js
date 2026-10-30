// Every setting the app reads from the environment lives here, so the rest
// of the code imports `config` instead of touching process.env directly.
// Values come from .env (loaded by `node --env-file-if-exists=.env`).

const env = process.env.NODE_ENV ?? 'development';

export const config = {
  env,
  isProd: env === 'production',
  // Node's test runner sets NODE_TEST_CONTEXT in the processes it starts.
  isTest: Boolean(process.env.NODE_TEST_CONTEXT),
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Signs the login cookie. Must be long and random on the server.
  sessionSecret: process.env.SESSION_SECRET ?? (env === 'production' ? undefined : 'dev-only-not-secret'),
  appName: 'Jome-Tech',
  timezone: 'Africa/Nairobi',
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_DATABASE ?? 'jometech',
    user: process.env.DB_USERNAME ?? 'jometech',
    password: process.env.DB_PASSWORD ?? '',
  },
};

if (!config.sessionSecret) {
  throw new Error('SESSION_SECRET is missing from .env. Generate one with: node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"');
}
