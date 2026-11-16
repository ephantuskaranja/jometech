import ExcelJS from 'exceljs';

// Reading and writing the import templates. Each sheet has one header row; columns are found by
// their header (case, spaces, * and brackets ignored), so a column moved or added doesn't matter.

const key = (s) => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

/** A cell as plain text: numbers without ".0", dates as YYYY-MM-DD, formulas as their result. */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result);
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return String(value.text);
    return '';
  }
  return String(value).trim();
}

/**
 * The rows of one sheet as objects keyed by `fields` ({ field: 'Header text' }), with their row number.
 * Empty rows are left out. Null when the workbook has no such sheet.
 */
export function readSheet(book, sheetName, fields) {
  const ws = book.worksheets.find((w) => key(w.name) === key(sheetName));
  if (!ws) return null;
  const header = ws.getRow(1);
  const columns = {};
  header.eachCell((cell, col) => {
    const field = Object.entries(fields).find(([, label]) => key(label) === key(cellText(cell.value)));
    if (field) columns[field[0]] = col;
  });
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const data = Object.fromEntries(Object.keys(fields).map((f) => [f, columns[f] ? cellText(row.getCell(columns[f]).value) : '']));
    if (Object.values(data).some((v) => v !== '')) rows.push({ row: n, ...data });
  });
  return { rows, missing: Object.keys(fields).filter((f) => !columns[f]) };
}

export async function loadBook(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return book;
}

/**
 * A template: one sheet per entry ({ name, columns: [[header, width, required]] , example }) plus
 * "How to fill" with the notes and an example row per sheet.
 */
export function template(sheets, notes) {
  const book = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = book.addWorksheet(s.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = s.columns.map(([header, width, required]) => ({ header: required ? `${header} *` : header, width }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1A5C' } };
    // Phone, ID and similar columns stay text, so Excel keeps the leading 0.
    s.columns.forEach(([, , , text], i) => { if (text) ws.getColumn(i + 1).numFmt = '@'; });
  }
  const help = book.addWorksheet('How to fill');
  help.columns = [{ width: 28 }, { width: 90 }];
  help.addRow(['How to fill this file']).font = { bold: true, size: 14 };
  help.addRow([]);
  for (const [a, b] of notes) {
    const r = help.addRow([a, b]);
    r.getCell(1).font = { bold: true };
    r.alignment = { wrapText: true, vertical: 'top' };
  }
  for (const s of sheets) {
    help.addRow([]);
    help.addRow([`Example: ${s.name}`]).font = { bold: true };
    help.addRow(s.columns.map(([h]) => h)).font = { italic: true };
    help.addRow(s.example);
  }
  return book;
}
