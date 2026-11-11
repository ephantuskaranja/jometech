import { Router } from 'express';
import { canAny } from '../../core/auth.js';
import { httpError } from '../../core/validate.js';
import * as transfers from '../stock/transfers.js';

// The gate: goods going out and coming in (step 26). Guards (goods.gate) at their site:
//   transfers to another site leave → "Left the gate"; transfers from another site arrive → "Arrived at the gate".
// Stores can't receive a transfer until its arrival is logged here.
export const router = Router();
const gate = canAny('goods.gate');

function needSite(req) {
  if (!req.site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
}

const text = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || null;

router.get('/gate/goods', gate, async (req, res) => {
  needSite(req);
  const list = await transfers.atGate(req.site.id);
  res.render('gate/views/goods', {
    title: 'Goods at the gate',
    leaving: list.filter((t) => t.leaving),
    arriving: list.filter((t) => !t.leaving),
  });
});

async function step(req, res, fn, done) {
  needSite(req);
  try {
    const t = await fn();
    req.session.flash = { type: 'success', text: done(t) };
  } catch (err) {
    if (![403, 409].includes(err.status)) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(req.body.back === 'transfer' ? `/inventory/transfers/${req.params.id}` : '/gate/goods');
}

router.post('/gate/transfers/:id/out', gate, (req, res) => step(req, res,
  () => transfers.gateOut(Number(req.params.id), req.site.id, req),
  (t) => `${t.number} left the gate.`));

router.post('/gate/transfers/:id/in', gate, (req, res) => step(req, res,
  () => transfers.gateIn(Number(req.params.id), req.site.id, text(req.body.note, 255), req),
  (t) => `${t.number} logged in at the gate. Stores can receive it now.`));
