// Follows 20261121000002: quality checklist sections that suggested Cutting, Frame Fabrication,
// Welding, Grinding or Assembly as the step to redo failed work now suggest the one Fabrication
// step, so a failed item is put right there again. Only where some job type has that step.
//
// Not undone on rollback: an admin may have changed the checklist since.

const FABRICATION = 'Fabrication (cutting, frame, welding, assembly, grinding)';
const PARTS = ['cutting', 'frame fabrication', 'welding', 'grinding', 'assembly'];

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const used = await knex('job_type_steps').where({ name: FABRICATION }).first('id');
  if (!used) return;
  await knex('qc_checklist_sections')
    .whereIn(knex.raw('LOWER(TRIM(rework_step))'), PARTS)
    .update({ rework_step: FABRICATION });
}

/** @param {import('knex').Knex} knex */
export async function down() {}
