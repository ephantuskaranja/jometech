import { db } from '../../core/db.js';
import { localDay } from '../../core/dates.js';
import { fmt } from '../../core/format.js';
import { countInWorkshop } from '../checkins/service.js';
import { arriving } from '../movements/service.js';
import * as jobs from '../jobs/service.js';
import * as enquiries from '../enquiries/service.js';
import * as proformas from '../proformas/service.js';
import * as invoices from '../invoices/service.js';
import * as orders from '../purchasing/service.js';
import { stockTotals } from '../stock/service.js';
import { atGate as goodsAtGate } from '../stock/transfers.js';
import { counts as visitorCounts } from '../visitors/service.js';
import { waitingAtGate } from '../checkins/release.js';

// The dashboard: one section per area the person works in (from their permissions),
// each a strip of numbers that open the list behind them. Workshop, visitors and
// people are for the current site; sales are company-wide, as their lists are.

const count = async (q) => Number((await q.count({ n: '*' }))[0].n);
const can = (user, ...perms) => perms.some((p) => user.can(p));

async function workshop(user, site) {
  const today = localDay();
  const active = (q) => q.where('site_id', site.id).whereIn('status', ['open', 'in_progress']);
  const [inWorkshop, byTab, overdue, dueWeek, coming] = await Promise.all([
    countInWorkshop(site.id),
    jobs.countByTab(site.id),
    count(active(db('jobs')).where('due_on', '<', today)),
    count(active(db('jobs')).whereBetween('due_on', [today, new Date(Date.parse(today + 'T00:00:00Z') + 6 * 86_400_000).toISOString().slice(0, 10)])),
    arriving(site.id),
  ]);
  const items = [
    { label: 'In the workshop', value: inWorkshop, foot: 'vehicles checked in', icon: 'truck', href: '/check-in' },
    { label: 'Active jobs', value: byTab.active, foot: 'open or in progress', icon: 'wrench', href: '/jobs' },
    { label: 'Overdue', value: overdue, foot: 'past the promised date', icon: 'exclamation-triangle', href: '/jobs', tone: 'warn' },
    { label: 'Due this week', value: dueWeek, foot: 'promised in the next 7 days', icon: 'calendar-week', href: '/jobs' },
  ];
  if (can(user, 'checkin.manage')) items.push({ label: 'Arriving', value: coming.length, foot: 'vehicles sent from another site', icon: 'arrow-left-right', href: '/check-in?show=moves', tone: 'info', hideZero: true });
  if (can(user, 'jobs.manage')) {
    const waiting = await jobs.waitingProformas([site.id]);
    items.push({ label: 'Jobs to open', value: waiting.length, foot: 'accepted proformas, no job yet', icon: 'clipboard-plus', href: '/jobs', tone: 'info', hideZero: true });
  }
  return { title: `Workshop at ${site.name}`, icon: 'wrench-adjustable', items };
}

async function sales(user) {
  const items = [];
  if (can(user, 'enquiries.manage')) {
    const e = await enquiries.countByTab();
    items.push({ label: 'Follow up today', value: e.follow, foot: 'enquiries due a call', icon: 'telephone', href: '/enquiries', tone: 'warn' });
    items.push({ label: 'Open enquiries', value: e.open, foot: 'not yet quoted', icon: 'inbox', href: '/enquiries?show=open' });
  }
  if (can(user, 'quotations.manage')) {
    const p = await proformas.countByTab();
    items.push({ label: 'Proformas awaiting reply', value: p.sent, foot: 'sent to the customer', icon: 'send', href: '/proformas?show=sent' });
    items.push({ label: 'Draft proformas', value: p.draft, foot: 'not sent yet', icon: 'file-earmark', href: '/proformas?show=draft', hideZero: true });
  }
  if (can(user, 'invoices.manage')) {
    const i = await invoices.countByTab();
    const [owed] = await db('invoices as i').where('i.status', 'issued')
      .select(db.raw('SUM(i.total - LEAST(i.total, COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.job_id = i.job_id AND p.voided_at IS NULL), 0))) AS owed'));
    items.push({ label: 'Unpaid invoices', value: i.unpaid, foot: `KES ${fmt.money(owed.owed ?? 0)} still owed`, icon: 'receipt', href: '/invoices?show=unpaid', tone: 'warn' });
    items.push({ label: 'Draft invoices', value: i.draft, foot: 'not issued yet', icon: 'file-earmark-text', href: '/invoices?show=draft', hideZero: true });
  }
  return items.length ? { title: 'Sales', icon: 'graph-up', items } : null;
}

async function stores(user, siteIds) {
  const items = [];
  if (can(user, 'inventory.manage', 'stores.issue', 'purchasing.manage', 'purchasing.approve')) {
    const { low } = await stockTotals();
    items.push({ label: 'Low stock', value: low, foot: 'at or below reorder level', icon: 'stack', href: '/inventory?show=low', tone: 'warn' });
  }
  if (can(user, 'purchasing.manage', 'purchasing.approve')) {
    const o = await orders.countByTab(siteIds);
    const pending = await count(db('purchase_orders').whereIn('site_id', siteIds).where('status', 'pending'));
    items.push({ label: 'Orders to approve', value: pending, foot: 'sent for approval', icon: 'patch-check', href: '/purchase-orders', tone: can(user, 'purchasing.approve') ? 'warn' : null });
    items.push({ label: 'Open orders', value: o.open, foot: 'draft, pending or approved', icon: 'cart', href: '/purchase-orders' });
    items.push({ label: 'Goods to receive', value: o.sent, foot: 'ordered, not all delivered', icon: 'box-seam', href: '/purchase-orders?show=sent', tone: 'info' });
  }
  return items.length ? { title: 'Stores', icon: 'box-seam', items } : null;
}

async function people(user, site, siteIds) {
  const items = [];
  if (can(user, 'attendance.manage')) {
    const today = localDay();
    const [staff, confirmed] = await Promise.all([
      count(db('employees').where({ site_id: site.id, is_active: true })),
      db('attendance_confirmations').where({ site_id: site.id, day: today }).first('day'),
    ]);
    items.push({ label: 'Staff here', value: staff, foot: `active at ${site.name}`, icon: 'people', href: '/employees' });
    items.push({ label: 'Today’s attendance', value: confirmed ? 'Done' : 'Not yet', foot: confirmed ? 'confirmed' : 'not confirmed', icon: 'calendar-check', href: '/attendance', tone: confirmed ? null : 'warn' });
  }
  if (can(user, 'payroll.manage', 'payroll.approve')) {
    const [drafts, checked] = await Promise.all([
      count(db('payrolls').whereIn('site_id', siteIds).where('status', 'draft')),
      count(db('payrolls').whereIn('site_id', siteIds).where('status', 'checked')),
    ]);
    if (can(user, 'payroll.manage')) items.push({ label: 'Payroll drafts', value: drafts, foot: 'to check', icon: 'cash-stack', href: '/payroll', hideZero: true });
    items.push({ label: 'Payroll to approve', value: checked, foot: 'checked, waiting', icon: 'patch-check', href: '/payroll', tone: can(user, 'payroll.approve') ? 'warn' : null });
  }
  return items.length ? { title: 'People', icon: 'person-badge', items } : null;
}

/** Visitors today at the site. The gate also sees vehicles to release; reception, those received today and why people came. */
async function visitors(user, site) {
  if (!can(user, 'visitors.view', 'visitors.gate', 'visitors.receive')) return null;
  const c = await visitorCounts(site.id);
  const atGate = can(user, 'checkin.gate', 'visitors.gate');
  const items = [
    { label: 'On site now', value: c.onSite, foot: 'signed in, not yet out', icon: 'people', href: '/visitors' },
    { label: 'Waiting for reception', value: c.waiting, foot: 'not yet received', icon: 'hourglass-split', href: '/visitors?only=waiting', tone: 'warn' },
    { label: 'Confirmed', value: c.confirmed, foot: 'received, ready to go', icon: 'check2-circle', href: '/visitors?only=confirmed' },
    { label: 'Cleared out today', value: c.cleared, foot: 'left the site', icon: 'box-arrow-right', href: '/visitors?show=register' },
  ];
  if (can(user, 'checkin.gate')) {
    items.push({ label: 'Vehicles to release', value: (await waitingAtGate(site.id)).length, foot: 'waiting at the gate', icon: 'truck', href: '/gate/vehicles', tone: 'info' });
  }
  if (can(user, 'goods.gate')) {
    items.push({ label: 'Goods at the gate', value: (await goodsAtGate(site.id)).length, foot: 'to let out or log in', icon: 'box-seam', href: '/gate/goods', tone: 'info' });
  }
  if (can(user, 'visitors.receive') && !atGate) {
    items.push({ label: 'Received today', value: c.received, foot: 'confirmed at reception', icon: 'person-check', href: '/visitors?show=register' });
  }
  return { title: `Visitors at ${site.name}`, icon: 'person-badge', items, byPurpose: c.byPurpose };
}

/** The sections this person sees, in the order they appear. */
export async function sectionsFor(user, site) {
  const siteIds = user.sites.map((s) => s.id);
  const list = await Promise.all([
    // Workshop for those who work in it: "see jobs" alone (sales, stores) isn't enough.
    site && can(user, 'jobs.manage', 'jobs.progress', 'checkin.manage') ? workshop(user, site) : null,
    sales(user),
    stores(user, siteIds),
    site ? people(user, site, siteIds) : null,
    site ? visitors(user, site) : null,
  ]);
  // A card marked hideZero only matters when there is something in it.
  return list.filter(Boolean).map((sec) => ({ ...sec, items: sec.items.filter((k) => !(k.hideZero && k.value === 0)) }));
}

/** Buttons for the things this person starts most often. */
export function quickActions(user) {
  return [
    can(user, 'checkin.manage') && { label: 'Check in a vehicle', href: '/check-in/new', icon: 'truck', primary: true },
    can(user, 'enquiries.manage') && { label: 'New enquiry', href: '/enquiries/new', icon: 'inbox' },
    can(user, 'quotations.manage') && { label: 'New proforma', href: '/proformas/new', icon: 'file-earmark-plus' },
    can(user, 'purchasing.manage') && { label: 'New purchase order', href: '/purchase-orders/new', icon: 'cart-plus' },
    can(user, 'attendance.manage') && { label: 'Mark attendance', href: '/attendance', icon: 'calendar-check' },
    can(user, 'visitors.gate', 'visitors.receive') && { label: 'Sign a visitor in', href: '/visitors/new', icon: 'person-plus', primary: !can(user, 'checkin.manage', 'enquiries.manage', 'quotations.manage', 'purchasing.manage', 'attendance.manage') },
  ].filter(Boolean).slice(0, 3);
}
