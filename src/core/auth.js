import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { db } from './db.js';
import { httpError } from './validate.js';

// ---------- Passwords ----------

export const hashPassword = (plain) => argon2.hash(plain); // argon2id with safe defaults

export async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false; // malformed hash
  }
}

/**
 * Temporary password an admin reads out or sends to someone, e.g. "k7mq-x2pd-9fha".
 * No 0/o, 1/l/i, so it's easy to read and type on a phone.
 */
export function generateTempPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

// Checked when nobody has the phone number entered, so a wrong phone number
// takes as long as a wrong password and doesn't reveal who has an account.
let dummyHash;
export async function burnPasswordCheck(plain) {
  dummyHash ??= await hashPassword('not-a-real-password');
  await verifyPassword(dummyHash, plain);
}

// ---------- Logged-in user ----------

/**
 * Loads an active user with their roles, permissions and sites.
 * The result is what views see as `user` and routes see as `req.user`.
 */
export async function loadUser(id) {
  const user = await db('users')
    .where({ id, is_active: true })
    .first('id', 'name', 'phone', 'email', 'theme', 'must_change_password', 'default_site_id');
  if (!user) return null;

  const roles = await db('roles')
    .join('user_roles', 'roles.id', 'user_roles.role_id')
    .where('user_roles.user_id', id)
    .select('roles.id', 'roles.key', 'roles.name', 'roles.all_sites');

  const isAdmin = roles.some((r) => r.key === 'admin');
  const permissions = new Set(
    roles.length === 0 ? [] : (await db('permissions')
      .join('role_permissions', 'permissions.id', 'role_permissions.permission_id')
      .whereIn('role_permissions.role_id', roles.map((r) => r.id))
      .distinct('permissions.key')).map((p) => p.key),
  );

  const sites = roles.some((r) => r.all_sites)
    ? await db('sites').where({ is_active: true }).orderBy('name').select('id', 'code', 'name')
    : await db('sites')
      .join('user_sites', 'sites.id', 'user_sites.site_id')
      .where({ 'user_sites.user_id': id, 'sites.is_active': true })
      .orderBy('sites.name')
      .select('sites.id', 'sites.code', 'sites.name');

  return {
    ...user,
    must_change_password: Boolean(user.must_change_password),
    initials: user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(''),
    roles,
    roleNames: roles.map((r) => r.name).join(', ') || 'No role',
    isAdmin,
    sites,
    can: (permission) => isAdmin || permissions.has(permission),
  };
}

// ---------- Middleware ----------

/**
 * Runs on every request: if the session holds a user id, loads that user into
 * req.user / res.locals.user and picks the current site.
 */
export async function attachUser(req, res, next) {
  res.locals.user = null;
  res.locals.site = null;
  const id = req.session?.userId;
  if (!id) return next();

  const user = await loadUser(id);
  if (!user) {
    // Deactivated or deleted while logged in.
    delete req.session.userId;
    return next();
  }

  const site = user.sites.find((s) => s.id === req.session.siteId)
    ?? user.sites.find((s) => s.id === user.default_site_id)
    ?? user.sites[0]
    ?? null;
  req.session.siteId = site?.id;

  req.user = user;
  req.site = site;
  res.locals.user = user;
  res.locals.site = site;
  next();
}

/** Pages behind login. Sends people to the login page, then back. */
export function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.accepts(['html', 'json']) === 'json') return res.status(401).json({ error: 'Log in first' });
    const nextUrl = req.method === 'GET' && req.originalUrl !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
    return res.redirect(`/login${nextUrl}`);
  }
  // A new or reset account must choose its own password before anything else.
  if (req.user.must_change_password && !['/account/password', '/logout'].includes(req.path)) {
    return res.redirect('/account/password');
  }
  next();
}

/** Route guard: router.get('/payroll', can('payroll.manage'), handler) */
export function can(permission) {
  return (req, res, next) => {
    if (req.user?.can(permission)) return next();
    next(httpError(403, "You don't have access to this page. Ask an administrator if you need it."));
  };
}

/** Route guard for "any one of these": canAny('customers.manage', 'checkin.manage') */
export function canAny(...permissions) {
  return (req, res, next) => {
    if (permissions.some((p) => req.user?.can(p))) return next();
    next(httpError(403, "You don't have access to this page. Ask an administrator if you need it."));
  };
}

/** Only allow redirects to our own pages (blocks /login?next=https://evil.example). */
export function safeNextUrl(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/';
}
