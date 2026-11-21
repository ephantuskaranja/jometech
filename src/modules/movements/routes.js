import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { check, httpError, optionalPhone, optionalReading, optionalText } from '../../core/validate.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { getCheckin } from '../checkins/service.js';
import * as movements from './service.js';

// Sending a checked-in vehicle to another site, and receiving it there. The forms live on the
// check-in page (checkins/views/show.ejs); the gate's two steps on Gate → Vehicles at the gate
// (checkins/views/gate.ejs):  sent → cleared out (sending gate) → logged in (receiving gate) → received.

export const router = Router();
const manage = canAny('checkin.manage');
const gate = canAny('checkin.gate');
const text = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || null;

/** Staff act only for the sites they work at (admins and managers: all sites). */
const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

const sendSchema = z.object({
  to_site_id: z.coerce.number({ message: 'Choose the site it is going to' }).int().positive('Choose the site it is going to'),
  driver_name: z.string().trim().min(2, 'Who is driving it?').max(100, 'Use 100 characters or fewer'),
  driver_phone: optionalPhone(),
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
  res.redirect(`/check-in/${checkinId}`);
}

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

// ---------- the gates ----------

/** Back to where the guard was: the gate page, or the check-in. */
const gateBack = (req, move) => (req.body.back === 'checkin' ? `/check-in/${move.checkin_id}` : '/gate/vehicles');

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
