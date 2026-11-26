// Sheet row 56 (2026-11-26): after an import the page leads on to the next step (set each machine's
// site, link clock IDs, then mark the day). That is about the machines in that file, so the import
// remembers them, even when the same file comes twice and adds no new punches.
//
//   attendance_imports.device_ids   the file's machines (clock_devices ids), comma separated; null for older imports

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('attendance_imports', (t) => {
    t.string('device_ids', 255).nullable().after('last_day');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('attendance_imports', (t) => {
    t.dropColumn('device_ids');
  });
}
