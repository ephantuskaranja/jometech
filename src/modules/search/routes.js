import { Router } from 'express';
import { canAny } from '../../core/auth.js';
import { VIEW_CUSTOMERS } from '../../core/access.js';
import { formatPhone } from '../../core/phone.js';
import { globalSearch } from '../customers/service.js';
import { vehicleLabel } from '../../core/vehicle-format.js';

// The search box in the top bar: reg no., chassis, phone, customer name or number.
// Job numbers join in when the jobs module is built.
export const router = Router();
const view = canAny(...VIEW_CUSTOMERS);

const toResults = ({ vehicles, customers }) => [
  ...vehicles.map((v) => ({
    type: 'vehicle', url: `/vehicles/${v.id}`, plate: v.reg_no, title: vehicleLabel(v),
    meta: [v.make, v.model].filter(Boolean).join(' ') || v.chassis_no || '', sub: v.customer_name,
  })),
  ...customers.map((c) => ({ type: 'customer', url: `/customers/${c.id}`, title: c.name, meta: c.number, sub: formatPhone(c.phone) })),
];

// As you type (top-bar dropdown)
router.get('/api/search', view, async (req, res) => {
  res.json({ results: toResults(await globalSearch(String(req.query.q ?? ''), { limit: 6 })) });
});

// Pressing Enter: full results page
router.get('/search', view, async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const found = await globalSearch(q, { limit: 50 });
  // Exactly one hit: go straight to it.
  const results = toResults(found);
  if (results.length === 1) return res.redirect(results[0].url);
  res.render('search/views/index', { title: q ? `Search: ${q}` : 'Search', q, results });
});
