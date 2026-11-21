import { Router } from 'express';
import multer from 'multer';
import { can, canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { config } from '../../config.js';
import { db } from '../../core/db.js';
import { storagePath } from '../../core/storage.js';
import { httpError } from '../../core/validate.js';
import * as qc from './service.js';
import { getJob } from '../jobs/service.js';
import { forCheck as signoffForCheck } from './signoff.js';

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

/** The answers arrive as result_<itemId>, note_<itemId> and redo_<itemId> (a step id, or 'here'). */
function readAnswers(body, items) {
  return Object.fromEntries(items.map((i) => [i.id, { result: body[`result_${i.id}`] ?? '', note: body[`note_${i.id}`] ?? '', redo: body[`redo_${i.id}`] }]));
}

async function renderInspection(req, res, insp, { status = 200, problems = null } = {}) {
  // A passed check whose job now waits for the customer: offer the sign-off from here too.
  const current = insp.status === 'passed' ? await db('job_steps').where({ job_id: insp.job_id, status: 'pending' }).orderBy('sort_order').first('is_signoff') : null;
  return res.status(status).render('qc/views/show', {
    signoffNext: Boolean(current?.is_signoff) && req.user.can('jobs.manage'),
    title: `${insp.number} · ${insp.job_number}`,
    insp, problems, statuses: qc.STATUSES, results: qc.RESULTS, vehicle: vehicleOf(insp), maxPhotos: qc.MAX_ITEM_PHOTOS,
    canInspect: req.user.can('qc.manage') && insp.status === 'in_progress',
  });
}

router.get('/qc/:id', view, async (req, res) => {
  const insp = await loadInspection(req);
  insp.entries = await history('qc', insp.id);
  await renderInspection(req, res, insp);
});

router.post('/qc/:id', inspect, async (req, res) => {
  const insp = await loadInspection(req);
  const finish = req.body.finish === '1';
  const result = await qc.saveInspection(insp.id, readAnswers(req.body, insp.items), req.body.remarks, req, { finish });
  if (result.missing || result.unexplained || result.unrouted) {
    // Show the form again with the answers kept and the gaps marked.
    const fresh = await qc.getInspection(insp.id);
    fresh.entries = await history('qc', insp.id);
    return renderInspection(req, res, fresh, { status: 422, problems: { missing: new Set(result.missing), unexplained: new Set(result.unexplained), unrouted: new Set(result.unrouted) } });
  }
  if (!finish) req.session.flash = { type: 'success', text: `${insp.number} saved. Carry on when you’re ready.` };
  else if (result.status === 'passed') {
    req.session.flash = { type: 'success', text: `${insp.number} passed. ${result.step.name} ticked off${result.step.next ? `; next: ${result.step.next}` : `; ${insp.job_number} is completed`}.` };
    return res.redirect(`/jobs/${insp.job_id}`); // the next step (usually the customer's sign-off) is there
  } else {
    const back = result.reworked.length
      ? `${insp.job_number} goes back to ${result.reworked.join(', ')}; when that is done it comes back for its next quality check.`
      : `Put the work right, then start a new quality check on ${insp.job_number}.`;
    req.session.flash = { type: 'warning', text: `${insp.number} failed on ${result.failed} item${result.failed === 1 ? '' : 's'}. ${back}`,
      actions: [{ label: `Back to ${insp.job_number}`, href: `/jobs/${insp.job_id}`, icon: 'wrench', primary: true }] };
  }
  res.redirect(`/qc/${insp.id}`);
});

router.post('/qc/:id/cancel', inspect, async (req, res) => {
  const insp = await loadInspection(req);
  await qc.cancelInspection(insp.id, req);
  req.session.flash = { type: 'success', text: `${insp.number} cancelled. ${insp.job_number} is still waiting for its quality check.` };
  res.redirect(`/jobs/${insp.job_id}`);
});

// ---------- photos of an item ----------
// One photo per request, already shrunk in the browser (as on a check-in). Answers are JSON.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } }).single('photo');
const receivePhoto = (req, res) => new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve(req.file))));

function photoError(req, res, err) {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That photo is too large (over 15 MB).' });
  if (!err.expose) req.log.error(err);
  res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'The photo couldn’t be saved. Try again.' });
}

export const photoUrls = (inspectionId, photoId) => ({
  id: photoId,
  full: `/qc/${inspectionId}/photos/${photoId}.webp`,
  thumb: `/qc/${inspectionId}/photos/${photoId}/thumb.webp`,
});

router.post('/qc/:id/items/:itemId/photos', inspect, async (req, res) => {
  try {
    const insp = await loadInspection(req);
    const file = await receivePhoto(req, res);
    if (!file) throw httpError(422, 'Choose a photo to add.');
    const photoId = await qc.addItemPhoto(insp.id, Number(req.params.itemId), file.buffer, req);
    res.status(201).json(photoUrls(insp.id, photoId));
  } catch (err) {
    photoError(req, res, err);
  }
});

router.post('/qc/:id/items/:itemId/photos/:photoId/delete', inspect, async (req, res) => {
  try {
    const insp = await loadInspection(req);
    await qc.deleteItemPhoto(insp.id, Number(req.params.itemId), Number(req.params.photoId), req);
    res.json({ ok: true });
  } catch (err) {
    photoError(req, res, err);
  }
});

async function sendPhoto(req, res, which) {
  const insp = await loadInspection(req);
  const photo = await qc.getItemPhoto(insp.id, Number(req.params.photoId));
  if (!photo) throw httpError(404, 'That photo doesn’t exist.');
  res.set('Cache-Control', 'private, max-age=604800, immutable'); // a photo never changes; a new one gets a new id
  res.type('image/webp').sendFile(storagePath(photo[which]));
}
router.get('/qc/:id/photos/:photoId.webp', view, (req, res) => sendPhoto(req, res, 'path'));
router.get('/qc/:id/photos/:photoId/thumb.webp', view, (req, res) => sendPhoto(req, res, 'thumb_path'));

// ---------- printing ----------

router.get('/qc/:id/print', view, async (req, res) => {
  const insp = await loadInspection(req);
  res.render('qc/views/print', { layout: false, title: `${insp.number} quality inspection`, insp, sections: insp.sections, company: config.company, printedAt: new Date(), vehicle: vehicleOf(insp), results: qc.RESULTS,
    signoff: await signoffForCheck(insp.id) });
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
