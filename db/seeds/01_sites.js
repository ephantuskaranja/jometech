// Jome-Tech's two sites (confirmed 2026-11-02). Safe to run again: an existing code is left untouched,
// so a site renamed in the app later keeps its new name.

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  await knex('sites')
    .insert([
      { code: 'HQ', name: 'HQ', address: 'Eastern Bypass, Ruai' },
      { code: 'SITEB', name: 'Site B' },
    ])
    .onConflict('code')
    .ignore();
}
