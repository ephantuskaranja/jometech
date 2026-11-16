import { tableDefaults } from '../../src/core/schema.js';

// Settings that admins change in the app (System pages), one value per key. Defaults live in code,
// so a missing row means "not changed yet". First: the target profit margin for pricing advice (28c).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('settings', (t) => {
    tableDefaults(t);
    t.string('key', 60).primary();
    t.string('value', 255).notNullable();
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('settings');
}
