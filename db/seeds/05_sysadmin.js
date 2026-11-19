// The System Administrator: the one account that can use Backups, Import data and Roles,
// and that no one else can switch off or reset. Only runs while nobody has the role.
//
// Server: set SYSADMIN_PHONE and SYSADMIN_PASSWORD in .env, then npm run db:seed.
// If that phone number already has an account, the role is added to it and its password is kept.
// Otherwise the account is made and the password must be changed at first login.
// Forgotten password: on the server, npm run user:create and enter the same phone number.
import { config } from '../../src/config.js';
import { audit } from '../../src/core/audit.js';
import { createUser } from '../../src/modules/users/service.js';
import { formatPhone, normalizePhone } from '../../src/core/phone.js';

const DEV_DEFAULTS = { phone: '0711000001', password: 'jometech-sysadmin-1' };

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  const role = await knex('roles').where({ key: 'sysadmin' }).first('id');
  if (!role) return; // 02_roles makes it; nothing to do without it
  if (await knex('user_roles').where({ role_id: role.id }).first('user_id')) return;

  const phone = normalizePhone(process.env.SYSADMIN_PHONE || (config.isProd ? '' : DEV_DEFAULTS.phone));
  if (!phone) {
    console.warn('No System Administrator yet: set SYSADMIN_PHONE and SYSADMIN_PASSWORD in .env and run npm run db:seed.');
    return;
  }

  const existing = await knex('users').where({ phone }).first('id', 'name');
  if (existing) {
    await knex.transaction(async (trx) => {
      await trx('user_roles').insert({ user_id: existing.id, role_id: role.id });
      await audit(trx, { user: null }, { entity: 'user', id: existing.id, action: 'update', summary: 'Made System Administrator by the seed' });
    });
    console.log(`System Administrator: ${existing.name} (${formatPhone(phone)}), password unchanged.`);
    return;
  }

  const password = process.env.SYSADMIN_PASSWORD || (config.isProd ? null : DEV_DEFAULTS.password);
  if (!password) {
    console.warn('No System Administrator yet: set SYSADMIN_PASSWORD in .env (a temporary password) and run npm run db:seed.');
    return;
  }
  const sites = await knex('sites').where({ is_active: true }).pluck('id');
  await createUser({
    name: process.env.SYSADMIN_NAME || 'System Administrator', phone, password, roles: ['sysadmin'], siteIds: sites, mustChangePassword: true,
  }, { user: null }, 'System Administrator, created by the seed');
  console.log(`System Administrator created: log in with ${formatPhone(phone)} and change the password when asked.`);
}
