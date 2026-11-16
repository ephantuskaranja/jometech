// Settings admins change in the app, one value per key. Defaults live here, so a key with no row
// in the table simply has its default.
//
//   await getSetting('costing.target_margin')          → 30
//   await setSetting('costing.target_margin', 35, req)
import { db } from './db.js';
import { audit } from './audit.js';

export const DEFAULTS = {
  'costing.target_margin': 30, // % of the price without VAT, for pricing advice on proformas
};

export async function getSetting(key) {
  const row = await db('settings').where({ key }).first('value');
  const fallback = DEFAULTS[key];
  if (!row) return fallback;
  return typeof fallback === 'number' ? Number(row.value) : row.value;
}

export async function setSetting(key, value, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('settings').where({ key }).first('value');
    const old = before ? before.value : String(DEFAULTS[key] ?? '');
    if (old === String(value)) return;
    await trx('settings').insert({ key, value: String(value), updated_by: actor.user.id }).onConflict('key').merge();
    await audit(trx, actor, { entity: 'setting', id: 0, action: 'update', before: { [key]: old }, after: { [key]: String(value) } });
  });
}
