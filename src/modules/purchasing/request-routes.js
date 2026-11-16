import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalText } from '../../core/validate.js';
import * as orders from './service.js';
import * as requests from './requests.js';
import { readLines, blankRow, rowsOf } from './lines.js';
import { listCategories } from '../items/service.js';

// Purchase requests: the workshop asks for materials, a manager approves, stores order them.

export const router = Router();
const view = canAny('purchasing.request', 'purchasing.manage', 'purchasing.approve');
const ask = canAny('purchasing.request', 'purchasing.manage');
const approve = canAny('purchasing.approve');

const schema = z.object({
  needed_by: z.string().trim().optional().refine((v) => !v || isDay(v), 'Check the date').transform((v) => v || null),
  notes: optionalText(1000),
});

const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);
const isOwn = (req, r) => r.requested_by === req.user.id;
/** Whoever asked may change or withdraw it; so may stores. */
const mayChange = (req, r) => isOwn(req, r) || req.user.can('purchasing.manage');

async function loadRequest(req) {
  const id = Number(req.params.id);
  const request = Number.isInteger(id) ? await requests.getRequest(id) : null;
  if (!request) throw httpError(404, 'That purchase request doesn’t exist.');
  if (!worksAt(req, request.site_id)) throw httpError(403, `${request.number} belongs to ${request.site_name}, which isn’t one of your sites.`);
  return request;
}

async function renderForm(req, res, { status = 200, request = null, values, rows = [], errors = {} }) {
  const canAddItems = req.user.can('purchasing.manage') || req.user.can('inventory.manage');
  res.status(status).render('purchasing/views/request-form', {
    title: request ? `Edit ${request.number}` : 'Ask for materials',
    request, values, errors, canAddItems,
    rows: rows.length ? rows : [blankRow()],
    items: await orders.itemOptions(),
    jobs: await orders.jobOptions(req.user.sites.map((s) => s.id)),
    categories: canAddItems ? await listCategories() : [],
    willApprove: req.user.can('purchasing.approve'),
    today: localDay(),
  });
}

async function validate(body) {
  const { data, errors } = check(schema, body);
  const { rows, lines, error } = await readLines(body, { prices: false });
  const all = { ...errors, ...(error ? { lines: error } : {}) };
  if (data?.needed_by && data.needed_by < localDay()) all.needed_by = 'That date has passed';
  if (data) data.lines = lines;
  return { data, rows, errors: all };
}

router.get('/purchase-requests', view, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const canOrder = req.user.can('purchasing.manage');
  const canApprove = req.user.can('purchasing.approve');
  // Each person lands where their work is: approvers on what waits for them, stores on what to order.
  const start = canApprove ? 'pending' : canOrder ? 'approved' : 'all';
  const tab = requests.TABS.includes(req.query.show) ? req.query.show : start;
  const siteIds = req.user.sites.map((s) => s.id);
  res.render('purchasing/views/requests', {
    title: 'Purchase requests', tab, q,
    list: await requests.listRequests({ siteIds, tab, q }),
    counts: await requests.countByTab(siteIds),
    statuses: requests.STATUSES,
    canAsk: req.user.can('purchasing.request') || canOrder,
    canOrder,
  });
});

router.get('/purchase-requests/new', ask, async (req, res) => {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  // From a job's page: the job is filled in as what it's for.
  const job = req.query.job ? (await orders.jobOptions(req.user.sites.map((s) => s.id))).find((j) => j.number === req.query.job) : null;
  const rows = job ? [{ ...blankRow(), for: `${job.number} ${job.customer_name}` }] : [];
  await renderForm(req, res, { values: { needed_by: '', notes: '' }, rows });
});

router.post('/purchase-requests', ask, async (req, res) => {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  const values = { needed_by: '', notes: '', ...req.body };
  const { data, rows, errors } = await validate(req.body);
  if (Object.keys(errors).length) return renderForm(req, res, { status: 422, values, rows, errors });
  const { id, number, status } = await requests.createRequest(data, req);
  req.session.flash = { type: 'success', text: status === 'approved' ? `${number} saved and approved: stores can order it.` : `${number} sent for approval.` };
  res.redirect(`/purchase-requests/${id}`);
});

router.get('/purchase-requests/:id', view, async (req, res) => {
  const request = await loadRequest(req);
  res.render('purchasing/views/request', {
    title: request.number, request, statuses: requests.STATUSES, orderStatuses: orders.STATUSES,
    entries: await history('purchase_request', request.id),
    canChange: mayChange(req, request),
    canApprove: req.user.can('purchasing.approve'),
    canOrder: req.user.can('purchasing.manage'),
    canSeeOrders: req.user.can('purchasing.manage') || req.user.can('purchasing.approve'),
    canSeeJobs: req.user.can('jobs.view') || req.user.can('jobs.progress') || req.user.can('jobs.manage'),
  });
});

router.get('/purchase-requests/:id/edit', ask, async (req, res) => {
  const request = await loadRequest(req);
  if (!mayChange(req, request)) throw httpError(403, `Only whoever asked, or stores, can change ${request.number}.`);
  if (request.status !== 'pending') throw httpError(409, `${request.number} is ${requests.STATUSES[request.status].label.toLowerCase()}, so it can’t be changed.`);
  await renderForm(req, res, { request, values: { needed_by: request.needed_by ?? '', notes: request.notes ?? '' }, rows: rowsOf(request.lines) });
});

router.post('/purchase-requests/:id', ask, async (req, res) => {
  const request = await loadRequest(req);
  if (!mayChange(req, request)) throw httpError(403, `Only whoever asked, or stores, can change ${request.number}.`);
  const values = { needed_by: '', notes: '', ...req.body };
  const { data, rows, errors } = await validate(req.body);
  if (Object.keys(errors).length) return renderForm(req, res, { status: 422, request, values, rows, errors });
  await requests.updateRequest(request.id, data, req);
  req.session.flash = { type: 'success', text: `Saved changes to ${request.number}.` };
  res.redirect(`/purchase-requests/${request.id}`);
});

const reasonOf = (req) => String(req.body.reason ?? '').trim();
const badReason = (reason) => reason.length < 3 || reason.length > 255;

router.post('/purchase-requests/:id/approve', approve, async (req, res) => {
  const request = await loadRequest(req);
  await requests.approveRequest(request.id, req);
  req.session.flash = { type: 'success', text: `${request.number} approved: stores can order it.` };
  res.redirect(`/purchase-requests/${request.id}`);
});

router.post('/purchase-requests/:id/decline', approve, async (req, res) => {
  const request = await loadRequest(req);
  const reason = reasonOf(req);
  if (badReason(reason)) {
    req.session.flash = { type: 'warning', text: 'Say why it is declined (3 to 255 characters), so whoever asked knows.' };
    return res.redirect(`/purchase-requests/${request.id}`);
  }
  await requests.declineRequest(request.id, reason, req);
  req.session.flash = { type: 'warning', text: `${request.number} declined.` };
  res.redirect(`/purchase-requests/${request.id}`);
});

router.post('/purchase-requests/:id/cancel', ask, async (req, res) => {
  const request = await loadRequest(req);
  if (!mayChange(req, request)) throw httpError(403, `Only whoever asked, or stores, can cancel ${request.number}.`);
  const reason = reasonOf(req);
  if (badReason(reason)) {
    req.session.flash = { type: 'warning', text: 'Say why it is no longer needed (3 to 255 characters).' };
    return res.redirect(`/purchase-requests/${request.id}`);
  }
  await requests.cancelRequest(request.id, reason, req);
  req.session.flash = { type: 'warning', text: `${request.number} cancelled.` };
  res.redirect(`/purchase-requests/${request.id}`);
});
