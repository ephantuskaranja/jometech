import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Job costing (28b): running costs, entered once a month per site by managers and admins
// (electricity, rent, water …). Each month's total is shared across the site's jobs by their work
// days that month, as the site's approved weekly payroll is by work days that week.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('running_costs', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.string('month', 7).notNullable();                                    // '2026-11'
    t.string('category', 30).notNullable();                                // electricity, rent … (costing/running-costs.js)
    t.decimal('amount', 14, 2).notNullable();
    t.string('note', 150).nullable();
    t.integer('entered_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.unique(['site_id', 'month', 'category']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('running_costs');
}
