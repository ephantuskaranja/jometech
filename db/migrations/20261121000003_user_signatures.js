// Staff keep their own signature (Account → My signature), drawn once and added to the documents
// they are responsible for: job cards, invoices, proformas, receiving and release notes, purchase orders.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('signature_path', 255).nullable();      // storage/signatures/… PNG
    t.datetime('signature_saved_at').nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('signature_path');
    t.dropColumn('signature_saved_at');
  });
}
