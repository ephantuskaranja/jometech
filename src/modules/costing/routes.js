import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { can } from '../../core/auth.js';
import { check, httpError, optionalAmount, optionalText } from '../../core/validate.js';
import { db } from '../../core/db.js';
import { isDay, localDay } from '../../core/dates.js';
import { listSites } from '../sites/service.js';
import * as costing from './service.js';
import { makeShares } from './service.js';
import * as running from './running-costs.js';

// System → Closed days: the days the workshop didn't work (Christmas …). Left out of a job's work days.
// Running costs: entered once a month per site, shared across that month's jobs by work days.
export const router = Router();
router.use('/admin/closed-days', can('system.settings'));

const daySchema = z.object({
  day: z.string().trim().refine(isDay, 'Choose the day'),
  site_id: z.string().trim().optional().transform((v) => (v ? Number(v) : null)),
  reason: z.string().trim().min(2, 'Say why it was closed, e.g. Christmas').max(100, 'Use 100 characters or fewer'),
});

async function render(res, { status = 200, values = { day: '', site_id: '', reason: '' }, errors = {} } = {}) {
  const list = await costing.listClosedDays();
  const today = localDay();
  res.status(status).render('costing/views/closed-days', {
    title: 'Closed days', values, errors, today,
    coming: list.filter((d) => d.day >= today).reverse(), past: list.filter((d) => d.day < today),
    sites: (await listSites()).filter((s) => s.is_active),
  });
}

router.get('/admin/closed-days', (req, res) => render(res));

router.post('/admin/closed-days', async (req, res) => {
  const { data, errors } = check(daySchema, req.body);
  if (errors) return render(res, { status: 422, values: req.body, errors });
  try {
    await costing.addClosedDay(data, req);
  } catch (err) {
    if (!err.field) throw err;
    return render(res, { status: 422, values: req.body, errors: { [err.field]: err.message } });
  }
  req.session.flash = { type: 'success', text: `${data.day} marked as closed. Jobs don’t count it as a work day.` };
  res.redirect('/admin/closed-days');
});

router.post('/admin/closed-days/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(404, 'That closed day doesn’t exist.');
  await costing.removeClosedDay(id, req);
  req.session.flash = { type: 'success', text: 'Closed day removed. Jobs count it as a work day again.' };
  res.redirect('/admin/closed-days');
});

// ---------- running costs: once a month per site (managers and admins) ----------

const seeCosts = can('costing.view');

const runningSchema = z.object(Object.fromEntries(running.CATEGORIES.flatMap((c) => [
  [`amount_${c.key}`, optionalAmount()],
  [`note_${c.key}`, optionalText(150)],
])));

async function renderRunning(req, res, month, { status = 200, values = null, errors = {} } = {}) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  const [saved, share] = await Promise.all([running.forMonth(req.site.id, month), makeShares().period('month', req.site.id, month)]);
  const jobIds = [...share.jobs.keys()];
  const jobs = jobIds.length ? await db('jobs as j').join('customers as c', 'c.id', 'j.customer_id').whereIn('j.id', jobIds)
    .select('j.id', 'j.number', 'j.status', 'c.name as customer_name') : [];
  res.status(status).render('costing/views/running-costs', {
    title: `Running costs · ${running.monthLabel(month)}`, month, label: running.monthLabel(month),
    prev: running.shiftMonth(month, -1), next: running.shiftMonth(month, 1), thisMonth: localDay().slice(0, 7),
    saved, values, errors, share, site: req.site,
    jobs: jobs.map((j) => ({ ...j, days: share.jobs.get(j.id) })).sort((a, b) => b.days - a.days),
  });
}

router.get('/costing/running-costs', seeCosts, async (req, res) => {
  const month = req.query.month ? running.requireMonth(String(req.query.month)) : localDay().slice(0, 7);
  await renderRunning(req, res, month);
});

router.post('/costing/running-costs', seeCosts, async (req, res) => {
  const month = running.requireMonth(String(req.body.month ?? ''));
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  const { data, errors: invalid } = check(runningSchema, req.body);
  const errors = { ...invalid };
  if (data?.amount_other && !data.note_other) errors.note_other = 'Say what the other cost was';
  if (Object.keys(errors).length) return renderRunning(req, res, month, { status: 422, values: req.body, errors });
  const amounts = Object.fromEntries(running.CATEGORIES.map((c) => [c.key, { amount: data[`amount_${c.key}`], note: data[`note_${c.key}`] }]));
  await running.saveMonth(req.site.id, month, amounts, req);
  req.session.flash = { type: 'success', text: `Running costs for ${running.monthLabel(month)} at ${req.site.name} saved. Jobs that month carry their share by work days.` };
  res.redirect(`/costing/running-costs?month=${month}`);
});

// ---------- Reports → Job costing ----------

function reportChoice(req) {
  const month = req.query.month && running.isMonth(String(req.query.month)) ? String(req.query.month) : localDay().slice(0, 7);
  const site = req.user.sites.find((s) => s.id === Number(req.query.site)) ?? null;
  const tab = req.query.show === 'open' ? 'open' : 'completed';
  const qs = new URLSearchParams({ month, show: tab, ...(site ? { site: site.id } : {}) }).toString();
  return { month, site, tab, qs, siteIds: site ? [site.id] : req.user.sites.map((s) => s.id) };
}

router.get('/reports/job-costing', seeCosts, async (req, res) => {
  const { month, site, tab, qs, siteIds } = reportChoice(req);
  const { jobs, totals } = await costing.report({ month, siteIds, tab });
  res.render('costing/views/report', {
    title: 'Job costing', month, label: running.monthLabel(month), prev: running.shiftMonth(month, -1), next: running.shiftMonth(month, 1),
    thisMonth: localDay().slice(0, 7), site, sites: req.user.sites, tab, qs, jobs, totals, missingText,
  });
});

router.get('/reports/job-costing.xlsx', seeCosts, async (req, res) => {
  const { month, site, tab, siteIds } = reportChoice(req);
  const { jobs, totals } = await costing.report({ month, siteIds, tab });
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Job costing');
  const MONEY = '#,##0.00';
  ws.columns = [
    { header: 'Job', key: 'number', width: 16 }, { header: 'Customer', key: 'customer', width: 28 }, { header: 'Site', key: 'site', width: 14 },
    { header: 'Job type', key: 'type', width: 18 }, { header: 'Work days', key: 'days', width: 10 },
    { header: 'Price without VAT', key: 'price', width: 18, style: { numFmt: MONEY } }, { header: 'Materials', key: 'materials', width: 16, style: { numFmt: MONEY } },
    { header: 'Wages', key: 'wages', width: 14, style: { numFmt: MONEY } }, { header: 'Running costs', key: 'running', width: 16, style: { numFmt: MONEY } },
    { header: 'Net profit', key: 'net', width: 16, style: { numFmt: MONEY } }, { header: 'Margin %', key: 'margin', width: 10 },
    { header: 'Not counted yet', key: 'missing', width: 34 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const j of jobs) {
    const c = j.costing;
    ws.addRow({
      number: j.number, customer: j.customer_name, site: j.site_name, type: j.job_type_name ?? '', days: c.days?.days ?? 0,
      price: c.price?.exVat ?? null, materials: c.materials, wages: c.wages?.amount ?? 0, running: c.running?.amount ?? 0,
      net: c.price ? c.net : null, margin: c.netMargin, missing: missingText(c),
    });
  }
  const t = ws.addRow({ number: 'Total', price: totals.price, materials: totals.materials, wages: totals.wages, running: totals.running, net: totals.net, margin: totals.margin });
  t.font = { bold: true };
  res.attachment(`job-costing-${month}${tab === 'open' ? '-in-progress' : ''}${site ? `-${site.code}` : ''}.xlsx`);
  await book.xlsx.write(res);
  res.end();
});

/** What a job's figures don't include yet (no approved payroll, running costs not entered, no price). */
export function missingText(c) {
  return [
    !c.price && 'no price',
    c.wages?.missing.length && `payroll for ${c.wages.missing.length} week${c.wages.missing.length === 1 ? '' : 's'}`,
    c.running?.missing.length && `running costs for ${c.running.missing.map(running.monthLabel).join(', ')}`,
  ].filter(Boolean).join('; ');
}
