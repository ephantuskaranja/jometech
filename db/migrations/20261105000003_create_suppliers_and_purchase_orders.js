import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Suppliers and purchase orders.
//
//   purchase_orders ──< purchase_order_lines     item, quantity, what it's for, price if known
//
//   draft ──▶ pending ──▶ approved ──▶ sent        (any of them can go back to draft, or be cancelled)
//
// A plate line also holds its size as typed (12 × 4 ft, or 2600 × 1220 mm) and the area of one piece.
// Prices are optional here, as on the paper order; goods received will need them. They exclude VAT.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('suppliers', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // SUP-0001
    t.string('name', 120).notNullable().unique();
    t.string('contact_person', 100).nullable();
    t.string('phone', 20).nullable();
    t.string('email', 120).nullable();
    t.string('address', 255).nullable();
    t.string('kra_pin', 20).nullable();
    t.string('payment_terms', 120).nullable();
    t.string('materials', 255).nullable();                                 // what they supply
    t.text('notes').nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
  });

  await knex.schema.createTable('purchase_orders', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // PO-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.integer('supplier_id').unsigned().notNullable().references('suppliers.id');
    t.date('order_date').notNullable();
    t.date('expected_on').nullable();
    t.text('notes').nullable();
    t.decimal('total', 14, 2).nullable();                                  // of the lines that have a price
    t.enum('status', ['draft', 'pending', 'approved', 'sent', 'cancelled']).notNullable().defaultTo('draft');
    t.integer('approved_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('approved_at').nullable();
    t.datetime('sent_at').nullable();
    t.datetime('cancelled_at').nullable();
    t.string('cancelled_reason', 255).nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['status']);
    t.index(['supplier_id']);
  });

  await knex.schema.createTable('purchase_order_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('purchase_orders.id').onDelete('CASCADE');
    t.smallint('sort_order').unsigned().notNullable();
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.decimal('quantity', 14, 3).notNullable();                            // pieces, for a plate
    t.decimal('length', 10, 2).nullable();
    t.decimal('width', 10, 2).nullable();
    t.enum('size_unit', ['ft', 'mm']).nullable();
    t.decimal('area_sq_ft', 12, 4).nullable();                             // of one piece
    t.integer('job_id').unsigned().nullable().references('jobs.id').onDelete('SET NULL');
    t.string('for_text', 60).nullable();                                   // "Trailer", when it isn't for one job
    t.decimal('unit_price', 14, 4).nullable();                             // per unit, or per sq ft
    t.decimal('amount', 14, 2).nullable();
    t.index(['order_id', 'sort_order']);
    t.index(['job_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('purchase_order_lines');
  await knex.schema.dropTable('purchase_orders');
  await knex.schema.dropTable('suppliers');
  await knex('number_sequences').whereIn('seq_key', ['SUP', 'PO']).delete();
}
