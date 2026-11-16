import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Variations: extra work the customer agrees after the job was priced (V1, V2 … on each job).
// Recorded by sales, managers and admins with its price (VAT included, as on proformas) and who
// agreed it; the workshop sees the work without the price. Agreed variations go on the invoice and
// count towards what is owed and the job's price in costing. Cancelled ones are kept, with a reason.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('job_variations', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('job_id').unsigned().notNullable().references('jobs.id').onDelete('CASCADE');
    t.smallint('seq').unsigned().notNullable();                            // V1, V2 … within the job
    t.string('description', 1000).notNullable();
    t.decimal('quantity', 12, 3).notNullable().defaultTo(1);
    t.string('unit', 20).notNullable().defaultTo('Unit');
    t.decimal('unit_price', 14, 2).notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.string('agreed_by', 100).notNullable();                              // the customer's person who agreed
    t.date('agreed_on').notNullable();
    t.enum('status', ['agreed', 'cancelled']).notNullable().defaultTo('agreed');
    t.string('cancelled_reason', 255).nullable();
    t.datetime('cancelled_at').nullable();
    t.integer('cancelled_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.unique(['job_id', 'seq']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('job_variations');
}
