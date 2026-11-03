import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Proforma invoices (Jome-Tech's quotations), continuing the paper ones: 490, 491 …
//
// The first number comes from PROFORMA_FIRST_NUMBER in .env (see src/core/numbering.js).
//
//   proformas ──< proforma_lines     qty, unit, description (several lines, "- " bullets), price
//
//   draft ──▶ sent ──▶ accepted | declined
//               └──▶ replaced: "Revise" makes 490-R1, a copy to edit; 490 is kept as it was sent.
//
// Prices include VAT. Changes after a job starts will be variations (a later step).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('proformas', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                       // 490, 490-R1
    t.integer('base_no').unsigned().notNullable();                         // 490 for every revision
    t.smallint('revision').unsigned().notNullable().defaultTo(0);          // 0 = the first one
    t.integer('site_id').unsigned().nullable().references('sites.id');
    t.integer('enquiry_id').unsigned().nullable().references('enquiries.id').onDelete('SET NULL');
    t.integer('customer_id').unsigned().notNullable().references('customers.id');
    t.integer('vehicle_id').unsigned().nullable().references('vehicles.id').onDelete('SET NULL');
    t.string('vehicle_description', 150).nullable();
    t.date('proforma_date').notNullable();
    t.text('notes').nullable();                                            // delivery time, payment terms …
    t.decimal('total', 14, 2).notNullable().defaultTo(0);                  // VAT included
    t.enum('status', ['draft', 'sent', 'accepted', 'declined', 'replaced']).notNullable().defaultTo('draft');
    t.string('declined_reason', 255).nullable();
    t.integer('replaced_by').unsigned().nullable().references('proformas.id').onDelete('SET NULL');
    t.datetime('sent_at').nullable();
    t.datetime('closed_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.unique(['base_no', 'revision']);
    t.index(['status']);
    t.index(['customer_id']);
  });

  await knex.schema.createTable('proforma_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('proforma_id').unsigned().notNullable().references('proformas.id').onDelete('CASCADE');
    t.smallint('sort_order').unsigned().notNullable();
    t.decimal('quantity', 10, 2).notNullable().defaultTo(1);
    t.string('unit', 20).notNullable().defaultTo('Unit');
    t.text('description').notNullable();
    t.decimal('unit_price', 14, 2).notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.index(['proforma_id', 'sort_order']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('proforma_lines');
  await knex.schema.dropTable('proformas');
  await knex('number_sequences').where({ seq_key: 'PF', period: '' }).delete();
}
