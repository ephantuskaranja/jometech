// Sidebar navigation. Icons are Bootstrap Icons names (https://icons.getbootstrap.com).
// `permission`: who sees the item (one key, or a list meaning "any of these").
// Items without `ready: true` show as "Soon" until their module is built.

export const nav = [
  {
    label: 'Workshop',
    items: [
      { label: 'Dashboard', href: '/', icon: 'grid-1x2', ready: true },
      { label: 'Check-in', href: '/check-in', icon: 'truck', permission: 'checkin.manage' },
      { label: 'Jobs', href: '/jobs', icon: 'wrench-adjustable', permission: ['jobs.view', 'jobs.progress'] },
      { label: 'Quality checks', href: '/qc', icon: 'shield-check', permission: 'qc.manage' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Customers', href: '/customers', icon: 'person', permission: 'customers.manage' },
      { label: 'Enquiries', href: '/enquiries', icon: 'inbox', permission: 'enquiries.manage' },
      { label: 'Quotations', href: '/quotations', icon: 'file-earmark-text', permission: ['quotations.manage', 'quotations.approve'] },
      { label: 'Invoices', href: '/invoices', icon: 'receipt', permission: 'invoices.manage' },
    ],
  },
  {
    label: 'Stores',
    items: [
      { label: 'Issue materials', href: '/stores/issue', icon: 'box-seam', permission: 'stores.issue' },
      { label: 'Inventory', href: '/inventory', icon: 'stack', permission: 'inventory.manage' },
      { label: 'Purchasing', href: '/purchasing', icon: 'cart', permission: ['purchasing.manage', 'purchasing.approve'] },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'Attendance', href: '/attendance', icon: 'people', permission: 'attendance.manage' },
      { label: 'Payroll', href: '/payroll', icon: 'wallet2', permission: ['payroll.manage', 'payroll.approve'] },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Users', href: '/admin/users', icon: 'person-gear', permission: 'users.manage', ready: true },
      { label: 'Settings & backups', href: '/admin/settings', icon: 'sliders', permission: ['system.settings', 'system.backup.manage'] },
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
