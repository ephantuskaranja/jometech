import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Goods received and stock.
//
//   goods_receipts ──< goods_receipt_lines     what arrived against a purchase order, and its real price
//   stock_movements                            the permanent record: rows are added, never changed
//   stock_balances                             what is at each site now; plates by sheet size
//   items.on_hand_qty / stock_value / avg_cost one weighted average per item, across all sites
//
// An item's stock is counted in its pricing unit, so a plate's is in sq ft. Costs exclude VAT and
// include a share of the delivery's transport. A mistake is undone by reversing the delivery.

const ORDER_STATUSES = ['draft', 'pending', 'approved', 'sent', 'cancelled'];
const statusColumn = (list) => `ENUM(${list.map((s) => `'${s}'`).join(', ')}) NOT NULL DEFAULT 'draft'`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`ALTER TABLE \`purchase_orders\` MODIFY \`status\` ${statusColumn([...ORDER_STATUSES, 'partly_received', 'received'])}`);
  await knex.schema.alterTable('purchase_order_lines', (t) => {
    t.decimal('received_qty', 14, 3).notNullable().defaultTo(0);
  });

  await knex.schema.alterTable('items', (t) => {
    t.decimal('on_hand_qty', 16, 3).notNullable().defaultTo(0);            // in its pricing unit, all sites
    t.decimal('stock_value', 16, 4).notNullable().defaultTo(0);
    t.decimal('avg_cost', 14, 4).nullable();
  });

  await knex.schema.createTable('goods_receipts', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // GRN-2026-0001
    t.integer('order_id').unsigned().notNullable().references('purchase_orders.id');
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.date('received_on').notNullable();
    t.string('delivery_note', 60).nullable();
    t.string('invoice_ref', 60).nullable();                                // the supplier's eTIMS receipt
    t.decimal('goods_total', 14, 2).notNullable().defaultTo(0);
    t.decimal('transport_cost', 14, 2).notNullable().defaultTo(0);
    t.text('notes').nullable();
    t.integer('received_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('reversed_at').nullable();
    t.integer('reversed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('reversed_reason', 255).nullable();
    timestamps(t, knex);
    t.index(['order_id']);
  });

  await knex.schema.createTable('goods_receipt_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('receipt_id').unsigned().notNullable().references('goods_receipts.id').onDelete('CASCADE');
    t.integer('order_line_id').unsigned().notNullable().references('purchase_order_lines.id');
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.decimal('quantity', 14, 3).notNullable();                            // accepted: pieces, for a plate
    t.decimal('rejected_qty', 14, 3).notNullable().defaultTo(0);           // rejected or damaged: not in stock
    t.decimal('stock_qty', 16, 3).notNullable();                           // in the pricing unit
    t.decimal('unit_price', 14, 4).nullable();                             // from the receipt, excluding VAT
    t.decimal('previous_price', 14, 4).nullable();
    t.decimal('goods_amount', 14, 2).notNullable().defaultTo(0);
    t.decimal('transport_share', 14, 2).notNullable().defaultTo(0);
    t.index(['receipt_id']);
  });

  await knex.schema.createTable('stock_balances', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.string('size_key', 40).notNullable().defaultTo('');                  // "12x4ft"; empty unless priced by area
    t.decimal('length', 10, 2).nullable();
    t.decimal('width', 10, 2).nullable();
    t.enum('size_unit', ['ft', 'mm']).nullable();
    t.decimal('area_sq_ft', 12, 4).nullable();
    t.decimal('quantity', 14, 3).notNullable().defaultTo(0);               // pieces, for a plate
    t.unique(['site_id', 'item_id', 'size_key']);
  });

  await knex.schema.createTable('stock_movements', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.enum('type', ['receive', 'reverse']).notNullable();
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.string('size_key', 40).notNullable().defaultTo('');
    t.decimal('quantity', 14, 3).notNullable();                            // pieces; minus when stock leaves
    t.decimal('stock_qty', 16, 3).notNullable();                           // in the pricing unit
    t.decimal('value', 16, 4).notNullable();
    t.integer('receipt_id').unsigned().nullable().references('goods_receipts.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['item_id', 'id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('stock_movements');
  await knex.schema.dropTable('stock_balances');
  await knex.schema.dropTable('goods_receipt_lines');
  await knex.schema.dropTable('goods_receipts');
  await knex.schema.alterTable('items', (t) => {
    t.dropColumn('on_hand_qty');
    t.dropColumn('stock_value');
    t.dropColumn('avg_cost');
  });
  await knex.schema.alterTable('purchase_order_lines', (t) => t.dropColumn('received_qty'));
  await knex('purchase_orders').whereIn('status', ['partly_received', 'received']).update({ status: 'sent' });
  await knex.raw(`ALTER TABLE \`purchase_orders\` MODIFY \`status\` ${statusColumn(ORDER_STATUSES)}`);
  await knex('number_sequences').where({ seq_key: 'GRN' }).delete();
}
