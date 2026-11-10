// The gate clears visitors out once reception has received them. When nobody is at reception,
// the guard may still clear a visitor out, giving a reason: kept here and shown wherever the visit is.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('visitors', (t) => {
    t.string('override_reason', 255).nullable().after('cleared_by'); // set: cleared out without being received
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('visitors', (t) => t.dropColumn('override_reason'));
}
