import { PERMISSIONS, ROLES } from '../../src/core/permissions.js';

// Writes the permission list and the six built-in roles.
// Safe to run again: new permissions are added and descriptions updated,
// but a role's permissions are only filled in when the role is first created,
// so changes an admin makes later are kept.

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  await knex('permissions')
    .insert(PERMISSIONS.map(([module, key, description]) => ({ module, key, description })))
    .onConflict('key')
    .merge(['module', 'description']);

  const permissionIds = Object.fromEntries(
    (await knex('permissions').select('id', 'key')).map((p) => [p.key, p.id]),
  );

  for (const role of ROLES) {
    const existing = await knex('roles').where({ key: role.key }).first('id');
    if (existing) continue;

    const [roleId] = await knex('roles').insert({
      key: role.key,
      name: role.name,
      description: role.description,
      all_sites: role.all_sites ?? false,
      is_system: true,
    });

    if (role.permissions === '*') continue; // admin: everything, checked in code
    await knex('role_permissions').insert(
      role.permissions.map((key) => ({ role_id: roleId, permission_id: permissionIds[key] })),
    );
  }
}
