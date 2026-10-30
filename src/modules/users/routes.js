import { Router } from 'express';
import { z } from 'zod';
import { can, generateTempPassword } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { normalizePhone } from '../../core/phone.js';
import { check, httpError } from '../../core/validate.js';
import * as users from './service.js';

// Admin → Users: list, add, edit, reset password, switch on/off.
export const router = Router();
router.use('/admin/users', can('users.manage'));

const asArray = (v) => (v === undefined || v === '' ? [] : [].concat(v));

const userSchema = z.object({
  name: z.string().trim().min(2, 'Enter their full name').max(100, 'Use 100 characters or fewer'),
  phone: z.string().trim().min(1, 'Enter their phone number')
    .refine((v) => normalizePhone(v), 'Use a format like 0712 345 678'),
  email: z.string().trim().max(120).optional()
    .transform((v) => v || null)
    .refine((v) => v === null || z.email().safeParse(v).success, 'Check the email address'),
  roles: z.preprocess(asArray, z.array(z.string()).min(1, 'Choose at least one role')),
  sites: z.preprocess(asArray, z.array(z.coerce.number().int().positive())),
});

/** Shows the add/edit form, with what the user typed and any errors. */
async function renderForm(req, res, { status = 200, user = null, values, errors = {}, tempPassword = null }) {
  const options = await users.formOptions();
  res.status(status).render('users/views/form', {
    title: user ? user.name : 'Add user',
    user: req.user, // the logged-in admin (layout); the person being edited is `account`
    account: user,
    values,
    errors,
    tempPassword,
    entries: user ? await history('user', user.id, { limit: 30 }) : [],
    roleOptions: options.roles.map((r) => ({ value: r.key, label: r.name, hint: r.description })),
    allSiteRoles: options.roles.filter((r) => r.all_sites).map((r) => r.key),
    siteOptions: options.sites.map((s) => ({ value: s.id, label: s.name })),
  });
}

/** Extra rules needing the database: sites required, and no locking yourself out. */
async function extraErrors(req, data, account) {
  const errors = {};
  const { roles } = await users.formOptions();
  const seesAllSites = data.roles.some((key) => roles.find((r) => r.key === key)?.all_sites);
  if (!seesAllSites && data.sites.length === 0) errors.sites = 'Choose at least one site';

  if (account && account.roleKeys.includes('admin') && !data.roles.includes('admin')) {
    if (account.id === req.user.id) errors.roles = 'You can’t remove your own Admin role. Ask another admin to do it.';
    else if ((await users.otherActiveAdmins(account.id)) === 0) errors.roles = 'This is the only admin. Make someone else an admin first.';
  }
  return Object.keys(errors).length ? errors : null;
}

// ---------- List ----------

router.get('/admin/users', async (req, res) => {
  const status = ['active', 'inactive', 'all'].includes(req.query.status) ? req.query.status : 'active';
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.render('users/views/index', { title: 'Users', list: await users.listUsers({ q, status }), q, status, now: new Date() });
});

// ---------- Add ----------

router.get('/admin/users/new', (req, res) => renderForm(req, res, {
  // Prefill: least access, at the admin's current site.
  values: { name: '', phone: '', email: '', roles: ['technician'], sites: req.site ? [req.site.id] : [] },
}));

router.post('/admin/users', async (req, res) => {
  const { data, errors } = check(userSchema, req.body);
  const values = { ...req.body, roles: asArray(req.body.roles), sites: asArray(req.body.sites) };
  if (errors) return renderForm(req, res, { status: 422, values, errors });
  const more = await extraErrors(req, data, null);
  if (more) return renderForm(req, res, { status: 422, values, errors: more });

  const password = generateTempPassword();
  try {
    const id = await users.createUser({ ...data, siteIds: data.sites, password, mustChangePassword: true }, req);
    req.session.tempPassword = { userId: id, password };
    req.session.flash = { type: 'success', text: `${data.name} added.` };
    res.redirect(`/admin/users/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(req, res, { status: 422, values, errors: { [err.field]: err.message } });
  }
});

// ---------- Edit ----------

async function loadAccount(req) {
  const account = await users.getUser(Number(req.params.id));
  if (!account) throw httpError(404, 'That user doesn’t exist. They may have been removed.');
  return account;
}

router.get('/admin/users/:id', async (req, res) => {
  const account = await loadAccount(req);
  // A new temporary password is shown once, right after it was made.
  const temp = req.session.tempPassword?.userId === account.id ? req.session.tempPassword.password : null;
  delete req.session.tempPassword;
  renderForm(req, res, {
    user: account,
    tempPassword: temp,
    values: { name: account.name, phone: account.phone, email: account.email ?? '', roles: account.roleKeys, sites: account.siteIds },
  });
});

router.post('/admin/users/:id', async (req, res) => {
  const account = await loadAccount(req);
  const { data, errors } = check(userSchema, req.body);
  const values = { ...req.body, roles: asArray(req.body.roles), sites: asArray(req.body.sites) };
  if (errors) return renderForm(req, res, { status: 422, user: account, values, errors });
  const more = await extraErrors(req, data, account);
  if (more) return renderForm(req, res, { status: 422, user: account, values, errors: more });

  try {
    await users.updateUser(account.id, { ...data, siteIds: data.sites }, req);
  } catch (err) {
    if (!err.field) throw err;
    return renderForm(req, res, { status: 422, user: account, values, errors: { [err.field]: err.message } });
  }
  req.session.flash = { type: 'success', text: `Saved changes to ${data.name}.` };
  res.redirect('/admin/users');
});

// ---------- Actions on the edit page ----------

router.post('/admin/users/:id/reset-password', async (req, res) => {
  const account = await loadAccount(req);
  const password = generateTempPassword();
  await users.resetPassword(account.id, password, req, { mustChangePassword: true });
  req.session.tempPassword = { userId: account.id, password };
  req.session.flash = { type: 'success', text: `New temporary password made for ${account.name}. Any lock on the account is cleared.` };
  res.redirect(`/admin/users/${account.id}`);
});

router.post('/admin/users/:id/status', async (req, res) => {
  const account = await loadAccount(req);
  const active = req.body.active === '1';

  if (!active && account.id === req.user.id) {
    req.session.flash = { type: 'warning', text: 'You can’t switch off your own account.' };
  } else if (!active && account.roleKeys.includes('admin') && (await users.otherActiveAdmins(account.id)) === 0) {
    req.session.flash = { type: 'warning', text: 'This is the only admin. Make someone else an admin first.' };
  } else {
    await users.setActive(account.id, active, req);
    req.session.flash = { type: 'success', text: active ? `${account.name} can log in again.` : `${account.name} is switched off and logged out. Their history is kept.` };
  }
  res.redirect(`/admin/users/${account.id}`);
});
