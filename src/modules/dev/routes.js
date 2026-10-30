import { Router } from 'express';
import { config } from '../../config.js';
import { httpError } from '../../core/validate.js';

// /dev/ui: every building block on one page, in the current theme.
// Build new screens from these pieces. Open in development, and to admins on the server.
export const router = Router();

router.use('/dev', (req, res, next) => {
  if (!config.isProd || req.user?.isAdmin) return next();
  next(httpError(404, "We couldn't find that page."));
});

// Example data for the kit only.
const SUPPLIERS = ['Mabati Steel Mills', 'Doshi Hardware', 'Kens Metal Industries', 'Steelmakers Ltd', 'Apex Steel', 'Devki Steel Mills', 'Tononoka Steel', 'Nail & Steel Products'];

router.get('/dev/ui', (req, res) => {
  res.render('dev/views/ui', {
    title: 'UI kit',
    suppliers: SUPPLIERS,
    // The "with errors" column shows what a failed save looks like.
    errors: { name: 'Enter the customer’s name', phone: 'Use a format like 0712 345 678', amount: 'Enter an amount, e.g. 12,500', reason: 'Choose a reason' },
  });
});

// Answers the searchable dropdown example as you type.
router.get('/dev/ui/suppliers', (req, res) => {
  const q = String(req.query.q ?? '').toLowerCase();
  res.json(SUPPLIERS.filter((s) => s.toLowerCase().includes(q)).map((s) => ({ value: s, label: s })));
});
