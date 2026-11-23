// Check-in purposes are now Fabrication, Repair Works, Modification and Others (issues sheet row 48):
// deliveries, customer visits and meetings sign in at the gate as visitors. Check-ins already
// recorded with those become Others, so reports only ever show the four.
//
// Not undone on rollback: which ones were which isn't kept.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex('checkins').whereIn('purpose', ['delivery', 'customer', 'meeting']).update({ purpose: 'other' });
}

/** @param {import('knex').Knex} knex */
export async function down() {}
