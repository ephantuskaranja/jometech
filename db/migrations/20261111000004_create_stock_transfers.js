import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Stock transfers between sites (step 25c): sent from one site, in transit, received at the other.
//
//   stock_transfers ──< stock_transfer_lines
//
// Sending takes the pieces off the sending site's balance; receiving puts what was sent on the receiving
// site's balance. The item's total and value don't change (one average across all sites). Fewer arrived
// than were sent: the shortfall becomes a "lost" adjustment at the receiving site, for a manager to approve.

const BEFORE = ['receive', 'reverse', 'issue', 'return', 'opening', 'adjust'];
const enumOf = (list) => `ENUM(${list.map((s) => `'${s}'`).join(', ')}) NOT NULL`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('stock_transfers', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // TRF-2026-0001
    t.integer('from_site_id').unsigned().notNullable().references('sites.id');
    t.integer('to_site_id').unsigned().notNullable().references('sites.id');
    t.enum('status', ['in_transit', 'received', 'cancelled']).notNullable().defaultTo('in_transit');
    t.string('carried_by', 100).nullable();                                // driver or whoever takes it
    t.string('note', 500).nullable();
    t.integer('sent_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('sent_at').notNullable().defaultTo(knex.fn.now());
    t.integer('received_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('received_at').nullable();
    t.string('receive_note', 500).nullable();
    t.string('cancel_reason', 255).nullable();
    t.integer('adjustment_id').unsigned().nullable().references('stock_adjustments.id').onDelete('SET NULL'); // the shortfall, if any
    timestamps(t, knex);
    t.index(['to_site_id', 'status']);
    t.index(['from_site_id', 'status']);
  });

  await knex.schema.createTable('stock_transfer_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('transfer_id').unsigned().notNullable().references('stock_transfers.id').onDelete('CASCADE');
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.string('size_key', 40).notNullable().defaultTo('');
    t.decimal('length', 10, 2).nullable();
    t.decimal('width', 10, 2).nullable();
    t.enum('size_unit', ['ft', 'mm']).nullable();
    t.decimal('area_sq_ft', 12, 4).nullable();
    t.decimal('quantity', 14, 3).notNullable();                            // sent: pieces for a plate
    t.decimal('received_qty', 14, 3).nullable();                           // set on receiving
    t.index(['transfer_id']);
  });

  await knex.raw(`ALTER TABLE \`stock_movements\` MODIFY \`type\` ${enumOf([...BEFORE, 'transfer_out', 'transfer_in'])}`);
  await knex.schema.alterTable('stock_movements', (t) => {
    t.integer('transfer_id').unsigned().nullable().references('stock_transfers.id').onDelete('SET NULL');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('stock_movements', (t) => {
    t.dropForeign('transfer_id');
    t.dropColumn('transfer_id');
  });
  await knex('stock_movements').whereIn('type', ['transfer_out', 'transfer_in']).delete();
  await knex.raw(`ALTER TABLE \`stock_movements\` MODIFY \`type\` ${enumOf(BEFORE)}`);
  await knex.schema.dropTableIfExists('stock_transfer_lines');
  await knex.schema.dropTableIfExists('stock_transfers');
}
