import { db } from '../../core/db.js';
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
  return {
    customer: customer?.name,
    vehicle: vehicle ? vehicleLabel(vehicle) : job.vehicle_description ?? null,
    supervisor: supervisor?.name ?? null,
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
    const number = await nextNumber(trx, 'job');
    const [id] = await trx('jobs').insert({
      number, site_id: siteId, customer_id: input.customer_id, vehicle_id: input.vehicle_id, vehicle_description: input.vehicle_description,
      checkin_id: checkin?.id ?? null, supervisor_id: input.supervisor_id, due_on: input.due_on, instructions: input.instructions, created_by: actor.user.id,
    });
    await writeLines(trx, id, input.lines);
    await audit(trx, actor, { entity: 'job', id, action: 'create', summary: 'No proforma' });
    return { id, number };
  });
}

/**
 * One click on an accepted proforma. Asking twice (a double click, two people) gives the same job.
 * @returns {Promise<{ id: number, number: string, site_id: number, existed: boolean }>}
 */
export async function createFromProforma(proformaId, actor) {
  return db.transaction(async (trx) => {
    const p = await trx('proformas').where({ id: proformaId }).forUpdate().first();
    if (!p) throw httpError(404, 'That proforma doesn’t exist.');
    const existing = await trx('jobs').where({ proforma_id: p.id }).first('id', 'number', 'site_id');
    if (existing) return { ...existing, existed: true };
    if (p.status !== 'accepted') throw httpError(409, `Only an accepted proforma can become a job. ${p.number} hasn’t been accepted.`);

    const checkin = await openCheckin(trx, p.vehicle_id);
    const siteId = checkin?.site_id ?? actor.site.id;
    const number = await nextNumber(trx, 'job');
    const [id] = await trx('jobs').insert({
      number, site_id: siteId, proforma_id: p.id, customer_id: p.customer_id, vehicle_id: p.vehicle_id, vehicle_description: p.vehicle_description,
      checkin_id: checkin?.id ?? null, created_by: actor.user.id,
    });
    await writeLines(trx, id, await trx('proforma_lines').where({ proforma_id: p.id }).orderBy('sort_order'));
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

    const beforeLines = await trx('job_lines').where({ job_id: id }).orderBy('sort_order');
    const lines = fixed ? beforeLines : input.lines;
    const changes = {
      customer_id: customerId, vehicle_id: input.vehicle_id, vehicle_description: input.vehicle_description,
      supervisor_id: input.supervisor_id, due_on: input.due_on, instructions: input.instructions, site_id: siteId,
      ...(vehicleChanged ? { checkin_id: checkin?.id ?? null } : {}),
    };
    await trx('jobs').where({ id }).update(changes);
    if (!fixed) await writeLines(trx, id, lines);
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
    await trx('jobs').where({ id }).update({ status: 'completed', completed_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'job', id, action: 'job_completed' });
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
    .where('j.id', id)
    .first('j.*', 'c.name as customer_name', 'c.number as customer_number', 'c.phone as customer_phone', 's.name as site_name',
      'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model', 'v.type', 'v.colour',
      'ci.number as checkin_number', 'ci.status as checkin_status', 'ci.odometer_km', 'ci.odometer_not_working',
      'p.number as proforma_number', 'sup.name as supervisor_name', 'cr.name as created_name');
  if (!job) return null;
  job.vehicle_label = job.vehicle_id ? vehicleLabel(job) : null;
  job.lines = await db('job_lines').where({ job_id: id }).orderBy('sort_order');
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
      db('job_lines').where('job_id', db.ref('j.id')).orderBy('sort_order').limit(1).select('description').as('first_line'));
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
  const counts = {};
  for (const tab of TABS) {
    const q = db('jobs as j').where('j.site_id', siteId);
    tabFilter(q, tab);
    counts[tab] = Number((await q.count({ n: '*' }))[0].n);
  }
  return counts;
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
