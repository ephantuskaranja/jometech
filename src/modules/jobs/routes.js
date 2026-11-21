import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { VIEW_CUSTOMERS, isManagerUp } from '../../core/access.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalId, optionalText } from '../../core/validate.js';
import { config } from '../../config.js';
import * as jobs from './service.js';
import { afterJobChange } from '../../core/next-steps.js';
import * as variations from './variations.js';
import * as jobPhotos from './photos.js';
import { storagePath } from '../../core/storage.js';
import { forJob as qcForJob, STATUSES as QC_STATUSES } from '../qc/service.js';
import { forJob as signoffsForJob, OUTCOMES as SIGNOFF_OUTCOMES } from '../qc/signoff.js';
import { jobCosting } from '../costing/service.js';
import * as customers from '../customers/service.js';
import { vehicleOptions } from '../enquiries/service.js';
import { getVehicle } from '../vehicles/service.js';
import { typeOptions } from '../job-types/service.js';
import { ordersForJob, STATUSES as ORDER_STATUSES } from '../purchasing/service.js';
import { requestsForJob, STATUSES as REQUEST_STATUSES } from '../purchasing/requests.js';
import { materialsForJob } from '../issues/service.js';
import { moneyForJob, METHODS as PAYMENT_METHODS } from '../invoices/service.js';
import { staffSignatures } from '../../core/staff-signatures.js';

// Jobs: start one from an accepted proforma or from scratch, move it along, print the job card.

export const router = Router();
const view = canAny('jobs.view', 'jobs.progress', 'jobs.manage');
const manage = canAny('jobs.manage');
// Sales accept the proforma, so they can start its job too. Everything after that is the workshop's.
const fromProforma = canAny('jobs.manage', 'quotations.manage');

const jobSchema = z.object({
  job_type_id: optionalId(),
  customer_id: optionalId().refine((v) => v !== null, 'Choose the customer'),
  vehicle_id: optionalId(),
  vehicle_description: optionalText(150),
  supervisor_id: optionalId(),
  responsible_name: optionalText(100),
  due_on: z.string().trim().optional().refine((v) => !v || isDay(v), 'Check the date').transform((v) => v || null),
  instructions: optionalText(2000),
});

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));

/** Lines arrive as three lists (line_quantity, line_unit, line_description); empty rows are skipped. */
function readLines(body) {
  const list = (key) => [].concat(body[key] ?? []).map((v) => String(v ?? ''));
  const [qtys, units, descriptions] = ['line_quantity', 'line_unit', 'line_description'].map(list);
  const rows = descriptions.map((description, i) => ({ quantity: qtys[i] ?? '', unit: units[i] ?? '', description }));
  const lines = [];
  let error = null;
  rows.forEach((row, i) => {
    const description = row.description.trim();
    if (!description) return;
    const qty = row.quantity.trim() === '' ? 1 : number(row.quantity);
    if (description.length > 2000) error ??= `Line ${i + 1}: use 2,000 characters or fewer`;
    else if (!Number.isFinite(qty) || qty <= 0 || qty > 99_999 || Math.abs(qty * 100 - Math.round(qty * 100)) > 1e-6) error ??= `Line ${i + 1}: check the quantity`;
    else lines.push({ quantity: qty, unit: row.unit.trim().slice(0, 20) || 'Unit', description });
  });
  if (!error && !lines.length) error = 'Say what work is to be done';
  return { rows, lines, error };
}

const blank = () => ({ job_type_id: '', customer_id: '', vehicle_id: '', vehicle_description: '', supervisor_id: '', responsible_name: '', due_on: '', instructions: '' });
const blankRow = () => ({ quantity: '1', unit: 'Unit', description: '' });
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
}

async function loadJob(req) {
  const id = Number(req.params.id);
  const job = Number.isInteger(id) ? await jobs.getJob(id) : null;
  if (!job) throw httpError(404, 'That job doesn’t exist.');
  if (!worksAt(req, job.site_id)) throw httpError(403, `${job.number} is at ${job.site_name}, which isn’t one of your sites.`);
  return job;
}

/** A promised date can't be in the past; on an edit, a date already set may stay as it is. */
function checkDue(data, errors, job = null) {
  if (!data?.due_on || data.due_on >= localDay() || data.due_on === job?.due_on) return errors;
  return { ...errors, due_on: 'Promise a date from today on' };
}

/**
 * Shortcut buttons for what stops a job being opened on a vehicle (jobs.vehicleBlocker):
 * edit the job already running, or switch to the site the vehicle is at and carry on there.
 * `next` is where to come back to after switching site.
 */
function blockerNotice(req, blocker, next) {
  if (!blocker) return null;
  const actions = [];
  let text = blocker.message;
  if (blocker.kind === 'running') {
    const { job } = blocker;
    if (worksAt(req, job.site_id)) {
      if (req.user.can('jobs.manage')) actions.push({ label: `Edit ${job.number}`, href: `/jobs/${job.id}/edit`, icon: 'pencil', primary: true });
      actions.push({ label: `Open ${job.number}`, href: `/jobs/${job.id}`, icon: 'box-arrow-up-right' });
    } else text += ` It is at ${job.site_name}: ask someone there.`;
  } else if (blocker.kind === 'site') {
    const { site } = blocker;
    if (worksAt(req, site.id) && !req.session.siteLocked) {
      actions.push({ label: `Switch to ${site.name}`, post: '/account/site', fields: { site_id: site.id, next }, icon: 'geo-alt', primary: true });
    } else text = `${text.replace(/ Switch to .*$/, '')} Ask someone at ${site.name} to open it, or an admin to add ${site.name} to your sites.`;
  }
  return { tone: 'warning', text, actions };
}

async function renderForm(req, res, { status = 200, job = null, values, rows = [], errors = {}, blocker = null }) {
  const customer = values.customer_id ? await customers.getCustomer(Number(values.customer_id)) : null;
  const supervisors = await jobs.supervisorOptions(job?.site_id ?? req.site.id);
  // Someone already in charge stays on the list, even if their role has since changed.
  if (job?.supervisor_id && !supervisors.some((u) => u.value === job.supervisor_id)) supervisors.unshift({ value: job.supervisor_id, label: job.supervisor_name });
  const noSupervisors = !supervisors.length;
  const jobTypes = await typeOptions();
  // A job whose type has since been removed still shows that type.
  if (job?.job_type_id && !jobTypes.some((t) => t.value === job.job_type_id)) jobTypes.push({ value: job.job_type_id, label: job.job_type_name });
  res.status(status).render('jobs/views/form', {
    title: job ? `Edit ${job.number}` : 'New job',
    notice: blockerNotice(req, blocker, job ? `/jobs/${job.id}/edit` : `/jobs/new${values.vehicle_id ? `?vehicle_id=${values.vehicle_id}` : ''}`),
    job, values, errors, supervisors, jobTypes, today: localDay(),
    // Once a job has a supervisor, only managers and above put someone else in charge.
    supervisorLocked: Boolean(job?.supervisor_id) && !isManagerUp(req.user),
    // No app user can supervise here yet: admins get a link to add one.
    supervisorHelp: noSupervisors ? { site: job?.site_name ?? req.site.name, canAdd: req.user.can('users.manage') } : null,
    rows: rows.length ? rows : [blankRow()],
    customerOption: customer ? [{ value: customer.id, label: `${customer.name} (${customer.number})` }] : [],
    vehicleOptions: customer ? await vehicleOptions(customer.id) : [],
    categories: customers.CATEGORIES, // "Add new customer" window
  });
}

router.get('/jobs', view, async (req, res) => {
  needSite(req);
  const q = String(req.query.q ?? '').slice(0, 60);
  const tab = jobs.TABS.includes(req.query.show) ? req.query.show : 'active';
  const siteIds = req.user.sites.map((s) => s.id);
  const canStart = req.user.can('jobs.manage') || req.user.can('quotations.manage');
  res.render('jobs/views/index', {
    title: 'Jobs', tab, q,
    list: await jobs.listJobs({ siteId: req.site.id, searchSiteIds: siteIds, tab, q }),
    counts: await jobs.countByTab(req.site.id),
    statuses: jobs.STATUSES, today: localDay(),
    waiting: canStart && tab === 'active' && !q ? await jobs.waitingProformas(siteIds) : [],
    jobTypes: await typeOptions(),
    canManage: req.user.can('jobs.manage'),
    manySites: siteIds.length > 1,
  });
});

// ?vehicle_id=12 (from a vehicle or a check-in) fills in the vehicle and its owner; ?customer_id=5 the customer.
router.get('/jobs/new', manage, async (req, res) => {
  needSite(req);
  const values = blank();
  const me = (await jobs.supervisorOptions(req.site.id)).find((u) => u.value === req.user.id);
  if (me) values.supervisor_id = me.value;
  values.job_type_id = (await typeOptions()).find((t) => t.is_default)?.value ?? '';
  const vehicle = req.query.vehicle_id ? await getVehicle(Number(req.query.vehicle_id)) : null;
  if (vehicle) Object.assign(values, { customer_id: vehicle.customer_id, vehicle_id: vehicle.id });
  else if (req.query.customer_id && (await customers.getCustomer(Number(req.query.customer_id)))) values.customer_id = Number(req.query.customer_id);
  // Say straight away if this vehicle already has a job running, or is at another site.
  const blocker = vehicle ? await jobs.vehicleBlocker(vehicle.id, { siteId: req.site.id }) : null;
  await renderForm(req, res, { values, blocker, errors: blocker ? { vehicle_id: blocker.message } : {} });
});

router.post('/jobs', manage, async (req, res) => {
  needSite(req);
  const values = { ...blank(), ...req.body };
  const { data, errors } = check(jobSchema, req.body);
  const { rows, lines, error } = readLines(req.body);
  const all = { ...checkDue(data, errors), ...(error ? { lines: error } : {}) };
  if (Object.keys(all).length) return renderForm(req, res, { status: 422, values, rows, errors: all });
  try {
    const { id, number: jobNumber } = await jobs.createJob({ ...data, lines }, req);
    req.session.flash = { type: 'success', text: `Job ${jobNumber} opened. Print the job card for the workshop.`, actions: await afterJobChange(req.user, id) };
    res.redirect(`/jobs/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, values, rows, errors: { [err.field]: err.message }, blocker: err.blocker });
  }
});

router.get('/jobs/:id', view, async (req, res) => {
  const job = await loadJob(req);
  res.render('jobs/views/show', {
    title: job.number, job,
    statuses: jobs.STATUSES, today: localDay(),
    entries: await history('job', job.id),
    canManage: req.user.can('jobs.manage'),
    canCheckIn: req.user.can('checkin.manage'),
    // Managers and above can put someone else in charge at any stage, from the job page.
    canChangeSupervisor: req.user.can('jobs.manage') && isManagerUp(req.user) && job.status !== 'cancelled',
    supervisorChoices: req.user.can('jobs.manage') && isManagerUp(req.user) ? await supervisorChoices(job) : [],
    canSeeCustomers: VIEW_CUSTOMERS.some((p) => req.user.can(p)),
    canSeeProforma: req.user.can('quotations.manage'),
    // Purchase orders with a line for this job, for those who can open them.
    orders: req.user.can('purchasing.manage') || req.user.can('purchasing.approve') ? await ordersForJob(job.id, req.user.sites.map((s) => s.id)) : [],
    orderStatuses: ORDER_STATUSES,
    // Materials asked for, for this job; and a button to ask, while the job is open.
    requests: req.user.can('purchasing.request') || req.user.can('purchasing.manage') || req.user.can('purchasing.approve') ? await requestsForJob(job.id, req.user.sites.map((s) => s.id)) : [],
    requestStatuses: REQUEST_STATUSES,
    canAskMaterials: (req.user.can('purchasing.request') || req.user.can('purchasing.manage')) && ['open', 'in_progress'].includes(job.status),
    materials: await materialsForJob(job.id),
    canIssue: req.user.can('stores.issue') && ['open', 'in_progress'].includes(job.status),
    // What materials cost: for those who run the stores and managers, not the workshop floor.
    canSeeCost: req.user.can('stores.issue') || req.user.can('inventory.manage'),
    canOpenIssues: req.user.can('stores.issue') || req.user.can('inventory.manage'),
    // Invoice and payments: admins and managers.
    money: req.user.can('invoices.manage') ? await moneyForJob(job.id) : null,
    paymentMethods: PAYMENT_METHODS,
    qcChecks: await qcForJob(job.id), qcStatuses: QC_STATUSES,
    signoffs: await signoffsForJob(job.id), signoffOutcomes: SIGNOFF_OUTCOMES,
    canInspect: req.user.can('qc.manage'),
    // What the job earned: managers and admins.
    costing: req.user.can('costing.view') ? await jobCosting(job) : null,
    // Extra work agreed after pricing; its price only for those who price work.
    variations: await variations.forJob(job.id),
    canPriceWork: req.user.can('quotations.manage') || req.user.can('invoices.manage'),
    variationDraft: (() => { const d = req.session.variationDraft ?? null; delete req.session.variationDraft; return d; })(),
    photos: await jobPhotos.forJob(job.id, job.steps), maxPhotos: jobPhotos.MAX_JOB_PHOTOS,
    canTakePhotos: (req.user.can('jobs.manage') || req.user.can('jobs.progress')) && ['open', 'in_progress'].includes(job.status),
  });
});

router.get('/jobs/:id/edit', manage, async (req, res) => {
  const job = await loadJob(req);
  if (!['open', 'in_progress'].includes(job.status)) throw httpError(409, `${job.number} is ${jobs.STATUSES[job.status].label.toLowerCase()}. Reopen it to change it.`);
  const values = Object.fromEntries(Object.keys(blank()).map((k) => [k, job[k] ?? '']));
  const rows = job.lines.map((l) => ({ quantity: String(Number(l.quantity)), unit: l.unit, description: l.description }));
  await renderForm(req, res, { job, values, rows });
});

router.post('/jobs/:id', manage, async (req, res) => {
  const job = await loadJob(req);
  // From a proforma: the customer and the work stay as agreed, whatever the form sends.
  const fixed = Boolean(job.proforma_id);
  let body = fixed ? { ...req.body, customer_id: job.customer_id } : req.body;
  // The supervisor stays as it is unless a manager or above changes it (the form shows it locked).
  if (job.supervisor_id && !isManagerUp(req.user)) body = { ...body, supervisor_id: String(job.supervisor_id) };
  const values = { ...blank(), ...body };
  const { data, errors } = check(jobSchema, body);
  const { rows, lines, error } = fixed ? { rows: [], lines: [], error: null } : readLines(body);
  const all = { ...checkDue(data, errors, job), ...(error ? { lines: error } : {}) };
  if (Object.keys(all).length) return renderForm(req, res, { status: 422, job, values, rows, errors: all });
  try {
    await jobs.updateJob(job.id, { ...data, lines }, req);
    req.session.flash = { type: 'success', text: `Saved changes to ${job.number}.` };
    res.redirect(`/jobs/${job.id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, job, values, rows, errors: { [err.field]: err.message }, blocker: err.blocker });
  }
});

/** Everyone who can run jobs at the job's site, plus whoever is in charge now (even if their role changed). */
async function supervisorChoices(job) {
  const list = await jobs.supervisorOptions(job.site_id);
  if (job.supervisor_id && !list.some((u) => u.value === job.supervisor_id)) list.unshift({ value: job.supervisor_id, label: job.supervisor_name });
  return list;
}

// Managers and above: put someone else in charge, at any stage (from the job page).
router.post('/jobs/:id/supervisor', manage, async (req, res) => {
  const job = await loadJob(req);
  if (!isManagerUp(req.user)) throw httpError(403, 'Only a manager or admin can change the supervisor once it is set.');
  const raw = String(req.body.supervisor_id ?? '').trim();
  const supervisorId = raw ? Number(raw) : null;
  if (raw && !Number.isInteger(supervisorId)) throw httpError(422, 'Choose the supervisor from the list.');
  try {
    const result = await jobs.changeSupervisor(job.id, supervisorId, req);
    req.session.flash = result.unchanged
      ? { type: 'info', text: `${result.to ?? 'No one'} is already the supervisor on ${job.number}.` }
      : { type: 'success', text: result.to ? `${result.to} now supervises ${job.number}.` : `${job.number} has no supervisor now.` };
  } catch (err) {
    if (!err.field) throw err;
    req.session.flash = { type: 'warning', text: `Supervisor not changed: ${err.message}.` };
  }
  res.redirect(`/jobs/${job.id}`);
});

router.post('/jobs/:id/start', manage, async (req, res) => {
  const job = await loadJob(req);
  await jobs.startJob(job.id, req);
  req.session.flash = { type: 'success', text: `${job.number} is now in progress.`, actions: await afterJobChange(req.user, job.id) };
  res.redirect(`/jobs/${job.id}`);
});

router.post('/jobs/:id/complete', manage, async (req, res) => {
  const job = await loadJob(req);
  await jobs.completeJob(job.id, req);
  req.session.flash = { type: 'success', text: `${job.number} completed.`, actions: await afterJobChange(req.user, job.id) };
  res.redirect(`/jobs/${job.id}`);
});

// The big button on the job page, and "this step doesn't apply" under it.
async function finishStep(req, res, status) {
  const job = await loadJob(req);
  const result = await jobs.finishStep(job.id, Number(req.params.stepId), status, req);
  if (!result) req.session.flash = { type: 'info', text: 'That step was already updated. Here is where the job is now.' };
  else {
    const what = `${result.name} ${status === 'done' ? 'done' : 'skipped'}.`;
    req.session.flash = { type: 'success', text: result.next ? `${what} Next: ${result.next}.` : `${what} ${job.number} is completed.`, actions: await afterJobChange(req.user, job.id) };
  }
  res.redirect(`/jobs/${job.id}`);
}
router.post('/jobs/:id/steps/:stepId/done', manage, (req, res) => finishStep(req, res, 'done'));
router.post('/jobs/:id/steps/:stepId/skip', manage, (req, res) => finishStep(req, res, 'skipped'));

router.post('/jobs/:id/steps/undo', manage, async (req, res) => {
  const job = await loadJob(req);
  const name = await jobs.undoStep(job.id, req);
  req.session.flash = { type: 'success', text: `Back to ${name}.` };
  res.redirect(`/jobs/${job.id}`);
});

router.post('/jobs/:id/cancel', manage, async (req, res) => {
  const job = await loadJob(req);
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why the job is being cancelled (3 to 255 characters).' };
    return res.redirect(`/jobs/${job.id}`);
  }
  await jobs.cancelJob(job.id, reason, req);
  req.session.flash = { type: 'warning', text: `${job.number} cancelled. You can reopen it if plans change.` };
  res.redirect(`/jobs/${job.id}`);
});

router.post('/jobs/:id/reopen', manage, async (req, res) => {
  const job = await loadJob(req);
  await jobs.reopenJob(job.id, req);
  req.session.flash = { type: 'success', text: `${job.number} reopened.` };
  res.redirect(`/jobs/${job.id}`);
});

// The job card: one A4 page for the workshop floor, with no prices.
router.get('/jobs/:id/print', view, async (req, res) => {
  const job = await loadJob(req);
  res.render('jobs/views/print', {
    layout: false, title: `Job card ${job.number}`, job,
    company: config.company, printedAt: new Date(),
    variations: (await variations.forJob(job.id)).filter((v) => v.status === 'agreed'),
    // What was issued to the job, less returns (sheet row 28). No costs: the card goes to the floor.
    materials: (await materialsForJob(job.id)).lines.filter((l) => Number(l.quantity) - Number(l.returned_qty) > 0),
    // The supervisor signs "Checked by" once the work is completed (their saved signature, Account → My signature).
    signs: await staffSignatures({ supervisor: job.status === 'completed' ? job.supervisor_id : null }),
  });
});

// One click on an accepted proforma.
router.post('/proformas/:id/job', fromProforma, async (req, res) => {
  needSite(req);
  let job;
  try {
    job = await jobs.createFromProforma(Number(req.params.id), Number(req.body.job_type_id) || null, req);
  } catch (err) {
    if (!err.blocker) throw err;
    const notice = blockerNotice(req, err.blocker, `/proformas/${req.params.id}`);
    req.session.flash = { type: 'warning', text: notice.text, actions: notice.actions };
    return res.redirect(`/proformas/${req.params.id}`);
  }
  req.session.flash = job.existed
    ? { type: 'info', text: `This proforma already has job ${job.number}.` }
    : { type: 'success', text: `Job ${job.number} opened. Add the supervisor and promised date, then print the job card.`,
      actions: worksAt(req, job.site_id) && req.user.can('jobs.manage') ? [{ label: 'Add supervisor and date', href: `/jobs/${job.id}/edit`, icon: 'pencil', primary: true }, ...await afterJobChange(req.user, job.id)] : [] };
  // The vehicle may be at a site this person doesn't work at: they stay on the proforma.
  res.redirect(worksAt(req, job.site_id) ? `/jobs/${job.id}` : `/proformas/${req.params.id}`);
});

router.get('/api/jobs/vehicles', manage, async (req, res) => {
  const id = Number(req.query.customer_id);
  res.json(id ? await vehicleOptions(id) : []);
});

// ---------- variations: extra work agreed after the job was priced (sales, managers, admins) ----------

const priceWork = canAny('quotations.manage', 'invoices.manage');

const variationSchema = z.object({
  description: z.string().trim().min(3, 'Say what the extra work is').max(1000, 'Use 1000 characters or fewer'),
  quantity: z.preprocess((v) => (String(v ?? '').trim() === '' ? 1 : number(v)), z.number({ message: 'Check the quantity' }).positive('Check the quantity').max(100_000, 'Check the quantity')),
  unit: z.string().trim().max(20).transform((v) => v || 'Unit'),
  unit_price: z.preprocess((v) => (String(v ?? '').trim() === '' ? NaN : number(v)), z.number({ message: 'Enter the price' }).min(0, 'Check the price').max(999_999_999, 'Check the price')),
  agreed_by: z.string().trim().min(2, 'Who at the customer agreed it?').max(100, 'Use 100 characters or fewer'),
  agreed_on: z.string().trim().refine(isDay, 'Check the date'),
});

router.post('/jobs/:id/variations', priceWork, async (req, res) => {
  const job = await loadJob(req);
  const { data, errors } = check(variationSchema, req.body);
  const problem = errors ? Object.values(errors)[0] : data.agreed_on > localDay() ? 'The day it was agreed can’t be in the future' : null;
  if (problem) {
    req.session.flash = { type: 'warning', text: `Variation not saved: ${problem}.` };
    req.session.variationDraft = req.body;
    return res.redirect(`/jobs/${job.id}#variations`);
  }
  const added = await variations.addVariation(job.id, data, req);
  const invoiceNote = added.invoice === 'draft' ? ' It is on the draft invoice too.'
    : added.invoice === 'issued' ? ` Invoice ${added.invoiceNumber} is already issued: cancel it and invoice again to include it.` : ' The invoice will include it.';
  req.session.flash = { type: added.invoice === 'issued' ? 'warning' : 'success', text: `${added.label} added to ${job.number}.${invoiceNote}` };
  res.redirect(`/jobs/${job.id}#variations`);
});

router.post('/jobs/:id/variations/:vid/cancel', priceWork, async (req, res) => {
  const job = await loadJob(req);
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why the variation is cancelled (3 to 255 characters).' };
    return res.redirect(`/jobs/${job.id}#variations`);
  }
  const name = await variations.cancelVariation(job.id, Number(req.params.vid), reason, req);
  req.session.flash = { type: 'success', text: `${name} cancelled. It no longer counts in the price.` };
  res.redirect(`/jobs/${job.id}#variations`);
});

// ---------- progress photos (supervisors and technicians), filed under the current step ----------

const takePhotos = canAny('jobs.manage', 'jobs.progress');
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } }).single('photo');
const receivePhoto = (req, res) => new Promise((resolve, reject) => photoUpload(req, res, (err) => (err ? reject(err) : resolve(req.file))));
const photoUrls = (jobId, photoId) => ({ id: photoId, full: `/jobs/${jobId}/photos/${photoId}.webp`, thumb: `/jobs/${jobId}/photos/${photoId}/thumb.webp` });

function photoError(req, res, err) {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That photo is too large (over 15 MB).' });
  if (!err.expose) req.log.error(err);
  res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'The photo couldn’t be saved. Try again.' });
}

router.post('/jobs/:id/photos', takePhotos, async (req, res) => {
  try {
    const job = await loadJob(req);
    const file = await receivePhoto(req, res);
    if (!file) throw httpError(422, 'Choose a photo to add.');
    res.status(201).json(photoUrls(job.id, await jobPhotos.addPhoto(job.id, file.buffer, req)));
  } catch (err) {
    photoError(req, res, err);
  }
});

router.post('/jobs/:id/photos/:photoId/delete', takePhotos, async (req, res) => {
  try {
    const job = await loadJob(req);
    await jobPhotos.deletePhoto(job.id, Number(req.params.photoId), req);
    res.json({ ok: true });
  } catch (err) {
    photoError(req, res, err);
  }
});

async function sendJobPhoto(req, res, which) {
  const job = await loadJob(req);
  const photo = await jobPhotos.getPhoto(job.id, Number(req.params.photoId));
  if (!photo) throw httpError(404, 'That photo doesn’t exist.');
  res.set('Cache-Control', 'private, max-age=604800, immutable'); // a photo never changes; a new one gets a new id
  res.type('image/webp').sendFile(storagePath(photo[which]));
}
router.get('/jobs/:id/photos/:photoId.webp', view, (req, res) => sendJobPhoto(req, res, 'path'));
router.get('/jobs/:id/photos/:photoId/thumb.webp', view, (req, res) => sendJobPhoto(req, res, 'thumb_path'));
