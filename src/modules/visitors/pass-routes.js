import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { config } from '../../config.js';
import { db } from '../../core/db.js';
import { formatReg } from '../../core/vehicle-format.js';
import { check, httpError, optionalText } from '../../core/validate.js';
import { history } from '../../core/audit.js';
import { staffSignatures } from '../../core/staff-signatures.js';
import * as visitors from './service.js';
import * as passes from './passes.js';

// Customer gate passes: a visitor on site sent to another site. Whoever may book visitors
// (reception, supervisors, managers, admins) issues the pass from the visit; the sending gate clears
// them out as usual; the other site sees the pass under "Coming in", finds it by its number, name
// or phone, and signs the person in from it (/visitors/new?pass=…). Printing is optional.
// Mounted before the visitor routes: /visitors/passes isn't a visitor.

export const router = Router();
const issue = canAny('visitors.book');
const see = canAny('visitors.book', 'visitors.view', 'visitors.gate', 'visitors.receive');
const signsIn = canAny('visitors.gate', 'visitors.receive');

const passSchema = z.object({
  to_site_id: z.coerce.number().int().positive('Choose where they are going'),
  purpose: z.string().trim().min(1, 'Choose why they are going').max(60),
  other_purpose: optionalText(60),
  host: optionalText(100),
  people: z.union([z.literal(''), z.coerce.number().int().min(1, 'At least 1').max(50, 'Check the number')]).optional()
    .transform((v) => (v ? v : 1)),
  vehicle_reg: optionalText(20).transform((v) => v && formatReg(v)),
  notes: optionalText(500),
});

function needSite(req) {
  if (!req.site) throw httpError(400, 'You have no site. Ask an administrator to add one to your account.');
}

/** The visit being sent: on site, at one of your sites. */
async function loadVisitor(req) {
  const visitor = await visitors.getVisitor(Number(req.params.id));
  if (!visitor || !req.user.sites.some((s) => s.id === visitor.site_id)) throw httpError(404, 'That visitor isn’t in your site’s register.');
  return visitor;
}

/** A pass to or from one of your sites. */
async function loadPass(req) {
  const pass = await passes.getPass(Number(req.params.id));
  const mine = (id) => req.user.sites.some((s) => s.id === id);
  if (!pass || !(mine(pass.from_site_id) || mine(pass.to_site_id))) throw httpError(404, 'That gate pass isn’t to or from your site.');
  return pass;
}

const otherSites = (siteId) => db('sites').where({ is_active: true }).whereNot({ id: siteId }).orderBy('name').select('id', 'name');

// ---------- issuing ----------

async function renderForm(req, res, { status = 200, visitor, values, errors = {} }) {
  const sites = await otherSites(visitor.site_id);
  if (!sites.length) throw httpError(409, 'There is no other site to send them to.');
  // Who they can see: the staff of each site they could go to (labelled with the site when there are several).
  const hostOptions = [{ value: 'Reception', label: 'Reception' }];
  for (const site of sites) {
    for (const s of await visitors.staffAt(site.id)) {
      const label = [s.name, s.trade].filter(Boolean).join(' · ') + (sites.length > 1 ? ` (${site.name})` : '');
      hostOptions.push({ value: s.name, label });
    }
  }
  res.status(status).render('visitors/views/pass-form', {
    title: `Send ${visitor.name} to another site`,
    visitor, values, errors, sites, hostOptions,
    hostValue: hostOptions.some((o) => o.value === values.host) ? values.host : 'Reception',
    purposes: visitors.PURPOSES,
  });
}

router.get('/visitors/:id/send', issue, async (req, res) => {
  const visitor = await loadVisitor(req);
  if (visitor.status === 'cleared') throw httpError(409, `${visitor.name} has already been cleared out.`);
  const sites = await otherSites(visitor.site_id);
  const known = visitors.PURPOSES.includes(visitor.purpose);
  const values = {
    to_site_id: sites.length === 1 ? String(sites[0].id) : '',
    purpose: known ? visitor.purpose : 'Other', other_purpose: known ? '' : visitor.purpose,
    host: 'Reception', people: String(visitor.people ?? 1), vehicle_reg: visitor.vehicle_reg ?? '', notes: '',
  };
  await renderForm(req, res, { visitor, values });
});

router.post('/visitors/:id/send', issue, async (req, res) => {
  const visitor = await loadVisitor(req);
  const values = { ...req.body };
  const { data, errors } = check(passSchema, req.body);
  const allErrors = { ...errors };
  if (data) {
    if (data.purpose === 'Other' && !data.other_purpose) allErrors.other_purpose = 'Say why they are going';
    const sites = await otherSites(visitor.site_id);
    if (!sites.some((s) => s.id === data.to_site_id)) allErrors.to_site_id = 'Choose where they are going';
    else if (data.host && data.host !== 'Reception' && !(await visitors.staffAt(data.to_site_id)).some((s) => s.name === data.host)) {
      allErrors.host = 'Choose someone at that site, or Reception';
    }
  }
  if (Object.keys(allErrors).length) return renderForm(req, res, { status: 422, visitor, values, errors: allErrors });
  const purpose = data.purpose === 'Other' ? data.other_purpose : data.purpose;
  try {
    const { id, number, siteName } = await passes.issuePass(visitor, { ...data, purpose, host: data.host || 'Reception' }, req);
    req.session.flash = { type: 'success', text: `Gate pass ${number}: ${visitor.name} to ${siteName}. The gate clears them out as usual; ${siteName} sees them coming. Print the pass if they should carry one.` };
    return res.redirect(`/visitors/passes/${id}`);
  } catch (err) {
    if (!err.expose) throw err;
    req.session.flash = { type: 'warning', text: err.message };
    return res.redirect(`/visitors/${visitor.id}`);
  }
});

// ---------- the list, one pass, printing ----------

const TABS = ['incoming', 'sent', 'search'];

router.get('/visitors/passes', see, async (req, res) => {
  needSite(req);
  const q = String(req.query.q ?? '').slice(0, 60);
  const tab = q ? 'search' : TABS.includes(req.query.show) ? req.query.show : 'incoming';
  const [list, counts] = await Promise.all([
    tab === 'search' && !q ? [] : passes.list(req.site.id, tab, q),
    passes.counts(req.site.id),
  ]);
  res.render('visitors/views/passes', {
    title: 'Customer gate passes', tab, q, list, counts,
    stages: passes.STAGES, stage: passes.stage,
    canSignIn: req.user.can('visitors.gate') || req.user.can('visitors.receive'),
    canIssue: req.user.can('visitors.book'),
  });
});

// Gate passes → "New gate pass": pick who is on site here; their Send to another site form opens.
router.get('/visitors/passes/new', issue, async (req, res) => {
  needSite(req);
  const onSite = await visitors.onSite(req.site.id);
  const going = await passes.openFor(onSite.map((v) => v.id));
  res.render('visitors/views/pass-pick', {
    title: 'New gate pass', others: await otherSites(req.site.id),
    list: onSite.filter((v) => !going.has(v.id)).reverse(), // newest first
  });
});

router.get('/visitors/passes/:id', see, async (req, res) => {
  const pass = await loadPass(req);
  const here = req.site?.id;
  res.render('visitors/views/pass', {
    title: `Gate pass ${pass.number}`, pass,
    st: passes.STAGES[passes.stage(pass)],
    entries: await history('visitor_pass', pass.id),
    // Signing in from the pass: at the site they are going to. Cancelling: at the site that sent them.
    canSignIn: (req.user.can('visitors.gate') || req.user.can('visitors.receive')) && here === pass.to_site_id,
    canCancel: req.user.can('visitors.book') && req.user.sites.some((s) => s.id === pass.from_site_id),
    canSeeVisits: req.user.can('visitors.view') || req.user.can('visitors.gate') || req.user.can('visitors.receive'),
  });
});

router.get('/visitors/passes/:id/print', see, async (req, res) => {
  const pass = await loadPass(req);
  res.render('visitors/views/pass-print', {
    layout: false,
    title: `${pass.number} customer gate pass`,
    pass, company: config.company, printedAt: new Date(),
    signs: await staffSignatures({ approved: pass.issued_by }),
  });
});

// "Arrived": one tap signs them in from the pass, nothing to type (the details came with the pass).
// Something different (a third person, another vehicle)? "Check details first" opens the filled-in form instead.
router.post('/visitors/passes/:id/arrive', signsIn, async (req, res) => {
  needSite(req);
  const pass = await loadPass(req);
  const back = req.body.back === 'passes' ? '/visitors/passes' : '/visitors';
  if (pass.to_site_id !== req.site.id) throw httpError(404, 'That gate pass isn’t for this site.');
  // As on the sign-in form: a receptionist (even one also on the gate) receives them at once.
  const atReception = req.user.can('visitors.receive') && (!req.user.can('visitors.gate') || req.user.roles.some((r) => r.key === 'reception'));
  try {
    const { number } = await visitors.signIn(req.site.id, await passes.signInValues(pass), req, { atReception, passId: pass.id });
    req.session.flash = { type: 'success', text: `${pass.name} signed in from gate pass ${pass.number} (${number}).${atReception ? '' : ' Reception confirms when they arrive.'}` };
  } catch (err) {
    if (!err.expose) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(back);
});

router.post('/visitors/passes/:id/cancel', issue, async (req, res) => {
  const pass = await loadPass(req);
  if (!req.user.sites.some((s) => s.id === pass.from_site_id)) throw httpError(403, 'Only the site that issued the pass can cancel it.');
  try {
    await passes.cancelPass(pass.id, req.body.cancel_reason, req);
    req.session.flash = { type: 'success', text: `Gate pass ${pass.number} cancelled.` };
  } catch (err) {
    if (!err.expose) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/visitors/passes/${pass.id}`);
});
