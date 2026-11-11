import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalText } from '../../core/validate.js';
import * as issues from './service.js';
import { getJob } from '../jobs/service.js';

// Issuing materials to jobs, and returning what wasn't used.

export const router = Router();
const manage = canAny('stores.issue');
const see = canAny('stores.issue', 'inventory.manage');

const issueSchema = z.object({
  issued_on: z.string().trim().refine((v) => isDay(v), 'Check the date'),
  received_by: optionalText(100),
  notes: optionalText(2000),
  destination: optionalText(150),
});

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
}

async function loadJob(req) {
  const id = Number(req.params.id);
  const job = Number.isInteger(id) ? await getJob(id) : null;
  if (!job) throw httpError(404, 'That job doesn’t exist.');
  if (!worksAt(req, job.site_id)) throw httpError(403, `${job.number} is at ${job.site_name}, which isn’t one of your sites.`);
  return job;
}

/** Rows arrive as lists of balance id, the name typed, and quantity. A row with neither is skipped. */
function readLines(body) {
  const list = (key) => [].concat(body[key] ?? []).map((v) => String(v ?? '').trim());
  const [ids, labels, quantities] = ['line_balance_id', 'line_label', 'line_quantity'].map(list);
  const rows = labels.map((label, i) => ({ balance_id: ids[i] ?? '', label, quantity: quantities[i] ?? '' }));
  const lines = [];
  let error = null;
  rows.forEach((row, i) => {
    if (!row.label && !row.balance_id && !row.quantity) return;
    const qty = number(row.quantity);
    if (!Number(row.balance_id)) error ??= `Line ${i + 1}: choose an item from what is in stock`;
    else if (!Number.isFinite(qty) || qty <= 0 || !decimals(qty, 3)) error ??= `Line ${i + 1}: check the quantity`;
    else lines.push({ balance_id: Number(row.balance_id), quantity: qty });
  });
  if (!error && !lines.length) error = 'Add at least one item';
  return { rows, lines, error };
}

const blankRow = () => ({ balance_id: '', label: '', quantity: '' });

async function renderForm(req, res, { status = 200, job, values, rows = [], errors = {} }) {
  res.status(status).render('issues/views/form', {
    title: `Issue materials to ${job.number}`, job, values, errors,
    rows: rows.length ? rows : [blankRow()],
    stock: await issues.availableStock(req.site.id),
  });
}

router.get('/stores/issue', see, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const siteIds = req.user.sites.map((s) => s.id);
  res.render('issues/views/index', {
    title: 'Issue materials', q,
    list: await issues.listIssues({ siteIds, q }),
    jobs: req.user.can('stores.issue') ? await issues.activeJobs(siteIds) : [],
  });
});

// The job picker on the list page.
router.get('/stores/issue/start', manage, async (req, res) => {
  const id = Number(req.query.job_id);
  if (!Number.isInteger(id) || id <= 0) {
    req.session.flash = { type: 'warning', text: 'Choose the job first.' };
    return res.redirect('/stores/issue');
  }
  res.redirect(`/jobs/${id}/issue`);
});

router.get('/jobs/:id/issue', manage, async (req, res) => {
  needSite(req);
  const job = await loadJob(req);
  if (!['open', 'in_progress'].includes(job.status)) throw httpError(409, `${job.number} is finished, so materials can’t be issued to it. Reopen it first.`);
  await renderForm(req, res, { job, values: { issued_on: localDay(), received_by: '', notes: '', leaves_site: '', destination: '' } });
});

router.post('/jobs/:id/issue', manage, async (req, res) => {
  needSite(req);
  const job = await loadJob(req);
  const values = { issued_on: '', received_by: '', notes: '', leaves_site: '', destination: '', ...req.body };
  const { data, errors } = check(issueSchema, req.body);
  const { rows, lines, error } = readLines(req.body);
  const all = { ...errors, ...(error ? { lines: error } : {}) };
  // Leaving the site: a gate pass, so the gate must know where it is going.
  const leaves = values.leaves_site === '1';
  if (leaves && !data?.destination) all.destination = 'Say where it is going';
  if (Object.keys(all).length) return renderForm(req, res, { status: 422, job, values, rows, errors: all });
  try {
    const { id, number: issueNumber } = await issues.issueMaterials(job.id, { ...data, leaves_site: leaves, lines }, req);
    req.session.flash = { type: 'success', text: `${issueNumber} saved: stock reduced and charged to ${job.number}.${leaves ? ' It is on the gate’s list to let out.' : ''}` };
    res.redirect(`/stores/issue/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(req, res, { status: 422, job, values, rows, errors: { [err.field]: err.message } });
  }
});

async function loadIssue(req) {
  const id = Number(req.params.id);
  const issue = Number.isInteger(id) ? await issues.getIssue(id) : null;
  if (!issue) throw httpError(404, 'That issue doesn’t exist.');
  if (!worksAt(req, issue.site_id)) throw httpError(403, `${issue.number} is at ${issue.site_name}, which isn’t one of your sites.`);
  return issue;
}

router.get('/stores/issue/:id', see, async (req, res) => {
  const issue = await loadIssue(req);
  const returnError = req.session.returnError ?? null;
  delete req.session.returnError;
  res.render('issues/views/show', {
    title: issue.number, issue, returnError,
    entries: await history('material_issue', issue.id),
    canReturn: req.user.can('stores.issue'),
    pass: issues.passStage(issue), passStages: issues.PASS_STAGES,
    canCancelPass: req.user.can('stores.issue') && issues.passStage(issue) === 'waiting',
  });
});

/** Stores: the materials aren't going out after all. */
router.post('/stores/issue/:id/cancel-pass', manage, async (req, res) => {
  const issue = await loadIssue(req);
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why it isn’t going (3 to 255 characters).' };
    return res.redirect(`/stores/issue/${issue.id}`);
  }
  try {
    await issues.cancelPass(issue.id, reason, req);
    req.session.flash = { type: 'success', text: `Gate pass for ${issue.number} cancelled. The materials are still charged to ${issue.job_number}: return what isn’t used.` };
  } catch (err) {
    if (err.status !== 409) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/stores/issue/${issue.id}`);
});

router.post('/stores/issue/:id/return', manage, async (req, res) => {
  const issue = await loadIssue(req);
  const list = (key) => [].concat(req.body[key] ?? []).map((v) => String(v ?? '').trim());
  const [ids, quantities] = [list('line_id'), list('line_quantity')];
  const lines = [];
  let error = null;
  ids.forEach((id, i) => {
    if (!quantities[i]) return;
    const qty = number(quantities[i]);
    if (!Number.isFinite(qty) || qty < 0 || !decimals(qty, 3)) error ??= 'Check the quantities coming back';
    else if (qty > 0) lines.push({ line_id: Number(id), quantity: qty });
  });
  if (!error && !lines.length) error = 'Enter how much came back';
  try {
    if (error) throw Object.assign(httpError(422, error), { field: 'lines' });
    await issues.returnMaterials(issue.id, lines, req);
    req.session.flash = { type: 'success', text: `Back in stock at the cost it left at, and taken off ${issue.job_number}.` };
  } catch (err) {
    if (!err.field) throw err;
    req.session.returnError = err.message;
  }
  res.redirect(`/stores/issue/${issue.id}`);
});
