import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';

// Job types and their production steps, kept by an admin under System.
// A job copies the list when it is made, so changes here only affect jobs made afterwards.

const err = (message, field) => Object.assign(httpError(422, message), { field });
const stepsText = (names) => names.join(' → ');

/** Active types with how many steps each has; the default first. */
export function listTypes() {
  return db('job_types as t').where('t.is_active', true)
    .orderBy('t.is_default', 'desc').orderBy('t.id')
    .select('t.id', 't.name', 't.is_default',
      db('job_type_steps').where('job_type_id', db.ref('t.id')).count('*').as('step_count'));
}

/** For dropdowns. */
export async function typeOptions() {
  return (await listTypes()).map((t) => ({ value: t.id, label: t.name, is_default: Boolean(t.is_default) }));
}

export const stepNames = (q, id) => q('job_type_steps').where({ job_type_id: id }).orderBy('sort_order').pluck('name');

export async function getType(id) {
  const type = await db('job_types').where({ id, is_active: true }).first();
  if (!type) return null;
  type.steps = await stepNames(db, id);
  return type;
}

async function nameTaken(trx, name, exceptId) {
  const q = trx('job_types').where({ name, is_active: true });
  if (exceptId) q.whereNot({ id: exceptId });
  return Boolean(await q.first('id'));
}

async function writeSteps(trx, id, steps) {
  await trx('job_type_steps').where({ job_type_id: id }).delete();
  await trx('job_type_steps').insert(steps.map((name, i) => ({ job_type_id: id, sort_order: i + 1, name })));
}

/** @returns {Promise<number>} */
export async function createType({ name, is_default, steps, qc_step = null }, actor) {
  return db.transaction(async (trx) => {
    if (await nameTaken(trx, name)) throw err('There is already a job type with this name', 'name');
    if (is_default) await trx('job_types').update({ is_default: false });
    const [id] = await trx('job_types').insert({ name, is_default, qc_step });
    await writeSteps(trx, id, steps);
    await audit(trx, actor, { entity: 'job_type', id, action: 'create', summary: stepsText(steps) });
    return id;
  });
}

/** Ticking "default" moves it here. It can't be unticked: one type must always be the default. */
export async function updateType(id, { name, is_default, steps, qc_step = null }, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('job_types').where({ id, is_active: true }).forUpdate().first();
    if (!before) throw httpError(404, 'That job type doesn’t exist.');
    if (await nameTaken(trx, name, id)) throw err('There is already a job type with this name', 'name');
    const beforeSteps = await stepNames(trx, id);
    const makeDefault = Boolean(before.is_default) || is_default;
    if (makeDefault && !before.is_default) await trx('job_types').whereNot({ id }).update({ is_default: false });
    await trx('job_types').where({ id }).update({ name, is_default: makeDefault, qc_step });
    await writeSteps(trx, id, steps);
    await audit(trx, actor, {
      entity: 'job_type', id, action: 'update',
      before: { name: before.name, default: Boolean(before.is_default), steps: stepsText(beforeSteps), qc_step: before.qc_step ?? 'None' },
      after: { name, default: makeDefault, steps: stepsText(steps), qc_step: qc_step ?? 'None' },
    });
  });
}

/** Switched off, not deleted: jobs already made keep their steps and the type's name. */
export async function removeType(id, actor) {
  await db.transaction(async (trx) => {
    const type = await trx('job_types').where({ id, is_active: true }).forUpdate().first();
    if (!type) throw httpError(404, 'That job type doesn’t exist.');
    if (type.is_default) throw httpError(409, `“${type.name}” is the default job type. Make another type the default first.`);
    await trx('job_types').where({ id }).update({ is_active: false });
    await audit(trx, actor, { entity: 'job_type', id, action: 'delete', summary: type.name });
  });
}
