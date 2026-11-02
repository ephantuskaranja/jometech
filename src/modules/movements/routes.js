import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { check, httpError, optionalPhone, optionalReading, optionalText } from '../../core/validate.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { getCheckin } from '../checkins/service.js';
import * as movements from './service.js';

// Sending a checked-in vehicle to another site, and receiving it there.
// The forms live on the check-in page (checkins/views/show.ejs).

export const router = Router();
const manage = canAny('checkin.manage');

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
    req.session.flash = { type: 'success', text: `${vehicleLabel(checkin)} is on its way to ${to.name} (${number}). ${to.name} confirms when it arrives.` };
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
