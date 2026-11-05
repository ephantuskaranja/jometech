// Lines with prices (proformas, invoices): quantity, unit, description and price, VAT included.

const number = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const twoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

/**
 * Lines arrive as four lists (line_quantity, line_unit, line_description, line_price).
 * A line with neither a description nor a price is skipped.
 */
export function readLines(body) {
  const list = (key) => [].concat(body[key] ?? []).map((v) => String(v ?? ''));
  const [qtys, units, descriptions, prices] = ['line_quantity', 'line_unit', 'line_description', 'line_price'].map(list);
  const rows = descriptions.map((d, i) => ({ quantity: qtys[i] ?? '', unit: units[i] ?? '', description: d, unit_price: prices[i] ?? '' }));
  const lines = [];
  let error = null;
  rows.forEach((row, i) => {
    const description = row.description.trim();
    const priceText = row.unit_price.trim();
    if (!description && !priceText) return;
    const qty = row.quantity.trim() === '' ? 1 : number(row.quantity);
    const price = number(priceText);
    const n = i + 1;
    if (!description) error ??= `Line ${n}: describe the work`;
    else if (description.length > 2000) error ??= `Line ${n}: use 2,000 characters or fewer`;
    else if (!Number.isFinite(qty) || qty <= 0 || qty > 99_999 || !twoDecimals(qty)) error ??= `Line ${n}: check the quantity`;
    else if (!priceText) error ??= `Line ${n}: enter the price`;
    else if (!Number.isFinite(price) || price < 0 || price > 999_999_999 || !twoDecimals(price)) error ??= `Line ${n}: check the price`;
    else {
      const unit = row.unit.trim().slice(0, 20) || 'Unit';
      lines.push({ quantity: qty, unit, description, unit_price: price, amount: Math.round(qty * price * 100) / 100 });
    }
  });
  if (!error && !lines.length) error = 'Add at least one line, with its price';
  return { rows, lines, error };
}
