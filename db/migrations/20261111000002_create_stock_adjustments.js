import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Stock adjustments (step 25a): stock taken off or added outside deliveries and issues
// (damaged, lost, found, used without an issue, a count difference), with a reason.
//
//   stock_adjustments ──< stock_adjustment_lines
//
// A storekeeper records it; nothing changes until a manager or admin approves it.
// Then each line becomes an 'adjust' stock movement: removals at the average cost that day,
// additions at the average (or the cost typed, for an item with no average yet).

const BEFORE = ['receive', 'reverse', 'issue', 'return', 'opening'];
const enumOf = (list) => `ENUM(${list.map((s) => `'${s}'`).join(', ')}) NOT NULL`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('stock_adjustments', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // ADJ-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.enum('reason', ['damaged', 'lost', 'found', 'used', 'count', 'other']).notNullable();
    t.string('note', 500).nullable();
    t.enum('status', ['pending', 'approved', 'rejected', 'cancelled']).notNullable().defaultTo('pending');
    t.decimal('value', 16, 4).nullable();                                  // net change in stock value, set on approval
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('decided_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('decided_at').nullable();
    t.string('decision_note', 255).nullable();                             // why it was rejected or cancelled
    timestamps(t, knex);
    t.index(['site_id', 'status']);
  });

  await knex.schema.createTable('stock_adjustment_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('adjustment_id').unsigned().notNullable().references('stock_adjustments.id').onDelete('CASCADE');
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.string('size_key', 40).notNullable().defaultTo('');
    t.decimal('length', 10, 2).nullable();
    t.decimal('width', 10, 2).nullable();
    t.enum('size_unit', ['ft', 'mm']).nullable();
    t.decimal('area_sq_ft', 12, 4).nullable();
    t.decimal('quantity', 14, 3).notNullable();                            // pieces for a plate; minus = taken off
    t.decimal('stock_qty', 16, 3).notNullable();                           // in the pricing unit, same sign
    t.decimal('entered_cost', 14, 4).nullable();                           // typed, for an addition to an item with no average
    t.decimal('unit_cost', 14, 4).nullable();                              // used on approval
    t.decimal('value', 16, 4).nullable();                                  // set on approval, same sign
    t.index(['adjustment_id']);
  });

  await knex.raw(`ALTER TABLE \`stock_movements\` MODIFY \`type\` ${enumOf([...BEFORE, 'adjust'])}`);
  await knex.schema.alterTable('stock_movements', (t) => {
    t.integer('adjustment_id').unsigned().nullable().references('stock_adjustments.id').onDelete('SET NULL');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('stock_movements', (t) => {
    t.dropForeign('adjustment_id');
    t.dropColumn('adjustment_id');
  });
  await knex('stock_movements').where({ type: 'adjust' }).delete();
  await knex.raw(`ALTER TABLE \`stock_movements\` MODIFY \`type\` ${enumOf(BEFORE)}`);
  await knex.schema.dropTableIfExists('stock_adjustment_lines');
  await knex.schema.dropTableIfExists('stock_adjustments');
}
