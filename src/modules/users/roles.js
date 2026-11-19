import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import { PERMISSIONS, ROLES } from '../../core/permissions.js';

// System → Roles: admins choose what each role may do. A change applies to everyone with that role
// from their next page. Admin and System Administrator can do everything (checked in code), so they aren't edited here.
// Re-running the seed keeps these changes (it only adds permissions that are new).

/** Every role, with how many permissions it has and how many active people hold it. */
export function listRoles() {
  return db('roles as r').orderBy('r.id').select('r.id', 'r.key', 'r.name', 'r.description', 'r.all_sites',
    db('role_permissions').where('role_id', db.ref('r.id')).count('*').as('permission_count'),
    db('user_roles as ur').join('users as u', 'u.id', 'ur.user_id').where('ur.role_id', db.ref('r.id')).where('u.is_active', true).count('*').as('user_count'));
}

/** The permission list, grouped as in permissions.js: [{ module, items: [{ key, description }] }]. */
export function permissionGroups() {
  const groups = [];
  for (const [module, key, description] of PERMISSIONS) {
    let g = groups.find((x) => x.module === module);
    if (!g) groups.push(g = { module, items: [] });
    g.items.push({ key, description });
  }
  return groups;
}

export async function getRole(id) {
  const role = await db('roles').where({ id }).first();
  if (!role) return null;
  role.permissions = await db('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', id).pluck('p.key');
  role.people = await db('user_roles as ur').join('users as u', 'u.id', 'ur.user_id').where({ 'ur.role_id': id, 'u.is_active': true }).orderBy('u.name').pluck('u.name');
  role.starting = ROLES.find((r) => r.key === role.key)?.permissions ?? null; // what the built-in role starts with
  return role;
}

const label = (key) => PERMISSIONS.find(([, k]) => k === key)?.[2] ?? key;

/** Sets the role's permissions to exactly these (unknown keys are ignored). */
export async function setPermissions(id, keys, actor) {
  return db.transaction(async (trx) => {
    const role = await trx('roles').where({ id }).forUpdate().first();
    if (!role) throw httpError(404, 'That role doesn’t exist.');
    if (role.key === 'admin' || role.key === 'sysadmin') throw httpError(409, `${role.name} can do everything; that can’t be changed.`);
    const wanted = new Set(keys.filter((k) => PERMISSIONS.some(([, key]) => key === k)));
    const all = await trx('permissions').select('id', 'key');
    const had = new Set(await trx('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', id).pluck('p.key'));
    const added = [...wanted].filter((k) => !had.has(k));
    const removed = [...had].filter((k) => !wanted.has(k));
    if (!added.length && !removed.length) return { added, removed };

    await trx('role_permissions').where({ role_id: id }).delete();
    const ids = all.filter((p) => wanted.has(p.key)).map((p) => ({ role_id: id, permission_id: p.id }));
    if (ids.length) await trx('role_permissions').insert(ids);
    const summary = [added.length && `Allowed: ${added.map(label).join('; ')}`, removed.length && `Taken away: ${removed.map(label).join('; ')}`].filter(Boolean).join(' · ');
    await audit(trx, actor, { entity: 'role', id, action: 'permissions_changed', summary: summary.length > 255 ? `${summary.slice(0, 254)}…` : summary });
    return { added, removed };
  });
}
