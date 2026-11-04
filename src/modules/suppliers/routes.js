import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { check, httpError, optionalEmail, optionalPhone, optionalText } from '../../core/validate.js';
import * as suppliers from './service.js';
import { ordersForSupplier, STATUSES as ORDER_STATUSES } from '../purchasing/service.js';

// Suppliers: who Jome-Tech buys from, and what has been ordered from them.

export const router = Router();
const view = canAny('purchasing.manage', 'purchasing.approve');
const manage = canAny('purchasing.manage');

const supplierSchema = z.object({
  name: z.string().trim().min(2, 'Enter the supplier’s name').max(120, 'Use 120 characters or fewer').transform((v) => v.replace(/\s+/g, ' ')),
  contact_person: optionalText(100),
  phone: optionalPhone(),
  email: optionalEmail(),
  address: optionalText(255),
  kra_pin: optionalText(20).transform((v) => v && v.toUpperCase())
    .refine((v) => v === null || /^[A-Z]\d{9}[A-Z]$/.test(v), 'A KRA PIN looks like P052233213I'),
  payment_terms: optionalText(120),
  materials: optionalText(255),
  notes: optionalText(2000),
});

const blank = () => ({ name: '', contact_person: '', phone: '', email: '', address: '', kra_pin: '', payment_terms: '', materials: '', notes: '' });

function renderForm(res, { status = 200, supplier = null, values, errors = {}, existingId = null }) {
  res.status(status).render('suppliers/views/form', { title: supplier ? `Edit ${supplier.name}` : 'New supplier', supplier, values, errors, existingId });
}

async function loadSupplier(req) {
  const id = Number(req.params.id);
  const supplier = Number.isInteger(id) ? await suppliers.getSupplier(id) : null;
  if (!supplier) throw httpError(404, 'That supplier doesn’t exist.');
  return supplier;
}

router.get('/suppliers', view, async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  const status = suppliers.STATUSES.includes(req.query.status) ? req.query.status : 'active';
  res.render('suppliers/views/index', { title: 'Suppliers', q, status, list: await suppliers.listSuppliers({ status, q }), canManage: req.user.can('purchasing.manage') });
});

router.get('/suppliers/new', manage, (req, res) => renderForm(res, { values: blank() }));

router.post('/suppliers', manage, async (req, res) => {
  const values = { ...blank(), ...req.body };
  const { data, errors } = check(supplierSchema, req.body);
  if (errors) return renderForm(res, { status: 422, values, errors });
  try {
    const { id, number } = await suppliers.createSupplier(data, req);
    req.session.flash = { type: 'success', text: `${data.name} added as ${number}.` };
    res.redirect(`/suppliers/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(res, { status: 422, values, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
});

router.get('/suppliers/:id', view, async (req, res) => {
  const supplier = await loadSupplier(req);
  res.render('suppliers/views/show', {
    title: supplier.name, supplier,
    orders: await ordersForSupplier(supplier.id, req.user.sites.map((s) => s.id)), orderStatuses: ORDER_STATUSES,
    entries: await history('supplier', supplier.id),
    canManage: req.user.can('purchasing.manage'),
  });
});

router.get('/suppliers/:id/edit', manage, async (req, res) => {
  const supplier = await loadSupplier(req);
  const values = Object.fromEntries(Object.keys(blank()).map((k) => [k, supplier[k] ?? '']));
  if (values.phone) values.phone = res.locals.fmt.phone(values.phone);
  renderForm(res, { supplier, values });
});

router.post('/suppliers/:id', manage, async (req, res) => {
  const supplier = await loadSupplier(req);
  const values = { ...blank(), ...req.body };
  const { data, errors } = check(supplierSchema, req.body);
  if (errors) return renderForm(res, { status: 422, supplier, values, errors });
  try {
    await suppliers.updateSupplier(supplier.id, data, req);
    req.session.flash = { type: 'success', text: `Saved changes to ${data.name}.` };
    res.redirect(`/suppliers/${supplier.id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(res, { status: 422, supplier, values, errors: { [err.field]: err.message }, existingId: err.existingId });
  }
});

async function setActive(req, res, active) {
  const supplier = await loadSupplier(req);
  await suppliers.setActive(supplier.id, active, req);
  req.session.flash = { type: 'success', text: `${supplier.name} switched ${active ? 'back on' : 'off'}.` };
  res.redirect(`/suppliers/${supplier.id}`);
}
router.post('/suppliers/:id/switch-off', manage, (req, res) => setActive(req, res, false));
router.post('/suppliers/:id/switch-on', manage, (req, res) => setActive(req, res, true));

// The dropdown on a purchase order.
router.get('/api/suppliers', view, async (req, res) => {
  res.json(await suppliers.lookupSuppliers(String(req.query.q ?? '')));
});

// Added in place from a purchase order: name and phone are enough. Returns the new option.
router.post('/api/suppliers', manage, async (req, res) => {
  const { data, errors } = check(supplierSchema.pick({ name: true, phone: true }), req.body ?? {});
  if (errors) return res.status(422).json({ errors });
  try {
    const { id, number } = await suppliers.createSupplier(data, req);
    res.status(201).json({ value: id, label: `${data.name} (${number})` });
  } catch (err) {
    if (!err.field) throw err;
    res.status(422).json({ errors: { [err.field]: err.message } });
  }
});
