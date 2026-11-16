import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';

// Running costs: entered once a month per site by managers and admins, one amount per category.

export const CATEGORIES = [
  { key: 'electricity', label: 'Electricity' },
  { key: 'rent', label: 'Rent' },
  { key: 'water', label: 'Water' },
  { key: 'internet', label: 'Internet & phone' },
  { key: 'fuel', label: 'Fuel & transport' },
  { key: 'equipment', label: 'Equipment & repairs' },
  { key: 'other', label: 'Other' },
];
export const categoryLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label ?? key;

/** A month's running costs at a site, one row per category (empty ones too). */
export async function forMonth(siteId, month) {
  const rows = await db('running_costs as r').leftJoin('users as u', 'u.id', 'r.entered_by')
    .where({ 'r.site_id': siteId, 'r.month': month }).select('r.*', 'u.name as entered_by_name');
  const lines = CATEGORIES.map((c) => {
    const row = rows.find((r) => r.category === c.key);
    return { ...c, amount: row ? Number(row.amount) : null, note: row?.note ?? '', entered_by_name: row?.entered_by_name ?? null, updated_at: row?.updated_at ?? null };
  });
  return { lines, total: lines.reduce((n, l) => n + (l.amount ?? 0), 0), entered: rows.length > 0 };
}

/** The month's total at a site, or null when nothing was entered for it. */
export async function monthTotal(q, siteId, month) {
  const row = await q('running_costs').where({ site_id: siteId, month }).count({ n: '*' }).sum({ total: 'amount' }).first();
  return Number(row.n) ? Number(row.total) : null;
}

/**
 * Saves the month's amounts: { [category]: { amount: number|null, note: string|null } }.
 * An empty amount removes that category for the month.
 */
export async function saveMonth(siteId, month, amounts, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('running_costs').where({ site_id: siteId, month }).forUpdate().select();
    const changes = [];
    for (const c of CATEGORIES) {
      const { amount = null, note = null } = amounts[c.key] ?? {};
      const row = before.find((r) => r.category === c.key);
      if (amount === null) {
        if (row) { await trx('running_costs').where({ id: row.id }).delete(); changes.push(`${c.label} removed`); }
        continue;
      }
      if (row && Number(row.amount) === amount && (row.note ?? null) === note) continue;
      if (row) await trx('running_costs').where({ id: row.id }).update({ amount, note, entered_by: actor.user.id });
      else await trx('running_costs').insert({ site_id: siteId, month, category: c.key, amount, note, entered_by: actor.user.id });
      changes.push(`${c.label} ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2 })}`);
    }
    if (!changes.length) return;
    const site = await trx('sites').where({ id: siteId }).first('name');
    await audit(trx, actor, { entity: 'running_costs', id: siteId, action: 'update', summary: `${site?.name ?? 'Site'} ${month}: ${changes.join('; ')}`.slice(0, 1000) });
  });
}

/** Months as 'YYYY-MM'. */
export const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export function shiftMonth(month, by) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
export const monthLabel = (month) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const monthEnd = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

export function requireMonth(month) {
  if (!isMonth(month)) throw httpError(404, 'That month isn’t valid.');
  return month;
}
