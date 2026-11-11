import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Stock counts (step 25b): a blind count of a site's stock, everything or one category.
//
//   stock_counts ──< stock_count_lines
//
// The sheet lists each item (and each plate size on the racks) without the system's figures.
// Posting compares what was counted with stock at that moment and turns the differences into
// one stock adjustment (reason "count") that a manager approves. Lines left blank aren't counted.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('stock_counts', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // CNT-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.integer('category_id').unsigned().nullable().references('item_categories.id').onDelete('SET NULL'); // null = everything
    t.enum('status', ['open', 'posted', 'cancelled']).notNullable().defaultTo('open');
    t.string('note', 500).nullable();
    t.integer('adjustment_id').unsigned().nullable().references('stock_adjustments.id').onDelete('SET NULL'); // made on posting, if anything differed
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('posted_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('posted_at').nullable();
    timestamps(t, knex);
    t.index(['site_id', 'status']);
  });

  await knex.schema.createTable('stock_count_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('count_id').unsigned().notNullable().references('stock_counts.id').onDelete('CASCADE');
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.string('size_key', 40).notNullable().defaultTo('');
    t.decimal('length', 10, 2).nullable();
    t.decimal('width', 10, 2).nullable();
    t.enum('size_unit', ['ft', 'mm']).nullable();
    t.decimal('area_sq_ft', 12, 4).nullable();
    t.decimal('counted', 14, 3).nullable();                                // pieces for a plate; null = not counted yet
    t.decimal('system_qty', 14, 3).nullable();                             // what the system had when posted
    t.boolean('added').notNullable().defaultTo(false);                     // added by the counter: found, not on the sheet
    t.unique(['count_id', 'item_id', 'size_key']);
  });

  await knex.schema.alterTable('stock_adjustments', (t) => {
    t.integer('count_id').unsigned().nullable().references('stock_counts.id').onDelete('SET NULL');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('stock_adjustments', (t) => {
    t.dropForeign('count_id');
    t.dropColumn('count_id');
  });
  await knex.schema.dropTableIfExists('stock_count_lines');
  await knex.schema.dropTableIfExists('stock_counts');
}
