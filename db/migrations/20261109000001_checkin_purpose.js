// Why a vehicle came in (fabrication, repairs, delivery, a meeting …): a fixed list in
// src/modules/checkins/service.js (PURPOSES), separate from job types because many visits are
// not workshop jobs. Required on new check-ins; older ones stay empty.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('checkins', (t) => {
    t.string('purpose', 20).nullable().after('vehicle_id');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('checkins', (t) => t.dropColumn('purpose'));
}
