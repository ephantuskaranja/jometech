import { db } from '../../core/db.js';
import { hashPassword } from '../../core/auth.js';
import { normalizePhone } from '../../core/phone.js';
import { httpError } from '../../core/validate.js';

// Business rules for user accounts. Routes (routes.js) and the
// `npm run user:create` command both go through these functions.

/**
 * Creates a user with roles and sites in one transaction.
 *
 * @param {{ name: string, phone: string, email?: string|null, password: string,
 *           roles: string[], siteIds?: number[], mustChangePassword?: boolean }} input
 * @returns {Promise<number>} new user id
 */
export async function createUser(input) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw httpError(422, `"${input.phone}" isn't a phone number. Use a format like 0712 345 678.`);

  return db.transaction(async (trx) => {
    await assertPhoneFree(trx, phone);
    await assertEmailFree(trx, input.email);
    const roleIds = await roleIdsFor(trx, input.roles);
    const siteIds = input.siteIds ?? [];

    const [id] = await trx('users').insert({
      name: input.name.trim(),
      phone,
      email: input.email ? input.email.trim().toLowerCase() : null,
      password_hash: await hashPassword(input.password),
      must_change_password: input.mustChangePassword ?? false,
      default_site_id: siteIds[0] ?? null,
    });

    await trx('user_roles').insert(roleIds.map((roleId) => ({ user_id: id, role_id: roleId })));
    if (siteIds.length) await trx('user_sites').insert(siteIds.map((siteId) => ({ user_id: id, site_id: siteId })));
    return id;
  });
}

/**
 * Changes name, phone, email, roles and sites.
 * @param {number} id
 * @param {{ name: string, phone: string, email?: string|null, roles: string[], siteIds: number[] }} input
 */
export async function updateUser(id, input) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw httpError(422, `"${input.phone}" isn't a phone number. Use a format like 0712 345 678.`);

  await db.transaction(async (trx) => {
    const current = await trx('users').where({ id }).first('default_site_id');
    if (!current) throw httpError(404, 'That user no longer exists.');
    await assertPhoneFree(trx, phone, id);
    await assertEmailFree(trx, input.email, id);
    const roleIds = await roleIdsFor(trx, input.roles);

    await trx('users').where({ id }).update({
      name: input.name.trim(),
      phone,
      email: input.email ? input.email.trim().toLowerCase() : null,
      // Keep their default site if they still have it, else use the first one.
      default_site_id: input.siteIds.includes(current.default_site_id) ? current.default_site_id : (input.siteIds[0] ?? null),
    });

    await trx('user_roles').where({ user_id: id }).delete();
    await trx('user_roles').insert(roleIds.map((roleId) => ({ user_id: id, role_id: roleId })));
    await trx('user_sites').where({ user_id: id }).delete();
    if (input.siteIds.length) await trx('user_sites').insert(input.siteIds.map((siteId) => ({ user_id: id, site_id: siteId })));
  });
}

/** Sets a new password, clears any lock, and (optionally) asks for a change at next login. */
export async function resetPassword(userId, password, { mustChangePassword = true } = {}) {
  await db('users').where({ id: userId }).update({
    password_hash: await hashPassword(password),
    must_change_password: mustChangePassword,
    failed_logins: 0,
    locked_until: null,
  });
}

/** Switches an account off (can't log in) or back on. Nothing is deleted. */
export async function setActive(userId, active) {
  await db('users').where({ id: userId }).update({ is_active: active });
  // Switching off also ends their open sessions straight away.
  if (!active) await db('sessions').whereRaw("JSON_EXTRACT(data, '$.userId') = ?", [userId]).delete();
}

/**
 * Users for the list page.
 * @param {{ q?: string, status?: 'active'|'inactive'|'all' }} filters
 */
export async function listUsers({ q = '', status = 'active' } = {}) {
  const query = db('users')
    .select('id', 'name', 'phone', 'email', 'is_active', 'last_login_at', 'locked_until')
    .orderBy('name');

  if (status === 'active') query.where('is_active', true);
  if (status === 'inactive') query.where('is_active', false);

  const term = q.trim();
  if (term) {
    const phone = normalizePhone(term);
    query.where((w) => {
      w.where('name', 'like', `%${term}%`).orWhere('email', 'like', `%${term}%`);
      if (phone) w.orWhere('phone', phone);
      else if (/^\d{3,}$/.test(term.replace(/\s/g, ''))) w.orWhere('phone', 'like', `%${term.replace(/\s/g, '')}%`);
    });
  }

  const users = await query;
  if (!users.length) return users;

  const ids = users.map((u) => u.id);
  const roles = await db('user_roles').join('roles', 'roles.id', 'user_roles.role_id')
    .whereIn('user_id', ids).orderBy('roles.id').select('user_id', 'roles.name', 'roles.all_sites');
  const sites = await db('user_sites').join('sites', 'sites.id', 'user_sites.site_id')
    .whereIn('user_id', ids).orderBy('sites.name').select('user_id', 'sites.name');

  return users.map((u) => {
    const userRoles = roles.filter((r) => r.user_id === u.id);
    return {
      ...u,
      roleNames: userRoles.map((r) => r.name),
      allSites: userRoles.some((r) => r.all_sites),
      siteNames: sites.filter((s) => s.user_id === u.id).map((s) => s.name),
    };
  });
}

/** One user with role keys and site ids, for the edit form. */
export async function getUser(id) {
  const user = await db('users').where({ id })
    .first('id', 'name', 'phone', 'email', 'is_active', 'must_change_password', 'last_login_at', 'locked_until', 'created_at');
  if (!user) return null;
  const roleKeys = await db('user_roles').join('roles', 'roles.id', 'user_roles.role_id').where({ user_id: id }).pluck('roles.key');
  const siteIds = await db('user_sites').where({ user_id: id }).pluck('site_id');
  return { ...user, roleKeys, siteIds };
}

/** Roles and sites to choose from in the form. */
export async function formOptions() {
  const [roles, sites] = await Promise.all([
    db('roles').orderBy('id').select('key', 'name', 'description', 'all_sites'),
    db('sites').where({ is_active: true }).orderBy('name').select('id', 'name'),
  ]);
  return { roles, sites };
}

/** Number of active admins other than `exceptUserId` (to never lock everyone out). */
export async function otherActiveAdmins(exceptUserId) {
  const [{ n }] = await db('users')
    .join('user_roles', 'users.id', 'user_roles.user_id')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where({ 'roles.key': 'admin', 'users.is_active': true })
    .whereNot('users.id', exceptUserId)
    .countDistinct('users.id as n');
  return Number(n);
}

// ---------- checks shared by create and update ----------

async function assertPhoneFree(trx, phone, exceptId) {
  const q = trx('users').where({ phone });
  if (exceptId) q.whereNot({ id: exceptId });
  const taken = await q.first('name');
  if (taken) throw Object.assign(httpError(409, `This phone number already belongs to ${taken.name}.`), { field: 'phone' });
}

async function assertEmailFree(trx, email, exceptId) {
  if (!email) return;
  const q = trx('users').where({ email: email.trim().toLowerCase() });
  if (exceptId) q.whereNot({ id: exceptId });
  const taken = await q.first('name');
  if (taken) throw Object.assign(httpError(409, `This email already belongs to ${taken.name}.`), { field: 'email' });
}

async function roleIdsFor(trx, keys) {
  const roles = await trx('roles').whereIn('key', keys).select('id', 'key');
  const missing = keys.filter((key) => !roles.some((r) => r.key === key));
  if (missing.length) throw httpError(422, `Unknown role: ${missing.join(', ')}. Run npm run db:seed first.`);
  return roles.map((r) => r.id);
}
