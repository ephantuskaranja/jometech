import { Router } from 'express';
import { z } from 'zod';
import { can } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { check, httpError } from '../../core/validate.js';
import * as types from './service.js';

// System → Job types & steps: the production steps new jobs start with.
export const router = Router();
router.use('/admin/job-types', can('system.settings'));

const MAX_STEP = 60;

const typeSchema = z.object({
  name: z.string().trim().min(2, 'Give the job type a name').max(60, 'Use 60 characters or fewer'),
  is_default: z.preprocess((v) => v === '1' || v === 'on', z.boolean()),
});

/** Steps arrive as a list; empty rows are skipped. The same name twice would be confusing on the job. */
function readSteps(body) {
  const rows = [].concat(body.step ?? []).map((v) => String(v ?? '').replace(/\s+/g, ' ').trim());
  const steps = rows.filter(Boolean);
  let error = null;
  const seen = new Set();
  for (const name of steps) {
    const key = name.toLowerCase();
    if (name.length > MAX_STEP) error ??= `Keep “${name.slice(0, 30)}…” to ${MAX_STEP} characters`;
    else if (seen.has(key)) error ??= `“${name}” is on the list twice`;
    seen.add(key);
  }
  if (!error && !steps.length) error = 'Add at least one step';
  return { rows, steps, error };
}

function renderForm(res, { status = 200, type = null, values, rows, errors = {}, entries = [] }) {
  res.status(status).render('job-types/views/form', {
    title: type ? type.name : 'New job type',
    type, values, errors, entries, maxStep: MAX_STEP,
    rows: rows.length ? rows : [''],
  });
}

async function loadType(req) {
  const id = Number(req.params.id);
  const type = Number.isInteger(id) ? await types.getType(id) : null;
  if (!type) throw httpError(404, 'That job type doesn’t exist.');
  return type;
}

async function save(req, res, type) {
  const values = { name: req.body.name ?? '', is_default: Boolean(req.body.is_default), receive_first: Boolean(req.body.receive_first), qc_step: String(req.body.qc_step ?? '').replace(/\s+/g, ' ').trim(), signoff_step: String(req.body.signoff_step ?? '').replace(/\s+/g, ' ').trim() };
  const { data, errors } = check(typeSchema, req.body);
  const { rows, steps, error } = readSteps(req.body);
  const all = { ...errors, ...(error ? { steps: error } : {}) };
  // The quality check step must be one of the steps (case as typed in the list).
  const qcStep = values.qc_step ? steps.find((s) => s.toLowerCase() === values.qc_step.toLowerCase()) : null;
  if (values.qc_step && !qcStep) all.qc_step = 'Choose one of the steps above, or No quality check';
  // The customer signs at a later step than the quality check.
  const signoffStep = values.signoff_step ? steps.find((s) => s.toLowerCase() === values.signoff_step.toLowerCase()) : null;
  if (values.signoff_step && !signoffStep) all.signoff_step = 'Choose one of the steps above, or No customer sign-off';
  else if (signoffStep && qcStep && steps.indexOf(signoffStep) <= steps.indexOf(qcStep)) all.signoff_step = 'The customer signs at a step after the quality check';
  // The first step can be the one the vehicle's check-in ticks off (not also the quality check or sign-off).
  const receiveStep = values.receive_first && steps.length ? steps[0] : null;
  if (receiveStep && (receiveStep === qcStep || receiveStep === signoffStep)) all.receive_first = 'The first step is the quality check or sign-off, so the check-in can’t tick it off';
  const entries = type ? await history('job_type', type.id) : [];
  if (Object.keys(all).length) return renderForm(res, { status: 422, type, values, rows, errors: all, entries });
  try {
    if (type) await types.updateType(type.id, { ...data, steps, receive_step: receiveStep, qc_step: qcStep, signoff_step: signoffStep }, req);
    else await types.createType({ ...data, steps, receive_step: receiveStep, qc_step: qcStep, signoff_step: signoffStep }, req);
    req.session.flash = { type: 'success', text: `Saved “${data.name}”. New jobs of this type will use these steps.` };
    res.redirect('/admin/job-types');
  } catch (err) {
    if (!err.field) throw err;
    renderForm(res, { status: 422, type, values, rows, errors: { [err.field]: err.message }, entries });
  }
}

router.get('/admin/job-types', async (req, res) => {
  res.render('job-types/views/index', { title: 'Job types & steps', list: await types.listTypes() });
});

// ?copy=3 starts with the steps of job type 3.
router.get('/admin/job-types/new', async (req, res) => {
  const source = req.query.copy ? await types.getType(Number(req.query.copy)) : null;
  const steps = source?.steps ?? [];
  // A new type starts with a quality check at "Quality Inspection" when its list has one.
  const qcStep = source ? source.qc_step : null;
  renderForm(res, { values: { name: '', is_default: false, receive_first: source ? Boolean(source.receive_step) : true, qc_step: qcStep ?? '', signoff_step: source?.signoff_step ?? '' }, rows: steps });
});

router.post('/admin/job-types', (req, res) => save(req, res, null));

router.get('/admin/job-types/:id', async (req, res) => {
  const type = await loadType(req);
  renderForm(res, { type, values: { name: type.name, is_default: Boolean(type.is_default), receive_first: Boolean(type.receive_step), qc_step: type.qc_step ?? '', signoff_step: type.signoff_step ?? '' }, rows: type.steps, entries: await history('job_type', type.id) });
});

router.post('/admin/job-types/:id', async (req, res) => save(req, res, await loadType(req)));

router.post('/admin/job-types/:id/remove', async (req, res) => {
  const type = await loadType(req);
  await types.removeType(type.id, req);
  req.session.flash = { type: 'success', text: `“${type.name}” removed. Jobs already made keep their steps.` };
  res.redirect('/admin/job-types');
});
