import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { saveFile, removeFile } from '../../core/storage.js';
import { vehicleLabel } from '../../core/vehicle-format.js';

// Vehicle release: the end of a check-in.
//
//   checklist (jobs on this visit completed, invoiced, paid) ──all green──▶ the collector signs ──▶ released (RN-2026-0001)
//                                                            └─red──▶ a manager allows it, with a reason ──┘
//
// Jobs count when they are linked to this check-in and not cancelled. A visit with no jobs has nothing to check.

const round = (n) => Math.round(n * 100) / 100;

/**
 * What stands between this vehicle and the gate.
 * @returns {Promise<{ jobs: object[], items: { key: string, ok: boolean, label: string, detail: string }[], ok: boolean }>}
 *   jobs: each with its invoice (number, total, paid, balance) or null.
 */
export async function checklist(checkinId, trx = db) {
  const jobs = await trx('jobs').where({ checkin_id: checkinId }).whereNot('status', 'cancelled').orderBy('id').select('id', 'number', 'status');
  for (const job of jobs) {
    const inv = await trx('invoices').where({ job_id: job.id, status: 'issued' }).first('id', 'number', 'total');
    const [{ paid }] = await trx('payments').where({ job_id: job.id }).whereNull('voided_at').select(trx.raw('COALESCE(SUM(amount), 0) as paid'));
    job.invoice = inv ? { ...inv, paid: Number(paid), balance: round(Number(inv.total) - Number(paid)) } : null;
  }
  if (!jobs.length) return { jobs, items: [], ok: true };

  const numbers = (list) => list.map((j) => j.number).join(', ');
  const unfinished = jobs.filter((j) => j.status !== 'completed');
  const uninvoiced = jobs.filter((j) => !j.invoice);
  const unpaid = jobs.filter((j) => j.invoice && j.invoice.balance > 0);
  const items = [
    { key: 'work', ok: !unfinished.length, label: 'Work finished', detail: unfinished.length ? `Not finished: ${numbers(unfinished)}` : `${numbers(jobs)} completed` },
    { key: 'invoiced', ok: !uninvoiced.length, label: 'Invoiced', detail: uninvoiced.length ? `No issued invoice: ${numbers(uninvoiced)}` : jobs.map((j) => `Invoice ${j.invoice.number}`).join(', ') },
    { key: 'paid', ok: !uninvoiced.length && !unpaid.length, label: 'Paid in full',
      detail: unpaid.length ? `Balance owing: ${unpaid.map((j) => `invoice ${j.invoice.number}`).join(', ')}` : uninvoiced.length ? 'Can’t be paid before it is invoiced' : 'Nothing owing' },
  ];
  return { jobs, items, ok: items.every((i) => i.ok) };
}

/** A manager lets the vehicle go although the checklist isn't all green (usually: on credit). */
export async function allowRelease(checkinId, reason, actor) {
  await db.transaction(async (trx) => {
    const c = await trx('checkins').where({ id: checkinId }).forUpdate().first('id', 'number', 'status');
    if (!c) throw httpError(404, 'That check-in doesn’t exist.');
    if (c.status !== 'in_workshop') throw httpError(409, `${c.number} has already left.`);
    await trx('checkins').where({ id: checkinId }).update({ release_allowed_at: trx.fn.now(), release_allowed_by: actor.user.id, release_allowed_reason: reason });
    await audit(trx, actor, { entity: 'checkin', id: checkinId, action: 'release_allowed', summary: `Release allowed: ${reason}` });
  });
}

export async function withdrawRelease(checkinId, actor) {
  await db.transaction(async (trx) => {
    const c = await trx('checkins').where({ id: checkinId }).forUpdate().first('id', 'number', 'status', 'release_allowed_at');
    if (!c) throw httpError(404, 'That check-in doesn’t exist.');
    if (c.status !== 'in_workshop') throw httpError(409, `${c.number} has already left.`);
    if (!c.release_allowed_at) return;
    await trx('checkins').where({ id: checkinId }).update({ release_allowed_at: null, release_allowed_by: null, release_allowed_reason: null });
    await audit(trx, actor, { entity: 'checkin', id: checkinId, action: 'release_withdrawn', summary: 'Permission to release withdrawn' });
  });
}

/**
 * Why this vehicle can't be released right now, or null if it can. Checked before the form is shown and again on saving.
 * @param {object} c the check-in row (status, number, release_allowed_at, and labels for the vehicle)
 */
export async function blockedBecause(c, trx = db) {
  if (c.status !== 'in_workshop') return `${c.number} is no longer in the workshop.`;
  if (await trx('vehicle_movements').where({ checkin_id: c.id, status: 'in_transit' }).first('id')) {
    return `${vehicleLabel(c)} is on its way to another site. That site receives it first.`;
  }
  const list = await checklist(c.id, trx);
  if (!list.ok && !c.release_allowed_at) return 'The checklist isn’t complete. A manager has to allow the release first.';
  return null;
}

/**
 * The collector signed: the vehicle leaves and the check-in is closed.
 * @param {{ collector_name: string, collector_phone: string|null, collector_id_no: string|null, signature: Buffer }} input
 * @returns {Promise<{ number: string }>}
 */
export async function releaseVehicle(checkinId, input, actor) {
  const rel = await saveFile('signatures', input.signature, 'png');
  try {
    return await db.transaction(async (trx) => {
      const c = await trx('checkins').join('vehicles', 'vehicles.id', 'checkins.vehicle_id').where('checkins.id', checkinId).forUpdate()
        .first('checkins.id', 'checkins.number', 'checkins.status', 'checkins.release_allowed_at', 'vehicles.reg_no', 'vehicles.chassis_no', 'vehicles.temp_tag');
      if (!c) throw httpError(404, 'That check-in doesn’t exist.');
      const blocked = await blockedBecause(c, trx);
      if (blocked) throw httpError(409, blocked);
      const list = await checklist(checkinId, trx);
      const number = await nextNumber(trx, 'release');
      await trx('vehicle_releases').insert({
        number, checkin_id: checkinId, collector_name: input.collector_name, collector_phone: input.collector_phone, collector_id_no: input.collector_id_no,
        signature_path: rel, checklist: JSON.stringify(list.items), on_approval: !list.ok, released_by: actor.user.id,
      });
      await trx('checkins').where({ id: checkinId }).update({ status: 'checked_out', checked_out_at: trx.fn.now(), checked_out_by: actor.user.id });
      await audit(trx, actor, { entity: 'checkin', id: checkinId, action: 'checked_out',
        summary: `Released ${vehicleLabel(c)} to ${input.collector_name} (${number}${list.ok ? '' : ', with a manager’s approval'})` });
      return { number };
    });
  } catch (err) {
    await removeFile(rel); // not saved: don't leave the image behind
    throw err;
  }
}

/** The checklist's jobs with their work lines, for the release note. */
export async function withWork(jobs) {
  const lines = await db('job_lines').whereIn('job_id', jobs.map((j) => j.id)).orderBy('sort_order').select('job_id', 'quantity', 'unit', 'description');
  return jobs.map((j) => ({ ...j, lines: lines.filter((l) => l.job_id === j.id) }));
}

/** The release of a check-in, if it has left. */
export function releaseOf(checkinId) {
  return db('vehicle_releases as r').leftJoin('users as u', 'u.id', 'r.released_by')
    .where('r.checkin_id', checkinId).first('r.*', 'u.name as released_by_name');
}
