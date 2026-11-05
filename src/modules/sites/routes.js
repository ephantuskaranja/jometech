import { Router } from 'express';
import { z } from 'zod';
import { can } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { check, httpError, optionalPhone, optionalText } from '../../core/validate.js';
import * as sites from './service.js';

// System → Sites: add a site, change its details, switch it off.
export const router = Router();
router.use('/admin/sites', can('system.settings'));

const siteSchema = z.object({
  name: z.string().trim().min(2, 'Give the site a name').max(100, 'Use 100 characters or fewer').transform((v) => v.replace(/\s+/g, ' ')),
  address: optionalText(255),
  phone: optionalPhone(),
});

const blank = () => ({ name: '', address: '', phone: '' });

async function renderForm(res, { status = 200, site = null, values, errors = {}, existingId = null }) {
  res.status(status).render('sites/views/form', {
    title: site ? site.name : 'New site',
    site, values, errors, existingId,
    entries: site ? await history('site', site.id) : [],
    reasons: site?.is_active ? await sites.blockers(site.id) : [],
  });
}

async function loadSite(req) {
  const id = Number(req.params.id);
  const site = Number.isInteger(id) ? await sites.getSite(id) : null;
  if (!site) throw httpError(404, 'That site doesn’t exist.');
  return site;
}

router.get('/admin/sites', async (req, res) => {
  res.render('sites/views/index', { title: 'Sites', list: await sites.listSites() });
});

router.get('/admin/sites/new', (req, res) => renderForm(res, { values: blank() }));

router.post('/admin/sites', async (req, res) => {
  const values = { ...blank(), ...req.body };
  const { data, errors } = check(siteSchema, req.body);
  if (errors) return renderForm(res, { status: 422, values, errors });
  try {
    await sites.createSite(data, req);
    req.session.flash = { type: 'success', text: `${data.name} added. Admins and managers can use it now. For anyone else, tick it on their page under Users.` };
    res.redirect('/admin/sites');
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, values, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
});

router.get('/admin/sites/:id', async (req, res) => {
  const site = await loadSite(req);
  const values = { name: site.name, address: site.address ?? '', phone: site.phone ? res.locals.fmt.phone(site.phone) : '' };
  await renderForm(res, { site, values });
});

router.post('/admin/sites/:id', async (req, res) => {
  const site = await loadSite(req);
  const values = { ...blank(), ...req.body };
  const { data, errors } = check(siteSchema, req.body);
  if (errors) return renderForm(res, { status: 422, site, values, errors });
  try {
    await sites.updateSite(site.id, data, req);
    req.session.flash = { type: 'success', text: `Saved changes to ${data.name}.` };
    res.redirect('/admin/sites');
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, site, values, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
});

async function setActive(req, res, active) {
  const site = await loadSite(req);
  await sites.setActive(site.id, active, req);
  req.session.flash = { type: 'success', text: `${site.name} switched ${active ? 'back on' : 'off'}.` };
  res.redirect(`/admin/sites/${site.id}`);
}
router.post('/admin/sites/:id/switch-off', (req, res) => setActive(req, res, false));
router.post('/admin/sites/:id/switch-on', (req, res) => setActive(req, res, true));
