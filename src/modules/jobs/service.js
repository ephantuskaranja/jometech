import { db } from '../../core/db.js';
import { countTabs } from '../../core/count-tabs.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { compact, vehicleLabel } from '../../core/vehicle-format.js';
import { httpError } from '../../core/validate.js';

// Jobs: the work the workshop does for a customer.
//
//   open ──▶ in_progress ──▶ completed
//     └───────────┴────────▶ cancelled      (completed or cancelled can be reopened)
//
// From an accepted proforma the customer, vehicle and lines are copied, without prices,
// and stay fixed: later changes will be variations. A job with no proforma can be edited.
// The job can also come first: "Make proforma" prices it, and once accepted that proforma becomes
// the job's (proformas/service.js). Stores issue materials only after that, unless a supervisor allows it.
// A job is opened only for a vehicle checked in at that site (sheet row 49), and follows it between sites.
// Older jobs opened before that rule may still have no vehicle; their check-in links by itself.
//
// Steps: a job copies the list of its job type (System → Job types & steps) and keeps that copy.
// One step is current at a time. Finishing or skipping the last one completes the job.

export const STATUSES = {
  open: { label: 'Open', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  completed: { label: 'Completed', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
};

/** List tabs. "active" = open or in progress. */
export const TABS = ['active', 'completed', 'all'];

const ACTIVE = ['open', 'in_progress'];

const err = (status, message, field) => Object.assign(httpError(status, message), { field });

const openCheckin = (trx, vehicleId) => (vehicleId
  ? trx('checkins').where({ vehicle_id: vehicleId, status: 'in_workshop' }).first('id', 'site_id', 'number')
  : null);

/**
 * What stops a job being opened on this vehicle, or null:
 *   running  it already has a job open or in progress: that job is edited instead of opening another
 *   not_in   it isn't checked in: the gate logs it in and the workshop checks it in first (sheet row 49)
 *   site     it is checked in at another site: the person switches to that site to open its job
 * @returns {Promise<null | { kind: 'running', message: string, job: { id: number, number: string, site_id: number, site_name: string } }
 *                        | { kind: 'not_in', message: string, vehicle: { id: number, label: string } }
 *                        | { kind: 'site', message: string, site: { id: number, name: string } }>}
 */
export async function vehicleBlocker(vehicleId, { siteId = null, exceptJobId = null } = {}, trx = db) {
  if (!vehicleId) return null;
  const vehicle = await trx('vehicles').where({ id: vehicleId }).first('reg_no', 'chassis_no', 'temp_tag');
  if (!vehicle) return null;
  const label = vehicleLabel(vehicle);
  const running = await trx('jobs as j').join('sites as s', 's.id', 'j.site_id')
    .where({ 'j.vehicle_id': vehicleId }).whereIn('j.status', ACTIVE)
    .modify((q) => { if (exceptJobId) q.whereNot('j.id', exceptJobId); })
    .orderBy('j.id', 'desc').first('j.id', 'j.number', 'j.status', 'j.site_id', 's.name as site_name');
  if (running) {
    return { kind: 'running', job: running, message: `${label} already has job ${running.number} ${running.status === 'open' ? 'open' : 'in progress'}. Add the work to that job instead of opening another.` };
  }
  const checkin = await openCheckin(trx, vehicleId);
  if (!checkin) return { kind: 'not_in', vehicle: { id: vehicleId, label }, message: `${label} isn’t checked in. Check it in first, then open its job.` };
  if (siteId && checkin.site_id !== siteId) {
    const site = await trx('sites').where({ id: checkin.site_id }).first('id', 'name');
    return { kind: 'site', site, message: `${label} is checked in at ${site.name}, not here. Switch to ${site.name} to open its job.` };
  }
  return null;
}

/** Throws the blocker as a form error on the vehicle, carrying what the page needs for its shortcut buttons. */
async function refuseIfBlocked(trx, vehicleId, options) {
  const blocker = await vehicleBlocker(vehicleId, options, trx);
  if (blocker) throw Object.assign(err(409, blocker.message, 'vehicle_id'), { blocker });
}

/** Who can be put in charge at a site: active users whose role lets them manage jobs. */
export function supervisorOptions(siteId) {
  return db('users as u')
    .join('user_roles as ur', 'ur.user_id', 'u.id')
    .join('roles as r', 'r.id', 'ur.role_id')
    .join('role_permissions as rp', 'rp.role_id', 'r.id')
    .join('permissions as p', 'p.id', 'rp.permission_id')
    .where({ 'u.is_active': true, 'p.key': 'jobs.manage' })
    .where((w) => w.where('r.all_sites', true)
      .orWhereExists(db('user_sites as us').whereRaw('us.user_id = u.id').where('us.site_id', siteId)))
    .distinct('u.id as value', 'u.name as label')
    .orderBy('u.name');
}

/** Customer and vehicle must exist, the vehicle must be that customer's, and the supervisor must be able to run jobs here. */
async function checkLinks(trx, input, { siteId, currentSupervisor = null }) {
  if (!(await trx('customers').where({ id: input.customer_id }).first('id'))) throw err(422, 'That customer no longer exists.', 'customer_id');
  if (input.vehicle_id) {
    const v = await trx('vehicles').where({ id: input.vehicle_id }).first('customer_id');
    if (!v || v.customer_id !== input.customer_id) throw err(422, 'Choose one of this customer’s vehicles', 'vehicle_id');
  }
  if (input.supervisor_id && input.supervisor_id !== currentSupervisor) {
    const allowed = await supervisorOptions(siteId);
    if (!allowed.some((u) => u.value === input.supervisor_id)) throw err(422, 'Choose someone who runs jobs at this site', 'supervisor_id');
  }
}

/** The job type chosen, or the default when none was. Null only if no job types exist. */
async function resolveType(trx, id) {
  const q = trx('job_types').where({ is_active: true });
  const type = await (id ? q.where({ id }) : q.where({ is_default: true })).first('id');
  if (id && !type) throw err(422, 'Choose a job type', 'job_type_id');
  return type?.id ?? null;
}

/** The job's own copy of its type's steps, with its vehicle received, quality check and customer sign-off steps marked. */
async function copySteps(trx, jobId, typeId) {
  await trx('job_steps').where({ job_id: jobId }).delete();
  if (!typeId) return;
  const { receive_step: receiveStep, qc_step: qcStep, signoff_step: signoffStep } = await trx('job_types').where({ id: typeId }).first('receive_step', 'qc_step', 'signoff_step');
  const steps = await trx('job_type_steps').where({ job_type_id: typeId }).orderBy('sort_order').pluck('name');
  if (steps.length) {
    await trx('job_steps').insert(steps.map((name, i) => ({ job_id: jobId, sort_order: i + 1, name,
      is_receive: i === 0 && name === receiveStep, is_qc: name === qcStep, is_signoff: name === signoffStep && name !== qcStep })));
  }
}

async function writeLines(trx, jobId, lines) {
  await trx('job_lines').where({ job_id: jobId }).delete();
  if (lines.length) {
    await trx('job_lines').insert(lines.map((l, i) => ({ job_id: jobId, sort_order: i + 1, quantity: l.quantity, unit: l.unit, description: l.description })));
  }
}

/** What the history shows when a job changes: names, not ids. */
async function snapshot(trx, job, lines) {
  const customer = await trx('customers').where({ id: job.customer_id }).first('name');
  const vehicle = job.vehicle_id ? await trx('vehicles').where({ id: job.vehicle_id }).first('reg_no', 'chassis_no', 'temp_tag') : null;
  const supervisor = job.supervisor_id ? await trx('users').where({ id: job.supervisor_id }).first('name') : null;
  const type = job.job_type_id ? await trx('job_types').where({ id: job.job_type_id }).first('name') : null;
  return {
    job_type: type?.name ?? null,
    customer: customer?.name,
    vehicle: vehicle ? vehicleLabel(vehicle) : job.vehicle_description ?? null,
    supervisor: supervisor?.name ?? null,
    responsible: job.responsible_name ?? null,
    due_on: job.due_on ?? null,
    instructions: job.instructions ?? null,
    work: lines.map((l) => `${Number(l.quantity)} ${l.unit}: ${l.description}`),
  };
}

/**
 * The customer's vehicles for the job form, each saying whether a job can be opened on it here:
 * checked in at this site with no other job running. `keepId` (the job's own vehicle) is always open.
 * @returns {Promise<Array<{ value: number, label: string, disabled: boolean }>>}
 */
export async function vehicleChoices(customerId, siteId, keepId = null) {
  const rows = await db('vehicles').where({ customer_id: customerId }).orderBy('reg_no').select('id', 'reg_no', 'chassis_no', 'temp_tag', 'make', 'model');
  const ids = rows.map((v) => v.id);
  const inside = new Map((await db('checkins as c').join('sites as s', 's.id', 'c.site_id').whereIn('c.vehicle_id', ids).where('c.status', 'in_workshop')
    .select('c.vehicle_id', 'c.site_id', 's.name as site_name')).map((c) => [c.vehicle_id, c]));
  const running = new Map((await db('jobs').whereIn('vehicle_id', ids).whereIn('status', ACTIVE).select('vehicle_id', 'number')).map((j) => [j.vehicle_id, j.number]));
  return rows.map((v) => {
    const label = [vehicleLabel(v), [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const at = inside.get(v.id);
    const why = v.id === keepId ? null
      : running.has(v.id) ? `job ${running.get(v.id)} running`
        : !at ? 'not checked in'
          : at.site_id !== siteId ? `checked in at ${at.site_name}` : null;
    return { value: v.id, label: why ? `${label} (${why})` : label, disabled: Boolean(why) };
  });
}

/** A job with no proforma, for a vehicle checked in here. @returns {Promise<{ id: number, number: string }>} */
export async function createJob(input, actor) {
  return db.transaction(async (trx) => {
    if (!input.vehicle_id) throw err(422, 'Choose the vehicle. It must be checked in here first.', 'vehicle_id');
    const owner = await trx('vehicles').where({ id: input.vehicle_id }).first('customer_id');
    if (owner?.customer_id !== input.customer_id) throw err(422, 'Choose one of this customer’s vehicles', 'vehicle_id');
    // One running job per vehicle, opened at the site the vehicle is checked in at.
    await refuseIfBlocked(trx, input.vehicle_id, { siteId: actor.site.id });
    const checkin = await openCheckin(trx, input.vehicle_id);
    const siteId = checkin?.site_id ?? actor.site.id;
    await checkLinks(trx, input, { siteId });
    const typeId = await resolveType(trx, input.job_type_id);
    const number = await nextNumber(trx, 'job');
    const [id] = await trx('jobs').insert({
      number, site_id: siteId, job_type_id: typeId, customer_id: input.customer_id, vehicle_id: input.vehicle_id, vehicle_description: input.vehicle_description,
      checkin_id: checkin?.id ?? null, supervisor_id: input.supervisor_id, responsible_name: input.responsible_name,
      due_on: input.due_on, instructions: input.instructions, created_by: actor.user.id,
    });
    await writeLines(trx, id, input.lines);
    await copySteps(trx, id, typeId);
    await audit(trx, actor, { entity: 'job', id, action: 'create', summary: 'No proforma' });
    return { id, number };
  });
}

/**
 * One click on an accepted proforma. Asking twice (a double click, two people) gives the same job.
 * @returns {Promise<{ id: number, number: string, site_id: number, existed: boolean }>}
 */
export async function createFromProforma(proformaId, jobTypeId, actor, chosenVehicleId = null) {
  return db.transaction(async (trx) => {
    const p = await trx('proformas').where({ id: proformaId }).forUpdate().first();
    if (!p) throw httpError(404, 'That proforma doesn’t exist.');
    const existing = await trx('jobs').where({ proforma_id: p.id }).first('id', 'number', 'site_id');
    if (existing) return { ...existing, existed: true };
    if (p.status !== 'accepted') throw httpError(409, `Only an accepted proforma can become a job. ${p.number} hasn’t been accepted.`);
    // The job starts once the vehicle is checked in. A proforma priced for a vehicle not yet on file
    // (only described) gets the customer's vehicle chosen when it has been checked in.
    const vehicleId = p.vehicle_id ?? chosenVehicleId;
    if (!vehicleId) {
      throw Object.assign(httpError(422, 'no vehicle'), { blocker: { kind: 'no_vehicle', message: `${p.number} has no vehicle on file. Check the vehicle in, then choose it here to start the job.` } });
    }
    if (!p.vehicle_id && !(await trx('vehicles').where({ id: vehicleId, customer_id: p.customer_id }).first('id'))) {
      throw httpError(422, 'Choose one of this customer’s vehicles.');
    }
    await refuseIfBlocked(trx, vehicleId, { siteId: actor.site.id });

    const checkin = await openCheckin(trx, vehicleId);
    const siteId = checkin?.site_id ?? actor.site.id;
    const typeId = await resolveType(trx, jobTypeId);
    const number = await nextNumber(trx, 'job');
    const [id] = await trx('jobs').insert({
      number, site_id: siteId, job_type_id: typeId, proforma_id: p.id, customer_id: p.customer_id, vehicle_id: vehicleId, vehicle_description: p.vehicle_description,
      checkin_id: checkin?.id ?? null, created_by: actor.user.id,
    });
    await writeLines(trx, id, await trx('proforma_lines').where({ proforma_id: p.id }).orderBy('sort_order'));
    await copySteps(trx, id, typeId);
    await audit(trx, actor, { entity: 'job', id, action: 'create', summary: `From proforma ${p.number}` });
    await audit(trx, actor, { entity: 'proforma', id: p.id, action: 'job_created', summary: `Job ${number}` });
    return { id, number, site_id: siteId, existed: false };
  });
}

/**
 * Stores issue materials to a job once the customer has accepted its proforma, or when a supervisor
 * (or above) has allowed it early (sheet row 49). Returns go back whatever the state.
 */
export const materialsAllowed = (job) => Boolean(job.proforma_id || job.materials_allowed_at);

/** "Allow materials now": before the proforma is accepted, with the reason (jobs.allow_materials; the route checks). */
/**
 * Accepted proformas that could be this job's (sheet row 58): the same customer's, not on any job yet,
 * and for this vehicle or for no vehicle in particular. Newest first.
 */
export function matchableProformas(job) {
  return db('proformas as p')
    .leftJoin('jobs as j', 'j.proforma_id', 'p.id')
    .leftJoin('vehicles as v', 'v.id', 'p.vehicle_id')
    .where({ 'p.status': 'accepted', 'p.customer_id': job.customer_id }).whereNull('j.id')
    .where((w) => { w.whereNull('p.vehicle_id'); if (job.vehicle_id) w.orWhere('p.vehicle_id', job.vehicle_id); })
    .where((w) => w.whereNull('p.for_job_id').orWhere('p.for_job_id', job.id))
    .orderBy('p.closed_at', 'desc').orderBy('p.id', 'desc').limit(50)
    .select('p.id', 'p.number', 'p.proforma_date', 'p.closed_at', 'p.total', 'p.vehicle_description', 'v.reg_no', 'v.chassis_no', 'v.temp_tag',
      db('proforma_lines').where('proforma_id', db.ref('p.id')).orderBy('sort_order').limit(1).select('description').as('first_line'));
}

/**
 * A job opened without a proforma takes one the customer already accepted: as if the job had been
 * made from it. The job's work becomes the proforma's lines, and stores can issue materials.
 */
export async function matchProforma(jobId, proformaId, actor) {
  return db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first('id', 'number', 'status', 'customer_id', 'vehicle_id', 'proforma_id');
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    if (job.status === 'cancelled') throw httpError(409, `${job.number} is cancelled. Reopen it first.`);
    if (job.proforma_id) throw httpError(409, `${job.number} already has a proforma. Extra work goes on it as a variation.`);
    const pending = await trx('proformas').where({ for_job_id: job.id }).whereIn('status', ['draft', 'sent']).first('number');
    if (pending) throw httpError(409, `Proforma ${pending.number} is being prepared for ${job.number}. Decline it first, or wait for the customer’s answer.`);
    const p = await trx('proformas').where({ id: proformaId }).forUpdate().first('id', 'number', 'status', 'customer_id', 'vehicle_id', 'for_job_id');
    if (!p || p.status !== 'accepted') throw httpError(409, 'Choose a proforma the customer has accepted.');
    if (p.customer_id !== job.customer_id) throw httpError(409, `${p.number} is for another customer.`);
    if (p.vehicle_id && p.vehicle_id !== job.vehicle_id) throw httpError(409, `${p.number} is for another vehicle.`);
    if (p.for_job_id && p.for_job_id !== job.id) throw httpError(409, `${p.number} was made for another job.`);
    const used = await trx('jobs').where({ proforma_id: p.id }).first('number');
    if (used) throw httpError(409, `${p.number} is already on job ${used.number}.`);

    await trx('jobs').where({ id: job.id }).update({ proforma_id: p.id });
    await writeLines(trx, job.id, await trx('proforma_lines').where({ proforma_id: p.id }).orderBy('sort_order'));
    await audit(trx, actor, { entity: 'job', id: job.id, action: 'proforma_matched', summary: `Matched to proforma ${p.number}: the work is now as agreed on it, and stores can issue materials` });
    await audit(trx, actor, { entity: 'proforma', id: p.id, action: 'job_attached', summary: `Job ${job.number}` });
    return p;
  });
}

export async function allowMaterials(id, reason, actor) {
  await db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id }).forUpdate().first();
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    if (!ACTIVE.includes(job.status)) throw httpError(409, `${job.number} is ${STATUSES[job.status].label.toLowerCase()}.`);
    if (materialsAllowed(job)) return;
    await trx('jobs').where({ id }).update({ materials_allowed_at: trx.fn.now(), materials_allowed_by: actor.user.id, materials_allowed_reason: reason });
    await audit(trx, actor, { entity: 'job', id, action: 'materials_allowed', summary: reason });
  });
}

/** Until it is completed or cancelled. A job from a proforma keeps its customer and lines. */
export async function updateJob(id, input, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('jobs').where({ id }).forUpdate().first();
    if (!before) throw httpError(404, 'That job doesn’t exist.');
    if (!ACTIVE.includes(before.status)) throw httpError(409, `${before.number} is ${STATUSES[before.status].label.toLowerCase()}. Reopen it to change it.`);
    const fixed = Boolean(before.proforma_id);
    const customerId = fixed ? before.customer_id : input.customer_id;

    // A newly chosen vehicle brings its open check-in, and the job goes to that vehicle's site.
    const vehicleChanged = input.vehicle_id !== before.vehicle_id;
    if (before.vehicle_id && !input.vehicle_id) throw err(422, 'A job’s vehicle can be changed to another checked-in vehicle, not removed', 'vehicle_id');
    // The new vehicle must be checked in, with no other job running on it.
    if (vehicleChanged) await refuseIfBlocked(trx, input.vehicle_id, { exceptJobId: id });
    const checkin = vehicleChanged ? await openCheckin(trx, input.vehicle_id) : null;
    const siteId = checkin?.site_id ?? before.site_id;
    await checkLinks(trx, { ...input, customer_id: customerId }, { siteId, currentSupervisor: before.supervisor_id });

    // The job type can change until a step has been ticked off; its steps change with it.
    const typeChanged = Boolean(input.job_type_id) && input.job_type_id !== before.job_type_id;
    if (typeChanged) {
      await resolveType(trx, input.job_type_id);
      if (await trx('job_steps').where({ job_id: id }).whereNot({ status: 'pending' }).first('id')) {
        throw err(422, 'Steps have already been ticked off, so the job type can’t change now', 'job_type_id');
      }
    }

    const beforeLines = await trx('job_lines').where({ job_id: id }).orderBy('sort_order');
    const lines = fixed ? beforeLines : input.lines;
    const changes = {
      // The description is only typed on an older job with no vehicle; once it has one, what was there stays.
      customer_id: customerId, vehicle_id: input.vehicle_id, vehicle_description: input.vehicle_id ? before.vehicle_description : input.vehicle_description,
      supervisor_id: input.supervisor_id, responsible_name: input.responsible_name,
      due_on: input.due_on, instructions: input.instructions, site_id: siteId,
      ...(vehicleChanged ? { checkin_id: checkin?.id ?? null } : {}),
      ...(typeChanged ? { job_type_id: input.job_type_id } : {}),
    };
    await trx('jobs').where({ id }).update(changes);
    if (!fixed) await writeLines(trx, id, lines);
    if (typeChanged) await copySteps(trx, id, input.job_type_id);
    await audit(trx, actor, {
      entity: 'job', id, action: 'update',
      before: await snapshot(trx, before, beforeLines),
      after: await snapshot(trx, { ...before, ...changes }, lines),
    });
    // A vehicle chosen once it is checked in (the job had only a description): it has arrived.
    if (vehicleChanged) await tickReceived(trx, id, actor);
  });
}

/**
 * Puts someone else in charge of the job, at any stage (managers and above; the route checks).
 * The new supervisor must be able to run jobs at the job's site.
 * @returns {Promise<{ from: string|null, to: string|null }>} the names, for the message
 */
export async function changeSupervisor(id, supervisorId, actor) {
  return db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id }).forUpdate().first();
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    if ((job.supervisor_id ?? null) === (supervisorId ?? null)) {
      const same = supervisorId ? await trx('users').where({ id: supervisorId }).first('name') : null;
      return { from: same?.name ?? null, to: same?.name ?? null, unchanged: true };
    }
    if (supervisorId) {
      const allowed = await supervisorOptions(job.site_id);
      if (!allowed.some((u) => u.value === supervisorId)) throw err(422, 'Choose someone who runs jobs at this site', 'supervisor_id');
    }
    const name = async (uid) => (uid ? (await trx('users').where({ id: uid }).first('name'))?.name ?? null : null);
    const [from, to] = [await name(job.supervisor_id), await name(supervisorId)];
    await trx('jobs').where({ id }).update({ supervisor_id: supervisorId });
    await audit(trx, actor, { entity: 'job', id, action: 'update', before: { supervisor: from }, after: { supervisor: to } });
    return { from, to, unchanged: false };
  });
}

async function lockJob(trx, id) {
  const job = await trx('jobs').where({ id }).forUpdate().first();
  if (!job) throw httpError(404, 'That job doesn’t exist.');
  return job;
}

export async function startJob(id, actor) {
  await db.transaction(async (trx) => {
    const job = await lockJob(trx, id);
    if (job.status !== 'open') throw httpError(409, `${job.number} is ${STATUSES[job.status].label.toLowerCase()}, so it can’t be started.`);
    await trx('jobs').where({ id }).update({ status: 'in_progress', started_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'job', id, action: 'job_started' });
    await tickReceived(trx, id, actor);
  });
}

export async function completeJob(id, actor) {
  await db.transaction(async (trx) => {
    const job = await lockJob(trx, id);
    if (job.status !== 'in_progress') throw httpError(409, `Only a job in progress can be completed. ${job.number} is ${STATUSES[job.status].label.toLowerCase()}.`);
    if (await pendingStep(trx, id)) throw httpError(409, `${job.number} still has steps to finish. Tick them off, or skip those that don’t apply.`);
    await markCompleted(trx, id, actor);
  });
}

const pendingStep = (trx, jobId) => trx('job_steps').where({ job_id: jobId, status: 'pending' }).orderBy('sort_order').first();
// The step ticked off most recently (after a failed quality check reopens an earlier step, that need not be the furthest one).
const lastFinishedStep = (trx, jobId) => trx('job_steps').where({ job_id: jobId }).whereNot({ status: 'pending' })
  .orderBy('finished_at', 'desc').orderBy('sort_order', 'desc').first();

async function markCompleted(trx, id, actor) {
  await trx('jobs').where({ id }).update({ status: 'completed', completed_at: trx.fn.now() });
  await audit(trx, actor, { entity: 'job', id, action: 'job_completed' });
}

async function reopenStep(trx, step) {
  await trx('job_steps').where({ id: step.id }).update({ status: 'pending', finished_at: null, finished_by: null });
}

/**
 * The current step is done (or skipped, when it doesn't apply to this job).
 * `stepId` is the step the person was looking at: a double click, or someone else having
 * just moved the job on, changes nothing and returns null.
 * @param {'done'|'skipped'} status
 * @returns {Promise<{ name: string, next: string|null } | null>}
 */
export async function finishStep(jobId, stepId, status, actor) {
  return db.transaction(async (trx) => {
    const job = await lockJob(trx, jobId);
    if (job.status === 'open') throw httpError(409, `Start ${job.number} first.`);
    if (job.status !== 'in_progress') throw httpError(409, `${job.number} is ${STATUSES[job.status].label.toLowerCase()}.`);
    const step = await pendingStep(trx, jobId);
    if (step?.id !== stepId) return null;
    if (step.is_qc) throw httpError(409, `${step.name} is ticked off by a passed quality check. Start the quality check on the job.`);
    if (step.is_signoff) throw httpError(409, `${step.name} is ticked off by the customer’s sign-off. Open Customer sign-off on the job.`);
    // Only a job with no vehicle at all may skip it; otherwise the vehicle's check-in ticks it off.
    if (step.is_receive && (status === 'done' || job.vehicle_id || job.vehicle_description)) {
      throw httpError(409, `${step.name} is ticked off when the vehicle is checked in. ${job.vehicle_id ? 'Check the vehicle in.' : 'Choose the vehicle on the job once it is checked in.'}`);
    }
    await trx('job_steps').where({ id: step.id }).update({ status, finished_at: trx.fn.now(3), finished_by: actor.user.id });
    await audit(trx, actor, { entity: 'job', id: jobId, action: status === 'done' ? 'step_done' : 'step_skipped', summary: step.name });
    const next = await pendingStep(trx, jobId);
    if (!next) await markCompleted(trx, jobId, actor);
    return { name: step.name, next: next?.name ?? null };
  });
}

/**
 * A passed quality check ticks off the job's quality check step (inside the inspection's transaction).
 * Only while the job is in progress and that step is the current one.
 * @returns {Promise<{ name: string, next: string|null }>}
 */
export function passQcStep(trx, jobId, actor) {
  return passLockedStep(trx, jobId, actor, { flag: 'is_qc', what: 'the quality check', where: 'its quality check step', why: 'quality check passed' });
}

/** The customer's sign-off (or no one there to sign) ticks off the job's sign-off step, the same way. */
export function passSignoffStep(trx, jobId, actor, why) {
  return passLockedStep(trx, jobId, actor, { flag: 'is_signoff', what: 'the sign-off', where: 'its customer sign-off step', why });
}

async function passLockedStep(trx, jobId, actor, { flag, what, where, why }) {
  const job = await lockJob(trx, jobId);
  if (job.status !== 'in_progress') throw httpError(409, `${job.number} is ${STATUSES[job.status].label.toLowerCase()}, so ${what} can’t be recorded.`);
  const step = await pendingStep(trx, jobId);
  if (!step?.[flag]) throw httpError(409, `${job.number} isn’t at ${where} any more (it is at ${step?.name ?? 'no step'}). Ask the supervisor to check the job.`);
  await trx('job_steps').where({ id: step.id }).update({ status: 'done', finished_at: trx.fn.now(3), finished_by: actor.user.id });
  await audit(trx, actor, { entity: 'job', id: jobId, action: 'step_done', summary: `${step.name} (${why})` });
  const next = await pendingStep(trx, jobId);
  if (!next) await markCompleted(trx, jobId, actor);
  return { name: step.name, next: next?.name ?? null };
}

/**
 * Sends the job back: these steps are to do again; every other step stays as it is.
 * From a failed quality check (`from.qc`) or the customer's concerns at sign-off (`from.signoff`).
 * Inside the caller's transaction.
 * @param {{ qc?: { id: number, number: string }, signoff?: { id: number } }} from
 * @returns {Promise<string[]>} the names of the steps reopened, in order
 */
export async function reworkSteps(trx, jobId, stepIds, from, actor) {
  if (!stepIds.length) return [];
  const steps = await trx('job_steps').where({ job_id: jobId }).whereIn('id', stepIds).orderBy('sort_order');
  const source = from.qc ? { rework_qc_id: from.qc.id, rework_signoff_id: null } : { rework_qc_id: null, rework_signoff_id: from.signoff.id };
  for (const step of steps) {
    await trx('job_steps').where({ id: step.id }).update({ status: 'pending', finished_at: null, finished_by: null, ...source });
  }
  const names = steps.map((s) => s.name);
  const why = from.qc ? `quality check ${from.qc.number} failed` : 'the customer’s concerns at sign-off';
  await audit(trx, actor, { entity: 'job', id: jobId, action: 'steps_reworked', summary: `${names.join(', ')} (${why})` });
  return names;
}

/** Ticked by mistake: the last finished step becomes the current one again. */
export async function undoStep(jobId, actor) {
  return db.transaction(async (trx) => {
    const job = await lockJob(trx, jobId);
    if (job.status !== 'in_progress') throw httpError(409, `${job.number} is ${STATUSES[job.status].label.toLowerCase()}.`);
    const step = await lastFinishedStep(trx, jobId);
    if (!step) throw httpError(409, 'No step has been ticked off yet.');
    if (step.is_receive && step.status === 'done') throw httpError(409, `${step.name} follows the vehicle’s check-in, so it can’t be undone here.`);
    await reopenStep(trx, step);
    await audit(trx, actor, { entity: 'job', id: jobId, action: 'step_undone', summary: step.name });
    return step.name;
  });
}

export async function cancelJob(id, reason, actor) {
  await db.transaction(async (trx) => {
    const job = await lockJob(trx, id);
    if (!ACTIVE.includes(job.status)) throw httpError(409, `${job.number} is ${STATUSES[job.status].label.toLowerCase()}, so it can’t be cancelled.`);
    await trx('jobs').where({ id }).update({ status: 'cancelled', cancelled_at: trx.fn.now(), cancelled_reason: reason });
    await audit(trx, actor, { entity: 'job', id, action: 'job_cancelled', summary: reason });
  });
}

/** Back to work: in progress if it had started, otherwise open. */
export async function reopenJob(id, actor) {
  await db.transaction(async (trx) => {
    const job = await lockJob(trx, id);
    if (ACTIVE.includes(job.status)) throw httpError(409, `${job.number} is already open.`);
    // Completed means every step was finished: the last one becomes current again, so there is something to do.
    if (job.status === 'completed' && !(await pendingStep(trx, id))) {
      const step = await lastFinishedStep(trx, id);
      if (step) await reopenStep(trx, step);
    }
    // The vehicle may have left and come back while the job was closed: link today's check-in.
    const checkin = await openCheckin(trx, job.vehicle_id);
    await trx('jobs').where({ id }).update({
      status: job.started_at ? 'in_progress' : 'open', completed_at: null, cancelled_at: null, cancelled_reason: null,
      ...(checkin && checkin.id !== job.checkin_id ? { checkin_id: checkin.id } : {}),
    });
    await audit(trx, actor, { entity: 'job', id, action: 'reopened' });
    await tickReceived(trx, id, actor);
  });
}

// ---------- called when the vehicle arrives or moves ----------

/** The vehicle was checked in: its active jobs link to this check-in and go to this site. */
export async function linkCheckin(trx, vehicleId, checkin, actor) {
  const jobs = await trx('jobs').where({ vehicle_id: vehicleId }).whereIn('status', ACTIVE).select('id');
  if (!jobs.length) return;
  await trx('jobs').whereIn('id', jobs.map((j) => j.id)).update({ checkin_id: checkin.id, site_id: checkin.site_id });
  for (const { id } of jobs) {
    await audit(trx, actor, { entity: 'job', id, action: 'vehicle_arrived', summary: `Check-in ${checkin.number}` });
    await tickReceived(trx, id, actor);
  }
}

/**
 * The job's Vehicle Received step is ticked off by the vehicle's check-in: when the job is under way,
 * it is at that step, and its vehicle is checked in (at start, at check-in, when the vehicle is chosen,
 * on reopening). Otherwise nothing happens; the job waits for its vehicle.
 */
export async function tickReceived(trx, jobId, actor) {
  const job = await trx('jobs').where({ id: jobId }).first('id', 'status', 'checkin_id');
  if (job?.status !== 'in_progress' || !job.checkin_id) return;
  const step = await pendingStep(trx, jobId);
  if (!step?.is_receive) return;
  const checkin = await trx('checkins').where({ id: job.checkin_id }).whereIn('status', ['in_workshop', 'released']).first('number');
  if (!checkin) return;
  await trx('job_steps').where({ id: step.id }).update({ status: 'done', finished_at: trx.fn.now(3), finished_by: actor.user.id });
  await audit(trx, actor, { entity: 'job', id: jobId, action: 'step_done', summary: `${step.name} (check-in ${checkin.number})` });
  if (!(await pendingStep(trx, jobId))) await markCompleted(trx, jobId, actor);
}

/** The vehicle was received at another site: its active jobs go with it. */
export async function followVehicle(trx, checkinId, site, actor) {
  const jobs = await trx('jobs').where({ checkin_id: checkinId }).whereIn('status', ACTIVE).select('id');
  if (!jobs.length) return;
  await trx('jobs').whereIn('id', jobs.map((j) => j.id)).update({ site_id: site.id });
  for (const { id } of jobs) await audit(trx, actor, { entity: 'job', id, action: 'job_moved', summary: `Moved to ${site.name} with the vehicle` });
}

// ---------- reading ----------

export async function getJob(id) {
  const job = await db('jobs as j')
    .join('customers as c', 'c.id', 'j.customer_id')
    .join('sites as s', 's.id', 'j.site_id')
    .leftJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .leftJoin('checkins as ci', 'ci.id', 'j.checkin_id')
    .leftJoin('proformas as p', 'p.id', 'j.proforma_id')
    .leftJoin('users as sup', 'sup.id', 'j.supervisor_id')
    .leftJoin('users as cr', 'cr.id', 'j.created_by')
    .leftJoin('users as ma', 'ma.id', 'j.materials_allowed_by')
    .leftJoin('job_types as jt', 'jt.id', 'j.job_type_id')
    .where('j.id', id)
    .first('j.*', 'c.name as customer_name', 'c.number as customer_number', 'c.phone as customer_phone', 's.name as site_name',
      'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model', 'v.type', 'v.colour',
      'ci.number as checkin_number', 'ci.status as checkin_status', 'ci.odometer_km', 'ci.odometer_not_working',
      'p.number as proforma_number', 'jt.name as job_type_name', 'sup.name as supervisor_name', 'cr.name as created_name', 'ma.name as materials_allowed_name');
  if (!job) return null;
  // A proforma made from the job, still with the customer (draft or sent).
  job.pending_proforma = job.proforma_id ? null
    : await db('proformas').where({ for_job_id: id }).whereIn('status', ['draft', 'sent']).orderBy('id', 'desc').first('id', 'number', 'status') ?? null;
  // An open job whose vehicle is in the workshop always shows that check-in, even if the link was
  // missed (the job was opened, reopened or given its vehicle in an order the links didn't follow).
  // The link is put right here too, so lists and the job card agree.
  const linkedIsOpen = ['in_workshop', 'released'].includes(job.checkin_status);
  if (ACTIVE.includes(job.status) && job.vehicle_id && !linkedIsOpen) {
    const now = await db('checkins').where({ vehicle_id: job.vehicle_id }).whereIn('status', ['in_workshop', 'released'])
      .orderBy('id', 'desc').first('id', 'number', 'status', 'odometer_km', 'odometer_not_working');
    if (now) {
      await db('jobs').where({ id: job.id }).update({ checkin_id: now.id });
      Object.assign(job, { checkin_id: now.id, checkin_number: now.number, checkin_status: now.status, odometer_km: now.odometer_km, odometer_not_working: now.odometer_not_working });
    }
  }
  job.vehicle_label = job.vehicle_id ? vehicleLabel(job) : null;
  job.lines = await db('job_lines').where({ job_id: id }).orderBy('sort_order');
  job.steps = await db('job_steps as s').leftJoin('users as u', 'u.id', 's.finished_by')
    .leftJoin('qc_inspections as rq', 'rq.id', 's.rework_qc_id')
    .leftJoin('customer_signoffs as rs', 'rs.id', 's.rework_signoff_id')
    .where('s.job_id', id).orderBy('s.sort_order')
    .select('s.id', 's.name', 's.status', 's.is_receive', 's.is_qc', 's.is_signoff', 's.finished_at', 'u.name as finished_by_name', 's.rework_qc_id', 'rq.number as rework_qc_number',
      's.rework_signoff_id', 'rs.concerns as rework_concerns', 'rs.signer_name as rework_signer_name');
  // A step a failed quality check sent back: what to put right there.
  const reworked = job.steps.filter((s) => s.rework_qc_id && s.status === 'pending');
  if (reworked.length) {
    const items = await db('qc_inspection_items').whereIn('redo_step_id', reworked.map((s) => s.id)).whereIn('inspection_id', reworked.map((s) => s.rework_qc_id))
      .where('result', 'fail').orderBy('sort_order').select('id', 'inspection_id', 'redo_step_id', 'text', 'note');
    for (const s of reworked) s.rework = items.filter((i) => i.redo_step_id === s.id && i.inspection_id === s.rework_qc_id);
  }
  job.currentStep = job.status === 'in_progress' ? job.steps.find((s) => s.status === 'pending') ?? null : null;
  job.stepsFinished = job.steps.filter((s) => s.status !== 'pending').length;
  return job;
}

function tabFilter(q, tab) {
  if (tab === 'active') q.whereIn('j.status', ACTIVE);
  else if (tab !== 'all') q.where('j.status', tab);
}

/** One site's jobs on a tab; a search looks through every site in `searchSiteIds`. */
export async function listJobs({ siteId, searchSiteIds = [siteId], tab = 'active', q = '' }) {
  const query = db('jobs as j')
    .join('customers as c', 'c.id', 'j.customer_id')
    .join('sites as s', 's.id', 'j.site_id')
    .leftJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .leftJoin('users as sup', 'sup.id', 'j.supervisor_id')
    .limit(200)
    .select('j.id', 'j.number', 'j.status', 'j.due_on', 'j.vehicle_description', 'j.completed_at', 'j.created_at',
      'c.name as customer_name', 'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model', 's.name as site_name', 'sup.name as supervisor_name',
      db('job_lines').where('job_id', db.ref('j.id')).orderBy('sort_order').limit(1).select('description').as('first_line'),
      db('job_steps').where({ job_id: db.ref('j.id'), status: 'pending' }).orderBy('sort_order').limit(1).select('name').as('current_step'),
      db('job_steps').where('job_id', db.ref('j.id')).whereNot('status', 'pending').count('*').as('steps_finished'),
      db('job_steps').where('job_id', db.ref('j.id')).count('*').as('steps_total'));
  const term = q.trim();
  if (term) {
    const key = compact(term);
    query.whereIn('j.site_id', searchSiteIds).where((w) => {
      w.where('j.number', 'like', `%${term}%`).orWhere('c.name', 'like', `%${term}%`)
        .orWhereExists(db('job_lines as l').whereRaw('l.job_id = j.id').where('l.description', 'like', `%${term}%`));
      if (key) w.orWhereRaw("REPLACE(`v`.`reg_no`, ' ', '') LIKE ?", [`%${key}%`]).orWhere('v.chassis_no', 'like', `%${key}%`);
    }).orderBy('j.id', 'desc');
  } else {
    query.where('j.site_id', siteId);
    tabFilter(query, tab);
    // Active: what is promised soonest comes first; nothing promised goes last.
    if (tab === 'active') query.orderByRaw('`j`.`due_on` IS NULL, `j`.`due_on`, `j`.`id`');
    else if (tab === 'completed') query.orderBy('j.completed_at', 'desc');
    else query.orderBy('j.id', 'desc');
  }
  return (await query).map((j) => ({ ...j, vehicle_label: j.reg_no || j.chassis_no || j.temp_tag ? vehicleLabel(j) : null }));
}

export async function countByTab(siteId) {
  return countTabs(TABS, (tab) => { const q = db('jobs as j').where('j.site_id', siteId); tabFilter(q, tab); return q; });
}

/**
 * Accepted proformas with no job yet, for the jobs page. Prices stay on the proforma.
 * `vehicle_site_id` is where its vehicle is checked in (null: not checked in, or no vehicle on file).
 */
export function waitingProformas(siteIds) {
  return db('proformas as p')
    .join('customers as c', 'c.id', 'p.customer_id')
    .leftJoin('jobs as j', 'j.proforma_id', 'p.id')
    .leftJoin('vehicles as v', 'v.id', 'p.vehicle_id')
    .leftJoin('checkins as ck', (q) => q.on('ck.vehicle_id', 'p.vehicle_id').andOnVal('ck.status', 'in_workshop'))
    .where('p.status', 'accepted').whereNull('j.id')
    .where((w) => w.whereIn('p.site_id', siteIds).orWhereNull('p.site_id'))
    .orderBy('p.closed_at').limit(20)
    .select('p.id', 'p.number', 'p.closed_at', 'c.name as customer_name', 'p.vehicle_id', 'ck.site_id as vehicle_site_id',
      'v.reg_no', 'v.chassis_no', 'v.temp_tag',
      db('proforma_lines').where('proforma_id', db.ref('p.id')).orderBy('sort_order').limit(1).select('description').as('first_line'));
}

/** Top-bar search: by job number, at the user's sites. */
export function findByNumber(term, siteIds, limit) {
  const text = term.trim();
  if (text.length < 2) return [];
  return db('jobs as j').join('customers as c', 'c.id', 'j.customer_id')
    .whereIn('j.site_id', siteIds).where('j.number', 'like', `%${text}%`)
    .orderBy('j.id', 'desc').limit(limit)
    .select('j.id', 'j.number', 'j.status', 'c.name as customer_name');
}

const brief = (q) => q.orderBy('id', 'desc').select('id', 'number', 'status', 'site_id', 'due_on');

/** A vehicle's jobs, newest first. */
export const forVehicle = (vehicleId) => brief(db('jobs').where({ vehicle_id: vehicleId }));

/** The jobs linked to one check-in, newest first. */
export const forCheckin = (checkinId) => brief(db('jobs').where({ checkin_id: checkinId }));
