// Vehicle moves between sites: how many people travel in the vehicle (driver included), as on the
// paper gate pass. Moves sent before this count the driver only.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('vehicle_movements', (t) => {
    t.tinyint('people').unsigned().notNullable().defaultTo(1).after('driver_phone');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('vehicle_movements', (t) => t.dropColumn('people'));
}
