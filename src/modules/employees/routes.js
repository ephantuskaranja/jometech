import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { isDay } from '../../core/dates.js';
import { check, httpError, optionalAmount, optionalPhone, optionalText, optionalIdNo } from '../../core/validate.js';
import * as employees from './service.js';
import { recentFor, STATUSES as ATTENDANCE } from '../attendance/service.js';

// Employees: supervisors add and update their staff; pay (the daily rate) is for managers and admins.

export const router = Router();
const manage = canAny('attendance.manage', 'payroll.manage', 'payroll.approve');
const seesPay = (req) => req.user.can('payroll.manage') || req.user.can('payroll.approve');

const employeeSchema = z.object({
  name: z.string().trim().min(2, 'Enter their name').max(100, 'Use 100 characters or fewer').transform((v) => v.replace(/\s+/g, ' ')),
  phone: optionalPhone(),
  id_no: optionalIdNo(),
  trade: optionalText(40),
  site_id: z.coerce.number({ message: 'Choose a site' }).int().positive('Choose a site'),
  category: z.enum(Object.keys(employees.CATEGORIES)).catch('casual'),
  daily_rate: optionalAmount(99_999),
  joined_on: z.string().trim().optional().refine((v) => !v || isDay(v), 'Check the date').transform((v) => v || null),
  mpesa_phone: optionalPhone(),
  emergency_name: optionalText(100),
  emergency_phone: optionalPhone(),
  notes: optionalText(2000),
  clock_ids: optionalText(200).transform((v) => employees.parseClockIds(v)),
});

const blank = (req) => ({
  name: '', phone: '', id_no: '', trade: '', site_id: req.site?.id ?? '', category: 'casual', daily_rate: '', joined_on: '',
  mpesa_phone: '', emergency_name: '', emergency_phone: '', notes: '', clock_ids: '',
});

const worksAt = (req, siteId) => req.user.sites.some((s) => s.id === siteId);

async function loadEmployee(req) {
  const id = Number(req.params.id);
  const employee = Number.isInteger(id) ? await employees.getEmployee(id) : null;
  if (!employee) throw httpError(404, 'That employee doesn’t exist.');
  if (!worksAt(req, employee.site_id)) throw httpError(403, `${employee.name} works at ${employee.site_name}, which isn’t one of your sites.`);
  return employee;
}

function validate(req) {
  const { data, errors } = check(employeeSchema, req.body);
  const all = { ...errors };
  if (data && !worksAt(req, data.site_id)) all.site_id = 'Choose one of your sites';
  return { data, errors: Object.keys(all).length ? all : null };
}

function renderForm(req, res, { status = 200, employee = null, values, errors = {} }) {
  res.status(status).render('employees/views/form', {
    title: employee ? `Edit ${employee.name}` : 'New employee',
    employee, values, errors,
    sites: req.user.sites.map((s) => ({ value: s.id, label: s.name })),
    trades: employees.TRADES, categories: employees.CATEGORIES,
    canSeePay: seesPay(req),
  });
}

router.get('/employees', manage, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const status = employees.STATUSES.includes(req.query.status) ? req.query.status : 'active';
  const siteId = req.user.sites.some((s) => s.id === Number(req.query.site)) ? Number(req.query.site) : null;
  res.render('employees/views/index', {
    title: 'Employees', q, status, siteId,
    sites: req.user.sites,
    list: await employees.listEmployees({ siteIds: req.user.sites.map((s) => s.id), siteId, status, q }),
    categories: employees.CATEGORIES,
    canSeePay: seesPay(req),
  });
});

router.get('/employees/new', manage, (req, res) => renderForm(req, res, { values: blank(req) }));

router.post('/employees', manage, async (req, res) => {
  const values = { ...blank(req), ...req.body };
  const { data, errors } = validate(req);
  if (errors) return renderForm(req, res, { status: 422, values, errors });
  try {
    const { id, number } = await employees.createEmployee(data, req, { withRate: seesPay(req) });
    req.session.flash = { type: 'success', text: `${data.name} added as ${number}.` };
    res.redirect(`/employees/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(req, res, { status: 422, values, errors: { [err.field]: err.message } });
  }
});

router.get('/employees/:id', manage, async (req, res) => {
  const employee = await loadEmployee(req);
  res.render('employees/views/show', {
    title: employee.name, employee,
    categories: employees.CATEGORIES,
    canSeePay: seesPay(req),
    attendance: await recentFor(employee.id), attendanceStatuses: ATTENDANCE,
    // Pay changes stay out of the history for those who can't see pay.
    entries: seesPay(req) ? await history('employee', employee.id) : withoutPay(await history('employee', employee.id)),
  });
});

/** The history without pay changes: an entry that only changed the rate disappears. */
function withoutPay(entries) {
  return entries.flatMap((e) => {
    if (!e.changes?.daily_rate) return [e];
    const { daily_rate: _hidden, ...rest } = e.changes;
    return Object.keys(rest).length ? [{ ...e, changes: rest }] : [];
  });
}

router.get('/employees/:id/edit', manage, async (req, res) => {
  const employee = await loadEmployee(req);
  const values = Object.fromEntries(Object.keys(blank(req)).map((k) => [k, employee[k] ?? '']));
  for (const k of ['phone', 'mpesa_phone', 'emergency_phone']) if (values[k]) values[k] = res.locals.fmt.phone(values[k]);
  values.clock_ids = employee.clock_ids.join(', ');
  values.daily_rate = employee.daily_rate === null ? '' : String(Number(employee.daily_rate));
  renderForm(req, res, { employee, values });
});

router.post('/employees/:id', manage, async (req, res) => {
  const employee = await loadEmployee(req);
  const values = { ...blank(req), ...req.body };
  const { data, errors } = validate(req);
  if (errors) return renderForm(req, res, { status: 422, employee, values, errors });
  try {
    await employees.updateEmployee(employee.id, data, req, { withRate: seesPay(req) });
    req.session.flash = { type: 'success', text: `Saved changes to ${data.name}.` };
    res.redirect(`/employees/${employee.id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(req, res, { status: 422, employee, values, errors: { [err.field]: err.message } });
  }
});

async function setActive(req, res, active) {
  const employee = await loadEmployee(req);
  await employees.setActive(employee.id, active, req);
  req.session.flash = { type: 'success', text: active ? `${employee.name} is back on the staff list.` : `${employee.name} marked as left. Their attendance is kept.` };
  res.redirect(`/employees/${employee.id}`);
}
router.post('/employees/:id/left', manage, (req, res) => setActive(req, res, false));
router.post('/employees/:id/back', manage, (req, res) => setActive(req, res, true));
