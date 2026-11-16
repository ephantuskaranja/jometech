import { sheetSize, SHEET_UNITS } from '../../core/sheet.js';
import * as orders from './service.js';

// The material lines of a purchase order or a purchase request, as typed on the form.

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;
const JOB_NUMBER = /^(JOB-\d{4}-\d+)/i;

export const blankRow = () => ({ item_id: '', item_name: '', quantity: '', length: '', width: '', size_unit: 'ft', for: '', price: '' });
const plain = (v) => (v === null || v === undefined ? '' : String(Number(v)));

/** Saved lines back into form rows. */
export const rowsOf = (lines) => lines.map((l) => ({
  item_id: l.item_id, item_name: l.item_name, quantity: plain(l.quantity), length: plain(l.length), width: plain(l.width), size_unit: l.size_unit ?? 'ft',
  for: l.job_number ?? l.for_text ?? '', price: plain(l.unit_price),
}));

/**
 * Lines arrive as lists, one entry per row. A row with no item and no quantity is skipped.
 * "For" is free text ("Trailer"), or starts with a job number (chosen from the suggestions) to link that job.
 * `prices: false` (a request) ignores prices: stores fill them in on the order.
 */
export async function readLines(body, { prices = true } = {}) {
  const list = (key) => [].concat(body[key] ?? []).map((v) => String(v ?? '').trim());
  const [ids, names, quantities, lengths, widths, units, fors, priceList] = ['line_item_id', 'line_item_name', 'line_quantity', 'line_length', 'line_width', 'line_size_unit', 'line_for', 'line_price'].map(list);
  const rows = names.map((item_name, i) => ({
    item_id: ids[i] ?? '', item_name, quantity: quantities[i] ?? '', length: lengths[i] ?? '', width: widths[i] ?? '',
    size_unit: units[i] || 'ft', for: fors[i] ?? '', price: prices ? priceList[i] ?? '' : '',
  }));
  const items = await orders.activeItems(rows.map((r) => Number(r.item_id)).filter(Boolean));
  const lines = [];
  let error = null;
  for (const [i, row] of rows.entries()) {
    if (!row.item_name && !row.item_id && !row.quantity) continue;
    const n = i + 1;
    const item = items.find((it) => it.id === Number(row.item_id));
    const qty = number(row.quantity);
    const price = row.price === '' ? null : number(row.price);
    if (!item) { error ??= `Line ${n}: choose an item from the list, or add it`; continue; }
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9_999_999 || !decimals(qty, 3)) { error ??= `Line ${n}: check the quantity`; continue; }
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 999_999_999 || !decimals(price, 2))) { error ??= `Line ${n}: check the price`; continue; }

    const line = { item_id: item.id, quantity: qty, length: null, width: null, size_unit: null, area_sq_ft: null, job_id: null, for_text: null };
    if (prices) Object.assign(line, { unit_price: price, amount: null });
    let billed = qty;
    if (item.priced_by === 'area') {
      const [length, width] = [number(row.length), number(row.width)];
      const fine = (v) => Number.isFinite(v) && v > 0 && v <= 100_000 && decimals(v, 2);
      if (!fine(length) || !fine(width) || !SHEET_UNITS.includes(row.size_unit)) { error ??= `Line ${n}: enter the plate’s length and width`; continue; }
      if (!Number.isInteger(qty)) { error ??= `Line ${n}: plates are ordered in whole pieces`; continue; }
      const { sqFt } = sheetSize({ length, width, unit: row.size_unit });
      Object.assign(line, { length, width, size_unit: row.size_unit, area_sq_ft: Math.round(sqFt * 10_000) / 10_000 });
      billed = qty * sqFt;
    }
    if (prices && price !== null) line.amount = Math.round(billed * price * 100) / 100;

    const jobNumber = JOB_NUMBER.exec(row.for)?.[1];
    if (jobNumber) {
      const job = await orders.jobIdFor(jobNumber.toUpperCase());
      if (!job) { error ??= `Line ${n}: there is no job ${jobNumber}`; continue; }
      line.job_id = job.id;
    } else if (row.for.length > 60) { error ??= `Line ${n}: keep “for” to 60 characters`; continue; } else {
      line.for_text = row.for || null;
    }
    lines.push(line);
  }
  if (!error && !lines.length) error = 'Add at least one item';
  return { rows, lines, error };
}
