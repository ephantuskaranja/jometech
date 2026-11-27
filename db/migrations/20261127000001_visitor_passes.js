import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Customer gate passes (sheet row 51 follow-up): a visitor on site at one yard is sent to the other
// (a customer's technician going to see their truck at Site B). Reception, a supervisor or a manager
// issues the pass from the visit; it can be printed for the visitor to carry, like the paper one.
//
//   open ──▶ (left_at: the sending gate cleared the visitor out) ──▶ arrived   (signed in at the other site: arrived_visitor_id)
//        └─▶ cancelled (with a reason, before they arrive)

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('visitor_passes', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                          // CGP-2026-0001
    t.integer('visitor_id').unsigned().notNullable().references('visitors.id'); // the visit they leave from
    t.integer('from_site_id').unsigned().notNullable().references('sites.id');
    t.integer('to_site_id').unsigned().notNullable().references('sites.id');
    t.string('name', 100).notNullable();
    t.string('phone', 20).notNullable();
    t.string('company', 120).nullable();
    t.string('purpose', 60).notNullable();
    t.string('host', 100).nullable();                                       // who they are going to see there
    t.integer('people').unsigned().notNullable().defaultTo(1);
    t.string('vehicle_reg', 20).nullable();
    t.string('notes', 500).nullable();
    t.enum('status', ['open', 'arrived', 'cancelled']).notNullable().defaultTo('open');
    t.datetime('issued_at').notNullable().defaultTo(knex.fn.now());
    t.integer('issued_by').unsigned().nullable().references('users.id').onDelete('SET NULL'); // "Approved by"
    t.datetime('left_at').nullable();
    t.integer('left_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('arrived_visitor_id').unsigned().nullable().references('visitors.id').onDelete('SET NULL');
    t.datetime('arrived_at').nullable();
    t.datetime('cancelled_at').nullable();
    t.integer('cancelled_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('cancel_reason', 255).nullable();
    timestamps(t, knex);
    t.index(['to_site_id', 'status']);
    t.index(['from_site_id', 'status']);
    t.index(['visitor_id']);
    t.index(['arrived_visitor_id']);
  });
  await knex.raw('ALTER TABLE `visitor_passes` ADD CONSTRAINT `visitor_passes_two_sites` CHECK (`from_site_id` <> `to_site_id`)');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('visitor_passes');
  await knex('number_sequences').where({ seq_key: 'CGP' }).delete();
}
