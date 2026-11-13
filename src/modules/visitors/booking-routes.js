import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { isDay, localDay } from '../../core/dates.js';
import { formatReg } from '../../core/vehicle-format.js';
import { check, httpError, optionalText, optionalPhone } from '../../core/validate.js';
import { history } from '../../core/audit.js';
import * as visitors from './service.js';
import * as bookings from './bookings.js';

// Expected visitors. Reception, sales, supervisors (managers, admins) book someone who is coming;
// the gate and reception see the list and sign them in from it (/visitors/new?booking=…).
// Mounted before the visitor routes: /visitors/expected isn't a visitor.

export const router = Router();
const book = canAny('visitors.book');
const see = canAny('visitors.book', 'visitors.view', 'visitors.gate', 'visitors.receive');

const bookingSchema = z.object({
  expected_on: z.string().trim().refine(isDay, 'Choose the day they are coming'),
  expected_time: z.string().trim().optional().transform((v) => v || null)
    .refine((v) => v === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'Use a time like 09:30'),
  name: z.string().trim().min(2, 'Enter the name of the person coming (the driver or the main person)').max(100, 'Use 100 characters or fewer'),
  phone: optionalPhone(),
  company: optionalText(120),
  purpose: z.string().trim().min(1, 'Choose why they are coming').max(60),
  other_purpose: optionalText(60),
  host: optionalText(100),
  vehicle_reg: optionalText(20).transform((v) => v && formatReg(v)),
  notes: optionalText(500),
});

const blank = (siteId) => ({ site_id: String(siteId ?? ''), expected_on: localDay(), expected_time: '', name: '', phone: '', company: '', purpose: '', other_purpose: '', host: 'Reception', vehicle_reg: '', notes: '' });

function needSite(req) {
  if (!req.site) throw httpError(400, 'You have no site. Ask an administrator to add one to your account.');
}

/** Acting on a booking: only at one of your sites. */
async function loadBooking(req) {
  const booking = await bookings.getBooking(Number(req.params.id));
  if (!booking || !req.user.sites.some((s) => s.id === booking.site_id)) throw httpError(404, 'That booking isn’t at your site.');
  return booking;
}

const TABS = ['today', 'upcoming', 'past'];

router.get('/visitors/expected', see, async (req, res) => {
  needSite(req);
  const tab = TABS.includes(req.query.show) ? req.query.show : 'today';
  const today = localDay();
  const [list, counts] = await Promise.all([bookings.list(req.site.id, tab, today), bookings.counts(req.site.id, today)]);
  res.render('visitors/views/expected', {
    title: 'Expected visitors', tab, list, counts, today,
    statuses: bookings.STATUSES, shownStatus: bookings.shownStatus,
    canBook: req.user.can('visitors.book'),
    canSignIn: req.user.can('visitors.gate') || req.user.can('visitors.receive'),
    canRegister: req.user.can('visitors.view') || req.user.can('visitors.gate') || req.user.can('visitors.receive'),
  });
});

/** Sites the person may book for: the current one, or any of theirs when not locked to one at login. */
const bookingSites = (req) => (req.session.siteLocked ? [req.site] : req.user.sites);

async function renderForm(req, res, { status = 200, values, errors = {}, booking = null }) {
  const sites = bookingSites(req);
  const siteId = Number(values.site_id) || req.site.id;
  const staff = await visitors.staffAt(siteId);
  const hostOptions = [{ value: 'Reception', label: 'Reception' }, ...staff.map((s) => ({ value: s.name, label: s.trade ? `${s.name} · ${s.trade}` : s.name }))];
  res.status(status).render('visitors/views/booking-form', {
    title: booking ? `Change booking ${booking.number}` : 'Book an expected visitor',
    values, errors, booking, today: localDay(),
    purposes: visitors.PURPOSES, hostOptions,
    hostValue: staff.some((s) => s.name === values.host) ? values.host : 'Reception',
    sites: sites.length > 1 && !booking ? sites : null,
    siteName: (sites.find((s) => s.id === siteId) ?? req.site).name,
  });
}

/** Checks the form; returns the booking's values, or renders the form with errors and returns null. */
async function readForm(req, res, booking) {
  const values = { ...blank(req.site.id), ...req.body };
  const { data, errors } = check(bookingSchema, req.body);
  const allErrors = { ...errors };
  const siteId = booking ? booking.site_id : Number(req.body.site_id) || req.site.id;
  if (!booking && !bookingSites(req).some((s) => s.id === siteId)) allErrors.site_id = 'Choose one of your sites';
  if (data) {
    if (data.purpose === 'Other' && !data.other_purpose) allErrors.other_purpose = 'Say why they are coming';
    // A new booking or a changed day can't be in the past (an old booking may keep its day while other details change).
    if (data.expected_on < localDay() && data.expected_on !== booking?.expected_on) allErrors.expected_on = 'Choose today or a later day';
    if (data.host && data.host !== 'Reception' && !(await visitors.staffAt(siteId)).some((s) => s.name === data.host)) {
      allErrors.host = 'Choose someone from the list, or Reception';
    }
  }
  if (Object.keys(allErrors).length) {
    await renderForm(req, res, { status: 422, values, errors: allErrors, booking });
    return null;
  }
  const purpose = data.purpose === 'Other' ? data.other_purpose : data.purpose;
  const { other_purpose: _other, ...rest } = data;
  return { ...rest, purpose, site_id: siteId, host: data.host || 'Reception' };
}

router.get('/visitors/expected/new', book, async (req, res) => {
  needSite(req);
  await renderForm(req, res, { values: blank(req.site.id) });
});

router.post('/visitors/expected', book, async (req, res) => {
  needSite(req);
  const input = await readForm(req, res, null);
  if (!input) return;
  const { id, number } = await bookings.createBooking(input, req);
  req.session.flash = { type: 'success', text: `${input.name} booked for ${res.locals.fmt.date(input.expected_on)} (${number}). The gate will see them on the list that day.` };
  res.redirect(`/visitors/expected/${id}`);
});

router.get('/visitors/expected/:id', see, async (req, res) => {
  const booking = await loadBooking(req);
  const today = localDay();
  res.render('visitors/views/booking', {
    title: booking.name, booking, today,
    status: bookings.shownStatus(booking, today), statuses: bookings.STATUSES,
    entries: await history('visitor_booking', booking.id),
    canBook: req.user.can('visitors.book'),
    // Signing in from the booking: at the site they're expected, while expected.
    canSignIn: (req.user.can('visitors.gate') || req.user.can('visitors.receive')) && req.site?.id === booking.site_id,
    canSeeVisit: req.user.can('visitors.view') || req.user.can('visitors.gate') || req.user.can('visitors.receive'),
  });
});

router.get('/visitors/expected/:id/edit', book, async (req, res) => {
  const booking = await loadBooking(req);
  if (booking.status !== 'expected') throw httpError(409, 'Only a booking that is still expected can be changed.');
  const known = visitors.PURPOSES.includes(booking.purpose);
  const values = {
    ...blank(booking.site_id),
    ...Object.fromEntries(Object.entries(booking).map(([k, v]) => [k, v ?? ''])),
    purpose: known ? booking.purpose : 'Other', other_purpose: known ? '' : booking.purpose,
  };
  await renderForm(req, res, { values, booking });
});

router.post('/visitors/expected/:id', book, async (req, res) => {
  const booking = await loadBooking(req);
  const input = await readForm(req, res, booking);
  if (!input) return;
  await bookings.updateBooking(booking.id, input, req);
  req.session.flash = { type: 'success', text: `Booking ${booking.number} saved.` };
  res.redirect(`/visitors/expected/${booking.id}`);
});

router.post('/visitors/expected/:id/cancel', book, async (req, res) => {
  const booking = await loadBooking(req);
  try {
    await bookings.cancelBooking(booking.id, req.body.cancel_reason, req);
    req.session.flash = { type: 'success', text: `${booking.name}’s booking cancelled.` };
  } catch (err) {
    if (!err.expose) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/visitors/expected/${booking.id}`);
});
