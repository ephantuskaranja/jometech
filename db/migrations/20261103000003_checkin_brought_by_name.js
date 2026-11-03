// "Brought in by" can be anyone, not only a saved contact person: when the name
// typed isn't a contact, it is kept on the check-in itself (not added to a customer).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('checkins', (t) => {
    t.string('brought_by_name', 100).nullable().after('contact_id');
    t.string('brought_by_phone', 20).nullable().after('brought_by_name');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('checkins', (t) => {
    t.dropColumn('brought_by_phone');
    t.dropColumn('brought_by_name');
  });
}
