import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';
import { httpError } from '../../core/validate.js';

// Materials issued to jobs.
//
// Each line takes the item's average cost that day, and the job keeps that cost even if the
// average later changes. Returns go back to stock at the cost they left at, so the job gets back
// exactly what it was charged. Plates go out as whole sheets until offcuts are built.

const err = (status, message, field) => Object.assign(httpError(status, message), { field });
const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10_000) / 10_000;
const num = Number;

const sizeLabel = (l) => (l.size_unit ? `${num(l.length)} × ${num(l.width)} ${l.size_unit}` : '');

/** What can be issued from a site: one choice per item and sheet size. */
export async function availableStock(siteId) {
  const rows = await db('stock_balances as b').join('items as i', 'i.id', 'b.item_id')
    .where('b.site_id', siteId).where('b.quantity', '>', 0).orderBy('i.name').orderBy('b.area_sq_ft', 'desc')
    .select('b.id', 'b.quantity', 'b.length', 'b.width', 'b.size_unit', 'b.area_sq_ft', 'i.name', 'i.unit', 'i.priced_by', 'i.avg_cost');
  return rows.map((b) => {
    const size = sizeLabel(b);
    return {
      id: b.id,
      label: size ? `${b.name}, ${size}` : b.name,
      available: num(b.quantity),
      unit: b.priced_by === 'area' ? 'pcs' : b.unit,
      area: b.area_sq_ft === null ? null : num(b.area_sq_ft),
      avg_cost: b.avg_cost === null ? 0 : num(b.avg_cost),
      cost_unit: b.unit,
    };
  });
}

/**
 * @param {number} jobId
 * @param {{ issued_on: string, received_by: string|null, notes: string|null, lines: { balance_id: number, quantity: number }[] }} input
 * @returns {Promise<{ id: number, number: string }>}
 */
export async function issueMaterials(jobId, input, actor) {
  return db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first('id', 'number', 'status');
    if (!job) throw httpError(404, 'That job doesn’t exist.');
    if (!['open', 'in_progress'].includes(job.status)) throw httpError(409, `${job.number} is finished, so materials can’t be issued to it. Reopen it first.`);

    const number = await nextNumber(trx, 'issue');
    const [id] = await trx('material_issues').insert({
      number, job_id: job.id, site_id: actor.site.id, issued_on: input.issued_on, received_by: input.received_by, notes: input.notes, created_by: actor.user.id,
    });

    // One row of the form at a time, in a fixed order so two people issuing can't lock each other out.
    for (const row of [...input.lines].sort((a, b) => a.balance_id - b.balance_id)) {
      const balance = await trx('stock_balances').where({ id: row.balance_id, site_id: actor.site.id }).forUpdate().first();
      if (!balance) throw err(422, 'One of those items isn’t in stock at this site.', 'lines');
      const item = await trx('items').where({ id: balance.item_id }).forUpdate().first();
      const size = sizeLabel(balance);
      const label = size ? `${item.name}, ${size}` : item.name;
      if (row.quantity > num(balance.quantity) + 1e-9) throw err(422, `${label}: only ${num(balance.quantity)} in stock here.`, 'lines');
      if (balance.area_sq_ft !== null && !Number.isInteger(row.quantity)) throw err(422, `${label}: plates are issued as whole sheets.`, 'lines');

      const stockQty = round3(balance.area_sq_ft === null ? row.quantity : row.quantity * num(balance.area_sq_ft));
      const unitCost = num(item.avg_cost ?? 0);
      const left = round3(num(item.on_hand_qty) - stockQty);
      // The last of an item takes all the value that's left, so no rounding is stranded in stock.
      const value = left <= 0 ? num(item.stock_value) : round4(stockQty * unitCost);
      await trx('items').where({ id: item.id }).update({ on_hand_qty: Math.max(0, left), stock_value: left <= 0 ? 0 : Math.max(0, round4(num(item.stock_value) - value)) });
      await trx('stock_balances').where({ id: balance.id }).update({ quantity: round3(num(balance.quantity) - row.quantity) });
      await trx('material_issue_lines').insert({
        issue_id: id, item_id: item.id, size_key: balance.size_key, length: balance.length, width: balance.width, size_unit: balance.size_unit, area_sq_ft: balance.area_sq_ft,
        quantity: row.quantity, stock_qty: stockQty, unit_cost: unitCost, value,
      });
      await trx('stock_movements').insert({
        type: 'issue', site_id: actor.site.id, item_id: item.id, size_key: balance.size_key, quantity: -row.quantity, stock_qty: -stockQty, value: -value, job_id: job.id, issue_id: id, created_by: actor.user.id,
      });
    }

    await audit(trx, actor, { entity: 'material_issue', id, action: 'create', summary: `To ${job.number}` });
    // No amount: the workshop can read a job's history, and costs stay with the stores.
    await audit(trx, actor, { entity: 'job', id: job.id, action: 'materials_issued', summary: number });
    return { id, number };
  });
}

/**
 * Unused materials come back, at the cost they left at. Allowed on a finished job too.
 * @param {{ line_id: number, quantity: number }[]} lines
 */
export async function returnMaterials(issueId, lines, actor) {
  await db.transaction(async (trx) => {
    const issue = await trx('material_issues').where({ id: issueId }).forUpdate().first();
    if (!issue) throw httpError(404, 'That issue doesn’t exist.');
    const issued = await trx('material_issue_lines').where({ issue_id: issueId }).forUpdate().select();
    const rows = lines.map((row) => {
      const line = issued.find((l) => l.id === row.line_id);
      if (!line) throw err(422, 'That line isn’t on this issue.', 'lines');
      const left = num(line.quantity) - num(line.returned_qty);
      if (row.quantity > left + 1e-9) throw err(422, `Only ${left} can still come back on one of the lines.`, 'lines');
      if (line.area_sq_ft !== null && !Number.isInteger(row.quantity)) throw err(422, 'Plates come back as whole sheets.', 'lines');
      return { ...row, line };
    }).sort((a, b) => a.line.item_id - b.line.item_id);

    for (const { quantity, line } of rows) {
      const item = await trx('items').where({ id: line.item_id }).forUpdate().first();
      const stockQty = round3(line.area_sq_ft === null ? quantity : quantity * num(line.area_sq_ft));
      // All of what's left on the line gives back all its remaining value, so the job nets to exactly zero.
      const fullyBack = num(line.returned_qty) + quantity >= num(line.quantity) - 1e-9;
      const value = fullyBack ? round4(num(line.value) - num(line.returned_value)) : round4(stockQty * num(line.unit_cost));
      const qty = round3(num(item.on_hand_qty) + stockQty);
      const stockValue = round4(num(item.stock_value) + value);
      await trx('items').where({ id: item.id }).update({ on_hand_qty: qty, stock_value: stockValue, avg_cost: round4(stockValue / qty) });

      const where = { site_id: issue.site_id, item_id: item.id, size_key: line.size_key };
      const balance = await trx('stock_balances').where(where).forUpdate().first();
      await trx('stock_balances').where({ id: balance.id }).update({ quantity: round3(num(balance.quantity) + quantity) });
      await trx('material_issue_lines').where({ id: line.id }).update({
        returned_qty: round3(num(line.returned_qty) + quantity), returned_value: round4(num(line.returned_value) + value),
      });
      await trx('stock_movements').insert({
        type: 'return', site_id: issue.site_id, item_id: item.id, size_key: line.size_key, quantity, stock_qty: stockQty, value, job_id: issue.job_id, issue_id: issue.id, created_by: actor.user.id,
      });
    }
    await audit(trx, actor, { entity: 'material_issue', id: issue.id, action: 'materials_returned' });
    await audit(trx, actor, { entity: 'job', id: issue.job_id, action: 'materials_returned', summary: `From ${issue.number}` });
  });
}

// ---------- reading ----------

export async function getIssue(id) {
  const issue = await db('material_issues as m')
    .join('jobs as j', 'j.id', 'm.job_id')
    .join('customers as c', 'c.id', 'j.customer_id')
    .join('sites as s', 's.id', 'm.site_id')
    .leftJoin('users as u', 'u.id', 'm.created_by')
    .where('m.id', id)
    .first('m.*', 'j.number as job_number', 'j.status as job_status', 'c.name as customer_name', 's.name as site_name', 'u.name as created_name');
  if (!issue) return null;
  issue.lines = await db('material_issue_lines as l').join('items as i', 'i.id', 'l.item_id')
    .where('l.issue_id', id).orderBy('l.id').select('l.*', 'i.name as item_name', 'i.unit as item_unit', 'i.priced_by');
  return issue;
}

export function listIssues({ siteIds, q = '' }) {
  const query = db('material_issues as m')
    .join('jobs as j', 'j.id', 'm.job_id')
    .join('customers as c', 'c.id', 'j.customer_id')
    .whereIn('m.site_id', siteIds).orderBy('m.id', 'desc').limit(200)
    .select('m.id', 'm.number', 'm.issued_on', 'm.received_by', 'j.number as job_number', 'c.name as customer_name',
      db('material_issue_lines').where('issue_id', db.ref('m.id')).sum({ v: db.raw('`value` - `returned_value`') }).as('net_value'));
  const term = q.trim();
  if (term) {
    query.where((w) => w.where('m.number', 'like', `%${term}%`).orWhere('j.number', 'like', `%${term}%`).orWhere('c.name', 'like', `%${term}%`).orWhere('m.received_by', 'like', `%${term}%`));
  }
  return query;
}

/** A job's materials, for its page: one row per issue line, and what they cost after returns. */
export async function materialsForJob(jobId) {
  const lines = await db('material_issue_lines as l')
    .join('material_issues as m', 'm.id', 'l.issue_id')
    .join('items as i', 'i.id', 'l.item_id')
    .where('m.job_id', jobId).orderBy('l.id')
    .select('l.*', 'm.number as issue_number', 'm.issued_on', 'i.name as item_name', 'i.unit as item_unit', 'i.priced_by');
  return { lines, total: lines.reduce((sum, l) => sum + num(l.value) - num(l.returned_value), 0) };
}

/** Active jobs at the user's sites, for "which job is this for?" */
export function activeJobs(siteIds) {
  return db('jobs as j').join('customers as c', 'c.id', 'j.customer_id').leftJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .whereIn('j.site_id', siteIds).whereIn('j.status', ['open', 'in_progress']).orderBy('j.id', 'desc').limit(200)
    .select('j.id', 'j.number', 'c.name as customer_name', 'v.reg_no');
}
