import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Vehicle release: how a check-in ends.
//
//   checkins ──1 vehicle_releases     who collected it (name, phone, signature on the device) and who let it go
//
// Before release, a checklist: the visit's jobs completed, invoiced and fully paid. If something is
// still open (usually money owed), a manager or admin allows the release with a reason, recorded on
// the check-in; the gate can't override it. The release note (RN-2026-0001) is printed from the release.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('checkins', (t) => {
    t.datetime('release_allowed_at').nullable();
    t.integer('release_allowed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('release_allowed_reason', 255).nullable();                    // "On credit: Co-op Bank paying by 30 Nov"
  });

  await knex.schema.createTable('vehicle_releases', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // RN-2026-0001
    t.integer('checkin_id').unsigned().notNullable().unique().references('checkins.id').onDelete('CASCADE');
    t.string('collector_name', 100).notNullable();
    t.string('collector_phone', 20).nullable();
    t.string('collector_id_no', 20).nullable();
    t.string('signature_path', 255).notNullable();                         // storage/signatures/YYYY/MM/…png
    t.text('checklist').notNullable();                                     // JSON: what the checklist said at release
    t.boolean('on_approval').notNullable().defaultTo(false);               // released with a manager's approval
    t.integer('released_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('vehicle_releases');
  await knex.schema.alterTable('checkins', (t) => {
    t.dropForeign('release_allowed_by');
    t.dropColumn('release_allowed_at');
    t.dropColumn('release_allowed_by');
    t.dropColumn('release_allowed_reason');
  });
  await knex('number_sequences').where({ seq_key: 'RN' }).delete();
}
