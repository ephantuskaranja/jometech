import { tableDefaults } from '../../src/core/schema.js';

// audit_log: one row per change, never edited or deleted (requirement §53).
// number_sequences: the last number handed out per document type and year (§59).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('audit_log', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL'); // null = system / command line
    t.string('entity', 40).notNullable();       // 'user', 'customer', 'job' …
    t.integer('entity_id').unsigned().notNullable();
    t.string('action', 30).notNullable();       // create | update | delete | password_reset | switched_off …
    t.json('changes').nullable();               // { field: [before, after] }
    t.string('summary', 255).nullable();        // plain-language note, e.g. "Created with npm run user:create"
    t.string('ip', 45).nullable();
    t.index(['entity', 'entity_id', 'id']);
    t.index(['user_id', 'id']);
  });

  await knex.schema.createTable('number_sequences', (t) => {
    tableDefaults(t);
    t.string('seq_key', 20).notNullable();      // 'JOB', 'CUS' …
    t.string('period', 10).notNullable();       // '2026' for yearly numbers, '' for never-reset ones
    t.integer('counter').unsigned().notNullable();
    t.primary(['seq_key', 'period']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('number_sequences');
  await knex.schema.dropTable('audit_log');
}
