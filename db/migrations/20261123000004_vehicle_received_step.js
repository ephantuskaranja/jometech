// "Vehicle Received" follows the check-in (2026-11-23): a job's first step can be one that only the
// vehicle's check-in ticks off, like the quality check and customer sign-off steps. Until then it
// was ticked by hand, with or without the vehicle checked in.
//
//   job_types.receive_step   the first step's name when it is ticked by the check-in, else null
//   job_steps.is_receive     the job's copy of that
//
// Every job type whose first step is Vehicle Received gets it, and so do the jobs of those types.
// Jobs already under way whose vehicle is checked in have that step ticked now, by whoever checked
// the vehicle in; those still waiting for their vehicle wait for its check-in.

const RECEIVED = 'Vehicle Received';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('job_types', (t) => {
    t.string('receive_step', 60).nullable().after('name');               // the step the vehicle's check-in ticks off
  });
  await knex.schema.alterTable('job_steps', (t) => {
    t.boolean('is_receive').notNullable().defaultTo(false).after('name');
  });

  const firstSteps = await knex('job_type_steps').where({ sort_order: 1, name: RECEIVED }).pluck('job_type_id');
  if (firstSteps.length) await knex('job_types').whereIn('id', firstSteps).update({ receive_step: RECEIVED });

  // Jobs of those types: their own first step, if it is still called that.
  const jobIds = await knex('jobs').whereIn('job_type_id', firstSteps.length ? firstSteps : [0]).pluck('id');
  if (jobIds.length) await knex('job_steps').whereIn('job_id', jobIds).where({ sort_order: 1, name: RECEIVED }).update({ is_receive: true });

  // Under way, vehicle checked in, step not ticked yet: tick it, as received by whoever checked it in.
  const waiting = await knex('job_steps as s').join('jobs as j', 'j.id', 's.job_id').join('checkins as k', 'k.id', 'j.checkin_id')
    .where({ 's.is_receive': true, 's.status': 'pending', 'j.status': 'in_progress' })
    .select('s.id', 'k.received_by', 'k.checked_in_at');
  for (const s of waiting) {
    await knex('job_steps').where({ id: s.id }).update({ status: 'done', finished_at: s.checked_in_at, finished_by: s.received_by });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('job_steps', (t) => t.dropColumn('is_receive'));
  await knex.schema.alterTable('job_types', (t) => t.dropColumn('receive_step'));
}
