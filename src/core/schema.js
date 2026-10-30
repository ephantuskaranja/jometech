// Helpers used inside migrations so every table is built the same way.
//
//   await knex.schema.createTable('customers', (t) => {
//     tableDefaults(t);
//     t.increments('id');
//     ...
//     timestamps(t, knex);
//   });
//
// Keep migrations to SQL that runs on MySQL 8.0 (production server) and 9.x (development).

/** InnoDB, full Unicode (names, emoji in notes) and accent/case-insensitive sorting. */
export function tableDefaults(t) {
  t.engine('InnoDB');
  t.charset('utf8mb4');
  t.collate('utf8mb4_0900_ai_ci');
}

/** created_at and updated_at, filled in and kept current by MySQL itself. */
export function timestamps(t, knex) {
  t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}
