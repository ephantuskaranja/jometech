import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { check, httpError, optionalPhone, optionalReading, optionalText } from '../../core/validate.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { config } from '../../config.js';
import { staffSignatures } from '../../core/staff-signatures.js';
import { getCheckin, listCheckins } from '../checkins/service.js';
import * as movements from './service.js';

// Sending a checked-in vehicle to another site, and receiving it there. The forms live on the
// check-in page (checkins/views/show.ejs); the gate's two steps on Gate → Vehicles at the gate
// (checkins/views/gate.ejs):  sent → cleared out (sending gate) → logged in (receiving gate) → received.

export const router = Router();
const manage = canAny('checkin.manage');
const gate = canAny('checkin.gate');
const manageOrGate = canAny('checkin.manage', 'checkin.gate');
const text = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || null;

/** Staff act only for the sites they work at (admins and managers: all sites). */
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

const sendSchema = z.object({
  to_site_id: z.coerce.number({ message: 'Choose the site it is going to' }).int().positive('Choose the site it is going to'),
  driver_name: z.string().trim().min(2, 'Who is driving it?').max(100, 'Use 100 characters or fewer'),
  driver_phone: optionalPhone(),
  // Everyone in the vehicle, driver included (the paper gate pass's "number of people"). Blank: the driver alone.
  people: z.union([z.literal(''), z.coerce.number().int().min(1, 'At least 1: the driver').max(50, 'Check the number')]).optional()
    .transform((v) => (v ? v : 1)),
  odometer_out: optionalReading(),
  notes: optionalText(500),
});

const receiveSchema = z.object({
  odometer_in: optionalReading(),
  receive_notes: optionalText(500),
});

/** Validation problems go back to the check-in page, which reopens the form with them. */
function backWithErrors(req, res, checkinId, form, values, errors) {
  req.session.moveForm = { checkinId, form, values, errors };
  res.redirect(form === 'send' ? `/check-in/${checkinId}/send` : `/check-in/${checkinId}`);
}

// "Send to another site" (the check-in page's header): its own page, with the form.
router.get('/check-in/:id/send', manage, async (req, res) => {
  const checkin = await getCheckin(Number(req.params.id));
  if (!checkin) throw httpError(404, 'That check-in doesn’t exist.');
  if (!worksAt(req, checkin.site_id)) throw httpError(403, `Only staff at ${checkin.site_name} can send this vehicle.`);
  const sendTo = await movements.otherSites(checkin.site_id);
  const why = checkin.status !== 'in_workshop' ? `${checkin.number} is no longer in the workshop.`
    : await movements.openMovement(checkin.id) ? `${vehicleLabel(checkin)} is already on its way to another site.`
    : !sendTo.length ? 'There is no other site to send it to.' : null;
  if (why) {
    req.session.flash = { type: 'warning', text: why };
    return res.redirect(`/check-in/${checkin.id}`);
  }
  // A form that came back with problems opens again with them.
  const back = req.session.moveForm?.checkinId === checkin.id && req.session.moveForm.form === 'send' ? req.session.moveForm : null;
  delete req.session.moveForm;
  res.render('movements/views/send', { title: `Send ${vehicleLabel(checkin)}`, checkin, sendTo, vehicleLabel, values: back?.values ?? {}, errors: back?.errors ?? {} });
});

router.post('/check-in/:id/send', manage, async (req, res) => {
  const checkin = await getCheckin(Number(req.params.id));
  if (!checkin) throw httpError(404, 'That check-in doesn’t exist.');
  if (!worksAt(req, checkin.site_id)) throw httpError(403, `Only staff at ${checkin.site_name} can send this vehicle.`);
  const { data, errors } = check(sendSchema, req.body);
  if (errors) return backWithErrors(req, res, checkin.id, 'send', req.body, errors);
  try {
    const { number, to } = await movements.sendVehicle(checkin.id, data, req);
    req.session.flash = { type: 'success', text: `${vehicleLabel(checkin)} is ready to go to ${to.name} (${number}). The gate clears it out; at ${to.name} the gate logs it in and a supervisor confirms it.` };
    res.redirect(`/check-in/${checkin.id}`);
  } catch (err) {
    if (!err.field) throw err;
    backWithErrors(req, res, checkin.id, 'send', req.body, { [err.field]: err.message });
  }
});

router.post('/movements/:id/receive', manage, async (req, res) => {
  const move = await movements.getMovement(Number(req.params.id));
  if (!move) throw httpError(404, 'That movement doesn’t exist.');
  if (!worksAt(req, move.to_site_id)) throw httpError(403, 'Only staff at the receiving site can confirm it arrived.');
  if (!movements.canConfirmArrival(req.user)) throw httpError(403, 'An admin, manager or supervisor at the receiving site confirms the vehicle arrived.');
  const { data, errors } = check(receiveSchema, req.body);
  if (errors) return backWithErrors(req, res, move.checkin_id, 'receive', req.body, errors);
  const received = await movements.receiveVehicle(move.id, data, req);
  req.session.flash = { type: 'success', text: `Received at ${received.to_site_name} (${received.number}). It is now in ${received.to_site_name}’s workshop list.` };
  res.redirect(`/check-in/${move.checkin_id}`);
});

router.post('/movements/:id/cancel', manage, async (req, res) => {
  const move = await movements.getMovement(Number(req.params.id));
  if (!move) throw httpError(404, 'That movement doesn’t exist.');
  if (!worksAt(req, move.from_site_id)) throw httpError(403, 'Only staff at the sending site can cancel the move.');
  await movements.cancelMovement(move.id, req);
  req.session.flash = { type: 'warning', text: `Move ${move.number} cancelled. The vehicle stays where it was.` };
  res.redirect(`/check-in/${move.checkin_id}`);
});

// Check-in → Movements → "Send a vehicle": pick one in the workshop here; its check-in opens with the send form.
router.get('/movements/new', manage, async (req, res) => {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  const others = await movements.otherSites(req.site.id);
  const list = (await listCheckins(req.site.id, 'on_site')).filter((c) => c.status === 'in_workshop' && !c.moving_to);
  res.render('movements/views/pick', { title: 'Send a vehicle to another site', list, others, vehicleLabel });
});

// The printed vehicle gate pass: either site's staff or gate, while it moves or afterwards.
router.get('/movements/:id/print', manageOrGate, async (req, res) => {
  const move = await movements.forPass(Number(req.params.id));
  if (!move || !(worksAt(req, move.from_site_id) || worksAt(req, move.to_site_id))) throw httpError(404, 'That movement isn’t to or from your site.');
  res.render('movements/views/pass-print', {
    layout: false,
    title: `${move.number} vehicle gate pass`,
    move, company: config.company, printedAt: new Date(),
    vehicle: vehicleLabel(move),
    signs: await staffSignatures({ approved: move.sent_by }),
  });
});

// ---------- the gates ----------

/** Back to where the guard was: the gate page, or the check-in. */
const gateBack = (req, move) => (req.body.back === 'checkin' ? `/check-in/${move.checkin_id}` : '/check-in/gate');

router.post('/movements/:id/gate-out', gate, async (req, res) => {
  const move = await movements.getMovement(Number(req.params.id));
  if (!move) throw httpError(404, 'That movement doesn’t exist.');
  if (!worksAt(req, move.from_site_id)) throw httpError(403, 'Only the gate at the sending site clears it out.');
  try {
    const m = await movements.gateOut(move.id, req);
    req.session.flash = { type: 'success', text: `${m.number} cleared out for ${m.to_site_name}. Their gate logs it in when it arrives.` };
  } catch (err) {
    if (err.status !== 409) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(gateBack(req, move));
});

router.post('/movements/:id/gate-in', gate, async (req, res) => {
  const move = await movements.getMovement(Number(req.params.id));
  if (!move) throw httpError(404, 'That movement doesn’t exist.');
  if (!worksAt(req, move.to_site_id)) throw httpError(403, 'Only the gate at the receiving site logs it in.');
  try {
    const m = await movements.gateIn(move.id, text(req.body.gate_in_note, 255), req);
    req.session.flash = { type: 'success', text: `${m.number} logged in at the gate. An admin, manager or supervisor confirms it is received.` };
  } catch (err) {
    if (err.status !== 409) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(gateBack(req, move));
});
