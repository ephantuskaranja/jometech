import knex from 'knex';
import knexConfig from '../../knexfile.js';

// One shared connection pool for the whole app. Connections open on the
// first query, so importing this file never fails even if MySQL is down.
//
//   import { db } from '../../core/db.js';
//   const sites = await db('sites').where({ is_active: true }).orderBy('name');
export const db = knex(knexConfig);

/** True when MySQL answers a trivial query. Used by /health. */
export async function dbIsUp() {
  try {
    await db.raw('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
