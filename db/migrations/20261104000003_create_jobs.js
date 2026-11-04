import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Jobs: the work the workshop does for a customer, printed as a job card.
//
//   jobs ──< job_lines     qty, unit, description (no prices: the proforma keeps those)
//
//   open ──▶ in_progress ──▶ completed
//     └───────────┴────────▶ cancelled      (completed or cancelled can be reopened)
//
// A job can start from an accepted proforma (one job per proforma) or with no proforma.
// The vehicle is optional at first: it may not have arrived yet.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('jobs', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // JOB-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.integer('proforma_id').unsigned().nullable().unique().references('proformas.id').onDelete('SET NULL');
    t.integer('customer_id').unsigned().notNullable().references('customers.id');
    t.integer('vehicle_id').unsigned().nullable().references('vehicles.id').onDelete('SET NULL');
    t.string('vehicle_description', 150).nullable();                       // until the vehicle is registered
    t.integer('checkin_id').unsigned().nullable().references('checkins.id').onDelete('SET NULL');
    t.integer('supervisor_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.date('due_on').nullable();                                           // promised to the customer
    t.text('instructions').nullable();
    t.enum('status', ['open', 'in_progress', 'completed', 'cancelled']).notNullable().defaultTo('open');
    t.datetime('started_at').nullable();
    t.datetime('completed_at').nullable();
    t.datetime('cancelled_at').nullable();
    t.string('cancelled_reason', 255).nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['site_id', 'status']);
    t.index(['customer_id']);
    t.index(['vehicle_id']);
  });

  await knex.schema.createTable('job_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('job_id').unsigned().notNullable().references('jobs.id').onDelete('CASCADE');
    t.smallint('sort_order').unsigned().notNullable();
    t.decimal('quantity', 10, 2).notNullable().defaultTo(1);
    t.string('unit', 20).notNullable().defaultTo('Unit');
    t.text('description').notNullable();
    t.index(['job_id', 'sort_order']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('job_lines');
  await knex.schema.dropTable('jobs');
  await knex('number_sequences').where({ seq_key: 'JOB' }).delete();
}
