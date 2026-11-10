import { db } from '../../core/db.js';
import { countTabs } from '../../core/count-tabs.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { config } from '../../config.js';
import { httpError } from '../../core/validate.js';
import { localDay } from '../../core/dates.js';
import { vehicleLabel } from '../../core/vehicle-format.js';

// Proforma invoices: what the customer is offered, at what price (VAT included).
//
//   draft (editable) ──▶ sent (locked) ──▶ accepted | declined
//   sent or declined ──"Revise"──▶ 490-R1 (a draft copy); 490 becomes "replaced"
//
// The enquiry it came from follows along: sent → "Proforma sent", accepted → won,
// declined → lost.

export const STATUSES = {
  draft: { label: 'Draft', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'ok' },
  declined: { label: 'Declined', tone: 'bad' },
  replaced: { label: 'Replaced', tone: 'neutral' },
};

/** List tabs. "closed" = accepted or declined; "all" includes replaced ones. */
export const TABS = ['draft', 'sent', 'closed', 'all'];

export const DECLINE_REASONS = ['Price too high', 'Went elsewhere', 'No response', 'Changed their mind'];

const err = (status, message, field) => Object.assign(httpError(status, message), { field });

/** The VAT inside a VAT-inclusive amount: 116 at 16% → 16. */
export const vatIn = (total) => Math.round((Number(total) * config.vatRate / (100 + config.vatRate)) * 100) / 100;

/** Customer and vehicle must exist, and the vehicle must be that customer's. */
async function checkLinks(trx, input) {
  if (!(await trx('customers').where({ id: input.customer_id }).first('id'))) throw err(422, 'That customer no longer exists.', 'customer_id');
  if (input.vehicle_id) {
    const v = await trx('vehicles').where({ id: input.vehicle_id }).first('customer_id');
    if (!v || v.customer_id !== input.customer_id) throw err(422, 'Choose one of this customer’s vehicles', 'vehicle_id');
  }
  if (input.enquiry_id && !(await trx('enquiries').where({ id: input.enquiry_id }).first('id'))) throw err(422, 'That enquiry no longer exists.', 'enquiry_id');
}

const FIELDS = ['enquiry_id', 'customer_id', 'vehicle_id', 'vehicle_description', 'proforma_date', 'notes'];
const pick = (input) => Object.fromEntries(FIELDS.map((k) => [k, input[k] ?? null]));
const totalOf = (lines) => Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;

async function writeLines(trx, proformaId, lines) {
  await trx('proforma_lines').where({ proforma_id: proformaId }).delete();
  if (lines.length) {
    await trx('proforma_lines').insert(lines.map((l, i) => ({
      proforma_id: proformaId, sort_order: i + 1, quantity: l.quantity, unit: l.unit, description: l.description, unit_price: l.unit_price, amount: l.amount,
    })));
  }
}

/** Moves the enquiry along, unless it is already further on (or closed for another reason). */
async function enquiryTo(trx, actor, enquiryId, status, { from, reason = null, summary }) {
  if (!enquiryId) return;
  const e = await trx('enquiries').where({ id: enquiryId }).forUpdate().first('id', 'status');
  if (!e || !from.includes(e.status)) return;
  const closing = ['won', 'lost'].includes(status);
  await trx('enquiries').where({ id: enquiryId }).update({
    status, lost_reason: status === 'lost' ? reason : null, closed_at: closing ? trx.fn.now() : null, ...(closing ? { follow_up_on: null } : {}),
  });
  await audit(trx, actor, { entity: 'enquiry', id: enquiryId, action: status === 'quoted' ? 'quoted' : status === 'open' ? 'reopened' : status, summary });
}

/** @returns {Promise<{ id: number, number: string }>} */
export async function createProforma(input, actor) {
  return db.transaction(async (trx) => {
    await checkLinks(trx, input);
    const number = await nextNumber(trx, 'proforma');
    const [id] = await trx('proformas').insert({
      ...pick(input), number, base_no: Number(number), revision: 0, total: totalOf(input.lines),
      site_id: actor.site?.id ?? null, created_by: actor.user.id,
    });
    await writeLines(trx, id, input.lines);
    const copied = input.copied_from ? ` (copied from ${input.copied_from})` : '';
    await audit(trx, actor, { entity: 'proforma', id, action: 'create', summary: `Proforma ${number}, KES ${totalOf(input.lines).toLocaleString('en-KE')}${copied}` });
    return { id, number };
  });
}

/** Only a draft can be changed; once sent, changes go in a revision. */
export async function updateProforma(id, input, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('proformas').where({ id }).forUpdate().first();
    if (!before) throw httpError(404, 'That proforma doesn’t exist.');
    if (before.status !== 'draft') throw httpError(409, `${before.number} has been sent, so it can’t be changed. Use “Revise” to make a new version.`);
    await checkLinks(trx, input);
    await trx('proformas').where({ id }).update({ ...pick(input), total: totalOf(input.lines) });
    await writeLines(trx, id, input.lines);
    await audit(trx, actor, { entity: 'proforma', id, action: 'update', summary: `Details changed (${before.number}), now KES ${totalOf(input.lines).toLocaleString('en-KE')}` });
  });
}

/** Given to the customer: locked from now on. */
export async function markSent(id, actor) {
  await db.transaction(async (trx) => {
    const p = await trx('proformas').where({ id }).forUpdate().first();
    if (!p) throw httpError(404, 'That proforma doesn’t exist.');
    if (p.status !== 'draft') throw httpError(409, `${p.number} has already been sent.`);
    const lines = await trx('proforma_lines').where({ proforma_id: id }).count({ n: '*' });
    if (!Number(lines[0].n)) throw httpError(422, 'Add at least one line before sending it.');
    await trx('proformas').where({ id }).update({ status: 'sent', sent_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'proforma', id, action: 'proforma_sent', summary: `Sent to the customer (${p.number})` });
    await enquiryTo(trx, actor, p.enquiry_id, 'quoted', { from: ['open'], summary: `Proforma ${p.number} sent` });
  });
}

/** The customer said yes, or no (with a reason). */
export async function closeProforma(id, { status, reason = null }, actor) {
  await db.transaction(async (trx) => {
    const p = await trx('proformas').where({ id }).forUpdate().first();
    if (!p) throw httpError(404, 'That proforma doesn’t exist.');
    if (p.status !== 'sent') throw httpError(409, `Only a sent proforma can be ${status}. ${p.number} is ${STATUSES[p.status].label.toLowerCase()}.`);
    await trx('proformas').where({ id }).update({ status, declined_reason: status === 'declined' ? reason : null, closed_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'proforma', id, action: status, summary: status === 'declined' ? `Declined: ${reason}` : `Accepted (${p.number})` });
    if (status === 'accepted') await enquiryTo(trx, actor, p.enquiry_id, 'won', { from: ['open', 'quoted'], summary: `Won: proforma ${p.number} accepted` });
    else await enquiryTo(trx, actor, p.enquiry_id, 'lost', { from: ['open', 'quoted'], reason, summary: `Lost: proforma ${p.number} declined (${reason})` });
  });
}

/**
 * A new version of a sent (or declined) proforma: 490 → 490-R1, a draft with
 * the same lines. The old one stays as it was sent, marked "replaced".
 * @returns {Promise<{ id: number, number: string }>}
 */
export async function reviseProforma(id, actor) {
  return db.transaction(async (trx) => {
    const p = await trx('proformas').where({ id }).forUpdate().first();
    if (!p) throw httpError(404, 'That proforma doesn’t exist.');
    if (!['sent', 'declined'].includes(p.status)) {
      throw httpError(409, p.status === 'draft' ? `${p.number} is still a draft: change it directly.` : `${p.number} is ${STATUSES[p.status].label.toLowerCase()}, so it can’t be revised.`);
    }
    const [{ last }] = await trx('proformas').where({ base_no: p.base_no }).max({ last: 'revision' });
    const revision = last + 1;
    const number = `${p.base_no}-R${revision}`;
    const [newId] = await trx('proformas').insert({
      ...pick(p), number, base_no: p.base_no, revision, total: p.total, proforma_date: localDay(),
      site_id: actor.site?.id ?? p.site_id, created_by: actor.user.id,
    });
    const lines = await trx('proforma_lines').where({ proforma_id: id }).orderBy('sort_order');
    await writeLines(trx, newId, lines.map((l) => ({ ...l, quantity: Number(l.quantity), unit_price: Number(l.unit_price), amount: Number(l.amount) })));
    await trx('proformas').where({ id }).update({ status: 'replaced', replaced_by: newId, closed_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'proforma', id, action: 'revised', summary: `Replaced by ${number}` });
    await audit(trx, actor, { entity: 'proforma', id: newId, action: 'create', summary: `Revision of ${p.number}` });
    // A declined proforma being revised: the enquiry is live again.
    if (p.status === 'declined') await enquiryTo(trx, actor, p.enquiry_id, 'open', { from: ['lost'], summary: `Reopened: revising proforma ${p.number}` });
    return { id: newId, number };
  });
}


export async function getProforma(id) {
  const p = await db('proformas as p')
    .join('customers as c', 'c.id', 'p.customer_id')
    .leftJoin('vehicles as v', 'v.id', 'p.vehicle_id')
    .leftJoin('enquiries as e', 'e.id', 'p.enquiry_id')
    .leftJoin('users as u', 'u.id', 'p.created_by')
    .leftJoin('proformas as r', 'r.id', 'p.replaced_by')
    .where('p.id', id)
    .first('p.*', 'c.name as customer_name', 'c.number as customer_number', 'c.phone as customer_phone', 'c.town as customer_town',
      'c.address as customer_address', 'c.kra_pin as customer_pin', 'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model',
      'e.number as enquiry_number', 'u.name as created_name', 'r.number as replaced_by_number');
  if (!p) return null;
  p.vehicle_label = p.vehicle_id ? vehicleLabel(p) : null;
  p.lines = await db('proforma_lines').where({ proforma_id: id }).orderBy('sort_order');
  p.versions = await db('proformas').where({ base_no: p.base_no }).orderBy('revision').select('id', 'number', 'status', 'total', 'proforma_date');
  p.job = await db('jobs').where({ proforma_id: id }).first('id', 'number');
  return p;
}

function tabFilter(q, tab) {
  if (tab === 'closed') q.whereIn('p.status', ['accepted', 'declined']);
  else if (tab !== 'all') q.where('p.status', tab);
}

export async function listProformas({ tab = 'sent', q = '' } = {}) {
  const query = db('proformas as p')
    .join('customers as c', 'c.id', 'p.customer_id')
    .leftJoin('users as u', 'u.id', 'p.created_by')
    .limit(200)
    .select('p.id', 'p.number', 'p.status', 'p.total', 'p.proforma_date', 'p.sent_at', 'p.closed_at', 'p.declined_reason', 'p.vehicle_description',
      'c.name as customer_name', 'u.name as created_name',
      db('proforma_lines').where('proforma_id', db.ref('p.id')).orderBy('sort_order').limit(1).select('description').as('first_line'));
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('p.number', 'like', `${term}%`).orWhere('c.name', 'like', `%${term}%`)
      .orWhereExists(db('proforma_lines as l').whereRaw('l.proforma_id = p.id').where('l.description', 'like', `%${term}%`)));
  } else {
    tabFilter(query, tab);
  }
  return query.orderBy('p.base_no', 'desc').orderBy('p.revision', 'desc');
}

export async function countByTab() {
  return countTabs(TABS, (tab) => { const q = db('proformas as p'); tabFilter(q, tab); return q; });
}

/** Proformas made for one enquiry (its page lists them). */
export function forEnquiry(enquiryId) {
  return db('proformas').where({ enquiry_id: enquiryId }).orderBy('base_no').orderBy('revision').select('id', 'number', 'status', 'total', 'proforma_date');
}

/** "Copy from another proforma": find one by number, customer or what it was for. */
export async function lookupProformas(q) {
  const rows = await listProformas({ tab: 'all', q });
  return rows.slice(0, 20).map((p) => ({
    value: p.id,
    label: `${p.number} · ${p.customer_name} · ${String(p.first_line ?? '').split('\n')[0].slice(0, 60)} · KES ${Number(p.total).toLocaleString('en-KE')}`,
  }));
}

/** A proforma's content as form rows, for a copy or a new one. */
export async function linesOf(id) {
  const rows = await db('proforma_lines').where({ proforma_id: id }).orderBy('sort_order');
  return rows.map((l) => ({ quantity: Number(l.quantity), unit: l.unit, description: l.description, unit_price: Number(l.unit_price) }));
}
