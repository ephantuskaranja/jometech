import { PERMISSIONS, ROLES } from '../../src/core/permissions.js';

// Writes the permission list and the built-in roles.
// Safe to run again: new permissions are added and descriptions updated.
// A role's permissions are filled in when the role is first created; after that,
// only permissions that are new in this run are added to it, so changes an
// admin made to older permissions are kept.

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  const known = new Set(await knex('permissions').pluck('key'));
  await knex('permissions')
    .insert(PERMISSIONS.map(([module, key, description]) => ({ module, key, description })))
    .onConflict('key')
    .merge(['module', 'description']);
  const added = new Set(PERMISSIONS.map(([, key]) => key).filter((key) => !known.has(key)));

  const permissionIds = Object.fromEntries(
    (await knex('permissions').select('id', 'key')).map((p) => [p.key, p.id]),
  );

  for (const role of ROLES) {
    const existing = await knex('roles').where({ key: role.key }).first('id');
    let roleId = existing?.id;
    if (existing) {
      await knex('roles').where({ id: roleId }).update({ site_at_login: role.site_at_login ?? false });
    } else {
      [roleId] = await knex('roles').insert({
        key: role.key,
        name: role.name,
        description: role.description,
        all_sites: role.all_sites ?? false,
        site_at_login: role.site_at_login ?? false,
        is_system: true,
      });
    }

    if (role.permissions === '*') continue; // admin: everything, checked in code
    const keys = existing ? role.permissions.filter((key) => added.has(key)) : role.permissions;
    if (keys.length) {
      await knex('role_permissions')
        .insert(keys.map((key) => ({ role_id: roleId, permission_id: permissionIds[key] })))
        .onConflict().ignore();
    }
  }
}
