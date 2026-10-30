// Starter site so the app has somewhere to put records.
// Rename it, and add the real sites, once Jome-Tech confirms them (plan §9, Q&A).
// Safe to run again: an existing code is left untouched.

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  await knex('sites')
    .insert([{ code: 'MAIN', name: 'Main workshop' }])
    .onConflict('code')
    .ignore();
}
