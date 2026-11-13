import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Expected visitors (issues sheet row 24). Reception, sales, supervisors (and managers, admins) book
// someone who is coming: the driver or main person, with the rest in the notes. The gate sees today's
// bookings and, when the person turns up, signs them in from the booking (the form comes filled in).
//
//   expected → arrived   (signed in at the gate or reception: visitor_id is the visit)
//            → cancelled (with a reason)
//   still expected after its day = no-show (worked out, not stored)

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('visitor_bookings', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // BKG-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.date('expected_on').notNullable();
    t.string('expected_time', 5).nullable();                               // '09:30', or none
    t.string('name', 100).notNullable();
    t.string('phone', 20).nullable();                                      // often not known yet (a driver)
    t.string('company', 120).nullable();
    t.string('purpose', 60).notNullable();
    t.string('host', 100).nullable();
    t.string('vehicle_reg', 20).nullable();
    t.string('notes', 500).nullable();                                     // others coming, delivery details
    t.enum('status', ['expected', 'arrived', 'cancelled']).notNullable().defaultTo('expected');
    t.integer('visitor_id').unsigned().nullable().references('visitors.id').onDelete('SET NULL');
    t.integer('booked_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('cancelled_at').nullable();
    t.integer('cancelled_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('cancel_reason', 255).nullable();
    timestamps(t, knex);
    t.index(['site_id', 'status', 'expected_on']);
    t.index(['visitor_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('visitor_bookings');
  await knex('number_sequences').where({ seq_key: 'BKG' }).delete();
}
