import { tableDefaults } from '../../src/core/schema.js';

// Quality checks (QC-c): the customer's sign-off. Each job type names the step where the customer
// (or the driver collecting for them) inspects the work; on a job that step is ticked off only by a
// sign-off. Three outcomes:
//
//   accepted    name, customer or driver, signature on the device   → the step is ticked off
//   not_signed  no one there to sign, with a reason                   → the step is ticked off
//   concerns    what the customer isn't happy with; the supervisor reopens the steps to redo,
//               and the quality check step too, so the job is checked again before the next sign-off
//
//   jobs ──< customer_signoffs ──> qc_inspections (the passed check the customer saw)
//   job_steps ──> customer_signoffs   rework_signoff_id (sent back by the customer's concerns)

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const STEP = 'Customer Inspection';
  await knex.schema.alterTable('job_types', (t) => {
    t.string('signoff_step', 60).nullable();                               // the step the customer's sign-off ticks off
  });
  await knex.schema.alterTable('job_steps', (t) => {
    t.boolean('is_signoff').notNullable().defaultTo(false);
  });
  const typeIds = await knex('job_type_steps').where({ name: STEP }).pluck('job_type_id');
  if (typeIds.length) await knex('job_types').whereIn('id', typeIds).update({ signoff_step: STEP });
  await knex('job_steps').where({ name: STEP }).update({ is_signoff: true });

  await knex.schema.createTable('customer_signoffs', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('job_id').unsigned().notNullable().references('jobs.id').onDelete('CASCADE');
    t.integer('qc_id').unsigned().nullable().references('qc_inspections.id').onDelete('SET NULL');
    t.enum('outcome', ['accepted', 'concerns', 'not_signed']).notNullable();
    t.enum('signer_role', ['customer', 'driver']).nullable();
    t.string('signer_name', 100).nullable();
    t.string('signer_phone', 20).nullable();
    t.string('signature_path', 255).nullable();                            // storage/signatures/YYYY/MM/…png
    t.string('concerns', 1000).nullable();
    t.string('reason', 255).nullable();                                    // why no one signed
    t.integer('recorded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    t.index(['job_id', 'created_at']);
  });
  await knex.schema.alterTable('job_steps', (t) => {
    t.integer('rework_signoff_id').unsigned().nullable().references('customer_signoffs.id').onDelete('SET NULL');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('job_steps', (t) => {
    t.dropForeign(['rework_signoff_id']);
    t.dropColumn('rework_signoff_id');
    t.dropColumn('is_signoff');
  });
  await knex.schema.dropTable('customer_signoffs');
  await knex.schema.alterTable('job_types', (t) => t.dropColumn('signoff_step'));
}
