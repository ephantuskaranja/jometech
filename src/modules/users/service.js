import { db } from '../../core/db.js';
import { hashPassword } from '../../core/auth.js';
import { normalizePhone } from '../../core/phone.js';
import { httpError } from '../../core/validate.js';

/**
 * Creates a user with roles and sites in one transaction.
 * Used by `npm run user:create` now and by the users screen later.
 *
 * @param {{ name: string, phone: string, email?: string|null, password: string,
 *           roles: string[], siteIds?: number[], mustChangePassword?: boolean }} input
 * @returns {Promise<number>} new user id
 */
export async function createUser(input) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw httpError(422, `"${input.phone}" isn't a phone number. Use a format like 0712 345 678.`);

  return db.transaction(async (trx) => {
    const taken = await trx('users').where({ phone }).first('name');
    if (taken) throw httpError(409, `${input.phone} already belongs to ${taken.name}.`);

    const roles = await trx('roles').whereIn('key', input.roles).select('id', 'key');
    const missing = input.roles.filter((key) => !roles.some((r) => r.key === key));
    if (missing.length) throw httpError(422, `Unknown role: ${missing.join(', ')}. Run npm run db:seed first.`);

    const siteIds = input.siteIds ?? [];
    const [id] = await trx('users').insert({
      name: input.name.trim(),
      phone,
      email: input.email ? input.email.trim().toLowerCase() : null,
      password_hash: await hashPassword(input.password),
      must_change_password: input.mustChangePassword ?? false,
      default_site_id: siteIds[0] ?? null,
    });

    await trx('user_roles').insert(roles.map((r) => ({ user_id: id, role_id: r.id })));
    if (siteIds.length) await trx('user_sites').insert(siteIds.map((siteId) => ({ user_id: id, site_id: siteId })));
    return id;
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
