import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { STATUSES as ATTENDANCE } from '../attendance/service.js';
import { METHODS } from './service.js';

// One person's payslip as a small PDF (A6, to send on WhatsApp) and as an Excel file.
// PDFs use the built-in Helvetica, so no font files are needed.

const require = createRequire(import.meta.url);
const PdfPrinter = require('pdfmake/src/printer');

const printer = new PdfPrinter({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
});

const money = (n) => Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayName = (day, opts) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
const weekLabel = (p) => `${dayName(p.days[0], { day: 'numeric', month: 'short' })} – ${dayName(p.days[5], { day: 'numeric', month: 'short', year: 'numeric' })}`;

/** What both files show, in order. */
function lines(payroll, slip) {
  return {
    days: payroll.days.map((day) => [dayName(day, { weekday: 'short', day: 'numeric', month: 'short' }),
      `${ATTENDANCE[slip.detail[day]]?.label ?? '—'}${slip.worked_at[day] ? ` (${slip.worked_at[day]})` : ''}`]),
    base: `${Number(slip.days)} ${Number(slip.days) === 1 ? 'day' : 'days'} × KES ${slip.daily_rate === null ? '—' : money(slip.daily_rate)}`,
    adjustments: slip.adjustment_lines.map((a) => [a.reason, `${Number(a.amount) > 0 ? '+' : ''}${money(a.amount)}`]),
    paid: slip.paid_at ? `Paid by ${METHODS[slip.paid_method]}${slip.paid_reference ? ` (${slip.paid_reference})` : ''}` : 'Not paid yet',
  };
}

/** @returns {Promise<Buffer>} */
export function payslipPdf(payroll, slip, company) {
  const l = lines(payroll, slip);
  const doc = printer.createPdfKitDocument({
    pageSize: 'A6',
    pageMargins: [22, 22, 22, 22],
    info: { title: `Payslip ${slip.name} ${payroll.days[0]}` },
    defaultStyle: { font: 'Helvetica', fontSize: 8, lineHeight: 1.15 },
    content: [
      { text: company.name, bold: true, fontSize: 10, color: '#1d3fbf' },
      { text: 'PAYSLIP', bold: true, fontSize: 9, margin: [0, 2, 0, 6] },
      { columns: [{ text: [{ text: slip.name, bold: true }, `\n${slip.employee_number}${slip.trade ? ` · ${slip.trade}` : ''}\n${payroll.site_name}`] },
        { text: `Week ${weekLabel(payroll)}\nPay day ${dayName(payroll.pay_day, { weekday: 'long', day: 'numeric', month: 'short' })}\n${payroll.number}`, alignment: 'right' }] },
      { table: { widths: ['*', 'auto'], body: l.days }, layout: { hLineWidth: (i) => (i === 0 ? 0 : 0.4), vLineWidth: () => 0, hLineColor: () => '#d0d5dd', paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 2, paddingBottom: () => 2 }, margin: [0, 8, 0, 6] },
      { columns: [{ text: l.base }, { text: slip.daily_rate === null ? '—' : money(slip.base), alignment: 'right' }] },
      ...l.adjustments.map(([reason, amount]) => ({ columns: [{ text: reason }, { text: amount, alignment: 'right' }], margin: [0, 2, 0, 0] })),
      { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 254, y2: 4, lineWidth: 0.6 }] },
      { columns: [{ text: 'To pay (KES)', bold: true, fontSize: 10 }, { text: money(slip.net), bold: true, fontSize: 10, alignment: 'right' }], margin: [0, 6, 0, 4] },
      { text: l.paid, color: '#475467' },
      slip.mpesa_phone || slip.phone ? { text: `M-Pesa: ${(slip.mpesa_phone || slip.phone).replace(/^\+254/, '0')}`, color: '#475467' } : '',
      { text: `Approved by ${payroll.approved_by_name ?? '—'}`, color: '#475467', margin: [0, 6, 0, 0] },
    ],
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** @returns {Promise<Buffer>} */
export async function payslipXlsx(payroll, slip, company) {
  const l = lines(payroll, slip);
  const book = new ExcelJS.Workbook();
  book.creator = company.name;
  const ws = book.addWorksheet('Payslip');
  ws.columns = [{ width: 30 }, { width: 18 }];
  ws.addRows([
    [company.name], ['Payslip', payroll.number], [],
    ['Name', slip.name], ['Number', slip.employee_number], ['Site', payroll.site_name], ['Week', weekLabel(payroll)], ['Pay day', payroll.pay_day], [],
    ...l.days, [],
    [l.base, Number(slip.base)],
    ...l.adjustments.map(([reason], i) => [reason, Number(slip.adjustment_lines[i].amount)]),
    ['To pay (KES)', Number(slip.net)], [], [l.paid],
  ]);
  ws.getRow(1).font = { bold: true, size: 12 };
  ws.eachRow((row) => { if (typeof row.getCell(2).value === 'number') row.getCell(2).numFmt = '#,##0.00'; });
  ws.lastRow.font = {};
  ws.getRow(ws.rowCount - 2).font = { bold: true };
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** The week's register: everyone, days, rate, adjustments and pay. @returns {Promise<Buffer>} */
export async function registerXlsx(payroll, company) {
  const book = new ExcelJS.Workbook();
  book.creator = company.name;
  const ws = book.addWorksheet('Payroll');
  ws.addRow([`${company.name}: payroll ${payroll.number}, ${payroll.site_name}, week ${weekLabel(payroll)}`]).font = { bold: true };
  ws.addRow([]);
  const head = ws.addRow(['Number', 'Name', ...payroll.days.map((d) => dayName(d, { weekday: 'short', day: 'numeric' })), 'Days', 'Daily rate', 'Days × rate', 'Adjustments', 'To pay', 'Paid by', 'Reference', 'M-Pesa']);
  head.font = { bold: true };
  for (const s of payroll.slips) {
    ws.addRow([s.employee_number, s.name, ...payroll.days.map((d) => `${ATTENDANCE[s.detail[d]]?.short ?? ''}${s.worked_at[d] ? ` (${s.worked_at[d]})` : ''}`), Number(s.days),
      s.daily_rate === null ? null : Number(s.daily_rate), Number(s.base), Number(s.adjustments), Number(s.net),
      s.paid_method ? METHODS[s.paid_method] : '', s.paid_reference ?? '', (s.mpesa_phone || s.phone || '').replace(/^\+254/, '0')]);
  }
  const total = ws.addRow(['', 'Total', ...payroll.days.map(() => ''), '', '', '', '', Number(payroll.total)]);
  total.font = { bold: true };
  ws.columns.forEach((c, i) => { c.width = i === 1 ? 26 : i < 2 ? 12 : i < 8 ? 7 : 13; });
  for (const col of [10, 11, 12, 13]) ws.getColumn(col).numFmt = '#,##0.00';
  return Buffer.from(await book.xlsx.writeBuffer());
}
