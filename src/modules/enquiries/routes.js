import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay, localDay } from '../../core/dates.js';
import { check, httpError, optionalAmount, optionalId, optionalPhone, optionalText } from '../../core/validate.js';
import { fmt } from '../../core/format.js';
import * as enquiries from './service.js';
import * as customers from '../customers/service.js';

// Enquiries: log a call, follow it up, close it as won or lost.

export const router = Router();
const manage = canAny('enquiries.manage');

const dayField = (message) => z.string().trim().optional().refine((v) => !v || isDay(v), message).transform((v) => v || null);

const enquirySchema = z.object({
  customer_id: optionalId(),
  caller_name: z.string().trim().min(2, 'Enter the caller’s name').max(100, 'Use 100 characters or fewer'),
  caller_phone: optionalPhone(),
  vehicle_id: optionalId(),
  vehicle_description: optionalText(150),
  work_type: z.string().trim().min(1, 'Choose what they want').max(60),
  other_work_type: optionalText(60),
  save_work_type: z.preprocess((v) => v === '1' || v === 'on', z.boolean()),
  description: z.string().trim().min(3, 'Describe what they want, in a few words').max(2000, 'Use 2,000 characters or fewer'),
  budget: optionalAmount(),
  source: z.enum(enquiries.SOURCES.map((s) => s.value)).catch('call'),
  follow_up_on: dayField('Check the date'),
});

const noteSchema = z.object({
  note: z.string().trim().min(2, 'Write what was said').max(2000, 'Use 2,000 characters or fewer'),
  follow_up_on: dayField('Check the date'),
});

const plusDays = (days) => new Date(Date.parse(`${localDay()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const blank = () => ({
  customer_id: '', caller_name: '', caller_phone: '', vehicle_id: '', vehicle_description: '', work_type: '', other_work_type: '', save_work_type: '1', description: '',
  budget: '', source: 'call', follow_up_on: plusDays(2),
});

async function loadEnquiry(req) {
  const enquiry = await enquiries.getEnquiry(Number(req.params.id));
  if (!enquiry) throw httpError(404, 'That enquiry doesn’t exist.');
  return enquiry;
}

/** Problems the form can show; a prospect (no customer) needs a phone to be called back. */
function validate(body) {
  const { data, errors } = check(enquirySchema, body);
  const all = { ...errors };
  // From what was typed, so it shows together with the form's other problems.
  if (!String(body.customer_id ?? '').trim() && !String(body.caller_phone ?? '').trim()) all.caller_phone ??= 'Enter their phone number, so they can be called back';
  if (data && !data.customer_id) data.vehicle_id = null;
  // "Other": the kind of work as typed, optionally added to the quick picks for next time.
  if (body.work_type === 'Other') {
    const typed = String(body.other_work_type ?? '').trim();
    if (typed.length < 2) all.other_work_type = 'Say what kind of work, e.g. Cattle body';
    else if (data) data.work_type = typed;
  }
  return { data, errors: all };
}

async function renderForm(res, { status = 200, enquiry = null, values, errors = {} }) {
  const customer = values.customer_id ? await customers.getCustomer(Number(values.customer_id)) : null;
  const workTypes = await enquiries.workTypes();
  // A kind of work that isn't a quick pick shows as "Other" with its name typed in.
  if (values.work_type && !workTypes.includes(values.work_type)) Object.assign(values, { other_work_type: values.work_type, work_type: 'Other' });
  res.status(status).render('enquiries/views/form', {
    title: enquiry ? `Edit ${enquiry.number}` : 'New enquiry',
    enquiry, values, errors,
    customerOption: customer ? [{ value: customer.id, label: `${customer.name} (${customer.number})` }] : [],
    vehicleOptions: customer ? await enquiries.vehicleOptions(customer.id) : [],
    workTypes,
    sources: enquiries.SOURCES,
    today: localDay(),
  });
}

router.get('/enquiries', manage, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const tab = enquiries.TABS.includes(req.query.show) ? req.query.show : 'follow';
  res.render('enquiries/views/index', {
    title: 'Enquiries', tab, q, today: localDay(),
    list: await enquiries.listEnquiries({ tab, q }),
    counts: await enquiries.countByTab(),
    statuses: enquiries.STATUSES,
  });
});

router.get('/enquiries/new', manage, async (req, res) => {
  const values = blank();
  // From a customer's page: ?customer_id=12 fills in who is calling.
  const customer = req.query.customer_id ? await customers.getCustomer(Number(req.query.customer_id)) : null;
  if (customer) Object.assign(values, { customer_id: customer.id, caller_name: customer.name });
  await renderForm(res, { values });
});

router.post('/enquiries', manage, async (req, res) => {
  const values = { ...blank(), ...req.body, save_work_type: req.body.save_work_type ?? '' }; // an unticked box sends nothing
  const { data, errors } = validate(req.body);
  if (Object.keys(errors).length) return renderForm(res, { status: 422, values, errors });
  try {
    const { number } = await enquiries.createEnquiry(data, req);
    if (req.body.work_type === 'Other' && data.save_work_type) await enquiries.addWorkType(data.work_type);
    req.session.flash = { type: 'success', text: `Saved as ${number}.${data.follow_up_on ? ` Follow up on ${fmt.date(data.follow_up_on)}.` : ''}` };
    // Back to the list, on the tab where it now shows.
    res.redirect(data.follow_up_on && data.follow_up_on <= localDay() ? '/enquiries?show=follow' : '/enquiries?show=open');
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, values, errors: { [err.field]: err.message } });
  }
});

router.get('/enquiries/:id', manage, async (req, res) => {
  const enquiry = await loadEnquiry(req);
  const phoneMatch = !enquiry.customer_id && enquiry.caller_phone ? (await customers.findByPhone(enquiry.caller_phone))[0] ?? null : null;
  res.render('enquiries/views/show', {
    title: enquiry.number, enquiry, phoneMatch,
    statuses: enquiries.STATUSES, sourceLabel: enquiries.sourceLabel, lostReasons: enquiries.LOST_REASONS,
    entries: await history('enquiry', enquiry.id),
    today: localDay(), nextDays: [1, 3, 7].map((d) => ({ days: d, day: plusDays(d) })),
  });
});

router.get('/enquiries/:id/edit', manage, async (req, res) => {
  const enquiry = await loadEnquiry(req);
  const values = Object.fromEntries(Object.keys(blank()).map((k) => [k, enquiry[k] ?? '']));
  await renderForm(res, { enquiry, values });
});

router.post('/enquiries/:id', manage, async (req, res) => {
  const enquiry = await loadEnquiry(req);
  const values = { ...blank(), ...req.body, save_work_type: req.body.save_work_type ?? '' }; // an unticked box sends nothing
  const { data, errors } = validate(req.body);
  if (Object.keys(errors).length) return renderForm(res, { status: 422, enquiry, values, errors });
  try {
    await enquiries.updateEnquiry(enquiry.id, data, req);
    if (req.body.work_type === 'Other' && data.save_work_type) await enquiries.addWorkType(data.work_type);
    req.session.flash = { type: 'success', text: `Saved changes to ${enquiry.number}.` };
    res.redirect(`/enquiries/${enquiry.id}`);
  } catch (err) {
    if (!err.field) throw err;
    await renderForm(res, { status: 422, enquiry, values, errors: { [err.field]: err.message } });
  }
});

router.post('/enquiries/:id/notes', manage, async (req, res) => {
  const enquiry = await loadEnquiry(req);
  const { data, errors } = check(noteSchema, req.body);
  if (errors) {
    req.session.flash = { type: 'warning', text: Object.values(errors)[0] };
    return res.redirect(`/enquiries/${enquiry.id}#notes`);
  }
  await enquiries.addNote(enquiry.id, data, req);
  req.session.flash = { type: 'success', text: data.follow_up_on ? `Note saved. Follow up on ${fmt.date(data.follow_up_on)}.` : 'Note saved. No follow-up date set.' };
  res.redirect(`/enquiries/${enquiry.id}`);
});

router.post('/enquiries/:id/close', manage, async (req, res) => {
  const enquiry = await loadEnquiry(req);
  const status = req.body.status === 'won' ? 'won' : 'lost';
  const reason = String(req.body.lost_reason === 'other' ? req.body.other_reason ?? '' : req.body.lost_reason ?? '').trim();
  if (status === 'lost' && (reason.length < 3 || reason.length > 255)) {
    req.session.flash = { type: 'warning', text: 'Say why it was lost (3 to 255 characters).' };
    return res.redirect(`/enquiries/${enquiry.id}`);
  }
  await enquiries.closeEnquiry(enquiry.id, { status, lost_reason: reason }, req);
  req.session.flash = { type: status === 'won' ? 'success' : 'warning', text: `${enquiry.number} closed as ${status}.` };
  res.redirect(`/enquiries/${enquiry.id}`);
});

router.post('/enquiries/:id/reopen', manage, async (req, res) => {
  const enquiry = await loadEnquiry(req);
  await enquiries.reopenEnquiry(enquiry.id, req);
  req.session.flash = { type: 'success', text: `${enquiry.number} reopened.` };
  res.redirect(`/enquiries/${enquiry.id}`);
});

router.post('/enquiries/:id/make-customer', manage, async (req, res) => {
  const enquiry = await loadEnquiry(req);
  const customer = await enquiries.makeCustomer(enquiry.id, req);
  req.session.flash = {
    type: 'success',
    text: customer.existing ? `Linked to ${customer.name} (${customer.number}), who already had this phone number.` : `${enquiry.caller_name} added as customer ${customer.number}.`,
  };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// The form's vehicle dropdown, once a customer is chosen.
router.get('/api/enquiries/vehicles', manage, async (req, res) => {
  const id = Number(req.query.customer_id);
  res.json(id ? await enquiries.vehicleOptions(id) : []);
});
