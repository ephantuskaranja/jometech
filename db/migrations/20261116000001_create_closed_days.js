import { tableDefaults } from '../../src/core/schema.js';

// Job costing (28a): days the workshop was closed (Christmas, New Year …), set by admins, for all
// sites or one. A job's work days are Monday to Saturday from start to completion, less these.
// Most public holidays are work days at Jome-Tech, so nothing is closed unless listed here.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('closed_days', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.date('day').notNullable();
    t.integer('site_id').unsigned().nullable().references('sites.id').onDelete('CASCADE');   // null: every site
    t.string('reason', 100).notNullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['day']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('closed_days');
}
