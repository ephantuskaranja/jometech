import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { isDay, localDay } from '../../core/dates.js';
import { formatReg } from '../../core/vehicle-format.js';
import { normalizePhone } from '../../core/phone.js';
import { check, httpError, optionalText, phoneField, optionalIdNo } from '../../core/validate.js';
import { history } from '../../core/audit.js';
import * as visitors from './service.js';
import * as bookings from './bookings.js';

// Visitor register: Gate signs in and clears out, Reception confirms "received".
// Everyone works on their current site (Gate and Reception: chosen at login).

export const router = Router();
const view = canAny('visitors.view', 'visitors.gate', 'visitors.receive');
const signsIn = canAny('visitors.gate', 'visitors.receive');
const gate = canAny('visitors.gate');
const reception = canAny('visitors.receive');

const visitorSchema = z.object({
  phone: phoneField('Enter their phone number'),
  name: z.string().trim().min(2, 'Enter the visitor’s name').max(100, 'Use 100 characters or fewer'),
  purpose: z.string().trim().min(1, 'Choose why they are here').max(60),
  other_purpose: optionalText(60),
  host: optionalText(100), // "Reception" or a staff member; checked against the list in validHost()
  company: optionalText(120),
  id_no: optionalIdNo(),
  vehicle_reg: optionalText(20).transform((v) => v && formatReg(v)),
  pass_no: optionalText(20),
  people: z.union([z.literal(''), z.coerce.number().int().min(1, 'At least 1').max(50, 'Check the number')]).optional()
    .transform((v) => (v ? v : 1)),
  notes: optionalText(500),
});

const blank = { phone: '', name: '', purpose: '', other_purpose: '', host: 'Reception', company: '', id_no: '', vehicle_reg: '', pass_no: '', people: '1', notes: '' };

function needSite(req) {
  if (!req.site) throw httpError(400, 'You have no site. Ask an administrator to add one to your account.');
}

/** Acting on a visitor: only at their site. */
async function loadVisitor(req) {
  const visitor = await visitors.getVisitor(Number(req.params.id));
  if (!visitor || !req.user.sites.some((s) => s.id === visitor.site_id)) throw httpError(404, 'That visitor isn’t in your site’s register.');
  return visitor;
}

router.get('/visitors', view, async (req, res) => {
  needSite(req);
  const tab = req.query.show === 'register' ? 'register' : 'now';
  const day = isDay(req.query.day) ? req.query.day : localDay();
  const q = String(req.query.q ?? '').slice(0, 60);
  // On site now, or only those waiting for reception / confirmed (from the cards).
  const only = tab === 'now' && ['waiting', 'confirmed'].includes(req.query.only) ? req.query.only : null;
  let list = tab === 'now' ? await visitors.onSite(req.site.id) : await visitors.register(req.site.id, { day, q });
  if (only) list = list.filter((v) => v.status === (only === 'waiting' ? 'arrived' : 'received'));
  res.render('visitors/views/index', {
    title: 'Visitors',
    tab, day, q, today: localDay(), only,
    list,
    onSiteCount: tab === 'now' && !only ? list.length : (await visitors.onSite(req.site.id)).length,
    expectedCount: (await bookings.counts(req.site.id)).today,
    statuses: visitors.STATUSES,
    overdue: visitors.overdue,
    canSignIn: req.user.can('visitors.gate') || req.user.can('visitors.receive'),
    canClear: req.user.can('visitors.gate'),
    canReceive: req.user.can('visitors.receive'),
  });
});

/** "Who are they seeing?": Reception (the default), then the site's app users and employees. */
function hostChoices(staff, host) {
  const hostOptions = [{ value: 'Reception', label: 'Reception' }, ...staff.map((s) => ({ value: s.name, label: s.trade ? `${s.name} · ${s.trade}` : s.name }))];
  return { hostOptions, hostValue: staff.some((s) => s.name === host) ? host : 'Reception' };
}

/** The booking being signed in from (?booking= or the form's booking_id): still expected, at this site. */
async function bookingFrom(req, id) {
  if (!id) return null;
  const booking = await bookings.getBooking(Number(id));
  if (!booking || booking.site_id !== req.site.id) throw httpError(404, 'That booking isn’t for this site.');
  if (booking.status !== 'expected') throw httpError(409, `${booking.name}’s booking is ${booking.status === 'arrived' ? 'already used: they were signed in' : 'cancelled'}.`);
  return booking;
}

async function renderForm(req, res, { status = 200, values, errors = {}, phoneOwner = null, booking = null }) {
  const staff = await visitors.staffAt(req.site.id);
  res.status(status).render('visitors/views/form', {
    title: 'Sign a visitor in',
    values, errors, phoneOwner, booking,
    purposes: visitors.PURPOSES,
    ...hostChoices(staff, values.host),
    // Reception signing in a walk-in: they are already at reception.
    receptionOnly: req.user.can('visitors.receive') && !req.user.can('visitors.gate'),
    canReceive: req.user.can('visitors.receive'),
  });
}

router.get('/visitors/new', signsIn, async (req, res) => {
  needSite(req);
  const booking = await bookingFrom(req, req.query.booking);
  const values = { ...blank, ...(booking ? bookings.formValues(booking) : {}), at_reception: req.user.can('visitors.gate') ? '' : '1' };
  await renderForm(req, res, { values, booking });
});

router.post('/visitors', signsIn, async (req, res) => {
  needSite(req);
  const values = { ...blank, ...req.body };
  const booking = await bookingFrom(req, req.body.booking_id);
  const { data, errors } = check(visitorSchema, req.body);
  const allErrors = { ...errors };
  if (data?.purpose === 'Other' && !data.other_purpose) allErrors.other_purpose = 'Say why they are here';
  if (data?.host && data.host !== 'Reception' && !(await visitors.staffAt(req.site.id)).some((s) => s.name === data.host)) {
    allErrors.host = 'Choose someone from the list, or Reception';
  }
  let phoneOwner = null;
  if (data) {
    const fmt = res.locals.fmt;
    const idOwner = await visitors.idTakenBy(data.id_no, data.name);
    if (idOwner) allErrors.id_no = `This ID number is ${idOwner.name}’s (last visit ${fmt.date(idOwner.arrived_at)}). Check the number on the ID.`;
    phoneOwner = await visitors.phoneUsedBy(data.phone, data.name);
    if (phoneOwner && req.body.confirm_phone !== '1') {
      allErrors.phone = `This phone was used by ${phoneOwner.name} (last visit ${fmt.date(phoneOwner.arrived_at)}). Is this a different person?`;
    } else phoneOwner = null;
  }
  if (Object.keys(allErrors).length) return await renderForm(req, res, { status: 422, values, errors: allErrors, phoneOwner, booking });

  // ID left blank for a returning visitor (same phone, same name): keep the one on file.
  if (!data.id_no) data.id_no = await visitors.idOnFile(data.phone, data.name);
  const purpose = data.purpose === 'Other' ? data.other_purpose : data.purpose;
  const atReception = req.user.can('visitors.receive') && (req.body.at_reception === '1' || !req.user.can('visitors.gate'));
  const { number } = await visitors.signIn(req.site.id, { ...data, purpose }, req, { atReception, bookingId: booking?.id });
  req.session.flash = {
    type: 'success',
    text: atReception ? `${data.name} signed in and received (${number}).` : `${data.name} signed in (${number}). Reception confirms when they arrive.`,
  };
  res.redirect('/visitors');
});

router.get('/visitors/:id', view, async (req, res) => {
  const visitor = await loadVisitor(req);
  res.render('visitors/views/show', {
    title: visitor.name, visitor, statuses: visitors.STATUSES, overdue: visitors.overdue(visitor),
    booking: await bookings.bookingForVisit(visitor.id),
    entries: await history('visitor', visitor.id),
    canClear: req.user.can('visitors.gate'), canReceive: req.user.can('visitors.receive'),
  });
});

router.post('/visitors/:id/receive', reception, async (req, res) => {
  const visitor = await loadVisitor(req);
  await visitors.markReceived(visitor.id, req);
  req.session.flash = { type: 'success', text: `${visitor.name} received.` };
  res.redirect(req.body.back === 'visitor' ? `/visitors/${visitor.id}` : '/visitors');
});

router.post('/visitors/:id/clear', gate, async (req, res) => {
  const visitor = await loadVisitor(req);
  const override = String(req.body.override_reason ?? '').trim();
  try {
    await visitors.clearOut(visitor.id, req, { override: override || null });
    req.session.flash = visitor.status === 'arrived'
      ? { type: 'warning', text: `${visitor.name} cleared out without reception confirming. This shows on the register.` }
      : { type: 'success', text: `${visitor.name} cleared out.` };
  } catch (err) {
    if (!err.expose) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(req.body.back === 'visitor' ? `/visitors/${visitor.id}` : '/visitors');
});

// A returning visitor: their phone fills in the rest of the form.
router.get('/api/visitors/last', signsIn, async (req, res) => {
  const phone = normalizePhone(String(req.query.phone ?? ''));
  const last = phone ? await visitors.lastVisit(phone) : null;
  if (!last) return res.json(null);
  // Never the ID number itself: anyone at the gate could type a phone and read it. Its last 4 only.
  const { id_no: idNo, ...rest } = last;
  res.json({ ...rest, id_end: idNo ? idNo.slice(-4) : null });
});
