import { VIEW_CUSTOMERS } from './access.js';

// Sidebar navigation. Icons are Bootstrap Icons names (https://icons.getbootstrap.com).
// `permission`: who sees the item (one key, or a list meaning "any of these").
// Items without `ready: true` show as "Soon" until their module is built.

export const nav = [
  {
    label: 'Workshop',
    items: [
      { label: 'Dashboard', href: '/', icon: 'grid-1x2', ready: true },
      { label: 'Check-in', href: '/check-in', icon: 'truck', permission: 'checkin.manage', ready: true },
      { label: 'Jobs', href: '/jobs', icon: 'wrench-adjustable', permission: ['jobs.view', 'jobs.progress', 'jobs.manage'], ready: true },
      { label: 'Quality checks', href: '/qc', icon: 'shield-check', permission: 'qc.manage' },
      { label: 'Visitors', href: '/visitors', icon: 'person-badge', permission: ['visitors.gate', 'visitors.receive', 'visitors.view'], ready: true },
      { label: 'Vehicles leaving', href: '/gate/vehicles', icon: 'box-arrow-right', permission: 'checkin.gate', ready: true },
      { label: 'Goods at the gate', href: '/gate/goods', icon: 'box-seam', permission: 'goods.gate', ready: true },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Customers', href: '/customers', icon: 'person', permission: VIEW_CUSTOMERS, ready: true },
      { label: 'Vehicles', href: '/vehicles', icon: 'truck-front', permission: VIEW_CUSTOMERS, ready: true },
      { label: 'Enquiries', href: '/enquiries', icon: 'inbox', permission: 'enquiries.manage', ready: true },
      { label: 'Proformas', href: '/proformas', icon: 'file-earmark-text', permission: 'quotations.manage', ready: true },
      { label: 'Invoices', href: '/invoices', icon: 'receipt', permission: 'invoices.manage', ready: true },
    ],
  },
  {
    label: 'Stores',
    items: [
      { label: 'Items', href: '/items', icon: 'box', permission: ['inventory.manage', 'stores.issue', 'purchasing.manage', 'purchasing.approve'], ready: true },
      { label: 'Issue materials', href: '/stores/issue', icon: 'box-seam', permission: ['stores.issue', 'inventory.manage'], ready: true },
      { label: 'Inventory', href: '/inventory', icon: 'stack', permission: ['inventory.manage', 'stores.issue', 'purchasing.manage', 'purchasing.approve'], ready: true },
      { label: 'Purchase orders', href: '/purchase-orders', icon: 'cart', permission: ['purchasing.manage', 'purchasing.approve'], ready: true },
      { label: 'Goods received', href: '/goods-received', icon: 'box-arrow-in-down', permission: ['purchasing.manage', 'purchasing.approve', 'inventory.manage'], ready: true },
      { label: 'Suppliers', href: '/suppliers', icon: 'building', permission: ['purchasing.manage', 'purchasing.approve'], ready: true },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'Employees', href: '/employees', icon: 'person-vcard', permission: ['attendance.manage', 'payroll.manage', 'payroll.approve'], ready: true },
      { label: 'Attendance', href: '/attendance', icon: 'calendar-check', permission: 'attendance.manage', ready: true },
      { label: 'Payroll', href: '/payroll', icon: 'wallet2', permission: ['attendance.manage', 'payroll.manage', 'payroll.approve'], ready: true },
    ],
  },
  {
    label: 'Reports',
    items: [
      { label: 'Summary', href: '/reports/summary', icon: 'clipboard-data', permission: 'reports.summary', ready: true },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Users', href: '/admin/users', icon: 'person-gear', permission: 'users.manage', ready: true },
      { label: 'Sites', href: '/admin/sites', icon: 'geo-alt', permission: 'system.settings', ready: true },
      { label: 'Job types & steps', href: '/admin/job-types', icon: 'list-check', permission: 'system.settings', ready: true },
      { label: 'Backups', href: '/admin/backups', icon: 'database-check', permission: 'system.backup.manage', ready: true },
    ],
  },
];

/** The menu with only the items this user may see; empty groups are dropped. */
export function navFor(user) {
  const allowed = (item) => !item.permission || [].concat(item.permission).some((p) => user.can(p));
  return nav
    .map((group) => ({ ...group, items: group.items.filter(allowed) }))
    .filter((group) => group.items.length > 0);
}

/** True when `href` is the current page or a parent of it. */
export function isActive(href, path) {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(href + '/');
}
