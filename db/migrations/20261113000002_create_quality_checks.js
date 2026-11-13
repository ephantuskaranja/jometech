import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Quality checks (QC-a). Admins keep one checklist (sections of items; each section suggests the
// production step that redoes its work). Each job type names its quality check step; a job's copy of
// that step can only be ticked off by a passed inspection. An inspection copies the checklist as it is
// that day, so later edits never change old reports.
//
//   in_progress → passed (ticks off the job's quality check step)
//               → failed (the work is put right, then a new inspection: attempt 2, 3 …)
//               → cancelled (started by mistake)

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('job_types', (t) => {
    t.string('qc_step', 60).nullable();                                    // the step a passed quality check ticks off
  });
  await knex.schema.alterTable('job_steps', (t) => {
    t.boolean('is_qc').notNullable().defaultTo(false);
  });
  // The starting job types all have "Quality Inspection"; jobs already made get it marked too.
  const QC = 'Quality Inspection';
  const typeIds = await knex('job_type_steps').where({ name: QC }).pluck('job_type_id');
  if (typeIds.length) await knex('job_types').whereIn('id', typeIds).update({ qc_step: QC });
  await knex('job_steps').where({ name: QC }).update({ is_qc: true });

  await knex.schema.createTable('qc_checklist_sections', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('sort_order').notNullable();
    t.string('name', 80).notNullable();
    t.string('rework_step', 60).nullable();                                // suggested step to redo a failed item
  });
  await knex.schema.createTable('qc_checklist_items', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('section_id').unsigned().notNullable().references('qc_checklist_sections.id').onDelete('CASCADE');
    t.integer('sort_order').notNullable();
    t.string('text', 200).notNullable();
  });

  await knex.schema.createTable('qc_inspections', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // QC-2026-0001
    t.integer('job_id').unsigned().notNullable().references('jobs.id');
    t.integer('attempt').unsigned().notNullable();                         // 1, 2 … per job
    t.enum('status', ['in_progress', 'passed', 'failed', 'cancelled']).notNullable().defaultTo('in_progress');
    t.string('remarks', 1000).nullable();
    t.integer('started_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('started_at').notNullable().defaultTo(knex.fn.now());
    t.integer('finished_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('finished_at').nullable();
    timestamps(t, knex);
    t.index(['job_id', 'status']);
  });
  await knex.schema.createTable('qc_inspection_items', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('inspection_id').unsigned().notNullable().references('qc_inspections.id').onDelete('CASCADE');
    t.integer('sort_order').notNullable();
    t.string('section', 80).notNullable();
    t.string('text', 200).notNullable();
    t.string('rework_step', 60).nullable();
    t.enum('result', ['pass', 'fail', 'na']).nullable();                   // not answered yet
    t.string('note', 255).nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('qc_inspection_items');
  await knex.schema.dropTable('qc_inspections');
  await knex.schema.dropTable('qc_checklist_items');
  await knex.schema.dropTable('qc_checklist_sections');
  await knex.schema.alterTable('job_steps', (t) => t.dropColumn('is_qc'));
  await knex.schema.alterTable('job_types', (t) => t.dropColumn('qc_step'));
  await knex('number_sequences').where({ seq_key: 'QC' }).delete();
}
