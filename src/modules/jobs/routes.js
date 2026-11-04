import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { VIEW_CUSTOMERS } from '../../core/access.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalId, optionalText } from '../../core/validate.js';
import { config } from '../../config.js';
import * as jobs from './service.js';
import * as customers from '../customers/service.js';
import { vehicleOptions } from '../enquiries/service.js';
import { getVehicle } from '../vehicles/service.js';
import { typeOptions } from '../job-types/service.js';

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

const blank = () => ({ job_type_id: '', customer_id: '', vehicle_id: '', vehicle_description: '', supervisor_id: '', due_on: '', instructions: '' });
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

async function renderForm(req, res, { status = 200, job = null, values, rows = [], errors = {} }) {
  const customer = values.customer_id ? await customers.getCustomer(Number(values.customer_id)) : null;
  const supervisors = await jobs.supervisorOptions(job?.site_id ?? req.site.id);
  // Someone already in charge stays on the list, even if their role has since changed.
  if (job?.supervisor_id && !supervisors.some((u) => u.value === job.supervisor_id)) supervisors.unshift({ value: job.supervisor_id, label: job.supervisor_name });
  const jobTypes = await typeOptions();
  // A job whose type has since been removed still shows that type.
  if (job?.job_type_id && !jobTypes.some((t) => t.value === job.job_type_id)) jobTypes.push({ value: job.job_type_id, label: job.job_type_name });
  res.status(status).render('jobs/views/form', {
    title: job ? `Edit ${job.number}` : 'New job',
    job, values, errors, supervisors, jobTypes,
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
  await renderForm(req, res, { values });
});

router.post('/jobs', manage, async (req, res) => {
  needSite(req);
  const values = { ...blank(), ...req.body };
  const { data, errors } = check(jobSchema, req.body);
  const { rows, lines, error } = readLines(req.body);
  const all = { ...errors, ...(error ? { lines: error } : {}) };
  if (Object.keys(all).length) return renderForm(req, res, { status: 422, values, rows, errors: all });
  try {
    const { id, number: jobNumber } = await jobs.createJob({ ...data, lines }, req);
    req.session.flash = { type: 'success', text: `Job ${jobNumber} opened. Print the job card for the workshop.` };
    res.redirect(`/jobs/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, values, rows, errors: { [err.field]: err.message } });
  }
});

router.get('/jobs/:id', view, async (req, res) => {
  const job = await loadJob(req);
  res.render('jobs/views/show', {
    title: job.number, job,
    statuses: jobs.STATUSES, today: localDay(),
    entries: await history('job', job.id),
    canManage: req.user.can('jobs.manage'),
    canSeeCustomers: VIEW_CUSTOMERS.some((p) => req.user.can(p)),
    canSeeProforma: req.user.can('quotations.manage'),
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
  const body = fixed ? { ...req.body, customer_id: job.customer_id } : req.body;
  const values = { ...blank(), ...body };
  const { data, errors } = check(jobSchema, body);
  const { rows, lines, error } = fixed ? { rows: [], lines: [], error: null } : readLines(body);
  const all = { ...errors, ...(error ? { lines: error } : {}) };
  if (Object.keys(all).length) return renderForm(req, res, { status: 422, job, values, rows, errors: all });
  try {
    await jobs.updateJob(job.id, { ...data, lines }, req);
    req.session.flash = { type: 'success', text: `Saved changes to ${job.number}.` };
    res.redirect(`/jobs/${job.id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, job, values, rows, errors: { [err.field]: err.message } });
  }
});

router.post('/jobs/:id/start', manage, async (req, res) => {
  const job = await loadJob(req);
  await jobs.startJob(job.id, req);
  req.session.flash = { type: 'success', text: `${job.number} is now in progress.` };
  res.redirect(`/jobs/${job.id}`);
});

router.post('/jobs/:id/complete', manage, async (req, res) => {
  const job = await loadJob(req);
  await jobs.completeJob(job.id, req);
  req.session.flash = { type: 'success', text: `${job.number} completed.` };
  res.redirect(`/jobs/${job.id}`);
});

// The big button on the job page, and "this step doesn't apply" under it.
async function finishStep(req, res, status) {
  const job = await loadJob(req);
  const result = await jobs.finishStep(job.id, Number(req.params.stepId), status, req);
  if (!result) req.session.flash = { type: 'info', text: 'That step was already updated. Here is where the job is now.' };
  else {
    const what = `${result.name} ${status === 'done' ? 'done' : 'skipped'}.`;
    req.session.flash = { type: 'success', text: result.next ? `${what} Next: ${result.next}.` : `${what} ${job.number} is completed.` };
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
  });
});

// One click on an accepted proforma.
router.post('/proformas/:id/job', fromProforma, async (req, res) => {
  needSite(req);
  const job = await jobs.createFromProforma(Number(req.params.id), Number(req.body.job_type_id) || null, req);
  req.session.flash = job.existed
    ? { type: 'info', text: `This proforma already has job ${job.number}.` }
    : { type: 'success', text: `Job ${job.number} opened. Add the supervisor and promised date, then print the job card.` };
  // The vehicle may be at a site this person doesn't work at: they stay on the proforma.
  res.redirect(worksAt(req, job.site_id) ? `/jobs/${job.id}` : `/proformas/${req.params.id}`);
});

router.get('/api/jobs/vehicles', manage, async (req, res) => {
  const id = Number(req.query.customer_id);
  res.json(id ? await vehicleOptions(id) : []);
});
