import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalText } from '../../core/validate.js';
import { fileTitle } from '../../core/file-title.js';
import { config } from '../../config.js';
import * as payroll from './service.js';
import { payslipPdf, payslipXlsx, registerXlsx } from './payslip-files.js';
import { STATUSES as ATTENDANCE } from '../attendance/service.js';

// Weekly payroll: managers prepare, adjust, approve, pay and close; supervisors check the days
// (without seeing any money). Payslips as PDF or Excel, to send on WhatsApp.

export const router = Router();
const view = canAny('attendance.manage', 'payroll.manage', 'payroll.approve');
const manage = canAny('payroll.manage');
const approve = canAny('payroll.approve');
const checker = canAny('attendance.manage');
const seesPay = (req) => req.user.can('payroll.manage') || req.user.can('payroll.approve');

const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

async function loadPayroll(req) {
  const id = Number(req.params.id);
  const p = Number.isInteger(id) ? await payroll.getPayroll(id) : null;
  if (!p) throw httpError(404, 'That payroll doesn’t exist.');
  if (!worksAt(req, p.site_id)) throw httpError(403, `${p.number} is for ${p.site_name}, which isn’t one of your sites.`);
  return p;
}

function slipOf(req, p) {
  const slip = p.slips.find((s) => s.id === Number(req.params.slip));
  if (!slip) throw httpError(404, 'That payslip doesn’t exist.');
  return slip;
}

/** Runs an action; a refusal the user can fix comes back as a message on the payroll page. */
async function act(req, res, fn, done) {
  try {
    await fn();
    if (done) req.session.flash = { type: 'success', text: done };
  } catch (err) {
    if (!err.expose) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/payroll/${req.params.id}`);
}

router.get('/payroll', view, async (req, res) => {
  const site = req.user.sites.find((s) => s.id === Number(req.query.site)) ?? req.site ?? req.user.sites[0];
  if (!site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  const today = localDay();
  const week = payroll.weekStartOf(isDay(String(req.query.week ?? '')) ? String(req.query.week) : today);
  res.render('payroll/views/index', {
    title: 'Payroll', site, week, today,
    sites: req.user.sites,
    prev: payroll.weekStartOf(new Date(Date.parse(`${week}T12:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10)),
    next: week < payroll.weekStartOf(today) ? new Date(Date.parse(`${week}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10) : null,
    confirmed: await payroll.confirmedDays(site.id, week),
    waiting: await payroll.waitingOnOtherSites(site.id, week),
    current: await payroll.payrollFor(site.id, week),
    list: await payroll.listPayrolls(req.user.sites.map((s) => s.id)),
    statuses: payroll.STATUSES,
    canPrepare: req.user.can('payroll.manage'), canSeePay: seesPay(req),
  });
});

router.post('/payroll', manage, async (req, res) => {
  const site = req.user.sites.find((s) => s.id === Number(req.body.site));
  const week = isDay(String(req.body.week ?? '')) ? payroll.weekStartOf(String(req.body.week)) : null;
  if (!site || !week) throw httpError(400, 'Choose the site and the week.');
  try {
    const { id, number } = await payroll.preparePayroll(site.id, week, req);
    req.session.flash = { type: 'success', text: `${number} prepared from the confirmed attendance. Add any advances or allowances, then the supervisor checks the days.` };
    res.redirect(`/payroll/${id}`);
  } catch (err) {
    if (!err.expose) throw err;
    req.session.flash = { type: 'warning', text: err.message };
    res.redirect(`/payroll?site=${site.id}&week=${week}`);
  }
});

router.get('/payroll/:id', view, async (req, res) => {
  const p = await loadPayroll(req);
  res.render('payroll/views/show', {
    title: `Payroll ${p.number}`, p,
    statuses: payroll.STATUSES, methods: payroll.METHODS, attendance: ATTENDANCE,
    canSeePay: seesPay(req), canManage: req.user.can('payroll.manage'), canApprove: req.user.can('payroll.approve'), canCheck: req.user.can('attendance.manage'),
    entries: seesPay(req) ? await history('payroll', p.id) : [],
  });
});

router.post('/payroll/:id/recalculate', manage, async (req, res) => {
  const p = await loadPayroll(req);
  await act(req, res, () => payroll.recalculate(p.id, req), 'Worked out again from the confirmed attendance. Adjustments were kept.');
});

router.post('/payroll/:id/check', checker, async (req, res) => {
  const p = await loadPayroll(req);
  await act(req, res, () => payroll.markChecked(p.id, req), 'Days checked. A manager approves it next.');
});

router.post('/payroll/:id/draft', manage, async (req, res) => {
  const p = await loadPayroll(req);
  await act(req, res, () => payroll.backToDraft(p.id, req), 'Back to draft: work it out again after correcting attendance, then have the days checked again.');
});

router.post('/payroll/:id/approve', approve, async (req, res) => {
  const p = await loadPayroll(req);
  await act(req, res, () => payroll.approve(p.id, req), 'Approved and locked. Payslips are ready; mark people paid as you pay them.');
});

const paySchema = z.object({
  method: z.enum(Object.keys(payroll.METHODS), { error: 'Choose how they were paid' }),
  reference: optionalText(60),
  slip: z.union([z.literal(''), z.coerce.number().int().positive()]).optional().transform((v) => v || null),
});

router.post('/payroll/:id/pay', manage, async (req, res) => {
  const p = await loadPayroll(req);
  const { data, errors } = check(paySchema, req.body);
  if (errors) {
    req.session.flash = { type: 'warning', text: Object.values(errors)[0] };
    return res.redirect(`/payroll/${p.id}`);
  }
  await act(req, res, () => payroll.markPaid(p.id, data.slip, data, req), data.slip ? 'Marked paid.' : 'Everyone marked paid.');
});

router.post('/payroll/:id/close', manage, async (req, res) => {
  const p = await loadPayroll(req);
  await act(req, res, () => payroll.close(p.id, req), `${p.number} closed.`);
});

const adjustmentSchema = z.object({
  direction: z.enum(['deduct', 'add']).catch('deduct'),
  amount: z.preprocess((v) => (typeof v === 'string' ? v.replace(/[,\s]/g, '') : v),
    z.coerce.number({ message: 'Enter the amount' }).positive('Enter the amount').max(1_000_000, 'Check the amount')),
  reason: z.string().trim().min(2, 'Say what it is for, e.g. Advance 12 Nov').max(120, 'Use 120 characters or fewer'),
});

router.post('/payroll/:id/slips/:slip/adjustments', manage, async (req, res) => {
  const p = await loadPayroll(req);
  const slip = slipOf(req, p);
  const { data, errors } = check(adjustmentSchema, req.body);
  if (errors) {
    req.session.flash = { type: 'warning', text: `${slip.name}: ${Object.values(errors)[0]}.` };
    return res.redirect(`/payroll/${p.id}`);
  }
  const amount = Math.round(data.amount * 100) / 100 * (data.direction === 'deduct' ? -1 : 1);
  await act(req, res, () => payroll.addAdjustment(slip.id, { amount, reason: data.reason }, req), `${slip.name}: ${data.direction === 'deduct' ? 'deduction' : 'addition'} saved.`);
});

router.post('/payroll/:id/adjustments/:adj/delete', manage, async (req, res) => {
  const p = await loadPayroll(req);
  if (!p.slips.some((s) => s.adjustment_lines.some((a) => a.id === Number(req.params.adj)))) throw httpError(404, 'That adjustment doesn’t exist.');
  await act(req, res, () => payroll.removeAdjustment(Number(req.params.adj), req), 'Adjustment removed.');
});

// ---------- files ----------

const slipName = (p, slip) => fileTitle(`Payslip ${p.days[0]}`, slip.name);

/** Payslips exist once the payroll is approved: before that, the figures can still change. */
function payslipReady(p) {
  if (['draft', 'checked'].includes(p.status)) throw httpError(409, 'Payslips are ready once the payroll is approved.');
}

router.get('/payroll/:id/slips/:slip.pdf', manage, async (req, res) => {
  const p = await loadPayroll(req);
  payslipReady(p);
  const slip = slipOf(req, p);
  res.type('application/pdf').attachment(`${slipName(p, slip)}.pdf`).send(await payslipPdf(p, slip, config.company));
});

router.get('/payroll/:id/slips/:slip.xlsx', manage, async (req, res) => {
  const p = await loadPayroll(req);
  payslipReady(p);
  const slip = slipOf(req, p);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`${slipName(p, slip)}.xlsx`).send(await payslipXlsx(p, slip, config.company));
});

router.get('/payroll/:id/register.xlsx', manage, async (req, res) => {
  const p = await loadPayroll(req);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`Payroll ${p.number} ${p.site_name}.xlsx`.replace(/[\\/:*?"<>|]+/g, ' ')).send(await registerXlsx(p, config.company));
});
