// Quick picks for "items received with the truck" on the check-in screen.
// Staff can still type anything else. Edit the list here or (later) from settings.
// Safe to run again: an existing name is left untouched.

const ITEMS = [
  'Spare wheel', 'Jack', 'Wheel spanner', 'Toolbox', 'Fire extinguisher',
  'Life-saver triangles', 'Ignition keys', 'Battery', 'Radio', 'Side mirrors',
  'Logbook copy', 'Tarpaulin',
];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  await knex('checkin_item_presets')
    .insert(ITEMS.map((name, i) => ({ name, sort_order: (i + 1) * 10 })))
    .onConflict('name')
    .ignore();
}
