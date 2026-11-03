// Quick picks for "what they want" on an enquiry (approved 2026-11-03).
// Safe to run again: existing names are left alone, so edits made later are kept.

const TYPES = ['Tipper', 'Dropside', 'Water bowser', 'Fuel tanker', 'Box body / van', 'Flatbed', 'Trailer', 'Repair / modification', 'Other'];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  await knex('enquiry_work_types')
    .insert(TYPES.map((name, i) => ({ name, sort_order: (i + 1) * 10 })))
    .onConflict('name')
    .ignore();
}
