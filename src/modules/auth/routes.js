import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { burnPasswordCheck, safeNextUrl, verifyPassword } from '../../core/auth.js';
import { normalizePhone } from '../../core/phone.js';
import { check } from '../../core/validate.js';
import { config } from '../../config.js';

export const router = Router();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const WRONG = 'That phone number and password don’t match. Check both and try again.';

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your phone number'),
  password: z.string().min(1, 'Enter your password'),
  next: z.string().optional(),
});

const render = (res, status, { values = {}, errors = {} } = {}) =>
  res.status(status).render('auth/views/login', { layout: 'layout-auth', title: 'Log in', values, errors });

// Slows down password guessing from one device: 20 tries per 15 minutes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => render(res, 429, {
    values: { identifier: req.body?.identifier ?? '' },
    errors: { _form: 'Too many login attempts from this device. Wait 15 minutes and try again.' },
  }),
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  render(res, 200, { values: { identifier: '', next: req.query.next ?? '' } });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { data, errors } = check(loginSchema, req.body);
  if (errors) return render(res, 422, { values: req.body, errors });

  const values = { identifier: data.identifier, next: data.next };
  const fail = (message) => render(res, 401, { values, errors: { _form: message } });

  // Phone number in any common format, or an email address.
  const phone = normalizePhone(data.identifier);
  const email = data.identifier.includes('@') ? data.identifier.toLowerCase() : null;
  const user = phone ? await db('users').where({ phone }).first()
    : email ? await db('users').where({ email }).first()
      : null;

  if (!user) {
    await burnPasswordCheck(data.password);
    return fail(WRONG);
  }

  if (user.locked_until && user.locked_until > new Date()) {
    const until = user.locked_until.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone });
    return fail(`Too many wrong passwords. Try again after ${until}, or ask an administrator to reset your password.`);
  }

  if (!(await verifyPassword(user.password_hash, data.password))) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED;
    await db('users').where({ id: user.id }).update({
      failed_logins: lock ? 0 : failed,
      locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : null,
    });
    if (lock) await audit(db, { user: null, ip: req.ip }, { entity: 'user', id: user.id, action: 'locked', summary: `Locked for ${LOCK_MINUTES} minutes` });
    return fail(lock ? `Too many wrong passwords. The account is locked for ${LOCK_MINUTES} minutes.` : WRONG);
  }

  // Checked after the password so a stranger can't learn which accounts exist.
  if (!user.is_active) return fail('This account is switched off. Ask an administrator to switch it back on.');

  await db('users').where({ id: user.id }).update({ failed_logins: 0, locked_until: null, last_login_at: new Date() });
  await audit(db, { user: { id: user.id }, ip: req.ip }, { entity: 'user', id: user.id, action: 'login' });

  // New session id on login, so a session id planted before login is useless.
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.session.siteId = user.default_site_id;
  res.redirect(safeNextUrl(data.next));
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('jt.sid');
    res.redirect('/login');
  });
});
