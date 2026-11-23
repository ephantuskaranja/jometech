import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Vehicles arriving at the gate (2026-11-23). The guard (or check-in staff) logs a customer's
// vehicle in: what it is, who drove it, why it came. The workshop's check-in is made from that
// arrival, so the gate has both ends of the visit (in here, out when released) and every vehicle
// on site is accounted for. A check-in without an arrival needs a reason (gate not manned …).
//
//   waiting ──▶ checked_in   (the check-in made from it)
//           └─▶ closed       (left without a check-in, logged by mistake …: with a reason)
//
// Vehicles moving between our own sites don't come through here: the receiving gate logs the
// movement in instead.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('vehicle_arrivals', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // ARR-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.string('vehicle_text', 60).notNullable();                            // as the guard typed it: KDA 123A, or "new Isuzu chassis"
    t.integer('vehicle_id').unsigned().nullable().references('vehicles.id').onDelete('SET NULL'); // when the plate is known
    t.string('driver_name', 100).notNullable();
    t.string('driver_phone', 20).nullable();
    t.string('purpose', 20).nullable();                                    // src/core/work-kinds.js PURPOSES
    t.string('note', 255).nullable();
    t.enum('status', ['waiting', 'checked_in', 'closed']).notNullable().defaultTo('waiting');
    t.datetime('arrived_at').notNullable().defaultTo(knex.fn.now());
    t.integer('logged_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('checkin_id').unsigned().nullable().references('checkins.id').onDelete('SET NULL');
    t.datetime('closed_at').nullable();
    t.integer('closed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('close_reason', 255).nullable();
    timestamps(t, knex);
    t.index(['site_id', 'status']);
  });
  await knex.schema.alterTable('checkins', (t) => {
    t.integer('arrival_id').unsigned().nullable().references('vehicle_arrivals.id').onDelete('SET NULL');
    t.string('no_arrival_reason', 255).nullable();                         // checked in without the gate logging it
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('checkins', (t) => {
    t.dropForeign(['arrival_id']);
    t.dropColumn('arrival_id');
    t.dropColumn('no_arrival_reason');
  });
  await knex.schema.dropTable('vehicle_arrivals');
  await knex('number_sequences').where({ seq_key: 'ARR' }).delete();
}
