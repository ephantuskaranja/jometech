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
// The vehicle may come later. Its check-in links by itself, and the job follows it between sites.
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

/** The job's own copy of its type's steps. */
async function copySteps(trx, jobId, typeId) {
  await trx('job_steps').where({ job_id: jobId }).delete();
  if (!typeId) return;
  const steps = await trx('job_type_steps').where({ job_type_id: typeId }).orderBy('sort_order').pluck('name');
  if (steps.length) await trx('job_steps').insert(steps.map((name, i) => ({ job_id: jobId, sort_order: i + 1, name })));
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

/** A job with no proforma. @returns {Promise<{ id: number, number: string }>} */
export async function createJob(input, actor) {
  return db.transaction(async (trx) => {
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
export async function createFromProforma(proformaId, jobTypeId, actor) {
  return db.transaction(async (trx) => {
    const p = await trx('proformas').where({ id: proformaId }).forUpdate().first();
    if (!p) throw httpError(404, 'That proforma doesn’t exist.');
    const existing = await trx('jobs').where({ proforma_id: p.id }).first('id', 'number', 'site_id');
    if (existing) return { ...existing, existed: true };
    if (p.status !== 'accepted') throw httpError(409, `Only an accepted proforma can become a job. ${p.number} hasn’t been accepted.`);

    const checkin = await openCheckin(trx, p.vehicle_id);
    const siteId = checkin?.site_id ?? actor.site.id;
    const typeId = await resolveType(trx, jobTypeId);
    const number = await nextNumber(trx, 'job');
    const [id] = await trx('jobs').insert({
      number, site_id: siteId, job_type_id: typeId, proforma_id: p.id, customer_id: p.customer_id, vehicle_id: p.vehicle_id, vehicle_description: p.vehicle_description,
      checkin_id: checkin?.id ?? null, created_by: actor.user.id,
    });
    await writeLines(trx, id, await trx('proforma_lines').where({ proforma_id: p.id }).orderBy('sort_order'));
    await copySteps(trx, id, typeId);
    await audit(trx, actor, { entity: 'job', id, action: 'create', summary: `From proforma ${p.number}` });
    await audit(trx, actor, { entity: 'proforma', id: p.id, action: 'job_created', summary: `Job ${number}` });
    return { id, number, site_id: siteId, existed: false };
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
      customer_id: customerId, vehicle_id: input.vehicle_id, vehicle_description: input.vehicle_description,
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
const lastFinishedStep = (trx, jobId) => trx('job_steps').where({ job_id: jobId }).whereNot({ status: 'pending' }).orderBy('sort_order', 'desc').first();

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
    await trx('job_steps').where({ id: step.id }).update({ status, finished_at: trx.fn.now(), finished_by: actor.user.id });
    await audit(trx, actor, { entity: 'job', id: jobId, action: status === 'done' ? 'step_done' : 'step_skipped', summary: step.name });
    const next = await pendingStep(trx, jobId);
    if (!next) await markCompleted(trx, jobId, actor);
    return { name: step.name, next: next?.name ?? null };
  });
}

/** Ticked by mistake: the last finished step becomes the current one again. */
export async function undoStep(jobId, actor) {
  return db.transaction(async (trx) => {
    const job = await lockJob(trx, jobId);
    if (job.status !== 'in_progress') throw httpError(409, `${job.number} is ${STATUSES[job.status].label.toLowerCase()}.`);
    const step = await lastFinishedStep(trx, jobId);
    if (!step) throw httpError(409, 'No step has been ticked off yet.');
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
    await trx('jobs').where({ id }).update({
      status: job.started_at ? 'in_progress' : 'open', completed_at: null, cancelled_at: null, cancelled_reason: null,
    });
    await audit(trx, actor, { entity: 'job', id, action: 'reopened' });
  });
}

// ---------- called when the vehicle arrives or moves ----------

/** The vehicle was checked in: its active jobs link to this check-in and go to this site. */
export async function linkCheckin(trx, vehicleId, checkin, actor) {
  const jobs = await trx('jobs').where({ vehicle_id: vehicleId }).whereIn('status', ACTIVE).select('id');
  if (!jobs.length) return;
  await trx('jobs').whereIn('id', jobs.map((j) => j.id)).update({ checkin_id: checkin.id, site_id: checkin.site_id });
  for (const { id } of jobs) await audit(trx, actor, { entity: 'job', id, action: 'vehicle_arrived', summary: `Check-in ${checkin.number}` });
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
    .leftJoin('job_types as jt', 'jt.id', 'j.job_type_id')
    .where('j.id', id)
    .first('j.*', 'c.name as customer_name', 'c.number as customer_number', 'c.phone as customer_phone', 's.name as site_name',
      'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model', 'v.type', 'v.colour',
      'ci.number as checkin_number', 'ci.status as checkin_status', 'ci.odometer_km', 'ci.odometer_not_working',
      'p.number as proforma_number', 'jt.name as job_type_name', 'sup.name as supervisor_name', 'cr.name as created_name');
  if (!job) return null;
  job.vehicle_label = job.vehicle_id ? vehicleLabel(job) : null;
  job.lines = await db('job_lines').where({ job_id: id }).orderBy('sort_order');
  job.steps = await db('job_steps as s').leftJoin('users as u', 'u.id', 's.finished_by')
    .where('s.job_id', id).orderBy('s.sort_order').select('s.id', 's.name', 's.status', 's.finished_at', 'u.name as finished_by_name');
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

/** Accepted proformas with no job yet, for the jobs page. Prices stay on the proforma. */
export function waitingProformas(siteIds) {
  return db('proformas as p')
    .join('customers as c', 'c.id', 'p.customer_id')
    .leftJoin('jobs as j', 'j.proforma_id', 'p.id')
    .where('p.status', 'accepted').whereNull('j.id')
    .where((w) => w.whereIn('p.site_id', siteIds).orWhereNull('p.site_id'))
    .orderBy('p.closed_at').limit(20)
    .select('p.id', 'p.number', 'p.closed_at', 'c.name as customer_name',
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
