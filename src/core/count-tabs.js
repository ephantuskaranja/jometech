import { db } from './db.js';

/**
 * Counts for a list's tabs in one round trip (UNION ALL), instead of a query per tab.
 *   countTabs(TABS, (tab) => { const q = db('jobs as j').where(...); tabFilter(q, tab); return q; })
 * @returns {Promise<Record<string, number>>} { active: 4, completed: 9, all: 13 }
 */
export async function countTabs(tabs, build) {
  const [first, ...rest] = tabs.map((tab) => build(tab).clearSelect().clearOrder().select(db.raw('? AS tab', [tab])).count({ n: '*' }));
  const rows = rest.length ? await first.unionAll(rest, true) : await first;
  const counts = Object.fromEntries(tabs.map((t) => [t, 0]));
  for (const r of rows) counts[r.tab] = Number(r.n);
  return counts;
}
