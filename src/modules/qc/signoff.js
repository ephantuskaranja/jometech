import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import { saveFile, removeFile } from '../../core/storage.js';
import { passSignoffStep, reworkSteps } from '../jobs/service.js';
import { redoSteps } from './service.js';

// The customer's sign-off at the job's sign-off step (Customer Inspection), after a passed quality check.
//
//   accepted    the customer, or the driver collecting for them, signs on the device  → step ticked off
//   not_signed  no one there to sign: staff record why                                → step ticked off
//   concerns    what isn't right; chosen steps reopen, and the quality check step too,
//               so the job is checked again before the customer looks again

export const OUTCOMES = {
  accepted: { label: 'Signed off', tone: 'ok' },
  not_signed: { label: 'Not signed', tone: 'warn' },
  concerns: { label: 'Concerns', tone: 'bad' },
};
export const ROLES = { customer: 'Customer', driver: 'Driver, for the customer' };

/** The job, locked, while it waits at its sign-off step; and that step. */
async function atSignoff(trx, jobId) {
  const job = await trx('jobs').where({ id: jobId }).forUpdate().first('id', 'number', 'status');
  if (!job) throw httpError(404, 'That job doesn’t exist.');
  if (job.status !== 'in_progress') throw httpError(409, `${job.number} isn’t in progress.`);
  const step = await trx('job_steps').where({ job_id: jobId, status: 'pending' }).orderBy('sort_order').first();
  if (!step?.is_signoff) throw httpError(409, `${job.number} isn’t at its customer sign-off step${step ? ` (it is at ${step.name})` : ''}.`);
  return job;
}

/** The job's latest passed quality check: what the customer is shown. */
export function lastPassedCheck(q, jobId) {
  return q('qc_inspections').where({ job_id: jobId, status: 'passed' }).orderBy('id', 'desc').first('id', 'number', 'attempt', 'finished_at');
}

/**
 * The customer (or driver) signs: the sign-off step is ticked off.
 * @param {{ signer_role: 'customer'|'driver', signer_name: string, signer_phone: string|null, signature: Buffer }} input
 */
export async function acceptSignoff(jobId, input, actor) {
  const rel = await saveFile('signatures', input.signature, 'png');
  try {
    return await db.transaction(async (trx) => {
      const job = await atSignoff(trx, jobId);
      const qc = await lastPassedCheck(trx, jobId);
      const [id] = await trx('customer_signoffs').insert({
        job_id: jobId, qc_id: qc?.id ?? null, outcome: 'accepted', signer_role: input.signer_role, signer_name: input.signer_name,
        signer_phone: input.signer_phone, signature_path: rel, recorded_by: actor.user.id,
      });
      const who = `${input.signer_name}${input.signer_role === 'driver' ? ' (driver)' : ''}`;
      await audit(trx, actor, { entity: 'job', id: jobId, action: 'signed_off', summary: `Signed off by ${who}` });
      const step = await passSignoffStep(trx, jobId, actor, `signed off by ${who}`);
      return { id, job, step };
    });
  } catch (err) {
    await removeFile(rel); // not saved: don't leave the image behind
    throw err;
  }
}

/** No one there to sign: recorded with the reason, and the step is ticked off. */
export async function notSigned(jobId, reason, actor) {
  return db.transaction(async (trx) => {
    const job = await atSignoff(trx, jobId);
    const qc = await lastPassedCheck(trx, jobId);
    const [id] = await trx('customer_signoffs').insert({ job_id: jobId, qc_id: qc?.id ?? null, outcome: 'not_signed', reason, recorded_by: actor.user.id });
    await audit(trx, actor, { entity: 'job', id: jobId, action: 'signoff_not_signed', summary: reason });
    const step = await passSignoffStep(trx, jobId, actor, `not signed: ${reason}`);
    return { id, job, step };
  });
}

/**
 * The customer isn't happy: their concerns are recorded, the chosen steps (before the quality check)
 * reopen, and so does the quality check step, so the job is checked again before the next sign-off.
 * @param {{ signer_role: 'customer'|'driver', signer_name: string, concerns: string, stepIds: number[] }} input
 * @returns {Promise<{ id: number, job: object, reworked: string[] }>}
 */
export async function raiseConcerns(jobId, input, actor) {
  return db.transaction(async (trx) => {
    const job = await atSignoff(trx, jobId);
    const allowed = new Set((await redoSteps(trx, jobId)).map((s) => s.id));
    const qcStep = await trx('job_steps').where({ job_id: jobId, is_qc: true }).first('id');
    const stepIds = [...new Set(input.stepIds.filter((s) => allowed.has(s))), ...(qcStep ? [qcStep.id] : [])];
    const qc = await lastPassedCheck(trx, jobId);
    const [id] = await trx('customer_signoffs').insert({
      job_id: jobId, qc_id: qc?.id ?? null, outcome: 'concerns', signer_role: input.signer_role, signer_name: input.signer_name,
      concerns: input.concerns, recorded_by: actor.user.id,
    });
    await audit(trx, actor, { entity: 'job', id: jobId, action: 'signoff_concerns', summary: `${input.signer_name}: ${input.concerns}`.slice(0, 1000) });
    const reworked = await reworkSteps(trx, jobId, stepIds, { signoff: { id } }, actor);
    return { id, job, reworked };
  });
}

const COLUMNS = ['so.*', 'u.name as recorded_by_name', 'q.number as qc_number'];
const withNames = (q) => q.leftJoin('users as u', 'u.id', 'so.recorded_by').leftJoin('qc_inspections as q', 'q.id', 'so.qc_id');

/** A job's sign-offs, newest first. */
export function forJob(jobId) {
  return withNames(db('customer_signoffs as so')).where('so.job_id', jobId).orderBy('so.id', 'desc').select(COLUMNS);
}

export function getSignoff(id) {
  return withNames(db('customer_signoffs as so')).join('jobs as j', 'j.id', 'so.job_id').where('so.id', id).first([...COLUMNS, 'j.site_id']);
}

/** The sign-off that closed this quality check (for the Customer line on its report), if any. */
export function forCheck(qcId) {
  return withNames(db('customer_signoffs as so')).where('so.qc_id', qcId).whereIn('so.outcome', ['accepted', 'not_signed']).orderBy('so.id', 'desc').first(COLUMNS);
}
