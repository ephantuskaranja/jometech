import { Router } from 'express';
import multer from 'multer';
import { canAny } from '../../core/auth.js';
import { httpError } from '../../core/validate.js';
import { isDay, localDay } from '../../core/dates.js';
import { config } from '../../config.js';
import * as attendance from './service.js';
import { FLAGS } from './day.js';
import { readPunchFile } from './read-punches.js';
import { listEmployees } from '../employees/service.js';

// Attendance: import the clock-in machines' export, link unknown clock IDs, and mark each site's day.

export const router = Router();
const manage = canAny('attendance.manage');
const reopen = canAny('payroll.manage', 'payroll.approve'); // managers and admins
const machines = canAny('payroll.manage', 'system.settings');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).single('file');
const receiveFile = (req, res) => new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve(req.file))));

/** The site and day being looked at: ?site (one of the user's sites, else the current one) and ?day (not in the future). */
function choice(req, source = req.query) {
  const today = localDay();
  const site = req.user.sites.find((s) => s.id === Number(source.site)) ?? req.site;
  if (!site) throw httpError(400, 'Choose the site you’re working at (top right) first.');
  const day = isDay(String(source.day ?? '')) && source.day <= today ? source.day : today;
  return { site, day, today };
}

const shiftDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

router.get('/attendance', manage, async (req, res) => {
  const { site, day, today } = choice(req);
  const grid = await attendance.dayGrid(site.id, day);
  res.render('attendance/views/day', {
    title: 'Attendance', site, day, today, grid,
    prev: shiftDay(day, -1), next: day < today ? shiftDay(day, 1) : null,
    statuses: attendance.STATUSES, flags: FLAGS, rules: config.attendance,
    sites: req.user.sites,
    last: grid.confirmation ? null : await attendance.lastDayBefore(site.id, day),
    canReopen: req.user.can('payroll.manage') || req.user.can('payroll.approve'),
    unknown: (await attendance.unknownClockIds()).length,
  });
});

router.post('/attendance', manage, async (req, res) => {
  const { site, day } = choice(req, req.body);
  const list = (key) => [].concat(req.body[key] ?? []).map((v) => String(v ?? ''));
  const [ids, statuses, notes] = ['row_employee', 'row_status', 'row_note'].map(list);
  const rows = ids.map((id, i) => ({ employee_id: Number(id), status: statuses[i] ?? '', note: (notes[i] ?? '').trim().slice(0, 255) || null }));
  const confirm = req.body.action === 'confirm';
  try {
    const { saved } = await attendance.saveDay(site.id, day, rows, req, { confirm });
    req.session.flash = { type: 'success', text: confirm ? `${site.name}, ${res.locals.fmt.date(`${day}T12:00:00Z`)}: confirmed. It is now ready for payroll.` : `Saved ${saved} ${saved === 1 ? 'person' : 'people'}. Confirm the day when everyone is marked.` };
  } catch (err) {
    if (!err.expose) throw err;
    req.session.flash = { type: 'warning', text: err.message };
  }
  res.redirect(`/attendance?site=${site.id}&day=${day}`);
});

router.post('/attendance/reopen', reopen, async (req, res) => {
  const { site, day } = choice(req, req.body);
  await attendance.reopenDay(site.id, day, req);
  req.session.flash = { type: 'warning', text: 'Reopened: the day can be changed again. Confirm it when done.' };
  res.redirect(`/attendance?site=${site.id}&day=${day}`);
});

// ---------- importing ----------

router.get('/attendance/import', manage, async (req, res) => {
  res.render('attendance/views/import', {
    title: 'Import attendance',
    imports: await attendance.recentImports(),
    devices: await attendance.devices(),
    unknown: await attendance.unknownClockIds(),
    staff: await listEmployees({ siteIds: req.user.sites.map((s) => s.id) }),
    currentSiteId: req.site?.id ?? req.user.sites[0]?.id,
    sites: req.user.sites, canSetMachines: req.user.can('payroll.manage') || req.user.can('system.settings'),
  });
});

// Sent by the page with fetch (the CSRF token goes in a header, as the body is a file); answers with where to go next.
router.post('/attendance/import', manage, async (req, res) => {
  let file;
  try {
    file = await receiveFile(req, res);
  } catch (err) {
    req.session.flash = { type: 'warning', text: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (over 10 MB).' : 'The file didn’t come through. Try again.' };
    return res.json({ go: '/attendance/import' });
  }
  if (!file) {
    req.session.flash = { type: 'warning', text: 'Choose the file exported from the clock-in machine first.' };
    return res.json({ go: '/attendance/import' });
  }
  const { punches, skipped, error } = await readPunchFile(file.buffer, file.originalname);
  if (error || !punches.length) {
    req.session.flash = { type: 'warning', text: error ?? 'No punches were found in that file.' };
    return res.json({ go: '/attendance/import' });
  }
  const r = await attendance.importPunches({ punches, fileName: file.originalname }, req);
  const span = r.firstDay === r.lastDay ? r.firstDay : `${r.firstDay} to ${r.lastDay}`;
  req.session.flash = { type: 'success', text: `${r.added} new punches imported (${span}).${r.rows - r.added ? ` ${r.rows - r.added} were already in.` : ''}${skipped ? ` ${skipped} rows couldn’t be read.` : ''}` };
  res.json({ go: '/attendance/import' });
});

router.post('/attendance/clock-ids', manage, async (req, res) => {
  const list = (key) => [].concat(req.body[key] ?? []).map((v) => String(v ?? ''));
  const [ids, choices, names, siteIds] = ['clock_id', 'choice', 'clock_name', 'site_id'].map(list);
  const mySites = new Set(req.user.sites.map((s) => s.id));
  const picked = ids.map((clock_id, i) => ({ clock_id, choice: choices[i], name: names[i] || null, site_id: Number(siteIds[i]) }))
    .filter((c) => c.choice && (c.choice !== 'new' || mySites.has(c.site_id)));
  if (!picked.length) {
    req.session.flash = { type: 'warning', text: 'Nothing chosen: pick an employee, or “Add as new”, for at least one clock ID.' };
    return res.redirect('/attendance/import#unknown');
  }
  const { linked, created } = await attendance.linkClockIds(picked, req);
  req.session.flash = { type: 'success', text: `${linked} clock ${linked === 1 ? 'ID' : 'IDs'} linked${created ? `, ${created} new ${created === 1 ? 'employee' : 'employees'} added. Add their trade and daily rate on the Employees page` : ''}.` };
  res.redirect('/attendance/import#unknown');
});

router.post('/attendance/machines/:id', machines, async (req, res) => {
  const siteId = Number(req.body.site_id) || null;
  await attendance.setDeviceSite(Number(req.params.id), siteId, req);
  req.session.flash = { type: 'success', text: 'Machine’s site saved. Its punches now count for that site.' };
  res.redirect('/attendance/import#machines');
});
