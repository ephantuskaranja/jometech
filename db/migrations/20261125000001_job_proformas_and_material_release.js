// Sheet row 49, part B (2026-11-25): the job can come first, and stores wait for the price.
//
//   proformas.for_job_id         a proforma made from a running job. Accepted, it becomes that job's
//                                proforma (jobs.proforma_id) instead of opening a second job.
//   jobs.materials_allowed_*     stores issue materials to a job only once its proforma is accepted,
//                                or when a supervisor (or above) allows it early, saying why.
//
// Jobs already there with no proforma keep getting materials: they are marked as allowed, since
// they were opened before the rule.

const BEFORE_RULE = 'Opened before materials waited for an accepted proforma';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('proformas', (t) => {
    t.integer('for_job_id').unsigned().nullable().after('enquiry_id').references('jobs.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('jobs', (t) => {
    t.datetime('materials_allowed_at').nullable();
    t.integer('materials_allowed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('materials_allowed_reason', 255).nullable();
  });
  await knex('jobs').whereNull('proforma_id').update({ materials_allowed_at: knex.fn.now(), materials_allowed_reason: BEFORE_RULE });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('jobs', (t) => {
    t.dropForeign('materials_allowed_by');
    t.dropColumn('materials_allowed_by');
    t.dropColumn('materials_allowed_at');
    t.dropColumn('materials_allowed_reason');
  });
  await knex.schema.alterTable('proformas', (t) => {
    t.dropForeign('for_job_id');
    t.dropColumn('for_job_id');
  });
}
