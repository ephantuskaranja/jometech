// Sidebar navigation. Icons are Bootstrap Icons names (https://icons.getbootstrap.com).
// Items without `ready: true` show as "Soon" until their module is built.
// Later, each item will also carry the permission needed to see it.

export const nav = [
  {
    label: 'Workshop',
    items: [
      { label: 'Dashboard', href: '/', icon: 'grid-1x2', ready: true },
      { label: 'Check-in', href: '/check-in', icon: 'truck' },
      { label: 'Jobs', href: '/jobs', icon: 'wrench-adjustable' },
      { label: 'Quality checks', href: '/qc', icon: 'shield-check' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Customers', href: '/customers', icon: 'person' },
      { label: 'Enquiries', href: '/enquiries', icon: 'inbox' },
      { label: 'Quotations', href: '/quotations', icon: 'file-earmark-text' },
      { label: 'Invoices', href: '/invoices', icon: 'receipt' },
    ],
  },
  {
    label: 'Stores',
    items: [
      { label: 'Issue materials', href: '/stores/issue', icon: 'box-seam' },
      { label: 'Inventory', href: '/inventory', icon: 'stack' },
      { label: 'Purchasing', href: '/purchasing', icon: 'cart' },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'Attendance', href: '/attendance', icon: 'people' },
      { label: 'Payroll', href: '/payroll', icon: 'wallet2' },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings & backups', href: '/admin', icon: 'sliders' },
    ],
  },
];

/** True when `href` is the current page or a parent of it. */
export function isActive(href, path) {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(href + '/');
}
