import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Sites: the workshops and yards Jome-Tech works from. Almost every other
// table (jobs, stock, attendance, users) will point at a site.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('sites', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('code', 10).notNullable().unique();   // short code used in document numbers, e.g. MAIN
    t.string('name', 100).notNullable().unique();
    t.string('address', 255).nullable();
    t.string('phone', 20).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(t, knex);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('sites');
}
