import { db } from './db.js';

// Audit trail: who changed what, and when.
//
//   await db.transaction(async (trx) => {
//     const before = await trx('customers').where({ id }).first();
//     await trx('customers').where({ id }).update(changes);
//     await audit(trx, req, { entity: 'customer', id, action: 'update', before, after: { ...before, ...changes } });
//   });
//
// Write it in the same transaction as the change, so a change is never saved
// without its history (or history without the change).

/** Never stored, even as "changed". */
const SECRET = new Set(['password_hash']);
/** Not worth a history line. */
const NOISE = new Set(['created_at', 'updated_at', 'last_login_at', 'failed_logins']);

/** Makes values comparable and readable in JSON: dates as ISO text, booleans as true/false. */
function normalize(value) {
  if (value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return [...value].map(normalize).sort();
  return value;
}

/** { field: [before, after] } for the fields that differ. */
export function diff(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (SECRET.has(key) || NOISE.has(key) || key === 'id') continue;
    const a = normalize(before?.[key]);
    const b = normalize(after?.[key]);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[key] = [a, b];
  }
  return changes;
}

/**
 * Writes one audit row. Skips an update that changed nothing.
 *
 * @param {import('knex').Knex.Transaction | import('knex').Knex} trx
 * @param {{ user?: { id: number } | null, ip?: string }} actor  usually `req`; `{ user: null }` from a script
 * @param {{ entity: string, id: number, action: string, before?: object, after?: object, summary?: string }} entry
 */
export async function audit(trx, actor, { entity, id, action, before = null, after = null, summary = null }) {
  const changes = before || after ? diff(before, after) : null;
  if (action === 'update' && changes && Object.keys(changes).length === 0) return;

  await trx('audit_log').insert({
    user_id: actor?.user?.id ?? null,
    entity,
    entity_id: id,
    action,
    changes: changes && Object.keys(changes).length ? JSON.stringify(changes) : null,
    summary,
    ip: actor?.ip ?? null,
  });
}

/** History of one record, newest first, with the name of who did it. */
export async function history(entity, id, { limit = 50 } = {}) {
  const rows = await db('audit_log')
    .leftJoin('users', 'users.id', 'audit_log.user_id')
    .where({ 'audit_log.entity': entity, 'audit_log.entity_id': id })
    .orderBy('audit_log.id', 'desc')
    .limit(limit)
    .select('audit_log.id', 'audit_log.created_at', 'audit_log.action', 'audit_log.changes', 'audit_log.summary', 'users.name as by');
  // mysql2 already parses JSON columns; older servers return text.
  return rows.map((r) => ({ ...r, changes: typeof r.changes === 'string' ? JSON.parse(r.changes) : r.changes }));
}
