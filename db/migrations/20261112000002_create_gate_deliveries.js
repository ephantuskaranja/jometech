import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Supplier deliveries logged at the gate (step 26b). The guard logs the truck against the open
// purchase order (or as "no order", with the supplier's name typed) with the delivery note, vehicle
// and driver. Stores can only receive goods (a GRN) against an arrival logged here: one arrival, one GRN.
//
//   waiting  → received (the GRN made from it; back to waiting if that GRN is reversed)
//            → closed   (stores sent it back or it wasn't ours, with a reason)

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('gate_deliveries', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // DLV-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.integer('order_id').unsigned().nullable().references('purchase_orders.id');
    t.string('supplier_name', 150).nullable();                             // typed when there is no order
    t.string('delivery_note', 60).nullable();
    t.string('vehicle_reg', 20).nullable();
    t.string('driver_name', 100).notNullable();
    t.string('note', 255).nullable();
    t.enum('status', ['waiting', 'received', 'closed']).notNullable().defaultTo('waiting');
    t.datetime('arrived_at').notNullable().defaultTo(knex.fn.now());
    t.integer('logged_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('receipt_id').unsigned().nullable().references('goods_receipts.id').onDelete('SET NULL');
    t.datetime('closed_at').nullable();
    t.integer('closed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('close_reason', 255).nullable();
    timestamps(t, knex);
    t.index(['site_id', 'status']);
    t.index(['order_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('gate_deliveries');
  await knex('number_sequences').where({ seq_key: 'DLV' }).delete();
}
