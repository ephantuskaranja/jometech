import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { hashPassword, safeNextUrl, verifyPassword } from '../../core/auth.js';
import { check } from '../../core/validate.js';
import { endSessionsOf } from '../../core/session.js';
import { storagePath } from '../../core/storage.js';
import { httpError } from '../../core/validate.js';
import { deleteSignature, pngFromDataUrl, saveSignature, signaturePathOf } from '../../core/staff-signatures.js';

// The logged-in user's own settings: password, theme, current site, their signature for documents.
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
  await endSessionsOf(req.user.id, req.sessionID); // other devices log in again with the new password
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

// Gate and Reception with more than one site: "Which site are you at?" right after logging in.
router.get('/choose-site', (req, res) => {
  if (!req.session.chooseSite) return res.redirect('/');
  res.render('account/views/choose-site', { layout: 'layout-auth', title: 'Choose your site', sites: req.user.sites });
});

router.post('/choose-site', async (req, res) => {
  const site = req.user.sites.find((s) => s.id === Number(req.body?.site_id));
  if (!req.session.chooseSite || !site) return res.redirect('/choose-site');
  req.session.siteId = site.id;
  delete req.session.chooseSite;
  await audit(db, req, { entity: 'user', id: req.user.id, action: 'site_chosen', summary: `Working at ${site.name} until logout` });
  res.redirect('/');
});

// Site switcher in the top bar.
router.post('/account/site', (req, res) => {
  const siteId = Number(req.body?.site_id);
  const site = req.user.sites.find((s) => s.id === siteId);
  if (req.session.siteLocked) {
    // Chosen at login for the whole shift; a different site means logging out and in again.
    req.session.flash = { type: 'warning', text: `You are working at ${req.site?.name} until you log out. Log out and in again to change site.` };
  } else if (site) {
    req.session.siteId = site.id;
    req.session.flash = { type: 'success', text: `Now working at ${site.name}.` };
  }
  res.redirect(safeNextUrl(req.body?.next));
});

// ---------- My signature: drawn once, printed on the documents this person is responsible for ----------

const renderSignature = async (req, res, status = 200, error = null) => {
  const user = await db('users').where({ id: req.user.id }).first('signature_path', 'signature_saved_at');
  res.status(status).render('account/views/signature', {
    title: 'My signature', error,
    saved: user?.signature_path ? { url: `/staff-signatures/${req.user.id}.png?v=${new Date(user.signature_saved_at ?? 0).getTime()}`, at: user.signature_saved_at } : null,
  });
};

router.get('/account/signature', (req, res) => renderSignature(req, res));

router.post('/account/signature', async (req, res) => {
  const raw = String(req.body?.signature ?? '');
  if (!raw) return renderSignature(req, res, 422, 'Sign in the box above');
  if (raw.length > 400_000) return renderSignature(req, res, 422, 'The signature is too large. Clear it and sign again.');
  const png = pngFromDataUrl(raw);
  if (!png) return renderSignature(req, res, 422, 'The signature didn’t come through. Clear it and sign again.');
  await saveSignature(req.user.id, png);
  await audit(db, req, { entity: 'user', id: req.user.id, action: 'signature_saved', summary: 'Saved their signature for documents' });
  req.session.flash = { type: 'success', text: 'Signature saved. It is added to the documents you are responsible for when they are printed.' };
  res.redirect('/account/signature');
});

router.post('/account/signature/delete', async (req, res) => {
  await deleteSignature(req.user.id);
  await audit(db, req, { entity: 'user', id: req.user.id, action: 'signature_removed', summary: 'Removed their signature' });
  req.session.flash = { type: 'warning', text: 'Signature removed. Documents print with a blank line to sign by hand.' };
  res.redirect('/account/signature');
});

// The image itself: for logged-in staff only (printed documents show it).
router.get('/staff-signatures/:id.png', async (req, res) => {
  const rel = await signaturePathOf(Number(req.params.id));
  if (!rel) throw httpError(404, 'No signature saved.');
  res.set('Cache-Control', 'private, max-age=604800'); // the address changes (?v=) when a new one is saved
  res.type('image/png').sendFile(storagePath(rel));
});
