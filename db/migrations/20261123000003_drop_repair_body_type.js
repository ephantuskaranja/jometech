// "Repair / modification" is no longer a body type on enquiries: the enquiry type
// (20261123000002) now says whether it is fabrication, repair or modification.
// Switched off rather than deleted; enquiries that used it keep the words.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex('enquiry_work_types').where({ name: 'Repair / modification' }).update({ is_active: false });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex('enquiry_work_types').where({ name: 'Repair / modification' }).update({ is_active: true });
}
