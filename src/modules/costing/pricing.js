import { db } from '../../core/db.js';
import { config } from '../../config.js';
import { getSetting } from '../../core/settings.js';
import { jobCosting, makeShares } from './service.js';

// Pricing advice for a proforma: what similar past jobs really cost (materials, and their share of
// wages and running costs), and the price that would give the target margin set by admins.
//
//   similar     completed in the last 12 months, of the chosen job type, and (if words are given)
//               with those words in the work description
//   suggested   average cost ÷ (1 − target margin), then VAT added

const round = (n) => Math.round(n * 100) / 100;
const MONTHS = 12;
const LIMIT = 40; // the most recent; enough for an average, quick to cost

/**
 * @param {{ jobTypeId: number|null, q: string, siteIds: number[] }} opts
 */
export async function guide({ jobTypeId, q = '', siteIds }) {
  const since = new Date();
  since.setMonth(since.getMonth() - MONTHS);
  const query = db('jobs as j').join('customers as c', 'c.id', 'j.customer_id')
    .where('j.status', 'completed').where('j.completed_at', '>=', since).whereIn('j.site_id', siteIds)
    .orderBy('j.completed_at', 'desc').limit(LIMIT)
    .select('j.id', 'j.number', 'j.site_id', 'j.started_at', 'j.completed_at', 'c.name as customer_name');
  if (jobTypeId) query.where('j.job_type_id', jobTypeId);
  const words = q.trim().split(/\s+/).filter((w) => w.length > 1).slice(0, 5);
  for (const w of words) query.whereExists(db('job_lines').where('job_id', db.ref('j.id')).where('description', 'like', `%${w.replace(/[%_]/g, '')}%`));
  const rows = await query;

  const shares = makeShares();
  const jobs = [];
  for (const row of rows) {
    const c = await jobCosting(row, shares);
    if (!c.price) continue; // nothing to compare without a price
    const cost = round(c.materials + (c.wages?.amount ?? 0) + (c.running?.amount ?? 0));
    jobs.push({
      id: row.id, number: row.number, customer: row.customer_name, completed: row.completed_at,
      cost, price: c.price.exVat, margin: c.netMargin, days: c.days?.days ?? 0,
      incomplete: Boolean(c.wages?.missing.length || c.running?.missing.length),
    });
  }
  const target = await getSetting('costing.target_margin');
  if (!jobs.length) return { count: 0, target, words };

  const avg = (f) => round(jobs.reduce((n, j) => n + f(j), 0) / jobs.length);
  const avgCost = avg((j) => j.cost);
  const suggestedExVat = round(avgCost / (1 - target / 100));
  return {
    count: jobs.length, target, words,
    avgCost, minCost: Math.min(...jobs.map((j) => j.cost)), maxCost: Math.max(...jobs.map((j) => j.cost)),
    avgPrice: avg((j) => j.price), avgMargin: Math.round(avg((j) => j.margin ?? 0) * 10) / 10, avgDays: Math.round(avg((j) => j.days)),
    suggestedExVat, suggestedWithVat: round(suggestedExVat * (1 + config.vatRate / 100)),
    incomplete: jobs.filter((j) => j.incomplete).length,
    recent: jobs.slice(0, 5),
  };
}
