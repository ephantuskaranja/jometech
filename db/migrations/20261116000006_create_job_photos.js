import { tableDefaults } from '../../src/core/schema.js';

// Job progress photos: taken on a phone by supervisors and technicians while the job is open, each
// filed under the step the job was at (Welding, Painting …), so the job shows its progress step by step.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('job_photos', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('job_id').unsigned().notNullable().references('jobs.id').onDelete('CASCADE');
    t.integer('step_id').unsigned().nullable().references('job_steps.id').onDelete('SET NULL'); // the step it was taken at
    t.string('step_name', 60).nullable();                                  // kept if the step goes (type changed)
    t.string('path', 255).notNullable();                                   // storage/photos/YYYY/MM/…webp (1280 px)
    t.string('thumb_path', 255).notNullable();                             // 320 px
    t.integer('bytes').unsigned().notNullable();
    t.integer('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['job_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('job_photos');
}
