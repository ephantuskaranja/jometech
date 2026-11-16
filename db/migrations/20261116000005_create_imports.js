import { tableDefaults } from '../../src/core/schema.js';

// Data imports for go-live (System → Import data): an admin uploads a filled-in Excel template,
// the app checks every row and keeps the result here as a preview; nothing is added until the
// admin confirms. Kinds: customers (with their vehicles), items (with opening stock), employees.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('imports', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('kind', 30).notNullable();
    t.string('file_name', 200).notNullable();
    t.enum('status', ['preview', 'done', 'discarded']).notNullable().defaultTo('preview');
    t.json('rows').notNullable();                                          // the checked rows, by sheet
    t.string('summary', 500).nullable();                                   // what was added, when done
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('finished_at').nullable();
    t.index(['kind', 'status']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('imports');
}
