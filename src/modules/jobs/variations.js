import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';

// Variations: extra work agreed with the customer after the job was priced (V1, V2 …).
//
//   agreed ──▶ cancelled (with a reason; not while an issued invoice counts it)
//
// A draft invoice gets the line at once (and loses it on cancelling). An issued invoice can't
// change: the job page says to cancel it and invoice again; a new invoice includes it.

const round = (n) => Math.round(n * 100) / 100;
const kes = (n) => `KES ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const label = (v) => `V${v.seq}`;
/** The invoice line's description, "Variation V1: …", so the line can be found again on a draft. */
export const lineText = (v) => `Variation ${label(v)}: ${v.description}`;

export function forJob(jobId, q = db) {
  return q('job_variations as v').leftJoin('users as u', 'u.id', 'v.created_by').leftJoin('users as c', 'c.id', 'v.cancelled_by')
    .where('v.job_id', jobId).orderBy('v.seq').select('v.*', 'u.name as created_by_name', 'c.name as cancelled_by_name');
}

/** Agreed variations as invoice lines. */
export async function invoiceLines(jobId, q = db) {
  const list = await q('job_variations').where({ job_id: jobId, status: 'agreed' }).orderBy('seq');
  return list.map((v) => ({ quantity: Number(v.quantity), unit: v.unit, description: lineText(v), unit_price: Number(v.unit_price) }));
}

/** What the agreed variations add to the job's price (VAT included). */
export async function agreedTotal(jobId, q = db) {
  const row = await q('job_variations').where({ job_id: jobId, status: 'agreed' }).sum({ total: 'amount' }).first();
  return Number(row?.total ?? 0);
}

const draftInvoice = (trx, jobId) => trx('invoices').where({ job_id: jobId, status: 'draft' }).forUpdate().first('id');

async function retotal(trx, invoiceId) {
  const row = await trx('invoice_lines').where({ invoice_id: invoiceId }).sum({ total: 'amount' }).first();
  await trx('invoices').where({ id: invoiceId }).update({ total: round(Number(row.total ?? 0)) });
}

/**
 * @param {{ description: string, quantity: number, unit: string, unit_price: number, agreed_by: string, agreed_on: string }} input
 * @returns {Promise<{ id: number, label: string, invoice: 'draft' | 'issued' | null, invoiceNumber?: string }>}
 */
export async function addVariation(jobId, input, actor) {
  return db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first('id', 'number', 'status');
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    if (!['open', 'in_progress'].includes(job.status)) throw httpError(409, `${job.number} is ${job.status}. Reopen it to add extra work.`);
    const [{ last }] = await trx('job_variations').where({ job_id: jobId }).max({ last: 'seq' });
    const amount = round(input.quantity * input.unit_price);
    const v = { job_id: jobId, seq: Number(last ?? 0) + 1, ...input, amount, created_by: actor.user.id };
    const [id] = await trx('job_variations').insert(v);
    // No price in the job's history: the workshop reads it.
    await audit(trx, actor, { entity: 'job', id: jobId, action: 'variation_added', summary: `${label(v)}: ${input.description}, agreed by ${input.agreed_by}`.slice(0, 1000) });

    // On the invoice: a draft gets the line now; an issued one has to be done again.
    const draft = await draftInvoice(trx, jobId);
    if (draft) {
      const [{ n }] = await trx('invoice_lines').where({ invoice_id: draft.id }).max({ n: 'sort_order' });
      await trx('invoice_lines').insert({ invoice_id: draft.id, sort_order: Number(n ?? 0) + 1, quantity: input.quantity, unit: input.unit, description: lineText(v), unit_price: input.unit_price, amount });
      await retotal(trx, draft.id);
      await audit(trx, actor, { entity: 'invoice', id: draft.id, action: 'update', summary: `${label(v)} added to the draft (${kes(amount)})` });
      return { id, label: label(v), invoice: 'draft' };
    }
    const issued = await trx('invoices').where({ job_id: jobId, status: 'issued' }).first('number');
    return { id, label: label(v), invoice: issued ? 'issued' : null, invoiceNumber: issued?.number };
  });
}

export async function cancelVariation(jobId, variationId, reason, actor) {
  return db.transaction(async (trx) => {
    const v = await trx('job_variations').where({ id: variationId, job_id: jobId }).forUpdate().first();
    if (!v) throw httpError(404, 'That variation isn’t on this job.');
    if (v.status === 'cancelled') throw httpError(409, `${label(v)} is already cancelled.`);
    const issued = await trx('invoices').where({ job_id: jobId, status: 'issued' }).first('number');
    if (issued) throw httpError(409, `Invoice ${issued.number} is issued and counts ${label(v)}. Cancel the invoice first, then the variation.`);
    await trx('job_variations').where({ id: v.id }).update({ status: 'cancelled', cancelled_reason: reason, cancelled_at: trx.fn.now(), cancelled_by: actor.user.id });
    await audit(trx, actor, { entity: 'job', id: jobId, action: 'variation_cancelled', summary: `${label(v)}: ${reason}` });
    const draft = await draftInvoice(trx, jobId);
    if (draft) {
      const removed = await trx('invoice_lines').where({ invoice_id: draft.id, description: lineText(v) }).delete();
      if (removed) {
        await retotal(trx, draft.id);
        await audit(trx, actor, { entity: 'invoice', id: draft.id, action: 'update', summary: `${label(v)} taken off the draft` });
      }
    }
    return label(v);
  });
}
