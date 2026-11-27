import { db } from '../../core/db.js';
import { fmt } from '../../core/format.js';
import { localDay } from '../../core/dates.js';
import { METHODS } from '../invoices/service.js';
import { vehicleLabel } from '../../core/vehicle-format.js';

// Reports → Sales, Stock value, Purchases and Labour. Each returns the same shape, shown by one page
// (views/table-report.ejs) and written by one Excel writer (routes):
//
//   { kpis: [{ label, value, foot }], tables: [{ title, columns: [{ key, label, type }], rows, total }], note }
//   type: 'money' | 'qty' | 'text' (default) | 'date' | 'link' (row[key] = { text, href })
//
// Sales, purchases and labour are for a month; stock value is as of now. All for one site or all of
// the person's sites.

const round = (n) => Math.round(n * 100) / 100;
const sum = (rows, key) => round(rows.reduce((n, r) => n + Number(r[key] ?? 0), 0));
export const monthEnd = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const range = (month) => ({ from: `${month}-01`, to: monthEnd(month) });

// ---------- sales: invoiced, received, still owed ----------

export async function sales({ month, siteIds }) {
  const { from, to } = range(month);
  const paid = db('payments').whereRaw('payments.job_id = i.job_id').whereNull('voided_at').select(db.raw('COALESCE(SUM(amount), 0)'));
  const invoices = (await db('invoices as i').join('customers as c', 'c.id', 'i.customer_id').join('jobs as j', 'j.id', 'i.job_id')
    .where('i.status', 'issued').whereBetween('i.invoice_date', [from, to]).whereIn('i.site_id', siteIds)
    .orderBy('i.invoice_date').orderBy('i.id')
    .select('i.id', 'i.number', 'i.invoice_date', 'i.total', 'c.id as customer_id', 'c.name as customer_name', 'j.number as job_number', paid.as('paid')))
    .map((i) => ({ ...i, total: Number(i.total), paid: Math.min(Number(i.paid), Number(i.total)), owed: round(Math.max(Number(i.total) - Number(i.paid), 0)) }));
  const received = await db('payments as p').join('jobs as j', 'j.id', 'p.job_id').whereNull('p.voided_at').whereNot('p.method', 'credit').whereBetween('p.paid_on', [from, to]).whereIn('j.site_id', siteIds)
    .groupBy('p.method').select('p.method', db.raw('SUM(p.amount) AS amount'), db.raw('COUNT(*) AS n'));

  const byCustomer = new Map();
  for (const i of invoices) {
    const c = byCustomer.get(i.customer_id) ?? { customer: { text: i.customer_name, href: `/customers/${i.customer_id}` }, invoices: 0, total: 0, paid: 0, owed: 0 };
    Object.assign(c, { invoices: c.invoices + 1, total: round(c.total + i.total), paid: round(c.paid + i.paid), owed: round(c.owed + i.owed) });
    byCustomer.set(i.customer_id, c);
  }
  const customers = [...byCustomer.values()].sort((a, b) => b.total - a.total);
  const receivedTotal = round(received.reduce((n, r) => n + Number(r.amount), 0));
  return {
    kpis: [
      { label: 'Invoiced', value: `KES ${fmt.money(sum(invoices, 'total'))}`, foot: `${invoices.length} invoice${invoices.length === 1 ? '' : 's'} issued` },
      { label: 'Received in the month', value: `KES ${fmt.money(receivedTotal)}`, foot: received.map((r) => `${METHODS[r.method] ?? r.method} ${fmt.money(r.amount)}`).join(' · ') || 'no payments' },
      { label: 'Still owed on these', value: `KES ${fmt.money(sum(invoices, 'owed'))}`, foot: `${invoices.filter((i) => i.owed > 0).length} not fully paid`, tone: sum(invoices, 'owed') > 0 ? 'warn' : null },
      { label: 'Customers', value: customers.length, foot: 'invoiced in the month' },
    ],
    tables: [
      { title: 'By customer', columns: [{ key: 'customer', label: 'Customer', type: 'link' }, { key: 'invoices', label: 'Invoices', type: 'qty' }, { key: 'total', label: 'Invoiced', type: 'money' }, { key: 'paid', label: 'Paid', type: 'money' }, { key: 'owed', label: 'Owed', type: 'money' }],
        rows: customers, total: { customer: 'Total', invoices: invoices.length, total: sum(invoices, 'total'), paid: sum(invoices, 'paid'), owed: sum(invoices, 'owed') } },
      { title: 'Invoices issued', columns: [{ key: 'number', label: 'Invoice', type: 'link' }, { key: 'invoice_date', label: 'Date', type: 'date' }, { key: 'customer', label: 'Customer' }, { key: 'job_number', label: 'Job' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'paid', label: 'Paid', type: 'money' }, { key: 'owed', label: 'Owed', type: 'money' }],
        rows: invoices.map((i) => ({ ...i, number: { text: i.number, href: `/invoices/${i.id}` }, customer: i.customer_name })), total: { number: 'Total', total: sum(invoices, 'total'), paid: sum(invoices, 'paid'), owed: sum(invoices, 'owed') } },
    ],
    note: 'Invoices issued in the month (prices include VAT); paid and owed as of today. “Received in the month” is every payment dated in the month, whichever invoice it was for.',
  };
}

// ---------- stock value: what is on the racks now ----------

/**
 * Stock builds still waiting for a buyer (sheet row 58): bodies built for stock, with what has gone into
 * them from the stores so far (net of returns). Ready = the job is complete.
 */
export async function stockBuilds(siteIds, today = localDay()) {
  const materials = db('material_issue_lines as l').join('material_issues as m', 'm.id', 'l.issue_id')
    .whereRaw('m.job_id = j.id').select(db.raw('COALESCE(SUM(l.value - l.returned_value), 0)'));
  const rows = await db('jobs as j').join('customers as c', 'c.id', 'j.customer_id').join('sites as s', 's.id', 'j.site_id')
    .leftJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .where({ 'j.stock_build': true, 'c.is_stock': true }).whereNot('j.status', 'cancelled').whereIn('j.site_id', siteIds)
    .orderBy('j.created_at').orderBy('j.id')
    .select('j.id', 'j.number', 'j.status', 'j.created_at', 'j.completed_at', 's.name as site_name', 'v.reg_no', 'v.chassis_no', 'v.temp_tag', 'v.make', 'v.model',
      materials.as('materials'),
      db('job_lines').where('job_id', db.ref('j.id')).orderBy('sort_order').limit(1).select('description').as('work'));
  return rows.map((j) => ({
    job: { text: j.number, href: `/jobs/${j.id}` },
    vehicle: [j.reg_no || j.chassis_no || j.temp_tag ? vehicleLabel(j) : null, [j.make, j.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—',
    work: j.work ?? '', site: j.site_name,
    state: j.status === 'completed' ? 'Ready' : 'Being built',
    started: localDay(j.created_at),
    days: Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${localDay(j.created_at)}T12:00:00Z`)) / 86400000)),
    materials: round(Number(j.materials ?? 0)),
  }));
}

export async function stock({ siteIds }) {
  const rows = (await db('stock_balances as b').join('items as i', 'i.id', 'b.item_id').join('sites as s', 's.id', 'b.site_id')
    .leftJoin('item_categories as c', 'c.id', 'i.category_id')
    .whereIn('b.site_id', siteIds).where('b.quantity', '>', 0)
    .orderBy('c.sort_order').orderBy('i.name').orderBy('s.name').orderBy('b.area_sq_ft', 'desc')
    .select('i.id', 'i.name', 'i.unit', 'i.priced_by', 'i.avg_cost', 'i.on_hand_qty', 'i.reorder_level', 'b.quantity', 'b.length', 'b.width', 'b.size_unit', 'b.area_sq_ft',
      's.name as site_name', 'c.name as category'))
    .map((r) => {
      const qty = r.area_sq_ft === null ? Number(r.quantity) : Number(r.quantity) * Number(r.area_sq_ft);
      const low = r.reorder_level !== null && Number(r.on_hand_qty) <= Number(r.reorder_level);
      return {
        item: { text: r.name, href: `/items/${r.id}` }, category: r.category ?? 'No category', site: r.site_name,
        size: r.size_unit ? `${Number(r.quantity)} × ${Number(r.length)} × ${Number(r.width)} ${r.size_unit}` : '',
        qty: Math.round(qty * 1000) / 1000, unit: r.unit, cost: Number(r.avg_cost ?? 0), value: round(qty * Number(r.avg_cost ?? 0)), low: low ? 'Low' : '',
      };
    });
  const byCategory = new Map();
  for (const r of rows) {
    const k = `${r.category}|${r.site}`;
    const c = byCategory.get(k) ?? { category: r.category, site: r.site, lines: 0, value: 0 };
    Object.assign(c, { lines: c.lines + 1, value: round(c.value + r.value) });
    byCategory.set(k, c);
  }
  const lowItems = new Set(rows.filter((r) => r.low).map((r) => r.item.text));
  const builds = await stockBuilds(siteIds);
  const ready = builds.filter((b) => b.state === 'Ready').length;
  return {
    kpis: [
      { label: 'Stock value', value: `KES ${fmt.money(sum(rows, 'value'))}`, foot: 'at average cost, excluding VAT' },
      { label: 'Items in stock', value: new Set(rows.map((r) => r.item.text)).size, foot: `${rows.length} line${rows.length === 1 ? '' : 's'} by site and size` },
      { label: 'Low stock', value: lowItems.size, foot: 'at or below the reorder level', tone: lowItems.size ? 'warn' : null },
      { label: 'Stock builds', value: builds.length, foot: builds.length ? `${ready} ready, ${builds.length - ready} being built; materials KES ${fmt.money(sum(builds, 'materials'))}` : 'none waiting for a buyer' },
    ],
    tables: [
      { title: 'Stock builds awaiting a customer', columns: [{ key: 'job', label: 'Job', type: 'link' }, { key: 'vehicle', label: 'Vehicle' }, { key: 'work', label: 'Work' }, { key: 'site', label: 'Site' },
        { key: 'state', label: 'State' }, { key: 'started', label: 'Started', type: 'date' }, { key: 'days', label: 'Days', type: 'qty' }, { key: 'materials', label: 'Materials so far', type: 'money' }],
        rows: builds, total: builds.length ? { job: 'Total', materials: sum(builds, 'materials') } : null },
      { title: 'By category', columns: [{ key: 'category', label: 'Category' }, { key: 'site', label: 'Site' }, { key: 'lines', label: 'Lines', type: 'qty' }, { key: 'value', label: 'Value', type: 'money' }],
        rows: [...byCategory.values()], total: { category: 'Total', lines: rows.length, value: sum(rows, 'value') } },
      { title: 'Items', columns: [{ key: 'item', label: 'Item', type: 'link' }, { key: 'site', label: 'Site' }, { key: 'size', label: 'Sheets' }, { key: 'qty', label: 'Quantity', type: 'qty' }, { key: 'unit', label: 'Unit' },
        { key: 'cost', label: 'Average cost', type: 'money' }, { key: 'value', label: 'Value', type: 'money' }, { key: 'low', label: '' }],
        rows, total: { item: 'Total', value: sum(rows, 'value') } },
    ],
    note: `As of ${fmt.dateTime(new Date())}. Value = quantity × the item’s average cost (one average across all sites, transport included, VAT excluded). Plates are counted in sq ft. Stock builds: bodies built for stock with no buyer yet; their materials are no longer in the stock value above.`,
  };
}

// ---------- purchases: goods received, by supplier ----------

export async function purchases({ month, siteIds }) {
  const { from, to } = range(month);
  const receipts = (await db('goods_receipts as g').join('purchase_orders as o', 'o.id', 'g.order_id').join('suppliers as s', 's.id', 'o.supplier_id').join('sites as site', 'site.id', 'g.site_id')
    .whereNull('g.reversed_at').whereBetween('g.received_on', [from, to]).whereIn('g.site_id', siteIds)
    .orderBy('g.received_on').orderBy('g.id')
    .select('g.id', 'g.number', 'g.received_on', 'g.goods_total', 'g.transport_cost', 'g.invoice_ref', 'o.number as order_number', 's.id as supplier_id', 's.name as supplier_name', 'site.name as site_name'))
    .map((g) => ({ ...g, goods: Number(g.goods_total), transport: Number(g.transport_cost), total: round(Number(g.goods_total) + Number(g.transport_cost)) }));
  const bySupplier = new Map();
  for (const g of receipts) {
    const s = bySupplier.get(g.supplier_id) ?? { supplier: { text: g.supplier_name, href: `/suppliers/${g.supplier_id}` }, deliveries: 0, goods: 0, transport: 0, total: 0 };
    Object.assign(s, { deliveries: s.deliveries + 1, goods: round(s.goods + g.goods), transport: round(s.transport + g.transport), total: round(s.total + g.total) });
    bySupplier.set(g.supplier_id, s);
  }
  return {
    kpis: [
      { label: 'Bought', value: `KES ${fmt.money(sum(receipts, 'total'))}`, foot: 'goods and transport, excluding VAT' },
      { label: 'Goods', value: `KES ${fmt.money(sum(receipts, 'goods'))}`, foot: `${receipts.length} deliver${receipts.length === 1 ? 'y' : 'ies'} received` },
      { label: 'Transport', value: `KES ${fmt.money(sum(receipts, 'transport'))}`, foot: 'shared into item costs' },
      { label: 'Suppliers', value: bySupplier.size, foot: 'delivered in the month' },
    ],
    tables: [
      { title: 'By supplier', columns: [{ key: 'supplier', label: 'Supplier', type: 'link' }, { key: 'deliveries', label: 'Deliveries', type: 'qty' }, { key: 'goods', label: 'Goods', type: 'money' }, { key: 'transport', label: 'Transport', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }],
        rows: [...bySupplier.values()].sort((a, b) => b.total - a.total), total: { supplier: 'Total', deliveries: receipts.length, goods: sum(receipts, 'goods'), transport: sum(receipts, 'transport'), total: sum(receipts, 'total') } },
      { title: 'Goods received', columns: [{ key: 'number', label: 'Received', type: 'link' }, { key: 'received_on', label: 'Date', type: 'date' }, { key: 'supplier', label: 'Supplier' }, { key: 'order_number', label: 'Order' }, { key: 'site_name', label: 'Site' },
        { key: 'invoice_ref', label: 'Their receipt' }, { key: 'goods', label: 'Goods', type: 'money' }, { key: 'transport', label: 'Transport', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }],
        rows: receipts.map((g) => ({ ...g, number: { text: g.number, href: `/goods-received/${g.id}` }, supplier: g.supplier_name })), total: { number: 'Total', goods: sum(receipts, 'goods'), transport: sum(receipts, 'transport'), total: sum(receipts, 'total') } },
    ],
    note: 'Goods received in the month at what they cost (from the supplier’s receipt, excluding VAT); deliveries taken back are left out.',
  };
}

// ---------- labour: attendance and wages ----------

export async function labour({ month, siteIds }) {
  const { from, to } = range(month);
  const payrolls = (await db('payrolls as p').join('sites as s', 's.id', 'p.site_id').whereIn('p.site_id', siteIds).whereBetween('p.pay_day', [from, to])
    .orderBy('p.week_start').orderBy('s.name')
    .select('p.id', 'p.number', 'p.week_start', 'p.pay_day', 'p.status', 'p.total', 's.name as site_name',
      db('payslips').whereRaw('payslips.payroll_id = p.id').count('*').as('staff'),
      db('payslips').whereRaw('payslips.payroll_id = p.id').sum('days').as('days')))
    .map((p) => ({ ...p, total: Number(p.total), staff: Number(p.staff), days: Number(p.days ?? 0) }));
  const counted = payrolls.filter((p) => ['approved', 'paid', 'closed'].includes(p.status));
  const attendance = await db('attendance_days as a').join('sites as s', 's.id', 'a.site_id').whereIn('a.site_id', siteIds).whereBetween('a.day', [from, to])
    .groupBy('s.id', 's.name').orderBy('s.name')
    .select('s.name as site', db.raw("SUM(a.status = 'present') AS present"), db.raw("SUM(a.status = 'half') AS half"), db.raw("SUM(a.status = 'absent') AS absent"),
      db.raw("SUM(a.status IN ('sick', 'leave')) AS away"), db.raw('COUNT(DISTINCT a.employee_id) AS people'));
  const att = attendance.map((a) => ({ site: a.site, people: Number(a.people), present: Number(a.present), half: Number(a.half), absent: Number(a.absent), away: Number(a.away),
    worked: Number(a.present) + Number(a.half) / 2 }));
  const STATUS = { draft: 'Draft', checked: 'Checked', approved: 'Approved', paid: 'Paid', closed: 'Closed' };
  return {
    kpis: [
      { label: 'Wages', value: `KES ${fmt.money(sum(counted, 'total'))}`, foot: `${counted.length} approved payroll${counted.length === 1 ? '' : 's'}` },
      { label: 'Days worked', value: fmt.qty(att.reduce((n, a) => n + a.worked, 0)), foot: 'present, half days as ½' },
      { label: 'Not yet approved', value: payrolls.length - counted.length, foot: `KES ${fmt.money(sum(payrolls.filter((p) => !counted.includes(p)), 'total'))}`, tone: payrolls.length > counted.length ? 'warn' : null },
    ],
    tables: [
      { title: 'Payrolls (paid in the month)', columns: [{ key: 'number', label: 'Payroll', type: 'link' }, { key: 'site_name', label: 'Site' }, { key: 'week_start', label: 'Week of', type: 'date' }, { key: 'status', label: 'Status' },
        { key: 'staff', label: 'Staff', type: 'qty' }, { key: 'days', label: 'Days', type: 'qty' }, { key: 'total', label: 'Total', type: 'money' }],
        rows: payrolls.map((p) => ({ ...p, number: { text: p.number, href: `/payroll/${p.id}` }, status: STATUS[p.status] ?? p.status })), total: { number: 'Total', staff: sum(payrolls, 'staff'), days: sum(payrolls, 'days'), total: sum(payrolls, 'total') } },
      { title: 'Attendance by site', columns: [{ key: 'site', label: 'Site' }, { key: 'people', label: 'People', type: 'qty' }, { key: 'present', label: 'Present', type: 'qty' }, { key: 'half', label: 'Half days', type: 'qty' },
        { key: 'absent', label: 'Absent', type: 'qty' }, { key: 'away', label: 'Sick / leave', type: 'qty' }, { key: 'worked', label: 'Days worked', type: 'qty' }],
        rows: att, total: { site: 'Total', present: sum(att, 'present'), half: sum(att, 'half'), absent: sum(att, 'absent'), away: sum(att, 'away'), worked: sum(att, 'worked') } },
    ],
    note: 'Payrolls paid (Saturday pay day) in the month; “Wages” counts approved, paid and closed ones. Attendance as marked for each day of the month.',
  };
}

export const REPORTS = {
  sales: { title: 'Sales', sub: 'Invoiced, received and still owed', fn: sales, monthly: true, icon: 'receipt' },
  stock: { title: 'Stock value', sub: 'What is on the racks, at average cost', fn: stock, monthly: false, icon: 'stack' },
  purchases: { title: 'Purchases', sub: 'Goods received, by supplier', fn: purchases, monthly: true, icon: 'cart' },
  labour: { title: 'Labour', sub: 'Attendance and wages', fn: labour, monthly: true, icon: 'people' },
};

export const thisMonth = () => localDay().slice(0, 7);
