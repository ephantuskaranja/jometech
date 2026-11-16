import { Router } from 'express';
import { z } from 'zod';
import { can } from '../../core/auth.js';
import { check, httpError } from '../../core/validate.js';
import { isDay, localDay } from '../../core/dates.js';
import { listSites } from '../sites/service.js';
import * as costing from './service.js';

// System → Closed days: the days the workshop didn't work (Christmas …). Left out of a job's work days.
export const router = Router();
router.use('/admin/closed-days', can('system.settings'));

const daySchema = z.object({
  day: z.string().trim().refine(isDay, 'Choose the day'),
  site_id: z.string().trim().optional().transform((v) => (v ? Number(v) : null)),
  reason: z.string().trim().min(2, 'Say why it was closed, e.g. Christmas').max(100, 'Use 100 characters or fewer'),
});

async function render(res, { status = 200, values = { day: '', site_id: '', reason: '' }, errors = {} } = {}) {
  const list = await costing.listClosedDays();
  const today = localDay();
  res.status(status).render('costing/views/closed-days', {
    title: 'Closed days', values, errors, today,
    coming: list.filter((d) => d.day >= today).reverse(), past: list.filter((d) => d.day < today),
    sites: (await listSites()).filter((s) => s.is_active),
  });
}

router.get('/admin/closed-days', (req, res) => render(res));

router.post('/admin/closed-days', async (req, res) => {
  const { data, errors } = check(daySchema, req.body);
  if (errors) return render(res, { status: 422, values: req.body, errors });
  try {
    await costing.addClosedDay(data, req);
  } catch (err) {
    if (!err.field) throw err;
    return render(res, { status: 422, values: req.body, errors: { [err.field]: err.message } });
  }
  req.session.flash = { type: 'success', text: `${data.day} marked as closed. Jobs don’t count it as a work day.` };
  res.redirect('/admin/closed-days');
});

router.post('/admin/closed-days/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(404, 'That closed day doesn’t exist.');
  await costing.removeClosedDay(id, req);
  req.session.flash = { type: 'success', text: 'Closed day removed. Jobs count it as a work day again.' };
  res.redirect('/admin/closed-days');
});
