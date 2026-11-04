// Starting categories for items. Staff can type a new one on the item form.
// Safe to run again: an existing name is left untouched.

const CATEGORIES = ['Plates', 'Sections (RHS, angle iron)', 'Springs, U-bolts & axle parts', 'Tyres & rims', 'Welding & cutting', 'Paint', 'Electrical', 'Other'];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  await knex('item_categories')
    .insert(CATEGORIES.map((name, i) => ({ name, sort_order: (i + 1) * 10 })))
    .onConflict('name')
    .ignore();
}
