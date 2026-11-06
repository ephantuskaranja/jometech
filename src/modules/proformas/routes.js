import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalId, optionalText } from '../../core/validate.js';
import { config } from '../../config.js';
import { readLines } from '../../core/price-lines.js';
import { fileTitle } from '../../core/file-title.js';
import * as proformas from './service.js';
import * as customers from '../customers/service.js';
import * as enquiries from '../enquiries/service.js';
import { typeOptions } from '../job-types/service.js';

// Proformas: write one (or copy another), send it, then accepted / declined / revised.

export const router = Router();
const manage = canAny('quotations.manage');

const proformaSchema = z.object({
  customer_id: optionalId().refine((v) => v !== null, 'Choose the customer'),
  enquiry_id: optionalId(),
  vehicle_id: optionalId(),
  vehicle_description: optionalText(150),
  proforma_date: z.string().trim().refine((v) => isDay(v), 'Check the date'),
  notes: optionalText(2000),
  copied_from: optionalText(20),
});

function validate(body) {
  const { data, errors } = check(proformaSchema, body);
  const { rows, lines, error } = readLines(body);
  const all = { ...errors };
  if (error) all.lines = error;
  if (data) {
    data.lines = lines;
    if (!data.customer_id) data.vehicle_id = null;
  }
  return { data, rows, errors: all };
}

const blank = () => ({ customer_id: '', enquiry_id: '', vehicle_id: '', vehicle_description: '', proforma_date: localDay(), notes: '', copied_from: '' });
const blankRow = () => ({ quantity: '1', unit: 'Unit', description: '', unit_price: '' });

async function loadProforma(req) {
  const proforma = await proformas.getProforma(Number(req.params.id));
  if (!proforma) throw httpError(404, 'That proforma doesn’t exist.');
  return proforma;
}

async function renderForm(res, { status = 200, proforma = null, values, rows, errors = {}, copiedFrom = null }) {
  const customer = values.customer_id ? await customers.getCustomer(Number(values.customer_id)) : null;
  const enquiry = values.enquiry_id ? await enquiries.getEnquiry(Number(values.enquiry_id)) : null;
  res.status(status).render('proformas/views/form', {
    title: proforma ? `Edit proforma ${proforma.number}` : 'New proforma',
    proforma, values, errors, enquiry, copiedFrom,
    rows: rows.length ? rows : [blankRow()],
    customerOption: customer ? [{ value: customer.id, label: `${customer.name} (${customer.number})` }] : [],
    vehicleOptions: customer ? await enquiries.vehicleOptions(customer.id) : [],
    categories: customers.CATEGORIES, // "Add new customer" window
    vatRate: config.vatRate,
  });
}

router.get('/proformas', manage, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const tab = proformas.TABS.includes(req.query.show) ? req.query.show : 'sent';
  res.render('proformas/views/index', {
    title: 'Proformas', tab, q,
    list: await proformas.listProformas({ tab, q }),
    counts: await proformas.countByTab(),
    statuses: proformas.STATUSES,
  });
});

// ?enquiry=12 fills in from the enquiry; ?customer_id=5 the customer; ?copy=7 the lines and notes of proforma 7.
router.get('/proformas/new', manage, async (req, res) => {
  const values = blank();
  let rows = [];
  let copiedFrom = null;
  const enquiry = req.query.enquiry ? await enquiries.getEnquiry(Number(req.query.enquiry)) : null;
  if (enquiry) {
    Object.assign(values, { enquiry_id: enquiry.id, customer_id: enquiry.customer_id ?? '', vehicle_id: enquiry.vehicle_id ?? '', vehicle_description: enquiry.vehicle_description ?? '' });
    rows = [{ ...blankRow(), description: enquiry.description }];
  }
  if (req.query.customer_id && (await customers.getCustomer(Number(req.query.customer_id)))) values.customer_id = Number(req.query.customer_id);
  const source = req.query.copy ? await proformas.getProforma(Number(req.query.copy)) : null;
  if (source) {
    copiedFrom = { id: source.id, number: source.number, customer_name: source.customer_name };
    values.copied_from = source.number;
    values.notes = source.notes ?? '';
    if (!values.vehicle_description) values.vehicle_description = source.vehicle_id ? '' : source.vehicle_description ?? '';
    rows = (await proformas.linesOf(source.id)).map((l) => ({ ...l, quantity: String(l.quantity), unit_price: String(l.unit_price) }));
  }
  await renderForm(res, { values, rows, copiedFrom });
});

router.post('/proformas', manage, async (req, res) => {
  const values = { ...blank(), ...req.body };
  const { data, rows, errors } = validate(req.body);
  if (Object.keys(errors).length) return renderForm(res, { status: 422, values, rows, errors });
  try {
    const { id, number } = await proformas.createProforma(data, req);
    req.session.flash = { type: 'success', text: `Proforma ${number} saved as a draft. Check it, then mark it as sent when the customer has it.` };
    res.redirect(`/proformas/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, values, rows, errors: { [err.field]: err.message } });
  }
});

router.get('/proformas/:id', manage, async (req, res) => {
  const proforma = await loadProforma(req);
  res.render('proformas/views/show', {
    title: `Proforma ${proforma.number}`, proforma,
    statuses: proformas.STATUSES, declineReasons: proformas.DECLINE_REASONS,
    vat: proformas.vatIn(proforma.total), vatRate: config.vatRate,
    entries: await history('proforma', proforma.id),
    jobTypes: proforma.status === 'accepted' && !proforma.job ? await typeOptions() : [],
  });
});

router.get('/proformas/:id/edit', manage, async (req, res) => {
  const proforma = await loadProforma(req);
  if (proforma.status !== 'draft') throw httpError(409, `${proforma.number} has been sent, so it can’t be changed. Use “Revise” to make a new version.`);
  const values = Object.fromEntries(Object.keys(blank()).map((k) => [k, proforma[k] ?? '']));
  const rows = proforma.lines.map((l) => ({ quantity: String(Number(l.quantity)), unit: l.unit, description: l.description, unit_price: String(Number(l.unit_price)) }));
  await renderForm(res, { proforma, values, rows });
});

router.post('/proformas/:id', manage, async (req, res) => {
  const proforma = await loadProforma(req);
  const values = { ...blank(), ...req.body };
  const { data, rows, errors } = validate(req.body);
  if (Object.keys(errors).length) return renderForm(res, { status: 422, proforma, values, rows, errors });
  try {
    await proformas.updateProforma(proforma.id, data, req);
    req.session.flash = { type: 'success', text: `Saved changes to ${proforma.number}.` };
    res.redirect(`/proformas/${proforma.id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, proforma, values, rows, errors: { [err.field]: err.message } });
  }
});

router.post('/proformas/:id/send', manage, async (req, res) => {
  const proforma = await loadProforma(req);
  await proformas.markSent(proforma.id, req);
  req.session.flash = { type: 'success', text: `${proforma.number} marked as sent. It can’t be changed now; use “Revise” if the customer wants changes.` };
  res.redirect(`/proformas/${proforma.id}`);
});

router.post('/proformas/:id/accept', manage, async (req, res) => {
  const proforma = await loadProforma(req);
  await proformas.closeProforma(proforma.id, { status: 'accepted' }, req);
  req.session.flash = { type: 'success', text: `${proforma.number} accepted.${proforma.enquiry_id ? ` Enquiry ${proforma.enquiry_number} closed as won.` : ''}` };
  res.redirect(`/proformas/${proforma.id}`);
});

router.post('/proformas/:id/decline', manage, async (req, res) => {
  const proforma = await loadProforma(req);
  const reason = String(req.body.reason === 'other' ? req.body.other_reason ?? '' : req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 255) {
    req.session.flash = { type: 'warning', text: 'Say why it was declined (3 to 255 characters).' };
    return res.redirect(`/proformas/${proforma.id}`);
  }
  await proformas.closeProforma(proforma.id, { status: 'declined', reason }, req);
  req.session.flash = { type: 'warning', text: `${proforma.number} declined. You can still revise it if they come back.` };
  res.redirect(`/proformas/${proforma.id}`);
});

router.post('/proformas/:id/revise', manage, async (req, res) => {
  const proforma = await loadProforma(req);
  const { id, number } = await proformas.reviseProforma(proforma.id, req);
  req.session.flash = { type: 'success', text: `${number} made from ${proforma.number}. Change what the customer asked for, then mark it as sent.` };
  res.redirect(`/proformas/${id}/edit`);
});

// The paper proforma, filled in: an A4 page to print or save as PDF.
router.get('/proformas/:id/print', manage, async (req, res) => {
  const proforma = await loadProforma(req);
  res.render('proformas/views/print', {
    layout: false,
    title: fileTitle(`Proforma ${proforma.number}`, proforma.customer_name), // also the PDF's file name
    proforma, company: config.company,
    vat: proformas.vatIn(proforma.total), vatRate: config.vatRate,
  });
});

// From an enquiry: a prospect becomes a customer first (a proforma is addressed to a customer).
router.post('/enquiries/:id/proforma', manage, async (req, res) => {
  const enquiry = await enquiries.getEnquiry(Number(req.params.id));
  if (!enquiry) throw httpError(404, 'That enquiry doesn’t exist.');
  if (!enquiry.customer_id) {
    try {
      await enquiries.makeCustomer(enquiry.id, req);
    } catch (err) {
      if (err.status !== 422) throw err;
      req.session.flash = { type: 'warning', text: err.message };
      return res.redirect(`/enquiries/${enquiry.id}`);
    }
  }
  res.redirect(`/proformas/new?enquiry=${enquiry.id}`);
});

// "Copy from another proforma" (Tom Select)
router.get('/api/proformas', manage, async (req, res) => {
  res.json(await proformas.lookupProformas(String(req.query.q ?? '').slice(0, 60)));
});

router.get('/api/proformas/vehicles', manage, async (req, res) => {
  const id = Number(req.query.customer_id);
  res.json(id ? await enquiries.vehicleOptions(id) : []);
});
