// Every permission the code checks, and what each built-in role starts with.
// The seed (db/seeds/02_roles.js) writes these to the database; after that,
// admins can change role permissions in the app (roles screen, coming later).
//
// Admins can do everything without needing each permission listed.

export const PERMISSIONS = [
  // module, key, description
  ['Workshop', 'checkin.manage', 'Check vehicles in and out'],
  ['Workshop', 'checkin.gate', 'Clear released vehicles out at the gate'],
  ['Workshop', 'jobs.view', 'See jobs and their details'],
  ['Workshop', 'jobs.manage', 'Create jobs, move stages, assign work'],
  ['Workshop', 'jobs.progress', 'Update own tasks and add photos'],
  ['Workshop', 'qc.manage', 'Carry out quality checks'],
  ['Gate', 'visitors.gate', 'Sign visitors in and clear them out at the gate'],
  ['Gate', 'visitors.receive', 'Confirm visitors were received; sign in walk-ins at reception'],
  ['Gate', 'visitors.view', 'See the visitor register'],
  ['Gate', 'visitors.book', 'Book expected visitors, so the gate knows who is coming'],
  ['Gate', 'goods.gate', 'Check goods in and out at the gate: transfers, deliveries, materials leaving'],
  ['Sales', 'customers.manage', 'Add and edit customers and vehicles'],
  ['Sales', 'enquiries.manage', 'Record and follow up enquiries'],
  ['Sales', 'quotations.manage', 'Prepare quotations'],
  ['Sales', 'quotations.approve', 'Approve quotations'],
  ['Sales', 'invoices.manage', 'Raise invoices and record payments'],
  ['Stores', 'stores.issue', 'Issue and return materials'],
  ['Stores', 'inventory.manage', 'Manage items, stock counts and transfers'],
  ['Stores', 'purchasing.manage', 'Raise purchase requests and orders, receive goods'],
  ['Stores', 'purchasing.approve', 'Approve purchase requests and orders'],
  ['Stores', 'inventory.approve', 'Approve stock adjustments and counts'],
  ['People', 'attendance.manage', 'Mark attendance'],
  ['People', 'payroll.manage', 'Prepare payroll'],
  ['People', 'payroll.approve', 'Approve payroll'],
  ['Reports', 'reports.view', 'See reports and dashboards'],
  ['Reports', 'reports.summary', 'See the period summary, with costs and stock values'],
  ['System', 'users.manage', 'Add users, set roles and reset passwords'],
  ['System', 'system.settings', 'Change company settings'],
  ['System', 'system.backup.manage', 'Run, download and delete backups'],
];

export const ROLES = [
  {
    key: 'admin', name: 'Admin', all_sites: true,
    description: 'Everything, including users, settings and backups',
    permissions: '*',
  },
  {
    key: 'manager', name: 'Manager', all_sites: true,
    description: 'Approvals and reports across all sites',
    permissions: PERMISSIONS.map(([, key]) => key).filter((key) => !key.startsWith('users.') && !key.startsWith('system.')),
  },
  {
    key: 'supervisor', name: 'Supervisor',
    description: 'Jobs, check-in, attendance and quality checks at their sites',
    permissions: ['checkin.manage', 'checkin.gate', 'goods.gate', 'jobs.view', 'jobs.manage', 'jobs.progress', 'qc.manage', 'attendance.manage', 'reports.view', 'visitors.view', 'visitors.book'],
  },
  {
    key: 'sales', name: 'Sales',
    description: 'Customers, enquiries and quotations',
    permissions: ['customers.manage', 'enquiries.manage', 'quotations.manage', 'jobs.view', 'visitors.book'],
  },
  {
    key: 'storekeeper', name: 'Storekeeper',
    description: 'Inventory, issuing materials and receiving goods',
    permissions: ['stores.issue', 'inventory.manage', 'purchasing.manage', 'jobs.view'],
  },
  {
    key: 'technician', name: 'Technician',
    description: 'Own tasks: progress updates and photos',
    permissions: ['jobs.progress'],
  },
  // Gate and Reception choose their site when they log in and keep it until they log out.
  {
    key: 'gate', name: 'Gate', site_at_login: true,
    description: 'The gate: visitors in and out, and released vehicles out',
    permissions: ['visitors.gate', 'visitors.view', 'checkin.gate', 'goods.gate'],
  },
  {
    key: 'reception', name: 'Reception', site_at_login: true,
    description: 'Visitor register at reception: confirm visitors were received, book expected visitors',
    permissions: ['visitors.receive', 'visitors.view', 'visitors.book'],
  },
];
