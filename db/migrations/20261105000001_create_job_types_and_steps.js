import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Production steps. An admin keeps a list of steps for each job type:
//
//   job_types ──< job_type_steps     the list to copy (New fabrication: Cutting, Welding …)
//   jobs ──< job_steps               this job's own copy, ticked off one at a time
//
// A job keeps its copy, so changing a list only affects jobs made afterwards.
// A job type is switched off, not deleted, so older jobs keep their name for it.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('job_types', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 60).notNullable();
    t.boolean('is_default').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(t, knex);
  });

  await knex.schema.createTable('job_type_steps', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('job_type_id').unsigned().notNullable().references('job_types.id').onDelete('CASCADE');
    t.smallint('sort_order').unsigned().notNullable();
    t.string('name', 60).notNullable();
    t.index(['job_type_id', 'sort_order']);
  });

  await knex.schema.createTable('job_steps', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('job_id').unsigned().notNullable().references('jobs.id').onDelete('CASCADE');
    t.smallint('sort_order').unsigned().notNullable();
    t.string('name', 60).notNullable();
    t.enum('status', ['pending', 'done', 'skipped']).notNullable().defaultTo('pending');
    t.datetime('finished_at').nullable();
    t.integer('finished_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.index(['job_id', 'status', 'sort_order']);
  });

  await knex.schema.alterTable('jobs', (t) => {
    t.integer('job_type_id').unsigned().nullable().after('site_id').references('job_types.id').onDelete('SET NULL');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('jobs', (t) => {
    t.dropForeign('job_type_id');
    t.dropColumn('job_type_id');
  });
  await knex.schema.dropTable('job_steps');
  await knex.schema.dropTable('job_type_steps');
  await knex.schema.dropTable('job_types');
}
