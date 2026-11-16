import { Router } from 'express';
import { config } from '../../config.js';
import { quickActions, sectionsFor } from './service.js';
import { alertsFor } from './alerts.js';

export const router = Router();

function greeting(now) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: config.timezone }).format(now));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

router.get('/', async (req, res) => {
  const now = new Date();
  const alerts = await alertsFor(req.user, req.site);
  res.render('dashboard/views/index', {
    title: 'Dashboard',
    greeting: `${greeting(now)}, ${req.user.name.split(' ')[0]}`,
    today: now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone }),
    alerts: alerts.groups,
    sections: await sectionsFor(req.user, req.site, alerts.totals),
    actions: quickActions(req.user),
  });
});
