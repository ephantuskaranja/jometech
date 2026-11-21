// Which permissions open which shared screens. Kept in one place because
// several modules (customers, vehicles, search, later check-in) use them.

/** Seeing customers and vehicles: anyone who deals with them. */
export const VIEW_CUSTOMERS = ['customers.manage', 'checkin.manage', 'jobs.view', 'quotations.manage', 'invoices.manage'];

/**
 * The Customers and Vehicles menu items: for those who work with customers. Seeing jobs alone
 * (storekeepers) still shows a job's customer and vehicle, but not the menus (sheet row 27).
 */
export const MENU_CUSTOMERS = VIEW_CUSTOMERS.filter((p) => p !== 'jobs.view');

/** Adding / editing customers. */
export const EDIT_CUSTOMERS = ['customers.manage'];

/** Adding / editing vehicles, and quick-adding a customer while doing so (at check-in). */
export const EDIT_VEHICLES = ['customers.manage', 'checkin.manage'];

/**
 * Managers and above (Manager, Admin, System Administrator): the people who can overrule
 * a decision already made on a record, e.g. who supervises a job once it is set.
 * @param {{ isAdmin: boolean, roles: { key: string }[] }} user
 */
export const isManagerUp = (user) => Boolean(user?.isAdmin || user?.roles?.some((r) => r.key === 'manager'));
