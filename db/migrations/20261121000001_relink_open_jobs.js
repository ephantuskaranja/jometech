// Open jobs whose vehicle is in the workshop but which never got linked to that check-in
// (so the job said "Not in the workshop"). Each one links to the vehicle's newest open check-in.
// Data only: nothing to undo.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    UPDATE jobs j
    JOIN (
      SELECT vehicle_id, MAX(id) AS id FROM checkins
      WHERE status IN ('in_workshop', 'released') GROUP BY vehicle_id
    ) open_ci ON open_ci.vehicle_id = j.vehicle_id
    LEFT JOIN checkins linked ON linked.id = j.checkin_id
    SET j.checkin_id = open_ci.id
    WHERE j.status IN ('open', 'in_progress')
      AND (linked.id IS NULL OR linked.status NOT IN ('in_workshop', 'released'))`);
}

/** @param {import('knex').Knex} knex */
export async function down() {}
