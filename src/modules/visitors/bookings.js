import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { localDay } from '../../core/dates.js';
import { httpError } from '../../core/validate.js';
import { PURPOSES } from './service.js';

// Expected visitors: someone books a person who is coming (the driver or main person; others
// go in the notes). The gate sees the day's bookings and signs the person in from the booking.
//
//   expected ──▶ arrived     (signed in: visitor_id is the visit)
//            └─▶ cancelled   (with a reason)
//   still expected after its day: a no-show (worked out from the date, not stored)

export const STATUSES = {
  expected: { label: 'Expected', tone: 'info' },
  arrived: { label: 'Arrived', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  no_show: { label: 'No-show', tone: 'warn' },
};

/** The status to show: an expected booking whose day has passed is a no-show. */
export const shownStatus = (b, today = localDay()) => (b.status === 'expected' && b.expected_on < today ? 'no_show' : b.status);

const COLUMNS = ['b.*', 'by.name as booked_by_name', 'v.number as visitor_number', 'v.arrived_at as visitor_arrived_at'];
const withNames = (q) => q.leftJoin('users as by', 'by.id', 'b.booked_by').leftJoin('visitors as v', 'v.id', 'b.visitor_id');

const FIELDS = ['site_id', 'expected_on', 'expected_time', 'name', 'phone', 'company', 'purpose', 'host', 'vehicle_reg', 'notes'];
const pick = (input) => Object.fromEntries(FIELDS.map((f) => [f, input[f] ?? null]));

export async function createBooking(input, actor) {
  return db.transaction(async (trx) => {
    const number = await nextNumber(trx, 'booking');
    const [id] = await trx('visitor_bookings').insert({ number, ...pick(input), booked_by: actor.user.id });
    await audit(trx, actor, { entity: 'visitor_booking', id, action: 'booked', summary: `${input.name} expected on ${input.expected_on} (${number})` });
    return { id, number };
  });
}

async function lockBooking(trx, id) {
  const booking = await trx('visitor_bookings').where({ id }).forUpdate().first();
  if (!booking) throw httpError(404, 'That booking doesn’t exist.');
  return booking;
}

export async function updateBooking(id, input, actor) {
  return db.transaction(async (trx) => {
    const b = await lockBooking(trx, id);
    if (b.status !== 'expected') throw httpError(409, `This booking is ${b.status === 'arrived' ? 'done: they have arrived' : 'cancelled'}. It can’t be changed.`);
    const values = pick(input);
    const changed = FIELDS.filter((f) => String(values[f] ?? '') !== String(b[f] ?? ''));
    if (!changed.length) return b;
    await trx('visitor_bookings').where({ id }).update(values);
    await audit(trx, actor, { entity: 'visitor_booking', id, action: 'updated', summary: `Booking changed: ${changed.map((f) => f.replace('_', ' ')).join(', ')}` });
    return b;
  });
}

export async function cancelBooking(id, reason, actor) {
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw httpError(422, 'Say why the booking is cancelled.');
  return db.transaction(async (trx) => {
    const b = await lockBooking(trx, id);
    if (b.status !== 'expected') throw httpError(409, `This booking is already ${b.status}.`);
    await trx('visitor_bookings').where({ id }).update({ status: 'cancelled', cancelled_at: trx.fn.now(), cancelled_by: actor.user.id, cancel_reason: why.slice(0, 255) });
    await audit(trx, actor, { entity: 'visitor_booking', id, action: 'cancelled', summary: `Booking cancelled: ${why}` });
    return b;
  });
}

/**
 * Marks the booking arrived, inside the transaction that signs the visitor in.
 * A booking is for one site: the person must be signed in there.
 */
export async function markArrived(trx, bookingId, siteId, visitor, actor) {
  const b = await lockBooking(trx, bookingId);
  if (b.site_id !== siteId) throw httpError(409, 'That booking is for another site.');
  if (b.status !== 'expected') throw httpError(409, `${b.name}’s booking is already ${b.status === 'arrived' ? 'used: they were signed in' : 'cancelled'}.`);
  await trx('visitor_bookings').where({ id: b.id }).update({ status: 'arrived', visitor_id: visitor.id });
  await audit(trx, actor, { entity: 'visitor_booking', id: b.id, action: 'arrived', summary: `${visitor.name} arrived (${visitor.number})` });
  return b;
}

export function getBooking(id) {
  return withNames(db('visitor_bookings as b')).leftJoin('users as cx', 'cx.id', 'b.cancelled_by')
    .where('b.id', id).first([...COLUMNS, 'cx.name as cancelled_by_name']);
}

/** The booking a visit came from, if any. */
export function bookingForVisit(visitorId) {
  return withNames(db('visitor_bookings as b')).where('b.visitor_id', visitorId).first(COLUMNS);
}

/**
 * Bookings at a site.
 *   today:    expected today (not yet here first, then those who came), by time
 *   upcoming: expected after today
 *   past:     earlier days: no-shows, arrived and cancelled (most recent first)
 */
export function list(siteId, tab = 'today', today = localDay()) {
  const q = withNames(db('visitor_bookings as b')).where('b.site_id', siteId);
  if (tab === 'upcoming') {
    return q.where('b.expected_on', '>', today).where('b.status', 'expected')
      .orderBy('b.expected_on').orderByRaw('b.expected_time IS NULL, b.expected_time').select(COLUMNS);
  }
  if (tab === 'past') {
    return q.where('b.expected_on', '<', today).orderBy('b.expected_on', 'desc').orderBy('b.id', 'desc').limit(200).select(COLUMNS);
  }
  return q.where('b.expected_on', today)
    .orderByRaw("FIELD(b.status, 'expected', 'arrived', 'cancelled'), b.expected_time IS NULL, b.expected_time, b.id").select(COLUMNS);
}

/** Tab counts: today's still expected, and those booked for later. */
export async function counts(siteId, today = localDay()) {
  const [row] = await db('visitor_bookings').where({ site_id: siteId, status: 'expected' }).select(
    db.raw('SUM(expected_on = ?) AS today', [today]),
    db.raw('SUM(expected_on > ?) AS upcoming', [today]),
  );
  return { today: Number(row.today ?? 0), upcoming: Number(row.upcoming ?? 0) };
}

/** What the sign-in form starts with when signing in from a booking. */
export function formValues(b) {
  const known = PURPOSES.includes(b.purpose);
  return {
    phone: b.phone ?? '', name: b.name, company: b.company ?? '', host: b.host ?? 'Reception', vehicle_reg: b.vehicle_reg ?? '',
    purpose: known ? b.purpose : 'Other', other_purpose: known ? '' : b.purpose,
    notes: b.notes ?? '', booking_id: String(b.id),
  };
}
