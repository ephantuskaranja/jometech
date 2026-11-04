import { Router } from 'express';
import { canAny } from '../../core/auth.js';
import { VIEW_CUSTOMERS } from '../../core/access.js';
import { formatPhone } from '../../core/phone.js';
import { globalSearch } from '../customers/service.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { findByNumber, STATUSES as JOB_STATUSES } from '../jobs/service.js';

// The search box in the top bar: reg no., chassis, phone, customer name or number, job number.
export const router = Router();
const view = canAny(...VIEW_CUSTOMERS);

/** Jobs only at the user's own sites, for those who may see jobs. */
const findJobs = (req, q, limit) => (req.user.can('jobs.view') ? findByNumber(q, req.user.sites.map((s) => s.id), limit) : []);

const toResults = ({ vehicles, customers }, jobs = []) => [
  ...jobs.map((j) => ({ type: 'job', url: `/jobs/${j.id}`, title: j.number, meta: JOB_STATUSES[j.status].label, sub: j.customer_name })),
  ...vehicles.map((v) => ({
    type: 'vehicle', url: `/vehicles/${v.id}`, plate: v.reg_no, title: vehicleLabel(v),
    meta: [v.make, v.model].filter(Boolean).join(' ') || v.chassis_no || '', sub: v.customer_name,
  })),
  ...customers.map((c) => ({ type: 'customer', url: `/customers/${c.id}`, title: c.name, meta: c.number, sub: formatPhone(c.phone) })),
];

// As you type (top-bar dropdown)
router.get('/api/search', view, async (req, res) => {
  const q = String(req.query.q ?? '');
  res.json({ results: toResults(await globalSearch(q, { limit: 6 }), await findJobs(req, q, 3)) });
});

// Pressing Enter: full results page
router.get('/search', view, async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const found = await globalSearch(q, { limit: 50 });
  // Exactly one hit: go straight to it.
  const results = toResults(found, await findJobs(req, q, 50));
  if (results.length === 1) return res.redirect(results[0].url);
  res.render('search/views/index', { title: q ? `Search: ${q}` : 'Search', q, results });
});
