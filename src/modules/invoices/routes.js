import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalAmount, optionalId, optionalText } from '../../core/validate.js';
import { readLines } from '../../core/price-lines.js';
import { fileTitle as documentTitle } from '../../core/file-title.js';
import { config } from '../../config.js';
import * as invoices from './service.js';
import * as customers from '../customers/service.js';
import { getJob } from '../jobs/service.js';
import { vatIn } from '../proformas/service.js';

// Invoices: from a job (its proforma's lines and prices), then issued, printed, paid.
// Payments are recorded on the job, from the job page or the invoice.

export const router = Router();
const manage = canAny('invoices.manage');

const invoiceSchema = z.object({
  financier_id: optionalId(),
  notes: optionalText(2000),
});

function validate(body) {
  const { data, errors } = check(invoiceSchema, body);
  const { rows, lines, error } = readLines(body);
  const all = { ...errors };
  if (error) all.lines = error;
  if (data) data.lines = lines;
  return { data, rows, errors: all };
}

const paymentSchema = z.object({
  amount: optionalAmount().refine((v) => v !== null && v > 0, 'Enter the amount received'),
  paid_on: z.string().trim().refine((v) => isDay(v) && v <= localDay(), 'Check the date (not in the future)'),
  method: z.enum(Object.keys(invoices.METHODS), { error: 'Choose how it was paid' }),
  payer: z.enum(['client', 'financier']).catch('client'),
  reference: optionalText(60),
  notes: optionalText(255),
  // More than is owed: confirmed in the form, with a reason (see invoices.recordPayment).
  confirm_excess: z.preprocess((v) => v === '1', z.boolean()),
  excess_reason: optionalText(200),
});

/** Where to go back to after a payment: the invoice or the job it was recorded from. */
const backTo = (value, fallback) => (/^\/(invoices|jobs)\/\d+$/.test(String(value ?? '')) ? value : fallback);

const blankRow = () => ({ quantity: '1', unit: 'Unit', description: '', unit_price: '' });
const asRows = (lines) => lines.map((l) => ({ quantity: String(Number(l.quantity)), unit: l.unit, description: l.description, unit_price: l.unit_price === '' ? '' : String(Number(l.unit_price)) }));

async function loadInvoice(req) {
  const invoice = await invoices.getInvoice(Number(req.params.id));
  if (!invoice) throw httpError(404, 'That invoice doesn’t exist.');
  return invoice;
}

async function loadJob(req) {
  const job = await getJob(Number(req.params.id));
  if (!job) throw httpError(404, 'That job doesn’t exist.');
  return job;
}

async function renderForm(res, { status = 200, job, invoice = null, values, rows, errors = {} }) {
  const financier = values.financier_id ? await customers.getCustomer(Number(values.financier_id)) : null;
  res.status(status).render('invoices/views/form', {
    title: invoice ? `Edit draft invoice for ${job.number}` : `Invoice ${job.number}`,
    job, invoice, values, errors,
    rows: rows.length ? rows : [blankRow()],
    financierOption: financier ? [{ value: financier.id, label: `${financier.name} (${financier.number})` }] : [],
    categories: customers.CATEGORIES, // "Add new customer" window, for a bank not in the list yet
    vatRate: config.vatRate,
  });
}

router.get('/invoices', manage, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const tab = invoices.TABS.includes(req.query.show) ? req.query.show : 'unpaid';
  res.render('invoices/views/index', {
    title: 'Invoices', tab, q,
    list: await invoices.listInvoices({ tab, q }),
    counts: await invoices.countByTab(),
    statuses: invoices.STATUSES, paidStates: invoices.PAID_STATES,
  });
});

// A job's invoice: opens it if there is one, otherwise a new draft filled in from the proforma.
router.get('/jobs/:id/invoice', manage, async (req, res) => {
  const job = await loadJob(req);
  const existing = await invoices.currentInvoice(job.id);
  if (existing) return res.redirect(`/invoices/${existing.id}`);
  if (job.status === 'cancelled') throw httpError(409, `${job.number} was cancelled, so it can’t be invoiced.`);
  await renderForm(res, { job, values: { financier_id: '', notes: '' }, rows: asRows(await invoices.startFor(job)) });
});

router.post('/jobs/:id/invoice', manage, async (req, res) => {
  const job = await loadJob(req);
  const values = { financier_id: '', notes: '', ...req.body };
  const { data, rows, errors } = validate(req.body);
  if (Object.keys(errors).length) return renderForm(res, { status: 422, job, values, rows, errors });
  try {
    const { id } = await invoices.createInvoice(job.id, data, req);
    req.session.flash = { type: 'success', text: 'Invoice saved as a draft. Check it, then issue it: that gives it its number.' };
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, job, values, rows, errors: { [err.field]: err.message } });
  }
});

router.get('/invoices/:id', manage, async (req, res) => {
  const invoice = await loadInvoice(req);
  res.render('invoices/views/show', {
    title: invoice.number ? `Invoice ${invoice.number}` : `Draft invoice ${invoice.job_number}`, invoice,
    statuses: invoices.STATUSES, paidStates: invoices.PAID_STATES, methods: invoices.METHODS,
    vat: vatIn(invoice.total), vatRate: config.vatRate, today: localDay(),
    due: await invoices.owedOn(invoice.job_id),
    entries: await history('invoice', invoice.id),
  });
});

router.get('/invoices/:id/edit', manage, async (req, res) => {
  const invoice = await loadInvoice(req);
  if (invoice.status !== 'draft') throw httpError(409, `Invoice ${invoice.number} has been issued, so it can’t be changed.`);
  const job = await getJob(invoice.job_id);
  await renderForm(res, { job, invoice, values: { financier_id: invoice.financier_id ?? '', notes: invoice.notes ?? '' }, rows: asRows(invoice.lines) });
});

router.post('/invoices/:id', manage, async (req, res) => {
  const invoice = await loadInvoice(req);
  const job = await getJob(invoice.job_id);
  const values = { financier_id: '', notes: '', ...req.body };
  const { data, rows, errors } = validate(req.body);
  if (Object.keys(errors).length) return renderForm(res, { status: 422, job, invoice, values, rows, errors });
  try {
    await invoices.updateInvoice(invoice.id, data, req);
    req.session.flash = { type: 'success', text: 'Saved changes to the draft.' };
    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, job, invoice, values, rows, errors: { [err.field]: err.message } });
  }
});

router.post('/invoices/:id/issue', manage, async (req, res) => {
  const invoice = await loadInvoice(req);
  const { number } = await invoices.issueInvoice(invoice.id, req);
  req.session.flash = { type: 'success', text: `Issued as invoice ${number}. Print it for the customer, and add the KRA eTIMS number once it is keyed in.` };
  res.redirect(`/invoices/${invoice.id}`);
});

router.post('/invoices/:id/delete', manage, async (req, res) => {
  const invoice = await loadInvoice(req);
  await invoices.deleteDraft(invoice.id, req);
  req.session.flash = { type: 'success', text: `Draft invoice for ${invoice.job_number} deleted.` };
  res.redirect(`/jobs/${invoice.job_id}`);
});

router.post('/invoices/:id/cancel', manage, async (req, res) => {
  const invoice = await loadInvoice(req);
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why it is being cancelled (3 to 255 characters).' };
    return res.redirect(`/invoices/${invoice.id}`);
  }
  await invoices.cancelInvoice(invoice.id, reason, req);
  req.session.flash = { type: 'warning', text: `Invoice ${invoice.number} cancelled. Payments stay on job ${invoice.job_number}; make a new invoice from the job if needed.` };
  res.redirect(`/invoices/${invoice.id}`);
});

router.post('/invoices/:id/etims', manage, async (req, res) => {
  const invoice = await loadInvoice(req);
  const value = String(req.body.etims_number ?? '').trim().toUpperCase();
  if (value.length > 40) {
    req.session.flash = { type: 'warning', text: 'The eTIMS number is too long (40 characters at most).' };
    return res.redirect(`/invoices/${invoice.id}`);
  }
  await invoices.setEtims(invoice.id, value || null, req);
  req.session.flash = { type: 'success', text: value ? `eTIMS number ${value} saved.` : 'eTIMS number removed.' };
  res.redirect(`/invoices/${invoice.id}`);
});

/** The print page's title, also the PDF's file name: "Invoice 105 - Mike Juma Wandeme & Co-operative Bank". */
export const fileTitle = ({ number, customer_name: customer, financier_name: bank }) => documentTitle(`Invoice ${number ?? 'draft'}`, customer, bank);

// The paper invoice, filled in: an A4 page to print or save as PDF.
router.get('/invoices/:id/print', manage, async (req, res) => {
  const invoice = await loadInvoice(req);
  res.render('invoices/views/print', {
    layout: false,
    title: fileTitle(invoice),
    invoice, company: config.company,
    vat: vatIn(invoice.total), vatRate: config.vatRate,
  });
});

// ---------- Payments, on the job ----------

router.post('/jobs/:id/payments', manage, async (req, res) => {
  const back = backTo(req.body.back, `/jobs/${req.params.id}`);
  const { data, errors } = check(paymentSchema, req.body);
  if (errors) {
    req.session.flash = { type: 'warning', text: `Payment not saved: ${Object.values(errors)[0]}.` };
    return res.redirect(back);
  }
  const money = (n) => `KES ${n.toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
  try {
    const { number, credit } = await invoices.recordPayment(Number(req.params.id), data, req);
    req.session.flash = { type: 'success', text: `Payment ${number} recorded: ${money(data.amount)}.${credit > 0 ? ` ${money(credit)} is held as the customer’s credit.` : ''}` };
  } catch (err) {
    if (!err.field) throw err;
    req.session.flash = { type: 'warning', text: `Payment not saved: ${err.message}` };
  }
  res.redirect(back);
});

router.post('/payments/:id/void', manage, async (req, res) => {
  const reason = String(req.body.reason ?? '').trim();
  const back = backTo(req.body.back, '/invoices');
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why the payment is being voided (3 to 255 characters).' };
    return res.redirect(back);
  }
  const p = await invoices.voidPayment(Number(req.params.id), reason, req);
  req.session.flash = { type: 'warning', text: `Payment ${p.number} voided. It stays on record, crossed out.` };
  res.redirect(back);
});
