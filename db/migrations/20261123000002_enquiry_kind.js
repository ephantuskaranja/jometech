// Enquiry type (issues sheet row 47): Fabrication, Repair Works, Modification or General enquiry,
// for reporting (src/core/work-kinds.js, the same list as the check-in's purpose). The quick picks
// already there (Tipper, Dropside …) stay as the body type, which a general enquiry may leave out.
// Enquiries taken before this have no type ("Not recorded" in reports).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('enquiries', (t) => {
    t.string('kind', 20).nullable().after('vehicle_description');
    t.string('work_type', 60).nullable().alter();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex('enquiries').whereNull('work_type').update({ work_type: 'Other' });
  await knex.schema.alterTable('enquiries', (t) => {
    t.dropColumn('kind');
    t.string('work_type', 60).notNullable().alter();
  });
}
