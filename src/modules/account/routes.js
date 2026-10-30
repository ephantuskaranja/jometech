import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { hashPassword, safeNextUrl, verifyPassword } from '../../core/auth.js';
import { check } from '../../core/validate.js';

// The logged-in user's own settings: password, theme, current site.
export const router = Router();

const passwordSchema = z.object({
  current: z.string().min(1, 'Enter your current password'),
  password: z.string().min(8, 'Use at least 8 characters').max(128, 'Use 128 characters or fewer'),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The two new passwords are different' })
  .refine((v) => v.password !== v.current, { path: ['password'], message: 'Choose a password different from the current one' });

const renderPassword = (req, res, status, errors = {}) =>
  res.status(status).render('account/views/password', {
    title: 'Change password',
    forced: req.user.must_change_password,
    errors,
  });

router.get('/account/password', (req, res) => renderPassword(req, res, 200));

router.post('/account/password', async (req, res) => {
  const { data, errors } = check(passwordSchema, req.body);
  if (errors) return renderPassword(req, res, 422, errors);

  const { password_hash: hash } = await db('users').where({ id: req.user.id }).first('password_hash');
  if (!(await verifyPassword(hash, data.current))) {
    return renderPassword(req, res, 422, { current: 'That isn’t your current password' });
  }

  const newHash = await hashPassword(data.password);
  await db.transaction(async (trx) => {
    await trx('users').where({ id: req.user.id }).update({ password_hash: newHash, must_change_password: false });
    await audit(trx, req, { entity: 'user', id: req.user.id, action: 'password_changed', summary: 'Chose their own password' });
  });
  req.session.flash = { type: 'success', text: 'Password changed. Use the new one next time you log in.' };
  res.redirect('/');
});

// Called by public/js/theme.js when the user picks a theme, so it follows them to other devices.
router.post('/account/theme', async (req, res) => {
  const theme = z.enum(['light', 'dark', 'system']).safeParse(req.body?.theme);
  if (!theme.success) return res.status(422).json({ error: 'Theme must be light, dark or system' });
  await db('users').where({ id: req.user.id }).update({ theme: theme.data });
  res.json({ ok: true });
});

// Site switcher in the top bar.
router.post('/account/site', (req, res) => {
  const siteId = Number(req.body?.site_id);
  const site = req.user.sites.find((s) => s.id === siteId);
  if (site) {
    req.session.siteId = site.id;
    req.session.flash = { type: 'success', text: `Now working at ${site.name}.` };
  }
  res.redirect(safeNextUrl(req.body?.next));
});
