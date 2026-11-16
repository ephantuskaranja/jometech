import { db } from '../../core/db.js';
import { sheetSize, SHEET_UNITS } from '../../core/sheet.js';
import { createItem, listCategories } from '../items/service.js';
import { addOpeningStock, sizeKey } from '../stock/service.js';
import { template as makeTemplate } from './sheet.js';

// Import: items and what is already on the racks (opening stock, per site). Same rules as the forms:
// categories from the list (Items → Categories), plates priced per sq ft with a thickness and counted
// in whole sheets of a size. An item already in the app is skipped; opening stock already entered for
// that item, site and size is skipped too, so the same file can't be counted twice.

export const KIND = 'items';
export const TITLE = 'Items and opening stock';

const ITEM_FIELDS = { name: 'Name', category: 'Category', priced_by: 'Priced by', unit: 'Unit', thickness: 'Thickness mm', price: 'Current price', reorder: 'Reorder level', notes: 'Notes' };
const STOCK_FIELDS = { item: 'Item', site: 'Site', quantity: 'Quantity', length: 'Length', width: 'Width', size_unit: 'Size unit', cost: 'Cost per unit' };
export const SHEETS = [
  { name: 'Items', fields: ITEM_FIELDS },
  { name: 'Opening stock', fields: STOCK_FIELDS },
];

export function template() {
  return makeTemplate([
    { name: 'Items', columns: [['Name', 30, true], ['Category', 18, true], ['Priced by', 12], ['Unit', 8], ['Thickness mm', 13], ['Current price', 14], ['Reorder level', 13], ['Notes', 30]],
      example: ['Plate 4 mm', 'Plates', 'Per sq ft', '', '4', '95', '20', ''] },
    { name: 'Opening stock', columns: [['Item', 30, true], ['Site', 14, true], ['Quantity', 10, true], ['Length', 9], ['Width', 9], ['Size unit', 10], ['Cost per unit', 14, true]],
      example: ['Plate 4 mm', 'HQ', '6', '8', '4', 'ft', '92.50'] },
  ], [
    ['Items', 'One row per item. Name and category are needed. An item already in the app (same name, spaces ignored) is skipped.'],
    ['Category', 'One of the categories under Items → Categories. Add a missing one there first.'],
    ['Priced by', '“Per unit” (Pc, Set, Length, kg …) or “Per sq ft” for plates. Empty = Per unit.'],
    ['Unit', 'For per-unit items, what it is counted in, e.g. Pc. Plates are always sq ft.'],
    ['Thickness mm', 'Needed for plates, e.g. 4.'],
    ['Opening stock', 'What is on the racks today, one row per item and site (and per plate size). The item can be from the Items sheet or already in the app.'],
    ['Site', 'The site name or code, e.g. HQ.'],
    ['Quantity', 'Pieces for a plate (whole sheets); otherwise in the item’s unit.'],
    ['Length, Width, Size unit', 'For plates only: the sheet size, e.g. 8 × 4 ft or 2440 × 1220 mm.'],
    ['Cost per unit', 'What it cost, excluding VAT: per sq ft for plates, per unit otherwise.'],
  ]);
}

const num = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));
const decimals = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;
const squash = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** Checks every row; each gets status 'add' | 'skip' | 'error', a message and the clean data. */
export async function check(sheets) {
  const categories = await listCategories();
  const existingItems = await db('items').select('id', 'name', 'priced_by', 'unit', 'is_active');
  const sites = await db('sites').where({ is_active: true }).select('id', 'name', 'code');
  const items = [];
  const names = new Map(); // squashed name → { row, priced_by, status, id? }

  for (const r of sheets.Items ?? []) {
    const problems = [];
    const name = r.name.replace(/\s+/g, ' ').trim();
    if (name.length < 2) problems.push('Name is missing');
    const category = categories.find((c) => c.name.toLowerCase() === r.category.trim().toLowerCase());
    if (!category) problems.push(r.category ? `Category “${r.category}” isn’t on the list (Items → Categories)` : 'Category is missing');
    const p = r.priced_by.trim().toLowerCase();
    const area = /sq|area|plate|ft/.test(p);
    if (p && !area && !/unit/.test(p)) problems.push(`Priced by “${r.priced_by}”: use Per unit or Per sq ft`);
    const thickness = r.thickness ? num(r.thickness) : null;
    if (area && !(thickness > 0 && thickness <= 200)) problems.push('A plate needs its thickness in mm');
    const unit = area ? 'sq ft' : (r.unit.trim() || null);
    if (!area && !unit) problems.push('Say what it is counted in (Unit), e.g. Pc');
    const price = r.price ? num(r.price) : null;
    if (r.price && !(price >= 0 && decimals(price, 2))) problems.push(`Check the price “${r.price}”`);
    const reorder = r.reorder ? num(r.reorder) : null;
    if (r.reorder && !(reorder >= 0)) problems.push(`Check the reorder level “${r.reorder}”`);
    const data = { name: name.slice(0, 120), category: category?.name ?? null, priced_by: area ? 'area' : 'unit', unit: unit?.slice(0, 20) ?? null,
      thickness_mm: area ? thickness : null, current_price: price, reorder_level: reorder, notes: r.notes ? r.notes.slice(0, 2000) : null };

    let status = 'add';
    let message = '';
    const key = squash(name);
    if (problems.length) { status = 'error'; message = problems.join('; '); }
    else if (names.has(key)) { status = 'error'; message = `“${name}” is already on row ${names.get(key).row} of this sheet`; }
    else {
      const existing = existingItems.find((i) => squash(i.name) === key);
      if (existing) { status = 'skip'; message = `Already an item: ${existing.name}${existing.is_active ? '' : ' (switched off)'}`; }
    }
    if (!names.has(key)) names.set(key, { row: r.row, status, priced_by: data.priced_by, unit: data.unit });
    items.push({ row: r.row, status, message, data, show: [name, data.category, area ? `per sq ft, ${thickness ?? '?'} mm` : `per ${unit ?? '?'}`] });
  }

  const stock = [];
  const seen = new Map();
  for (const r of sheets['Opening stock'] ?? []) {
    const problems = [];
    const key = squash(r.item);
    const inFile = names.get(key);
    const inApp = existingItems.find((i) => squash(i.name) === key);
    let item = null;
    if (!r.item) problems.push('Item is missing');
    else if (inFile && inFile.status === 'error') problems.push(`Its item (row ${inFile.row} of Items) has a problem`);
    else if (inApp) item = { id: inApp.id, name: inApp.name, priced_by: inApp.priced_by, unit: inApp.unit };
    else if (inFile) item = { name: r.item.trim(), priced_by: inFile.priced_by, unit: inFile.unit };
    else problems.push(`No item “${r.item}” in this file or the app`);
    const site = sites.find((s) => s.name.toLowerCase() === r.site.trim().toLowerCase() || s.code.toLowerCase() === r.site.trim().toLowerCase());
    if (!site) problems.push(r.site ? `No site “${r.site}” (use the name or code, e.g. ${sites[0]?.code ?? 'HQ'})` : 'Site is missing');
    const quantity = num(r.quantity);
    if (!(quantity > 0 && quantity <= 9_999_999 && decimals(quantity, 3))) problems.push(r.quantity ? `Check the quantity “${r.quantity}”` : 'Quantity is missing');
    const cost = num(r.cost);
    if (!(cost > 0 && cost <= 999_999_999 && decimals(cost, 2))) problems.push(r.cost ? `Check the cost “${r.cost}”` : 'Cost per unit is missing (excluding VAT)');
    const data = { item_id: item?.id ?? null, item_name: item?.name ?? r.item, site_id: site?.id ?? null, quantity, unit_cost: cost, length: null, width: null, size_unit: null, area_sq_ft: null };
    if (item?.priced_by === 'area') {
      const [length, width] = [num(r.length), num(r.width)];
      const unit = (r.size_unit.trim().toLowerCase() || 'ft');
      if (!(length > 0 && width > 0 && length <= 100_000 && width <= 100_000) || !SHEET_UNITS.includes(unit)) problems.push('A plate needs its length and width (and ft or mm)');
      else Object.assign(data, { length, width, size_unit: unit, area_sq_ft: Math.round(sheetSize({ length, width, unit }).sqFt * 10_000) / 10_000 });
      if (!Number.isInteger(quantity)) problems.push('Plates are counted in whole sheets');
    }

    let status = 'add';
    let message = '';
    const size = sizeKey(data);
    const id = `${key}|${site?.id}|${size}`;
    if (problems.length) { status = 'error'; message = problems.join('; '); }
    else if (seen.has(id)) { status = 'error'; message = `Same item, site and size as row ${seen.get(id)}`; }
    else if (item.id && await db('stock_movements').where({ type: 'opening', item_id: item.id, site_id: site.id, size_key: size }).first('id')) {
      status = 'skip'; message = 'Opening stock already entered for this item, site and size';
    }
    if (!seen.has(id)) seen.set(id, r.row);
    const sizeText = data.size_unit ? ` · ${data.length} × ${data.width} ${data.size_unit}` : '';
    stock.push({ row: r.row, status, message, data, show: [r.item, `${quantity || '?'} ${item?.priced_by === 'area' ? 'sheets' : item?.unit ?? ''}${sizeText}`, site?.name ?? r.site, cost ? `KES ${cost} each` : ''] });
  }
  return { Items: items, 'Opening stock': stock };
}

/** Adds the rows marked 'add': items first, then the opening stock site by site. */
export async function run(sheets, actor) {
  const failed = [];
  let itemsAdded = 0;
  for (const it of sheets.Items) {
    if (it.status !== 'add') continue;
    try {
      await createItem(it.data, actor);
      itemsAdded++;
    } catch (err) {
      failed.push(`Items row ${it.row}: ${err.message}`);
    }
  }
  let stockAdded = 0;
  const bySite = new Map();
  for (const s of sheets['Opening stock']) {
    if (s.status !== 'add') continue;
    const id = s.data.item_id ?? (await db('items').whereRaw("REPLACE(`name`, ' ', '') = ?", [s.data.item_name.replace(/\s+/g, '')]).first('id'))?.id;
    if (!id) { failed.push(`Opening stock row ${s.row}: its item wasn’t added`); continue; }
    const line = { item_id: id, quantity: s.data.quantity, unit_cost: s.data.unit_cost, length: s.data.length, width: s.data.width, size_unit: s.data.size_unit, area_sq_ft: s.data.area_sq_ft };
    if (!bySite.has(s.data.site_id)) bySite.set(s.data.site_id, []);
    bySite.get(s.data.site_id).push({ line, row: s.row });
  }
  for (const [siteId, rows] of bySite) {
    try {
      await addOpeningStock(rows.map((r) => r.line), { user: actor.user, ip: actor.ip, site: { id: siteId } });
      stockAdded += rows.length;
    } catch (err) {
      failed.push(`Opening stock rows ${rows.map((r) => r.row).join(', ')}: ${err.message}`);
    }
  }
  return { summary: `${itemsAdded} item${itemsAdded === 1 ? '' : 's'} and ${stockAdded} opening stock line${stockAdded === 1 ? '' : 's'} added`, failed };
}
