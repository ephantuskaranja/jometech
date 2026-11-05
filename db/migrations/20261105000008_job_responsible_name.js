// A job's responsible employee: whoever does or leads the work but doesn't use the app (a foreman,
// a welder), typed as a name. Optional, and separate from the supervisor, who is an app user.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('jobs', (t) => {
    t.string('responsible_name', 100).nullable().after('supervisor_id');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('jobs', (t) => t.dropColumn('responsible_name'));
}
