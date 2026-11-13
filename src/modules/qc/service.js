import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { passQcStep } from '../jobs/service.js';

// Quality checks. A job at its quality check step is inspected against the checklist
// (copied into the inspection, so later checklist edits don't change it): each item
// Pass, Fail or N/A, with a note for every failure.
//
//   in_progress ──▶ passed     (ticks off the job's quality check step)
//               ├─▶ failed     (put right, then a new inspection: attempt 2, 3 …)
//               └─▶ cancelled  (started by mistake)

export const STATUSES = {
  in_progress: { label: 'In progress', tone: 'info' },
  passed: { label: 'Passed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
export const RESULTS = { pass: 'Pass', fail: 'Fail', na: 'N/A' };

// ---------- the checklist (System → Quality checklist) ----------

/** Sections in order, each with its items in order. */
export async function checklist(q = db) {
  const sections = await q('qc_checklist_sections').orderBy('sort_order').select('id', 'name', 'rework_step');
  const items = await q('qc_checklist_items').orderBy('sort_order').select('section_id', 'text');
  return sections.map((s) => ({ ...s, items: items.filter((i) => i.section_id === s.id).map((i) => i.text) }));
}

const asText = (list) => list.map((s) => `${s.name}${s.rework_step ? ` (redo at ${s.rework_step})` : ''}: ${s.items.join('; ')}`);

/** Replaces the whole checklist. Inspections keep their own copy, so nothing old changes. */
export async function saveChecklist(sections, actor) {
  await db.transaction(async (trx) => {
    const before = await checklist(trx);
    await trx('qc_checklist_sections').delete(); // items go with them
    for (const [i, s] of sections.entries()) {
      const [id] = await trx('qc_checklist_sections').insert({ sort_order: i + 1, name: s.name, rework_step: s.rework_step || null });
      await trx('qc_checklist_items').insert(s.items.map((text, j) => ({ section_id: id, sort_order: j + 1, text })));
    }
    await audit(trx, actor, { entity: 'qc_checklist', id: 0, action: 'update', before: { checklist: asText(before) }, after: { checklist: asText(sections) } });
  });
}

/** Every step name in the active job types: what a section may suggest redoing. */
export async function stepNameOptions() {
  return db('job_type_steps as s').join('job_types as t', 't.id', 's.job_type_id').where('t.is_active', true)
    .distinct('s.name').orderBy('s.name').pluck('s.name');
}

// ---------- inspections ----------

async function lockInspection(trx, id) {
  const insp = await trx('qc_inspections').where({ id }).forUpdate().first();
  if (!insp) throw httpError(404, 'That quality check doesn’t exist.');
  return insp;
}

/** The job's open inspection, or a new one copied from today's checklist. Only at the job's quality check step. */
export async function startInspection(jobId, actor) {
  return db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    const open = await trx('qc_inspections').where({ job_id: jobId, status: 'in_progress' }).first('id', 'number');
    if (open) return { ...open, resumed: true };
    if (job.status !== 'in_progress') throw httpError(409, `${job.number} isn’t in progress, so it can’t be inspected.`);
    const step = await trx('job_steps').where({ job_id: jobId, status: 'pending' }).orderBy('sort_order').first();
    if (!step?.is_qc) throw httpError(409, `${job.number} isn’t at its quality check step yet${step ? ` (it is at ${step.name})` : ''}.`);

    const sections = await checklist(trx);
    if (!sections.length) throw httpError(409, 'The quality checklist is empty. An admin sets it up under System → Quality checklist.');
    const [{ n }] = await trx('qc_inspections').where({ job_id: jobId }).whereNot({ status: 'cancelled' }).count({ n: '*' });
    const number = await nextNumber(trx, 'qc');
    const [id] = await trx('qc_inspections').insert({ number, job_id: jobId, attempt: Number(n) + 1, started_by: actor.user.id });
    let order = 0;
    await trx('qc_inspection_items').insert(sections.flatMap((s) => s.items.map((text) => ({
      inspection_id: id, sort_order: ++order, section: s.name, text, rework_step: s.rework_step,
    }))));
    await audit(trx, actor, { entity: 'job', id: jobId, action: 'qc_started', summary: `Quality check ${number} started` });
    await audit(trx, actor, { entity: 'qc', id, action: 'qc_started', summary: `${number} for ${job.number}` });
    return { id, number, resumed: false };
  });
}

/**
 * Saves the answers. `answers`: { [itemId]: { result: 'pass'|'fail'|'na'|'', note } }.
 * With `finish`, every item must be answered and every failure explained: then it passes
 * (ticking off the job's step) or fails.
 * @returns {Promise<{ status: string, missing?: number[], unexplained?: number[], step?: object }>}
 */
export async function saveInspection(id, answers, remarks, actor, { finish = false } = {}) {
  return db.transaction(async (trx) => {
    const insp = await lockInspection(trx, id);
    if (insp.status !== 'in_progress') throw httpError(409, `${insp.number} is already ${STATUSES[insp.status].label.toLowerCase()}.`);
    const items = await trx('qc_inspection_items').where({ inspection_id: id }).orderBy('sort_order');
    for (const item of items) {
      const a = answers[item.id] ?? {};
      const result = ['pass', 'fail', 'na'].includes(a.result) ? a.result : null;
      const note = String(a.note ?? '').trim().slice(0, 255) || null;
      if (result !== item.result || note !== item.note) {
        await trx('qc_inspection_items').where({ id: item.id }).update({ result, note });
        Object.assign(item, { result, note });
      }
    }
    await trx('qc_inspections').where({ id }).update({ remarks: String(remarks ?? '').trim().slice(0, 1000) || null });
    if (!finish) return { status: 'in_progress' };

    const missing = items.filter((i) => !i.result).map((i) => i.id);
    const unexplained = items.filter((i) => i.result === 'fail' && !i.note).map((i) => i.id);
    if (missing.length || unexplained.length) return { status: 'in_progress', missing, unexplained };

    const failed = items.filter((i) => i.result === 'fail');
    const status = failed.length ? 'failed' : 'passed';
    await trx('qc_inspections').where({ id }).update({ status, finished_by: actor.user.id, finished_at: trx.fn.now() });
    const summary = failed.length ? `${insp.number} failed: ${failed.map((i) => i.text).join('; ')}`.slice(0, 1000) : `${insp.number} passed`;
    await audit(trx, actor, { entity: 'qc', id, action: `qc_${status}`, summary });
    await audit(trx, actor, { entity: 'job', id: insp.job_id, action: `qc_${status}`, summary });
    const step = status === 'passed' ? await passQcStep(trx, insp.job_id, actor) : null;
    return { status, step, failed: failed.length };
  });
}

/** Started by mistake: set aside (kept, marked cancelled). */
export async function cancelInspection(id, actor) {
  return db.transaction(async (trx) => {
    const insp = await lockInspection(trx, id);
    if (insp.status !== 'in_progress') throw httpError(409, `${insp.number} is already ${STATUSES[insp.status].label.toLowerCase()}.`);
    await trx('qc_inspections').where({ id }).update({ status: 'cancelled', finished_by: actor.user.id, finished_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'qc', id, action: 'qc_cancelled', summary: `${insp.number} cancelled` });
    await audit(trx, actor, { entity: 'job', id: insp.job_id, action: 'qc_cancelled', summary: `Quality check ${insp.number} cancelled` });
    return insp;
  });
}

// ---------- reading ----------

const COLUMNS = ['q.*', 'j.number as job_number', 'j.site_id', 'j.status as job_status', 'c.name as customer_name',
  'v.reg_no', 'v.temp_tag', 'v.chassis_no', 'v.make', 'v.model', 'j.vehicle_description', 'jt.name as job_type_name',
  's.name as site_name', 'sb.name as started_by_name', 'fb.name as finished_by_name', 'sup.name as supervisor_name'];
const withJob = (q) => q.join('jobs as j', 'j.id', 'q.job_id').join('customers as c', 'c.id', 'j.customer_id').join('sites as s', 's.id', 'j.site_id')
  .leftJoin('vehicles as v', 'v.id', 'j.vehicle_id').leftJoin('job_types as jt', 'jt.id', 'j.job_type_id')
  .leftJoin('users as sb', 'sb.id', 'q.started_by').leftJoin('users as fb', 'fb.id', 'q.finished_by').leftJoin('users as sup', 'sup.id', 'j.supervisor_id');

export async function getInspection(id) {
  const insp = await withJob(db('qc_inspections as q')).where('q.id', id).first(COLUMNS);
  if (!insp) return null;
  insp.items = await db('qc_inspection_items').where({ inspection_id: id }).orderBy('sort_order');
  insp.sections = [];
  for (const item of insp.items) {
    let section = insp.sections.at(-1);
    if (section?.name !== item.section) insp.sections.push(section = { name: item.section, items: [] });
    section.items.push(item);
  }
  insp.counts = Object.fromEntries(['pass', 'fail', 'na'].map((r) => [r, insp.items.filter((i) => i.result === r).length]));
  insp.counts.open = insp.items.filter((i) => !i.result).length;
  return insp;
}

/** A job's inspections, newest first. */
export function forJob(jobId) {
  return db('qc_inspections as q').leftJoin('users as fb', 'fb.id', 'q.finished_by').leftJoin('users as sb', 'sb.id', 'q.started_by')
    .where('q.job_id', jobId).orderBy('q.id', 'desc')
    .select('q.id', 'q.number', 'q.attempt', 'q.status', 'q.started_at', 'q.finished_at', 'fb.name as finished_by_name', 'sb.name as started_by_name',
      db('qc_inspection_items').where('inspection_id', db.ref('q.id')).where('result', 'fail').count('*').as('failed'));
}

/** Jobs at a site waiting at their quality check step, with the inspection under way if any. */
export function waiting(siteId) {
  const current = db('job_steps').where('job_id', db.ref('j.id')).where('status', 'pending').orderBy('sort_order').limit(1);
  return db('jobs as j').join('customers as c', 'c.id', 'j.customer_id').leftJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .where({ 'j.site_id': siteId, 'j.status': 'in_progress' })
    .whereRaw('(?) = 1', [current.clone().select('is_qc')])
    .orderBy('j.due_on').orderBy('j.id')
    .select('j.id', 'j.number', 'j.due_on', 'c.name as customer_name', 'v.reg_no', 'v.temp_tag', 'j.vehicle_description',
      db('qc_inspections').where('job_id', db.ref('j.id')).where('status', 'in_progress').limit(1).select('id').as('open_id'),
      db('qc_inspections').where('job_id', db.ref('j.id')).where('status', 'failed').count('*').as('failed_before'));
}

/** Finished inspections at a site, newest first. */
export function recent(siteId, limit = 100) {
  return withJob(db('qc_inspections as q')).where('j.site_id', siteId).whereIn('q.status', ['passed', 'failed'])
    .orderBy('q.finished_at', 'desc').limit(limit).select(COLUMNS);
}
