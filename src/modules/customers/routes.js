import { Router } from 'express';
import { z } from 'zod';
import { canAny } from '../../core/auth.js';
import { VIEW_CUSTOMERS, EDIT_CUSTOMERS, EDIT_VEHICLES } from '../../core/access.js';
import { history } from '../../core/audit.js';
import { formatKraPin } from '../../core/vehicle-format.js';
import { check, httpError, optionalEmail, optionalPhone, optionalText, phoneField } from '../../core/validate.js';
import * as customers from './service.js';
import { typeLabel } from '../vehicles/service.js';

export const router = Router();
const view = canAny(...VIEW_CUSTOMERS);
const edit = canAny(...EDIT_CUSTOMERS);

// ---------- Validation ----------

const customerSchema = z.object({
  name: z.string().trim().min(2, 'Enter the customer’s name').max(150, 'Use 150 characters or fewer'),
  phone: phoneField('Enter a phone number'),
  category: z.enum(customers.CATEGORIES.map((c) => c.value)).catch('individual'),
  email: optionalEmail(),
  kra_pin: optionalText(20)
    .refine((v) => v === null || formatKraPin(v), 'A KRA PIN looks like A123456789B')
    .transform((v) => v && formatKraPin(v)),
  town: optionalText(80),
  address: optionalText(255),
  credit_days: z.coerce.number().int().refine((v) => customers.CREDIT_TERMS.some((c) => c.value === v), 'Choose the credit terms').catch(0),
  notes: optionalText(2000),
});

const contactSchema = z.object({
  name: z.string().trim().min(2, 'Enter the contact’s name').max(100),
  role: optionalText(60),
  phone: optionalPhone(),
  email: optionalEmail(),
});

// On the "add customer" form a company can enter its first contact straight away.
const firstContactSchema = z.object({
  contact_name: optionalText(100),
  contact_role: optionalText(60),
  contact_phone: optionalPhone(),
});

const blank = { name: '', phone: '', category: 'individual', email: '', kra_pin: '', town: '', address: '', credit_days: 0, notes: '', contact_name: '', contact_role: '', contact_phone: '' };

function renderForm(res, { status = 200, customer = null, values, errors = {} }) {
  res.status(status).render('customers/views/form', {
    title: customer ? `Edit ${customer.name}` : 'Add customer',
    customer, values, errors,
    categories: customers.CATEGORIES,
    creditTerms: customers.CREDIT_TERMS,
  });
}

async function loadCustomer(req) {
  const customer = await customers.getCustomer(Number(req.params.id));
  if (!customer) throw httpError(404, 'That customer doesn’t exist.');
  return customer;
}

// ---------- List ----------

router.get('/customers', view, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const category = customers.CATEGORIES.some((c) => c.value === req.query.category) ? req.query.category : '';
  res.render('customers/views/index', {
    title: 'Customers',
    list: await customers.listCustomers({ q, category }),
    q, category,
    categories: customers.CATEGORIES,
    categoryLabel: customers.categoryLabel,
  });
});

// ---------- Add ----------

router.get('/customers/new', edit, (req, res) => {
  renderForm(res, { values: { ...blank, name: String(req.query.name ?? '') } });
});

router.post('/customers', edit, async (req, res) => {
  const values = { ...blank, ...req.body };
  const main = check(customerSchema, req.body);
  const first = check(firstContactSchema, req.body);
  const errors = { ...main.errors, ...first.errors };
  if (main.errors || first.errors) return renderForm(res, { status: 422, values, errors });

  const c = first.data;
  const contact = main.data.category !== 'individual' && c.contact_name ? { name: c.contact_name, role: c.contact_role, phone: c.contact_phone } : null;
  try {
    const { id, number } = await customers.createCustomer(main.data, req, { contact });
    req.session.flash = { type: 'success', text: `${main.data.name} added as ${number}.` };
    res.redirect(`/customers/${id}`);
  } catch (err) {
    if (!err.field) throw err;
    renderForm(res, { status: 422, values, errors: { [err.field]: err.message } });
  }
});

// ---------- Detail page (tabs) ----------

const TABS = ['overview', 'vehicles', 'contacts', 'history'];

router.get('/customers/:id', view, async (req, res) => {
  const customer = await loadCustomer(req);
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'overview';
  const [contacts, vehicles] = await Promise.all([customers.listContacts(customer.id), customers.vehiclesOf(customer.id)]);
  res.render('customers/views/show', {
    title: customer.name,
    customer, contacts, vehicles, tab,
    entries: tab === 'history' ? await history('customer', customer.id) : [],
    canEdit: req.user.can('customers.manage') || req.user.isAdmin,
    canAddVehicle: EDIT_VEHICLES.some((p) => req.user.can(p)),
    categoryLabel: customers.categoryLabel,
    creditLabel: customers.creditLabel,
    typeLabel,
    contactErrors: {},
  });
});

// ---------- Edit ----------

router.get('/customers/:id/edit', edit, async (req, res) => {
  const customer = await loadCustomer(req);
  renderForm(res, { customer, values: { ...blank, ...customer, email: customer.email ?? '', kra_pin: customer.kra_pin ?? '' } });
});

router.post('/customers/:id', edit, async (req, res) => {
  const customer = await loadCustomer(req);
  const values = { ...blank, ...req.body };
  const { data, errors } = check(customerSchema, req.body);
  if (errors) return renderForm(res, { status: 422, customer, values, errors });
  try {
    await customers.updateCustomer(customer.id, data, req);
  } catch (err) {
    if (!err.field) throw err;
    return renderForm(res, { status: 422, customer, values, errors: { [err.field]: err.message } });
  }
  req.session.flash = { type: 'success', text: `Saved changes to ${data.name}.` };
  res.redirect(`/customers/${customer.id}`);
});

// ---------- Contacts ----------

router.post('/customers/:id/contacts', edit, async (req, res) => {
  const customer = await loadCustomer(req);
  const { data, errors } = check(contactSchema, req.body);
  if (errors) {
    req.session.flash = { type: 'warning', text: Object.values(errors)[0] };
  } else {
    await customers.addContact(customer.id, data, req);
    req.session.flash = { type: 'success', text: `${data.name} added as a contact.` };
  }
  res.redirect(`/customers/${customer.id}?tab=contacts`);
});

router.post('/customers/:id/contacts/:contactId', edit, async (req, res) => {
  const customer = await loadCustomer(req);
  const { data, errors } = check(contactSchema, req.body);
  if (errors) {
    req.session.flash = { type: 'warning', text: Object.values(errors)[0] };
  } else {
    await customers.updateContact(customer.id, Number(req.params.contactId), data, req);
    req.session.flash = { type: 'success', text: `Saved ${data.name}.` };
  }
  res.redirect(`/customers/${customer.id}?tab=contacts`);
});

router.post('/customers/:id/contacts/:contactId/delete', edit, async (req, res) => {
  const customer = await loadCustomer(req);
  await customers.removeContact(customer.id, Number(req.params.contactId), req);
  req.session.flash = { type: 'success', text: 'Contact removed. Vehicles they brought in are kept.' };
  res.redirect(`/customers/${customer.id}?tab=contacts`);
});

// ---------- JSON for forms (searchable dropdowns, warnings, quick add) ----------

router.get('/api/customers', view, async (req, res) => {
  res.json(await customers.lookupCustomers(String(req.query.q ?? '')));
});

// "Existing customer: ABC Transport. Use this?"
router.get('/api/customers/check-phone', view, async (req, res) => {
  const except = Number(req.query.except) || null;
  res.json({ matches: await customers.findByPhone(String(req.query.phone ?? ''), except) });
});

router.get('/api/customers/:id/contacts', view, async (req, res) => {
  const contacts = await customers.listContacts(Number(req.params.id));
  res.json(contacts.map((c) => ({ value: c.id, label: [c.name, c.role].filter(Boolean).join(' · ') })));
});

// Quick add from the vehicle form: name, phone, category. Returns the new option.
router.post('/api/customers', canAny(...EDIT_VEHICLES), async (req, res) => {
  const { data, errors } = check(customerSchema.pick({ name: true, phone: true, category: true }), req.body ?? {});
  if (errors) return res.status(422).json({ errors });
  const { id, number } = await customers.createCustomer(data, req);
  res.status(201).json({ value: id, label: `${data.name} (${number})`, category: data.category });
});
