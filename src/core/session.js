import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import { csrfSync } from 'csrf-sync';
import { config } from '../config.js';

const MySQLStore = MySQLStoreFactory(session);

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

// Sessions live in the `sessions` table (created by a migration), so people
// stay logged in when the server restarts.
export const sessionStore = new MySQLStore({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  createDatabaseTable: false,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: TWELVE_HOURS,
});

export const sessionMiddleware = session({
  name: 'jt.sid',
  secret: config.sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true, // each request restarts the 12-hour clock: idle for 12 h → logged out
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd, // https only on the server (behind Caddy)
    maxAge: TWELVE_HOURS,
  },
});

// CSRF protection: every POST must carry the token from its own page, either
// as a hidden _csrf form field or an x-csrf-token header (fetch calls).
const csrf = csrfSync({
  getTokenFromRequest: (req) => req.body?._csrf ?? req.headers['x-csrf-token'],
});
export const csrfProtection = csrf.csrfSynchronisedProtection;
export const generateCsrfToken = csrf.generateToken;
