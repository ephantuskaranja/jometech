import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Items: what the workshop buys and uses.
//
//   priced_by 'unit'  U-bolts, springs, tyres, rims: a price per Pc, Set, Length, m, kg …
//   priced_by 'area'  plates: a price per sq ft. The item is the plate's type and thickness
//                     ("Plate 4 mm"), not its size: 12 ft × 4 ft and 2600 × 1220 mm share one rate.
//
// Prices exclude VAT, because Jome-Tech claims VAT back. current_price is set here for now;
// goods received notes will keep it up to date (a later step).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('item_categories', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 60).notNullable().unique();
    t.smallint('sort_order').unsigned().notNullable().defaultTo(1000);
  });

  await knex.schema.createTable('items', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('code', 20).notNullable().unique();                           // ITM-0001
    t.string('name', 120).notNullable().unique();
    t.integer('category_id').unsigned().notNullable().references('item_categories.id');
    t.enum('priced_by', ['unit', 'area']).notNullable().defaultTo('unit');
    t.string('unit', 20).notNullable().defaultTo('Pc');                    // "sq ft" when priced by area
    t.decimal('thickness_mm', 6, 2).nullable();                            // plates: gives the sheet's weight
    t.decimal('current_price', 14, 4).nullable();                          // per unit, excluding VAT
    t.decimal('reorder_level', 14, 3).nullable();
    t.text('notes').nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['category_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('items');
  await knex.schema.dropTable('item_categories');
  await knex('number_sequences').where({ seq_key: 'ITM' }).delete();
}
