// Which permissions open which shared screens. Kept in one place because
// several modules (customers, vehicles, search, later check-in) use them.

/** Seeing customers and vehicles: anyone who deals with them. */
export const VIEW_CUSTOMERS = ['customers.manage', 'checkin.manage', 'jobs.view', 'quotations.manage', 'invoices.manage'];

/** Adding / editing customers. */
export const EDIT_CUSTOMERS = ['customers.manage'];

/** Adding / editing vehicles, and quick-adding a customer while doing so (at check-in). */
export const EDIT_VEHICLES = ['customers.manage', 'checkin.manage'];
