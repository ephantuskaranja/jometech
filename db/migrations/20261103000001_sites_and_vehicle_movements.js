import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Two sites (HQ and Site B, added by the seed) and vehicles moving between them.
//
//   checkins ──< vehicle_movements    sent from one site, then received at the other
//
// A movement is "in_transit" from the moment it is sent until the other site
// receives it; then the check-in's site_id changes to the new site.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // The starter site becomes HQ. Records already at it stay where they are (same id).
  await knex('sites').where({ code: 'MAIN' }).update({ code: 'HQ', name: 'HQ', address: 'Eastern Bypass, Ruai' });

  await knex.schema.createTable('vehicle_movements', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                       // MOV-2026-0001
    t.integer('checkin_id').unsigned().notNullable().references('checkins.id').onDelete('CASCADE');
    t.integer('vehicle_id').unsigned().notNullable().references('vehicles.id');
    t.integer('from_site_id').unsigned().notNullable().references('sites.id');
    t.integer('to_site_id').unsigned().notNullable().references('sites.id');
    t.enum('status', ['in_transit', 'received', 'cancelled']).notNullable().defaultTo('in_transit');
    // Leaving
    t.string('driver_name', 100).notNullable();
    t.string('driver_phone', 20).nullable();
    t.integer('odometer_out').unsigned().nullable();
    t.string('notes', 500).nullable();
    t.datetime('sent_at').notNullable().defaultTo(knex.fn.now());
    t.integer('sent_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    // Arriving
    t.datetime('received_at').nullable();
    t.integer('received_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('odometer_in').unsigned().nullable();
    t.string('receive_notes', 500).nullable();
    timestamps(t, knex);
    t.index(['status', 'to_site_id']);
    t.index(['checkin_id']);
  });
  await knex.raw('ALTER TABLE `vehicle_movements` ADD CONSTRAINT `vehicle_movements_two_sites` CHECK (`from_site_id` <> `to_site_id`)');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('vehicle_movements');
  await knex('sites').where({ code: 'HQ' }).update({ code: 'MAIN', name: 'Main workshop', address: null });
}
