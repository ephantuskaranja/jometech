import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { db } from '../../core/db.js';
import { check, httpError, optionalPhone } from '../../core/validate.js';
import { storagePath } from '../../core/storage.js';
import { isPng } from '../checkins/service.js';
import { getJob } from '../jobs/service.js';
import { getInspection, redoSteps } from './service.js';
import * as signoff from './signoff.js';
import { afterJobChange } from '../../core/next-steps.js';

// Customer sign-off on a job (its Customer Inspection step): the customer, or the driver collecting
// for them, signs on the device; or no one is there to sign; or they have concerns, and the job goes
// back for rework and a new quality check.

export const router = Router();
const manage = canAny('jobs.manage');
const view = canAny('qc.manage', 'jobs.view', 'jobs.manage', 'jobs.progress');

async function loadJob(req) {
  const job = await getJob(Number(req.params.id));
  if (!job || !req.user.sites.some((s) => s.id === job.site_id)) throw httpError(404, 'That job isn’t at your site.');
  return job;
}

const NO_ONE_REASONS = ['The customer collected without coming to the handover', 'The vehicle was collected by someone who can’t sign for it', 'The vehicle left on a low-loader / tow truck'];

async function renderSignoff(req, res, job, { status = 200, values = {}, errors = {}, form = null } = {}) {
  if (!job.currentStep?.is_signoff) throw httpError(409, `${job.number} isn’t at its customer sign-off step${job.currentStep ? ` (it is at ${job.currentStep.name})` : ''}.`);
  const passed = await signoff.lastPassedCheck(db, job.id);
  const qc = passed ? await getInspection(passed.id) : null;
  res.status(status).render('qc/views/signoff', {
    title: `Customer sign-off · ${job.number}`, job, qc, roles: signoff.ROLES, reasons: NO_ONE_REASONS,
    redoSteps: await redoSteps(db, job.id), previous: await signoff.forJob(job.id),
    values: { signer_role: 'customer', signer_name: '', signer_phone: '', concerns: '', ...values }, errors, form,
  });
}

router.get('/jobs/:id/signoff', manage, async (req, res) => {
  await renderSignoff(req, res, await loadJob(req));
});

const signerSchema = {
  signer_role: z.enum(['customer', 'driver'], { message: 'Say who is signing' }),
  signer_name: z.string().trim().min(2, 'Type their full name').max(100, 'Use 100 characters or fewer'),
};
const acceptSchema = z.object({
  ...signerSchema,
  signer_phone: optionalPhone(),
  signature: z.string().min(1, 'Sign in the box above').max(400_000, 'The signature is too large. Clear it and sign again.'),
});
const concernsSchema = z.object({
  ...signerSchema,
  concerns: z.string().trim().min(3, 'Say what the customer isn’t happy with').max(1000, 'Use 1000 characters or fewer'),
});

/** "data:image/png;base64,…" from the signature pad → PNG bytes, or null. */
function signaturePng(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  return buf && isPng(buf) ? buf : null;
}

const doneText = (job, step) => `${step.name} ticked off${step.next ? `; next: ${step.next}` : `; ${job.number} is completed`}.`;

router.post('/jobs/:id/signoff', manage, async (req, res) => {
  const job = await loadJob(req);
  const { data, errors: invalid } = check(acceptSchema, req.body);
  const errors = { ...invalid };
  const png = data ? signaturePng(data.signature) : null;
  if (data && !png) errors.signature = 'The signature didn’t come through. Clear it and sign again.';
  if (Object.keys(errors).length) return renderSignoff(req, res, job, { status: 422, values: { ...req.body, signature: '' }, errors, form: 'accept' });
  const { step } = await signoff.acceptSignoff(job.id, { signer_role: data.signer_role, signer_name: data.signer_name, signer_phone: data.signer_phone, signature: png }, req);
  req.session.flash = { type: 'success', text: `Signed off by ${data.signer_name}. ${doneText(job, step)}`, actions: await afterJobChange(req.user, job.id) };
  res.redirect(`/jobs/${job.id}`);
});

router.post('/jobs/:id/signoff/not-signed', manage, async (req, res) => {
  const job = await loadJob(req);
  const reason = String(req.body.reason === 'other' ? req.body.other_reason ?? '' : req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    return renderSignoff(req, res, job, { status: 422, values: req.body, errors: { reason: 'Say why no one signed (3 to 255 characters)' }, form: 'not_signed' });
  }
  const { step } = await signoff.notSigned(job.id, reason, req);
  req.session.flash = { type: 'warning', text: `Recorded without a signature. ${doneText(job, step)}`, actions: await afterJobChange(req.user, job.id) };
  res.redirect(`/jobs/${job.id}`);
});

router.post('/jobs/:id/signoff/concerns', manage, async (req, res) => {
  const job = await loadJob(req);
  const { data, errors: invalid } = check(concernsSchema, req.body);
  const errors = { ...invalid };
  const stepIds = [].concat(req.body.redo ?? []).map(Number).filter(Number.isInteger);
  if (Object.keys(errors).length) return renderSignoff(req, res, job, { status: 422, values: { ...req.body, redo: stepIds }, errors, form: 'concerns' });
  const { reworked } = await signoff.raiseConcerns(job.id, { ...data, stepIds }, req);
  req.session.flash = { type: 'warning', text: `Concerns recorded. ${job.number} goes back to ${reworked.join(', ')}; it is checked again before the customer looks again.` };
  res.redirect(`/jobs/${job.id}`);
});

router.get('/signoffs/:id/signature.png', view, async (req, res) => {
  const record = await signoff.getSignoff(Number(req.params.id));
  if (!record?.signature_path || !req.user.sites.some((s) => s.id === record.site_id)) throw httpError(404, 'No signature here.');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(storagePath(record.signature_path));
});
