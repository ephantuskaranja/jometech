import { Router } from 'express';
import { can, canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { config } from '../../config.js';
import { httpError } from '../../core/validate.js';
import * as qc from './service.js';
import { getJob } from '../jobs/service.js';

// Quality checks: the list (Workshop → Quality checks), an inspection on a job,
// printed reports (filled in, or blank for paper), and System → Quality checklist.

export const router = Router();
const inspect = canAny('qc.manage');
// Seeing a report: the workshop too (there are no prices on it).
const view = canAny('qc.manage', 'jobs.view', 'jobs.manage', 'jobs.progress');

function needSite(req) {
  if (!req.site) throw httpError(400, 'You have no site. Ask an administrator to add one to your account.');
}

async function loadInspection(req) {
  const insp = await qc.getInspection(Number(req.params.id));
  if (!insp || !req.user.sites.some((s) => s.id === insp.site_id)) throw httpError(404, 'That quality check isn’t at your site.');
  return insp;
}

const vehicleOf = (x) => x.reg_no ?? x.temp_tag ?? x.vehicle_description ?? null;

router.get('/qc', inspect, async (req, res) => {
  needSite(req);
  const tab = req.query.show === 'done' ? 'done' : 'waiting';
  const [waiting, done] = await Promise.all([qc.waiting(req.site.id), tab === 'done' ? qc.recent(req.site.id) : []]);
  res.render('qc/views/index', { title: 'Quality checks', tab, waiting, done, statuses: qc.STATUSES, vehicleOf });
});

// Start (or carry on with) the job's inspection.
router.post('/jobs/:id/qc', inspect, async (req, res) => {
  const job = await getJob(Number(req.params.id));
  if (!job || !req.user.sites.some((s) => s.id === job.site_id)) throw httpError(404, 'That job isn’t at your site.');
  const { id } = await qc.startInspection(job.id, req);
  res.redirect(`/qc/${id}`);
});

/** The answers arrive as result_<itemId> and note_<itemId>. */
function readAnswers(body, items) {
  return Object.fromEntries(items.map((i) => [i.id, { result: body[`result_${i.id}`] ?? '', note: body[`note_${i.id}`] ?? '' }]));
}

function renderInspection(req, res, insp, { status = 200, problems = null } = {}) {
  return res.status(status).render('qc/views/show', {
    title: `${insp.number} · ${insp.job_number}`,
    insp, problems, statuses: qc.STATUSES, results: qc.RESULTS, vehicle: vehicleOf(insp),
    canInspect: req.user.can('qc.manage') && insp.status === 'in_progress',
  });
}

router.get('/qc/:id', view, async (req, res) => {
  const insp = await loadInspection(req);
  insp.entries = await history('qc', insp.id);
  renderInspection(req, res, insp);
});

router.post('/qc/:id', inspect, async (req, res) => {
  const insp = await loadInspection(req);
  const finish = req.body.finish === '1';
  const result = await qc.saveInspection(insp.id, readAnswers(req.body, insp.items), req.body.remarks, req, { finish });
  if (result.missing || result.unexplained) {
    // Show the form again with the answers kept and the gaps marked.
    const fresh = await qc.getInspection(insp.id);
    fresh.entries = await history('qc', insp.id);
    return renderInspection(req, res, fresh, { status: 422, problems: { missing: new Set(result.missing), unexplained: new Set(result.unexplained) } });
  }
  if (!finish) req.session.flash = { type: 'success', text: `${insp.number} saved. Carry on when you’re ready.` };
  else if (result.status === 'passed') {
    req.session.flash = { type: 'success', text: `${insp.number} passed. ${result.step.name} ticked off${result.step.next ? `; next: ${result.step.next}` : `; ${insp.job_number} is completed`}.` };
  } else {
    req.session.flash = { type: 'warning', text: `${insp.number} failed on ${result.failed} item${result.failed === 1 ? '' : 's'}. Put the work right, then start a new quality check on ${insp.job_number}.` };
  }
  res.redirect(`/qc/${insp.id}`);
});

router.post('/qc/:id/cancel', inspect, async (req, res) => {
  const insp = await loadInspection(req);
  await qc.cancelInspection(insp.id, req);
  req.session.flash = { type: 'success', text: `${insp.number} cancelled. ${insp.job_number} is still waiting for its quality check.` };
  res.redirect(`/jobs/${insp.job_id}`);
});

// ---------- printing ----------

router.get('/qc/:id/print', view, async (req, res) => {
  const insp = await loadInspection(req);
  res.render('qc/views/print', { layout: false, title: `${insp.number} quality inspection`, insp, sections: insp.sections, company: config.company, printedAt: new Date(), vehicle: vehicleOf(insp), results: qc.RESULTS });
});

// A blank form for paper, from today's checklist; ?job=ID fills in the job's details.
router.get('/qc-form/print', view, async (req, res) => {
  const job = req.query.job ? await getJob(Number(req.query.job)) : null;
  if (job && !req.user.sites.some((s) => s.id === job.site_id)) throw httpError(404, 'That job isn’t at your site.');
  const sections = (await qc.checklist()).map((s) => ({ name: s.name, items: s.items.map((text) => ({ text, result: null, note: null })) }));
  const insp = job ? { job_number: job.number, job_id: job.id, customer_name: job.customer_name, site_name: job.site_name, job_type_name: job.job_type_name,
    chassis_no: job.chassis_no, make: job.make, model: job.model, supervisor_name: job.supervisor_name } : {};
  res.render('qc/views/print', { layout: false, title: 'Quality inspection form', insp, sections, blank: true, company: config.company, printedAt: new Date(),
    vehicle: job ? (job.reg_no ?? job.temp_tag ?? job.vehicle_description) : null, results: qc.RESULTS });
});

// ---------- System → Quality checklist ----------

router.get('/admin/qc-checklist', can('system.settings'), async (req, res) => {
  res.render('qc/views/checklist', { title: 'Quality checklist', sections: await qc.checklist(), stepNames: await qc.stepNameOptions(), errors: null, entries: await history('qc_checklist', 0) });
});

/** The editor posts the whole checklist as JSON: [{ name, rework_step, items: [text] }]. */
function readChecklist(raw) {
  let list;
  try { list = JSON.parse(String(raw ?? '')); } catch { list = null; }
  if (!Array.isArray(list)) return { error: 'The checklist didn’t arrive. Try again.' };
  const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const sections = list.map((s) => ({ name: clean(s?.name, 80), rework_step: clean(s?.rework_step, 60), items: [].concat(s?.items ?? []).map((t) => clean(t, 200)).filter(Boolean) }))
    .filter((s) => s.name || s.items.length);
  const unnamed = sections.find((s) => !s.name);
  if (unnamed) return { sections, error: 'Give every section a name.' };
  const empty = sections.find((s) => !s.items.length);
  if (empty) return { sections, error: `“${empty.name}” has no items. Add one or remove the section.` };
  if (!sections.length) return { sections, error: 'Add at least one section with an item.' };
  return { sections };
}

router.post('/admin/qc-checklist', can('system.settings'), async (req, res) => {
  const { sections, error } = readChecklist(req.body.checklist);
  if (error) {
    return res.status(422).render('qc/views/checklist', { title: 'Quality checklist', sections: sections ?? await qc.checklist(), stepNames: await qc.stepNameOptions(), errors: error, entries: await history('qc_checklist', 0) });
  }
  await qc.saveChecklist(sections, req);
  req.session.flash = { type: 'success', text: 'Quality checklist saved. New quality checks use it; earlier ones keep theirs.' };
  res.redirect('/admin/qc-checklist');
});
