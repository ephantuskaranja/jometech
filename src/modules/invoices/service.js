import { db } from '../../core/db.js';
import { countTabs } from '../../core/count-tabs.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';
import { localDay } from '../../core/dates.js';
import { vehicleLabel } from '../../core/vehicle-format.js';
import { invoiceLines as variationLines, agreedTotal as variationsTotal } from '../jobs/variations.js';

// Invoices (one per job) and payments received for jobs.
//
//   draft (editable, no number) ──"Issue"──▶ issued (105, locked) ──▶ cancelled (with a reason)
//
// Payments belong to the job: a deposit can come in before there is an invoice. The invoice
// shows what the client (and the bank financing the vehicle, if any) has paid, and the balance.
// Prices include VAT, as on proformas.

export const STATUSES = {
  draft: { label: 'Draft', tone: 'neutral' },
  issued: { label: 'Issued', tone: 'info' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
};

/** How much of an issued invoice is paid. */
export const PAID_STATES = {
  unpaid: { label: 'Not paid', tone: 'warn' },
  part: { label: 'Part paid', tone: 'info' },
  paid: { label: 'Paid', tone: 'ok' },
};

export const METHODS = { mpesa: 'M-Pesa', bank: 'Bank transfer', cheque: 'Cheque', cash: 'Cash' };
/** A payment's 'how', for showing it: the four above, and credit moved between the customer's jobs. */
export const methodLabel = (p) => (p.method !== 'credit' ? METHODS[p.method] : Number(p.amount) < 0 ? 'Credit moved to another job' : 'From the customer’s credit');

/** List tabs. "unpaid" = issued with something still to pay. */
export const TABS = ['draft', 'unpaid', 'paid', 'all'];

const err = (status, message, field) => Object.assign(httpError(status, message), { field });
const round = (n) => Math.round(n * 100) / 100;
const totalOf = (lines) => round(lines.reduce((sum, l) => sum + l.amount, 0));
const kes = (n) => `KES ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function paidState(total, paid) {
  if (paid <= 0) return 'unpaid';
  return paid < Number(total) ? 'part' : 'paid';
}

/** What has been paid for a job (payments not voided), as a subquery on a jobs column. */
const paidSub = (jobRef) => db('payments').where('job_id', db.ref(jobRef)).whereNull('voided_at').select(db.raw('COALESCE(SUM(amount), 0)'));

async function writeLines(trx, invoiceId, lines) {
  await trx('invoice_lines').where({ invoice_id: invoiceId }).delete();
  if (lines.length) {
    await trx('invoice_lines').insert(lines.map((l, i) => ({
      invoice_id: invoiceId, sort_order: i + 1, quantity: l.quantity, unit: l.unit, description: l.description, unit_price: l.unit_price, amount: l.amount,
    })));
  }
}

/** The job's invoice, if it has one that isn't cancelled. */
export function currentInvoice(jobId, trx = db) {
  return trx('invoices as i').leftJoin('customers as f', 'f.id', 'i.financier_id')
    .where('i.job_id', jobId).whereNot('i.status', 'cancelled').first('i.id', 'i.number', 'i.status', 'i.total', 'f.name as financier_name');
}

/** The bank (or other financier) must be a customer record, and not the customer itself. */
async function checkFinancier(trx, financierId, customerId) {
  if (!financierId) return;
  if (financierId === customerId) throw err(422, 'Choose the bank paying for the vehicle, not the customer', 'financier_id');
  if (!(await trx('customers').where({ id: financierId }).first('id'))) throw err(422, 'That bank no longer exists.', 'financier_id');
}

/**
 * What a new invoice for this job starts with: the proforma's lines and prices (or the job's work
 * with no prices), then the agreed variations with theirs.
 */
export async function startFor(job) {
  const extra = await variationLines(job.id);
  if (job.proforma_id) {
    const lines = await db('proforma_lines').where({ proforma_id: job.proforma_id }).orderBy('sort_order');
    if (lines.length) return [...lines.map((l) => ({ quantity: Number(l.quantity), unit: l.unit, description: l.description, unit_price: Number(l.unit_price) })), ...extra];
  }
  return [...job.lines.map((l) => ({ quantity: Number(l.quantity), unit: l.unit, description: l.description, unit_price: '' })), ...extra];
}

/** @returns {Promise<{ id: number }>} */
export async function createInvoice(jobId, input, actor) {
  return db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    if (job.status === 'cancelled') throw httpError(409, `${job.number} was cancelled, so it can’t be invoiced.`);
    if ((await trx('customers').where({ id: job.customer_id }).first('is_stock'))?.is_stock) {
      throw httpError(409, `${job.number} is a stock build with no customer yet. Assign the customer on the job, then invoice them.`);
    }
    const existing = await currentInvoice(jobId, trx);
    if (existing) throw httpError(409, `${job.number} already has an invoice${existing.number ? ` (${existing.number})` : ' (a draft)'}.`);
    await checkFinancier(trx, input.financier_id, job.customer_id);
    const total = totalOf(input.lines);
    const [id] = await trx('invoices').insert({
      job_id: job.id, site_id: job.site_id, customer_id: job.customer_id, financier_id: input.financier_id,
      vehicle_id: job.vehicle_id, vehicle_description: job.vehicle_description, notes: input.notes, total, created_by: actor.user.id,
    });
    await writeLines(trx, id, input.lines);
    await audit(trx, actor, { entity: 'invoice', id, action: 'create', summary: `Draft invoice for ${job.number}, ${kes(total)}` });
    await audit(trx, actor, { entity: 'job', id: job.id, action: 'invoice_drafted', summary: `Draft invoice, ${kes(total)}` });
    return { id };
  });
}

/** Only a draft can be changed. The customer and vehicle follow the job. */
export async function updateInvoice(id, input, actor) {
  await db.transaction(async (trx) => {
    const inv = await trx('invoices').where({ id }).forUpdate().first();
    if (!inv) throw httpError(404, 'That invoice doesn’t exist.');
    if (inv.status !== 'draft') throw httpError(409, `Invoice ${inv.number} has been issued, so it can’t be changed. Cancel it and make a new one if it is wrong.`);
    const job = await trx('jobs').where({ id: inv.job_id }).first('customer_id', 'vehicle_id', 'vehicle_description');
    await checkFinancier(trx, input.financier_id, job.customer_id);
    const total = totalOf(input.lines);
    await trx('invoices').where({ id }).update({
      customer_id: job.customer_id, vehicle_id: job.vehicle_id, vehicle_description: job.vehicle_description,
      financier_id: input.financier_id, notes: input.notes, total,
    });
    await writeLines(trx, id, input.lines);
    await audit(trx, actor, { entity: 'invoice', id, action: 'update', summary: `Draft changed, now ${kes(total)}` });
  });
}

/** A draft that won't be used. It has no number yet, so nothing is lost. */
export async function deleteDraft(id, actor) {
  await db.transaction(async (trx) => {
    const inv = await trx('invoices').where({ id }).forUpdate().first();
    if (!inv) throw httpError(404, 'That invoice doesn’t exist.');
    if (inv.status !== 'draft') throw httpError(409, `Invoice ${inv.number} has been issued: cancel it instead, with a reason.`);
    await trx('invoices').where({ id }).delete(); // lines go with it
    await audit(trx, actor, { entity: 'job', id: inv.job_id, action: 'invoice_draft_deleted', summary: `Draft invoice deleted (${kes(inv.total)})` });
  });
}

/** Gives it the next number and today's date, and locks it. */
export async function issueInvoice(id, actor) {
  return db.transaction(async (trx) => {
    const inv = await trx('invoices').where({ id }).forUpdate().first();
    if (!inv) throw httpError(404, 'That invoice doesn’t exist.');
    if (inv.status !== 'draft') throw httpError(409, `Invoice ${inv.number} is already ${inv.status}.`);
    const [{ n }] = await trx('invoice_lines').where({ invoice_id: id }).count({ n: '*' });
    if (!Number(n)) throw httpError(422, 'Add at least one line before issuing it.');
    const number = await nextNumber(trx, 'invoice');
    await trx('invoices').where({ id }).update({ number, status: 'issued', invoice_date: localDay(), issued_at: trx.fn.now() });
    await audit(trx, actor, { entity: 'invoice', id, action: 'invoice_issued', summary: `Issued as invoice ${number}, ${kes(inv.total)}` });
    await audit(trx, actor, { entity: 'job', id: inv.job_id, action: 'invoice_issued', summary: `Invoice ${number} issued, ${kes(inv.total)}` });
    return { number };
  });
}

/** An issued invoice that was wrong or not wanted. It keeps its number; the job can then get a new one. */
export async function cancelInvoice(id, reason, actor) {
  await db.transaction(async (trx) => {
    const inv = await trx('invoices').where({ id }).forUpdate().first();
    if (!inv) throw httpError(404, 'That invoice doesn’t exist.');
    if (inv.status !== 'issued') throw httpError(409, inv.status === 'draft' ? 'A draft can be deleted instead.' : `Invoice ${inv.number} is already cancelled.`);
    await trx('invoices').where({ id }).update({ status: 'cancelled', cancelled_at: trx.fn.now(), cancelled_reason: reason });
    await audit(trx, actor, { entity: 'invoice', id, action: 'invoice_cancelled', summary: `Cancelled: ${reason}` });
    await audit(trx, actor, { entity: 'job', id: inv.job_id, action: 'invoice_cancelled', summary: `Invoice ${inv.number} cancelled: ${reason}` });
  });
}

/** The KRA eTIMS invoice number, typed in after keying it into the KRA portal. Can be corrected. */
export async function setEtims(id, etimsNumber, actor) {
  await db.transaction(async (trx) => {
    const inv = await trx('invoices').where({ id }).forUpdate().first();
    if (!inv) throw httpError(404, 'That invoice doesn’t exist.');
    if (inv.status === 'cancelled') throw httpError(409, `Invoice ${inv.number} is cancelled.`);
    await trx('invoices').where({ id }).update({ etims_number: etimsNumber });
    await audit(trx, actor, { entity: 'invoice', id, action: 'update', before: { etims: inv.etims_number }, after: { etims: etimsNumber } });
  });
}

// ---------- Payments ----------

/**
 * What a job's payments are checked against: its invoice (a draft counts), else the accepted
 * proforma it was made from plus agreed variations (deposits before invoicing). Null when it has neither.
 * @returns {Promise<{ total: number, against: string } | null>}
 */
export async function amountDue(jobId, trx = db) {
  const inv = await currentInvoice(jobId, trx);
  if (inv) return { total: Number(inv.total), against: inv.number ? `invoice ${inv.number}` : 'the draft invoice' };
  const pf = await trx('jobs as j').join('proformas as p', 'p.id', 'j.proforma_id')
    .where({ 'j.id': jobId, 'p.status': 'accepted' }).first('p.number', 'p.total');
  if (!pf) return null;
  const extra = await variationsTotal(jobId, trx);
  return extra ? { total: round(Number(pf.total) + extra), against: `proforma ${pf.number} and variations` } : { total: Number(pf.total), against: `proforma ${pf.number}` };
}

/**
 * For the payment form: what is still owed on the job and against what (null: nothing to check),
 * and where extra work would be added to the invoice instead of holding the money as credit.
 * `credit`: what the customer overpaid on their other jobs, which can go towards this one (only while something is owed).
 */
export async function owedOn(jobId) {
  const due = await amountDue(jobId);
  if (!due) return null;
  const inv = await currentInvoice(jobId);
  const extraWork = !inv ? { href: `/jobs/${jobId}/invoice`, text: 'make the invoice with it' }
    : inv.status === 'draft' ? { href: `/invoices/${inv.id}/edit`, text: 'add it to the draft invoice' }
      : { href: `/invoices/${inv.id}`, text: `cancel invoice ${inv.number} and invoice again with it` };
  const owed = round(Math.max(due.total - (await paidOn(db, jobId)), 0));
  let credit = null;
  if (owed > 0) {
    const { customer_id: customerId } = await db('jobs').where({ id: jobId }).first('customer_id');
    credit = await creditOf(customerId, { except: jobId });
    if (!credit.total) credit = null;
  }
  return { owed, against: due.against, extraWork, credit };
}

const paidOn = async (trx, jobId) => Number((await trx('payments').where({ job_id: jobId }).whereNull('voided_at').sum({ s: 'amount' }).first()).s ?? 0);

/**
 * Records a payment. One that is more than what is still owed needs confirming
 * (input.confirm_excess) and a reason (input.excess_reason): the extra is held as the
 * customer's credit, e.g. paid ahead for future work.
 * @returns {Promise<{ id: number, number: string, credit: number }>}
 */
export async function recordPayment(jobId, input, actor) {
  return db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first('id', 'number', 'status');
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    if (job.status === 'cancelled') throw httpError(409, `${job.number} was cancelled.`);

    const due = await amountDue(jobId, trx);
    const owed = due ? round(Math.max(due.total - (await paidOn(trx, jobId)), 0)) : null;
    const credit = owed === null ? 0 : round(Math.max(input.amount - owed, 0));
    let notes = input.notes;
    if (credit > 0) {
      if (!input.confirm_excess) {
        throw err(422, `${kes(owed)} is still owed on ${due.against}: this payment is ${kes(credit)} more. Confirm to hold the extra as the customer’s credit.`, 'amount');
      }
      const reason = (input.excess_reason ?? '').trim();
      if (reason.length < 3) throw err(422, 'Say why the customer paid more (e.g. a deposit for the next job).', 'excess_reason');
      notes = [`${kes(credit)} held as credit: ${reason}`, notes].filter(Boolean).join(' · ').slice(0, 255);
    }

    const number = await nextNumber(trx, 'payment');
    const [id] = await trx('payments').insert({
      number, job_id: jobId, paid_on: input.paid_on, amount: input.amount, method: input.method,
      reference: input.reference, payer: input.payer, notes, received_by: actor.user.id,
    });
    const from = input.payer === 'financier' ? 'the bank' : 'the client';
    const ref = input.reference ? ` ${input.reference}` : '';
    const held = credit > 0 ? `; ${kes(credit)} more than owed, held as credit` : '';
    await audit(trx, actor, { entity: 'job', id: jobId, action: 'payment_received', summary: `${number}: ${kes(input.amount)} from ${from} by ${METHODS[input.method]}${ref}${held}` });
    return { id, number, credit };
  });
}

/**
 * A customer's credit: on each of their jobs, what was paid beyond its invoice (or accepted
 * proforma before invoicing). For the customer's page.
 * @returns {Promise<{ total: number, jobs: { id: number, number: string, credit: number }[] }>}
 */
export async function creditOf(customerId, { except = null, q = db, lock = false } = {}) {
  if (lock) await q('jobs').where({ customer_id: customerId }).forUpdate().select('id'); // two people using the same credit at once
  const rows = await q('jobs as j')
    .join(q('payments').whereNull('voided_at').groupBy('job_id').select('job_id').sum({ paid: 'amount' }).as('p'), 'p.job_id', 'j.id')
    .leftJoin('invoices as i', (q) => q.on('i.job_id', 'j.id').andOnVal('i.status', '<>', 'cancelled'))
    .leftJoin('proformas as pf', (q) => q.on('pf.id', 'j.proforma_id').andOnVal('pf.status', 'accepted'))
    .where('j.customer_id', customerId)
    .whereNot('j.status', 'cancelled')
    .modify((x) => { if (except) x.whereNot('j.id', except); })
    .orderBy('j.id')
    .select('j.id', 'j.number', 'p.paid', q.raw('COALESCE(i.total, pf.total) as due'));
  const jobs = rows.filter((r) => r.due !== null)
    .map((r) => ({ id: r.id, number: r.number, credit: round(Number(r.paid) - Number(r.due)) }))
    .filter((r) => r.credit > 0);
  return { total: round(jobs.reduce((s, j) => s + j.credit, 0)), jobs };
}

/**
 * Uses the customer's credit (overpaid on their other jobs) towards what is owed on this job: for each
 * job the credit is on, oldest first, a minus payment there and a plus payment here, linked.
 * @returns {Promise<{ amount: number, from: string[] }>}
 */
export async function useCredit(jobId, amount, actor) {
  return db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first('id', 'number', 'status', 'customer_id');
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    if (job.status === 'cancelled') throw httpError(409, `${job.number} was cancelled.`);
    const due = await amountDue(jobId, trx);
    if (!due) throw err(422, `${job.number} has no invoice or accepted proforma yet, so there is nothing to put the credit against.`, 'amount');
    const owed = round(Math.max(due.total - (await paidOn(trx, jobId)), 0));
    const credit = await creditOf(job.customer_id, { except: jobId, q: trx, lock: true });
    if (!(amount > 0)) throw err(422, 'Enter how much of the credit to use.', 'amount');
    if (amount > owed) throw err(422, `Only ${kes(owed)} is owed on ${due.against}.`, 'amount');
    if (amount > credit.total) throw err(422, `The customer has ${kes(credit.total)} of credit.`, 'amount');

    let left = round(amount);
    const from = [];
    for (const source of credit.jobs) {
      if (left <= 0) break;
      const part = round(Math.min(left, source.credit));
      left = round(left - part);
      const base = { paid_on: localDay(), method: 'credit', payer: 'client', received_by: actor.user.id };
      const outNumber = await nextNumber(trx, 'payment');
      const [outId] = await trx('payments').insert({ ...base, number: outNumber, job_id: source.id, amount: -part, notes: `Credit moved to ${job.number}` });
      const inNumber = await nextNumber(trx, 'payment');
      const [inId] = await trx('payments').insert({ ...base, number: inNumber, job_id: jobId, amount: part, notes: `Credit from ${source.number}`, linked_payment_id: outId });
      await trx('payments').where({ id: outId }).update({ linked_payment_id: inId });
      await audit(trx, actor, { entity: 'job', id: source.id, action: 'credit_moved', summary: `${outNumber}: ${kes(part)} of the customer’s credit used on ${job.number}` });
      await audit(trx, actor, { entity: 'job', id: jobId, action: 'credit_used', summary: `${inNumber}: ${kes(part)} from the customer’s credit on ${source.number}` });
      from.push(source.number);
    }
    return { amount: round(amount), from };
  });
}

/** A payment entered by mistake. It stays on record, crossed out. A credit move is voided as a pair. */
export async function voidPayment(paymentId, reason, actor) {
  return db.transaction(async (trx) => {
    const p = await trx('payments').where({ id: paymentId }).forUpdate().first();
    if (!p) throw httpError(404, 'That payment doesn’t exist.');
    if (p.voided_at) throw httpError(409, `${p.number} is already voided.`);
    const pair = p.linked_payment_id ? await trx('payments').where({ id: p.linked_payment_id }).whereNull('voided_at').forUpdate().first() : null;
    for (const row of [p, pair].filter(Boolean)) {
      await trx('payments').where({ id: row.id }).update({ voided_at: trx.fn.now(), voided_by: actor.user.id, void_reason: reason });
      await audit(trx, actor, { entity: 'job', id: row.job_id, action: 'payment_voided', summary: `${row.number} (${kes(row.amount)}) voided: ${reason}` });
    }
    return p;
  });
}

/** A job's payments, newest first, and what has been paid by the client and the bank. */
export async function paymentsFor(jobId) {
  const list = await db('payments as p').leftJoin('users as u', 'u.id', 'p.received_by')
    .where('p.job_id', jobId).orderBy('p.paid_on', 'desc').orderBy('p.id', 'desc')
    .select('p.*', 'u.name as received_name');
  const live = list.filter((p) => !p.voided_at);
  const sum = (rows) => round(rows.reduce((s, p) => s + Number(p.amount), 0));
  const client = sum(live.filter((p) => p.payer === 'client'));
  const financier = sum(live.filter((p) => p.payer === 'financier'));
  return { list, client, financier, total: round(client + financier) };
}

/** For the job page: its invoice and payments. */
export async function moneyForJob(jobId) {
  const invoice = await currentInvoice(jobId);
  const payments = await paymentsFor(jobId);
  return { invoice, payments, balance: invoice ? round(Number(invoice.total) - payments.total) : null, due: await owedOn(jobId) };
}

// ---------- Reading ----------

export async function getInvoice(id) {
  const inv = await db('invoices as i')
    .join('customers as c', 'c.id', 'i.customer_id')
    .join('jobs as j', 'j.id', 'i.job_id')
    .leftJoin('customers as f', 'f.id', 'i.financier_id')
    .leftJoin('vehicles as v', 'v.id', 'i.vehicle_id')
    .leftJoin('proformas as pf', 'pf.id', 'j.proforma_id')
    .leftJoin('users as u', 'u.id', 'i.created_by')
    .where('i.id', id)
    .first('i.*', 'c.name as customer_name', 'c.number as customer_number', 'c.address as customer_address', 'c.town as customer_town', 'c.kra_pin as customer_pin',
      'f.name as financier_name', 'f.address as financier_address', 'f.town as financier_town',
      'j.number as job_number', 'j.status as job_status', 'j.proforma_id', 'pf.number as proforma_number',
      'v.reg_no', 'v.chassis_no', 'v.engine_no', 'v.temp_tag', 'v.make', 'v.model', 'u.name as created_name');
  if (!inv) return null;
  inv.vehicle_label = inv.vehicle_id ? vehicleLabel(inv) : null;
  inv.lines = await db('invoice_lines').where({ invoice_id: id }).orderBy('sort_order');
  inv.payments = await paymentsFor(inv.job_id);
  inv.balance = round(Number(inv.total) - inv.payments.total);
  inv.paid_state = paidState(inv.total, inv.payments.total);
  // Earlier invoices for the same job that were cancelled (shown as a note).
  inv.others = await db('invoices').where({ job_id: inv.job_id }).whereNot('id', id).orderBy('id').select('id', 'number', 'status');
  return inv;
}

function tabFilter(q, tab) {
  if (tab === 'draft') q.where('i.status', 'draft');
  else if (tab === 'unpaid') q.where('i.status', 'issued').whereRaw('i.total > (?)', [paidSub('i.job_id')]);
  else if (tab === 'paid') q.where('i.status', 'issued').whereRaw('i.total <= (?)', [paidSub('i.job_id')]);
}

export async function listInvoices({ tab = 'unpaid', q = '', siteIds = null } = {}) {
  const query = db('invoices as i')
    .modify((x) => { if (siteIds) x.whereIn('i.site_id', siteIds); })
    .join('customers as c', 'c.id', 'i.customer_id')
    .join('jobs as j', 'j.id', 'i.job_id')
    .leftJoin('customers as f', 'f.id', 'i.financier_id')
    .leftJoin('vehicles as v', 'v.id', 'i.vehicle_id')
    .limit(200)
    .select('i.id', 'i.number', 'i.status', 'i.total', 'i.invoice_date', 'i.created_at', 'i.vehicle_description', 'i.cancelled_reason',
      'c.name as customer_name', 'f.name as financier_name', 'j.id as job_id', 'j.number as job_number', 'v.reg_no', 'v.chassis_no', 'v.temp_tag',
      paidSub('i.job_id').as('paid'));
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('i.number', 'like', `${term}%`).orWhere('j.number', 'like', `%${term}%`).orWhere('c.name', 'like', `%${term}%`)
      .orWhere('f.name', 'like', `%${term}%`).orWhereRaw("REPLACE(v.reg_no, ' ', '') LIKE ?", [`%${term.replace(/\s+/g, '')}%`]));
  } else {
    tabFilter(query, tab);
  }
  const rows = await query.orderByRaw('i.issued_at IS NULL DESC').orderBy('i.issued_at', 'desc').orderBy('i.id', 'desc');
  return rows.map((r) => ({ ...r, vehicle_label: r.reg_no || r.chassis_no || r.temp_tag ? vehicleLabel(r) : r.vehicle_description, balance: round(Number(r.total) - Number(r.paid)) }));
}

export async function countByTab(siteIds = null) {
  return countTabs(TABS, (tab) => { const q = db('invoices as i'); if (siteIds) q.whereIn('i.site_id', siteIds); tabFilter(q, tab); return q; });
}

/** For the period summary: invoices issued and payments received between two moments. */
export async function forPeriod({ start, end, from, to }, siteId) {
  const issued = await db('invoices as i').join('customers as c', 'c.id', 'i.customer_id').join('jobs as j', 'j.id', 'i.job_id')
    .whereIn('i.status', ['issued', 'cancelled']).where('i.issued_at', '>=', start).where('i.issued_at', '<', end)
    .modify((q) => { if (siteId) q.where('i.site_id', siteId); })
    .orderBy('i.issued_at').select('i.id', 'i.number', 'i.status', 'i.total', 'i.issued_at', 'c.name as customer_name', 'j.number as job_number');
  const received = await db('payments as p').join('jobs as j', 'j.id', 'p.job_id').join('customers as c', 'c.id', 'j.customer_id')
    .whereNull('p.voided_at').whereNot('p.method', 'credit').whereBetween('p.paid_on', [from, to]) // credit moved between jobs isn't money received
    .modify((q) => { if (siteId) q.where('j.site_id', siteId); })
    .orderBy('p.paid_on').orderBy('p.id').select('p.number', 'p.paid_on', 'p.amount', 'p.method', 'p.payer', 'p.reference', 'j.id as job_id', 'j.number as job_number', 'c.name as customer_name');
  const live = issued.filter((i) => i.status === 'issued');
  return {
    issued,
    issuedValue: round(live.reduce((s, i) => s + Number(i.total), 0)),
    received,
    receivedValue: round(received.reduce((s, p) => s + Number(p.amount), 0)),
  };
}
