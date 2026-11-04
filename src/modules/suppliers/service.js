import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';

// Suppliers: who Jome-Tech buys from.

export const STATUSES = ['active', 'inactive', 'all'];

const FIELDS = ['name', 'contact_person', 'phone', 'email', 'address', 'kra_pin', 'payment_terms', 'materials', 'notes'];
const pick = (input) => Object.fromEntries(FIELDS.map((k) => [k, input[k] ?? null]));

/** "Tononoka Rolling Mills" and "tononoka  rolling mills" are the same supplier. */
async function checkName(trx, name, exceptId = null) {
  const q = trx('suppliers').whereRaw("REPLACE(`name`, ' ', '') = ?", [name.replace(/\s+/g, '')]);
  if (exceptId) q.whereNot({ id: exceptId });
  const match = await q.first('id', 'name', 'is_active');
  if (match) {
    throw Object.assign(httpError(409, match.is_active ? `“${match.name}” is already a supplier.` : `“${match.name}” is already a supplier, but it is switched off.`), { field: 'name', existingId: match.id });
  }
}

/** @returns {Promise<{ id: number, number: string }>} */
export async function createSupplier(input, actor) {
  return db.transaction(async (trx) => {
    await checkName(trx, input.name);
    const number = await nextNumber(trx, 'supplier');
    const [id] = await trx('suppliers').insert({ ...pick(input), number, created_by: actor.user.id });
    await audit(trx, actor, { entity: 'supplier', id, action: 'create', summary: `${number}: ${input.name}` });
    return { id, number };
  });
}

export async function updateSupplier(id, input, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('suppliers').where({ id }).forUpdate().first();
    if (!before) throw httpError(404, 'That supplier doesn’t exist.');
    await checkName(trx, input.name, id);
    await trx('suppliers').where({ id }).update(pick(input));
    await audit(trx, actor, { entity: 'supplier', id, action: 'update', before: pick(before), after: pick(input) });
  });
}

/** Switched off, never deleted: past orders refer to it. */
export async function setActive(id, active, actor) {
  await db.transaction(async (trx) => {
    const s = await trx('suppliers').where({ id }).forUpdate().first('id', 'name', 'is_active');
    if (!s) throw httpError(404, 'That supplier doesn’t exist.');
    if (Boolean(s.is_active) === active) return;
    await trx('suppliers').where({ id }).update({ is_active: active });
    await audit(trx, actor, { entity: 'supplier', id, action: active ? 'record_on' : 'record_off', summary: s.name });
  });
}

export function getSupplier(id) {
  return db('suppliers').where({ id }).first();
}

export function listSuppliers({ status = 'active', q = '' } = {}) {
  const query = db('suppliers').orderBy('name').limit(500);
  if (status !== 'all') query.where({ is_active: status === 'active' });
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('name', 'like', `%${term}%`).orWhere('number', 'like', `%${term}%`)
      .orWhere('materials', 'like', `%${term}%`).orWhere('contact_person', 'like', `%${term}%`));
  }
  return query;
}

/** The supplier dropdown on a purchase order. */
export async function lookupSuppliers(q) {
  const rows = await listSuppliers({ q: String(q).slice(0, 60) }).limit(20);
  return rows.map((s) => ({ value: s.id, label: `${s.name} (${s.number})` }));
}
