import { Router } from 'express';
import ExcelJS from 'exceljs';
import { canAny } from '../../core/auth.js';
import { localDay } from '../../core/dates.js';
import { fmt } from '../../core/format.js';
import { config } from '../../config.js';
import * as reports from './service.js';
import { METHODS as PAYMENT_METHODS } from '../invoices/service.js';

// Period summary: a day or a range, one site or all. Printed from the browser, or downloaded as Excel.

export const router = Router();
const see = canAny('reports.summary');

/** The period, site and query string (for the Download link) from ?period&from&to&site. */
function choice(req) {
  const today = localDay();
  const p = reports.periodOf(req.query, today);
  const site = req.user.sites.find((s) => s.id === Number(req.query.site)) ?? null;
  const qs = new URLSearchParams({ period: p.key, ...(p.key === 'custom' ? { from: p.from, to: p.to } : {}), ...(site ? { site: site.id } : {}) });
  return { today, p, site, qs: qs.toString() };
}

const day = (d) => fmt.date(`${d}T12:00:00Z`);
const periodLabel = (p) => (p.from === p.to ? day(p.from) : `${day(p.from)} – ${day(p.to)}`);

router.get('/reports/summary', see, async (req, res) => {
  const { today, p, site, qs } = choice(req);
  res.render('reports/views/summary', {
    title: 'Summary',
    p, site, qs, today,
    periodLabel: periodLabel(p),
    periods: reports.PERIODS,
    sites: req.user.sites,
    changes: reports.JOB_CHANGES,
    methods: PAYMENT_METHODS,
    s: await reports.summary(p, site?.id ?? null, today),
  });
});

router.get('/reports/summary.xlsx', see, async (req, res) => {
  const { today, p, site } = choice(req);
  const s = await reports.summary(p, site?.id ?? null, today);
  const book = workbook(s, { p, site, today });
  res.attachment(`summary-${p.from}${p.to === p.from ? '' : `-to-${p.to}`}${site ? `-${site.code}` : ''}.xlsx`);
  await book.xlsx.write(res);
  res.end();
});

// ---------- Excel: a sheet per section ----------

const MONEY = '#,##0.00';

function sheet(book, name, columns, rows) {
  const ws = book.addWorksheet(name);
  ws.columns = columns.map(([header, key, width = 16, numFmt]) => ({ header, key, width, style: numFmt ? { numFmt } : {} }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.addRows(rows);
  if (!rows.length) ws.addRow({ [columns[0][1]]: 'Nothing in this period' });
  return ws;
}

function workbook(s, { p, site, today }) {
  const { jobs, stores, front, money } = s;
  const book = new ExcelJS.Workbook();
  book.creator = config.company?.name ?? 'Jome-Tech';

  const glance = book.addWorksheet('Summary');
  glance.columns = [{ width: 34 }, { width: 18 }];
  glance.addRows([
    ['Summary', periodLabel(p)],
    ['Site', site?.name ?? 'All sites'],
    ['"Now" figures are as of', day(today)],
    [],
    ['Jobs started', jobs.started],
    ['New jobs', jobs.created],
    ['Jobs completed', jobs.completed.length],
    ['Jobs overdue (now)', jobs.overdue.length],
    ['Stock issued to jobs, less returns (KES)', stores.issuedValue],
    ['Goods received (KES)', stores.receivedValue],
    ['Price rises of 10% or more', stores.priceRises.length],
    ['Items low (now, all sites)', stores.lowStock.length],
    ['Orders waiting for approval (now)', stores.ordersWaiting.length],
    ['Vehicles checked in', front.checkedIn.length],
    ['Vehicles checked out', front.checkedOut.length],
    ['Proformas sent', front.proformas.sent.length],
    ['Proformas sent (KES)', front.proformas.sentValue],
    ['Proformas accepted', front.proformas.accepted.length],
    ['Proformas accepted (KES)', front.proformas.acceptedValue],
    ['New enquiries', front.enquiries.count],
    ['Invoiced (KES)', money.issuedValue],
    ['Payments received (KES)', money.receivedValue],
  ]);
  glance.getRow(1).font = { bold: true, size: 13 };
  for (const r of [9, 10, 17, 19, 21, 22]) glance.getCell(`B${r}`).numFmt = MONEY;

  sheet(book, 'Job changes', [['When', 'at', 20], ['Job', 'number', 16], ['Change', 'change', 16], ['Detail', 'summary', 30], ['Customer', 'customer_name', 28], ['Vehicle', 'vehicle', 16], ['By', 'user_name', 20]],
    jobs.changes.map((c) => ({ ...c, at: fmt.dateTime(c.created_at), change: reports.JOB_CHANGES[c.action] })));
  sheet(book, 'Jobs completed', [['Job', 'number'], ['Customer', 'customer_name', 28], ['Vehicle', 'vehicle'], ['Completed', 'done', 20], ['Days taken', 'days', 12], ['Due', 'due', 14], ['On time', 'onTime', 10]],
    jobs.completed.map((j) => ({ ...j, done: fmt.dateTime(j.completed_at), due: j.due_on ? day(j.due_on) : '', onTime: j.late === null ? '' : j.late ? 'Late' : 'Yes' })));
  sheet(book, 'Overdue now', [['Job', 'number'], ['Customer', 'customer_name', 28], ['Vehicle', 'vehicle'], ['Due', 'due', 14], ['Days late', 'daysLate', 12], ['Current step', 'current_step', 24]],
    jobs.overdue.map((j) => ({ ...j, due: day(j.due_on) })));
  sheet(book, 'Issued to jobs', [['Job', 'number'], ['Customer', 'customer_name', 28], ['Item', 'item', 30], ['How much', 'amount', 16], ['Cost (KES)', 'value', 16, MONEY]],
    stores.issuedToJobs.flatMap((j) => [
      ...j.lines.map((l) => ({ number: j.number, customer_name: j.customer_name, item: l.name, amount: l.amount, value: l.value })),
      ...(j.returnedValue ? [{ number: j.number, customer_name: j.customer_name, item: 'Returned to stores', value: -j.returnedValue }] : []),
    ]));
  sheet(book, 'Goods received', [['GRN', 'number'], ['Date', 'date', 14], ['Supplier', 'supplier_name', 28], ['Order', 'order_number'], ['Into stock (KES)', 'value', 18, MONEY], ['Note', 'note', 12]],
    stores.received.map((g) => ({ ...g, date: day(g.received_on), note: g.reversed_at ? 'Reversed' : '' })));
  sheet(book, 'Price rises', [['Item', 'item_name', 30], ['Unit', 'unit', 10], ['Was (KES)', 'previous_price', 14, MONEY], ['Now (KES)', 'unit_price', 14, MONEY], ['Rise %', 'risePct', 10], ['GRN', 'receipt_number']],
    stores.priceRises.map((r) => ({ ...r, previous_price: Number(r.previous_price), unit_price: Number(r.unit_price), risePct: Math.round(r.rise) })));
  sheet(book, 'Low stock now', [['Item', 'name', 30], ['Unit', 'unit', 10], ['On hand', 'on_hand', 12], ['Reorder at', 'reorder', 12]],
    stores.lowStock.map((i) => ({ ...i, on_hand: Number(i.on_hand_qty), reorder: Number(i.reorder_level) })));
  sheet(book, 'Orders waiting', [['Order', 'number'], ['Supplier', 'supplier_name', 28], ['Value (KES)', 'total', 16, MONEY], ['Waiting since', 'since', 20]],
    stores.ordersWaiting.map((o) => ({ ...o, total: o.total === null ? null : Number(o.total), since: fmt.dateTime(o.waitingSince) })));
  sheet(book, 'Vehicles', [['What', 'what', 14], ['When', 'when', 20], ['Number', 'number'], ['Vehicle', 'vehicle'], ['Customer / sites', 'detail', 34]], [
    ...front.checkedIn.map((k) => ({ what: 'Checked in', when: fmt.dateTime(k.at), number: k.number, vehicle: k.vehicle, detail: k.customer_name })),
    ...front.checkedOut.map((k) => ({ what: 'Checked out', when: fmt.dateTime(k.at), number: k.number, vehicle: k.vehicle, detail: k.customer_name })),
    ...front.movements.map((m) => ({ what: 'Moved', when: fmt.dateTime(m.sent_at), number: m.number, vehicle: m.vehicle, detail: `${m.from_site} → ${m.to_site}` })),
  ]);
  sheet(book, 'Proformas', [['What', 'what', 12], ['When', 'when', 20], ['Proforma', 'number'], ['Customer', 'customer_name', 28], ['Total incl. VAT (KES)', 'total', 20, MONEY]], [
    ...front.proformas.sent.map((r) => ({ ...r, what: 'Sent' })),
    ...front.proformas.accepted.map((r) => ({ ...r, what: 'Accepted' })),
    ...front.proformas.declined.map((r) => ({ ...r, what: 'Declined' })),
  ].map((r) => ({ ...r, when: fmt.dateTime(r.at), total: Number(r.total) })));
  sheet(book, 'Enquiries', [['Work type', 'work_type', 30], ['New enquiries', 'n', 14]], front.enquiries.byWorkType)
    .addRows([[], ['Won in the period', front.enquiries.won], ['Lost in the period', front.enquiries.lost]]);
  sheet(book, 'Invoices', [['Invoice', 'number'], ['Issued', 'when', 20], ['Job', 'job_number'], ['Customer', 'customer_name', 28], ['Total incl. VAT (KES)', 'total', 20, MONEY], ['Note', 'note', 12]],
    money.issued.map((i) => ({ ...i, when: fmt.dateTime(i.issued_at), total: Number(i.total), note: i.status === 'cancelled' ? 'Cancelled' : '' })));
  sheet(book, 'Payments', [['Receipt', 'number'], ['Date', 'date', 14], ['Job', 'job_number'], ['Customer', 'customer_name', 28], ['From', 'from', 10], ['How', 'how', 14], ['Reference', 'reference', 18], ['Amount (KES)', 'amount', 16, MONEY]],
    money.received.map((p) => ({ ...p, date: day(p.paid_on), from: p.payer === 'financier' ? 'Bank' : 'Client', how: PAYMENT_METHODS[p.method], amount: Number(p.amount) })));
  return book;
}
