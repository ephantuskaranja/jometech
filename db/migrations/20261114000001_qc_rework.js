import { tableDefaults } from '../../src/core/schema.js';

// Quality checks (QC-b): rework. Each failed item says where it is put right: one of the job's
// steps before the quality check (reopened when the check fails), or at the quality check itself.
// Failed items can carry photos of the defect. A reopened step remembers the check that sent it back.
//
//   qc_inspection_items ──> job_steps        redo_step_id (or redo_here)
//   qc_inspection_items ──< qc_item_photos
//   job_steps ──> qc_inspections             rework_qc_id
//
// Steps record when they were finished to the millisecond: "undo the last step" takes the one ticked
// most recently, which after rework is not always the furthest one.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('qc_inspection_items', (t) => {
    t.integer('redo_step_id').unsigned().nullable().references('job_steps.id').onDelete('SET NULL');
    t.boolean('redo_here').notNullable().defaultTo(false);                 // put right at the quality check, no step reopened
  });
  await knex.schema.alterTable('job_steps', (t) => {
    t.integer('rework_qc_id').unsigned().nullable().references('qc_inspections.id').onDelete('SET NULL');
    t.datetime('finished_at', { precision: 3 }).nullable().alter();
  });
  await knex.schema.createTable('qc_item_photos', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('item_id').unsigned().notNullable().references('qc_inspection_items.id').onDelete('CASCADE');
    t.string('path', 255).notNullable();                                   // storage/photos/YYYY/MM/…webp (1280 px)
    t.string('thumb_path', 255).notNullable();                             // 320 px
    t.integer('bytes').unsigned().notNullable();
    t.integer('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['item_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('qc_item_photos');
  await knex.schema.alterTable('job_steps', (t) => {
    t.datetime('finished_at').nullable().alter();
    t.dropForeign(['rework_qc_id']);
    t.dropColumn('rework_qc_id');
  });
  await knex.schema.alterTable('qc_inspection_items', (t) => {
    t.dropForeign(['redo_step_id']);
    t.dropColumn('redo_step_id');
    t.dropColumn('redo_here');
  });
}
