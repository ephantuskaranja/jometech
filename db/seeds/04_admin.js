// The first admin, who then creates everyone else in Users.
// Only runs while there is no admin at all, so it never touches a real account.
// The password must be changed at first login.
//
// Development: defaults below. Server: set ADMIN_PHONE and ADMIN_PASSWORD in .env
// (the defaults are in this public file, so they are never used in production).
import { config } from '../../src/config.js';
import { createUser } from '../../src/modules/users/service.js';
import { formatPhone, normalizePhone } from '../../src/core/phone.js';

const DEV_DEFAULTS = { phone: '0711000000', password: 'jometech-admin-1' };

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  const hasAdmin = await knex('user_roles').join('roles', 'roles.id', 'user_roles.role_id').where('roles.key', 'admin').first('user_roles.user_id');
  if (hasAdmin) return;

  const phone = process.env.ADMIN_PHONE || (config.isProd ? null : DEV_DEFAULTS.phone);
  const password = process.env.ADMIN_PASSWORD || (config.isProd ? null : DEV_DEFAULTS.password);
  if (!phone || !password) {
    console.warn('No admin yet: set ADMIN_PHONE and ADMIN_PASSWORD in .env and run npm run db:seed (or use npm run user:create).');
    return;
  }

  const sites = await knex('sites').where({ is_active: true }).pluck('id');
  await createUser({
    name: process.env.ADMIN_NAME || 'Administrator', phone, password, roles: ['admin'], siteIds: sites, mustChangePassword: true,
  }, { user: null }, 'First admin, created by the seed');
  console.log(`Admin created: log in with ${formatPhone(normalizePhone(phone))} and change the password when asked.`);
}
