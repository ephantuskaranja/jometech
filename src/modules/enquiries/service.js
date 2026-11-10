import { db } from '../../core/db.js';
import { countTabs } from '../../core/count-tabs.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { localDay } from '../../core/dates.js';
import { normalizePhone } from '../../core/phone.js';
import { httpError } from '../../core/validate.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { createCustomer } from '../customers/service.js';

// Enquiries, mostly phone calls. A caller who isn't a customer yet stays a
// prospect (caller_name / caller_phone) until "Add as customer".
//
//   open ──▶ quoted (proforma sent, step 11) ──▶ won | lost (with a reason)

export const SOURCES = [
  { value: 'call', label: 'Phone call' },
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'referral', label: 'Referral' },
  { value: 'other', label: 'Other' },
];
export const sourceLabel = (v) => SOURCES.find((s) => s.value === v)?.label ?? v;

export const STATUSES = {
  open: { label: 'Open', tone: 'info' },
  quoted: { label: 'Proforma sent', tone: 'warn' },
  won: { label: 'Won', tone: 'ok' },
  lost: { label: 'Lost', tone: 'neutral' },
};

export const LOST_REASONS = ['Price too high', 'Went elsewhere', 'No response', 'Changed their mind', 'Not something we do'];

/** List tabs. "follow" = still open and the follow-up day has come. */
export const TABS = ['follow', 'open', 'quoted', 'closed'];

const err = (status, message, field) => Object.assign(httpError(status, message), { field });

export function workTypes() {
  return db('enquiry_work_types').where({ is_active: true }).orderBy('sort_order').pluck('name');
}

/** A kind of work typed under "Other" becomes a quick pick, just before Other. Same name in other capitals: ignored. */
export async function addWorkType(name) {
  const other = await db('enquiry_work_types').where({ name: 'Other' }).first('sort_order');
  const [{ last }] = await db('enquiry_work_types').whereNot({ name: 'Other' }).max({ last: 'sort_order' });
  const sort = Math.min((last ?? 0) + 1, (other?.sort_order ?? 1000) - 1);
  await db('enquiry_work_types').insert({ name, sort_order: sort }).onConflict('name').ignore();
}

/** Customer and vehicle must exist, and the vehicle must be that customer's. */
async function checkLinks(trx, input) {
  if (input.customer_id && !(await trx('customers').where({ id: input.customer_id }).first('id'))) {
    throw err(422, 'That customer no longer exists.', 'customer_id');
  }
  if (input.vehicle_id) {
    const v = await trx('vehicles').where({ id: input.vehicle_id }).first('customer_id');
    if (!v || v.customer_id !== input.customer_id) throw err(422, 'Choose one of this customer’s vehicles', 'vehicle_id');
  }
}

const FIELDS = ['customer_id', 'caller_name', 'caller_phone', 'vehicle_id', 'vehicle_description', 'work_type', 'description', 'budget', 'source', 'follow_up_on'];
const pick = (input) => Object.fromEntries(FIELDS.map((k) => [k, input[k] ?? null]));

/** @returns {Promise<{ id: number, number: string }>} */
export async function createEnquiry(input, actor) {
  return db.transaction(async (trx) => {
    await checkLinks(trx, input);
    const number = await nextNumber(trx, 'enquiry');
    const [id] = await trx('enquiries').insert({
      ...pick(input), number, site_id: actor.site?.id ?? null, assigned_to: actor.user.id, created_by: actor.user.id,
    });
    await audit(trx, actor, { entity: 'enquiry', id, action: 'create', summary: `${input.work_type} for ${input.caller_name} (${number})` });
    return { id, number };
  });
}

export async function updateEnquiry(id, input, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('enquiries').where({ id }).forUpdate().first();
    if (!before) throw httpError(404, 'That enquiry doesn’t exist.');
    await checkLinks(trx, input);
    await trx('enquiries').where({ id }).update(pick(input));
    await audit(trx, actor, { entity: 'enquiry', id, action: 'update', summary: `Details changed (${before.number})` });
  });
}

/** A call back: what was said, and when to call next (null: no follow-up planned). */
export async function addNote(id, { note, follow_up_on }, actor) {
  await db.transaction(async (trx) => {
    const e = await trx('enquiries').where({ id }).forUpdate().first('id', 'number', 'status');
    if (!e) throw httpError(404, 'That enquiry doesn’t exist.');
    await trx('enquiry_notes').insert({ enquiry_id: id, note, follow_up_on, created_by: actor.user.id });
    // A closed enquiry keeps notes, but nothing to follow up.
    await trx('enquiries').where({ id }).update({ follow_up_on: ['won', 'lost'].includes(e.status) ? null : follow_up_on });
    await audit(trx, actor, { entity: 'enquiry', id, action: 'note', summary: follow_up_on ? `${note} (call again ${follow_up_on})` : note });
  });
}

/** Won (became a job) or lost (with a reason). */
export async function closeEnquiry(id, { status, lost_reason = null }, actor) {
  await db.transaction(async (trx) => {
    const e = await trx('enquiries').where({ id }).forUpdate().first('id', 'number', 'status');
    if (!e) throw httpError(404, 'That enquiry doesn’t exist.');
    if (['won', 'lost'].includes(e.status)) throw httpError(409, `${e.number} is already closed.`);
    await trx('enquiries').where({ id }).update({ status, lost_reason: status === 'lost' ? lost_reason : null, closed_at: trx.fn.now(), follow_up_on: null });
    await audit(trx, actor, { entity: 'enquiry', id, action: status, summary: status === 'lost' ? `Lost: ${lost_reason}` : `Won (${e.number})` });
  });
}

export async function reopenEnquiry(id, actor) {
  await db.transaction(async (trx) => {
    const e = await trx('enquiries').where({ id }).forUpdate().first('id', 'number', 'status');
    if (!e) throw httpError(404, 'That enquiry doesn’t exist.');
    if (!['won', 'lost'].includes(e.status)) throw httpError(409, `${e.number} is still open.`);
    await trx('enquiries').where({ id }).update({ status: 'open', lost_reason: null, closed_at: null });
    await audit(trx, actor, { entity: 'enquiry', id, action: 'reopened', summary: `Reopened (${e.number})` });
  });
}

/**
 * The prospect becomes a customer. A customer who already has that phone is
 * linked instead of making a second one. Returns the customer.
 */
export async function makeCustomer(id, actor) {
  const e = await db('enquiries').where({ id }).first();
  if (!e) throw httpError(404, 'That enquiry doesn’t exist.');
  if (e.customer_id) throw httpError(409, `${e.number} is already linked to a customer.`);
  if (!e.caller_phone) throw httpError(422, 'Add the caller’s phone number first (Edit), so the customer can be found again.');
  const existing = await db('customers').where({ phone: e.caller_phone }).first('id', 'number', 'name');
  const customer = existing ?? { ...(await createCustomer({ name: e.caller_name, phone: e.caller_phone, category: 'individual' }, actor)), name: e.caller_name };
  await db.transaction(async (trx) => {
    await trx('enquiries').where({ id }).update({ customer_id: customer.id });
    await audit(trx, actor, {
      entity: 'enquiry', id, action: 'customer_linked',
      summary: existing ? `Linked to existing customer ${customer.name} (${customer.number})` : `Added as customer ${customer.number}`,
    });
  });
  return { ...customer, existing: Boolean(existing) };
}

export async function getEnquiry(id) {
  const e = await db('enquiries as e')
    .leftJoin('customers as c', 'c.id', 'e.customer_id')
    .leftJoin('vehicles as v', 'v.id', 'e.vehicle_id')
    .leftJoin('users as a', 'a.id', 'e.assigned_to')
    .where('e.id', id)
    .first('e.*', 'c.name as customer_name', 'c.number as customer_number', 'c.phone as customer_phone',
      'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model', 'a.name as assigned_name');
  if (!e) return null;
  e.vehicle_label = e.vehicle_id ? vehicleLabel(e) : null;
  e.notes = await db('enquiry_notes as n').leftJoin('users as u', 'u.id', 'n.created_by')
    .where('n.enquiry_id', id).orderBy('n.id', 'desc').select('n.*', 'u.name as by_name');
  return e;
}

function tabFilter(q, tab, today) {
  if (tab === 'follow') q.whereIn('e.status', ['open', 'quoted']).where('e.follow_up_on', '<=', today);
  else if (tab === 'closed') q.whereIn('e.status', ['won', 'lost']);
  else q.where('e.status', tab);
}

export async function listEnquiries({ tab = 'follow', q = '' } = {}) {
  const today = localDay();
  const query = db('enquiries as e')
    .leftJoin('customers as c', 'c.id', 'e.customer_id')
    .leftJoin('users as a', 'a.id', 'e.assigned_to')
    .limit(200)
    .select('e.id', 'e.number', 'e.status', 'e.caller_name', 'e.caller_phone', 'e.work_type', 'e.description', 'e.budget',
      'e.follow_up_on', 'e.created_at', 'e.closed_at', 'e.lost_reason', 'e.customer_id', 'c.name as customer_name', 'a.name as assigned_name');
  const term = q.trim();
  if (term) {
    const phone = normalizePhone(term);
    query.where((w) => {
      w.where('e.number', 'like', `%${term}%`).orWhere('e.caller_name', 'like', `%${term}%`).orWhere('c.name', 'like', `%${term}%`)
        .orWhere('e.description', 'like', `%${term}%`).orWhere('e.work_type', 'like', `%${term}%`);
      if (phone) w.orWhere('e.caller_phone', phone).orWhere('c.phone', phone);
    });
  } else {
    tabFilter(query, tab, today);
  }
  if (tab === 'follow' && !term) query.orderBy('e.follow_up_on').orderBy('e.id');
  else if (tab === 'closed' && !term) query.orderBy('e.closed_at', 'desc');
  else query.orderBy('e.created_at', 'desc');
  return query;
}

export async function countByTab() {
  const today = localDay();
  return countTabs(TABS, (tab) => { const q = db('enquiries as e'); tabFilter(q, tab, today); return q; });
}

/** For the form's vehicle dropdown once a customer is chosen. */
export async function vehicleOptions(customerId) {
  const rows = await db('vehicles').where({ customer_id: customerId }).orderBy('reg_no').select('id', 'reg_no', 'chassis_no', 'temp_tag', 'make', 'model');
  return rows.map((v) => ({ value: v.id, label: [vehicleLabel(v), [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') }));
}
