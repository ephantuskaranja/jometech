// ID numbers in one format (no spaces, dashes, dots or slashes; capitals), so
// "29 967 996" and "29967996" are the same person. Matches tidyIdNo() in core/validate.js.

const COLUMNS = [['visitors', 'id_no'], ['employees', 'id_no'], ['checkins', 'driver_id_no'], ['vehicle_releases', 'collector_id_no']];

export async function up(knex) {
  for (const [table, col] of COLUMNS) {
    await knex.raw(
      `UPDATE ?? SET ?? = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(??, ' ', ''), '-', ''), '.', ''), '/', '')) WHERE ?? IS NOT NULL`,
      [table, col, col, col],
    );
    await knex(table).where(col, '').update({ [col]: null });
  }
}

export async function down() {
  // Nothing to undo: the tidied numbers are the same numbers.
}
