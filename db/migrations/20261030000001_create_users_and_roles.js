import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Who can log in, what they may do (roles → permissions) and where (sites).
//
//   users ──< user_roles >── roles ──< role_permissions >── permissions
//   users ──< user_sites >── sites

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('roles', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('key', 40).notNullable().unique();        // used in code, e.g. 'storekeeper'
    t.string('name', 60).notNullable();
    t.string('description', 255).nullable();
    t.boolean('all_sites').notNullable().defaultTo(false); // admins and managers see every site
    t.boolean('is_system').notNullable().defaultTo(false); // built-in roles can't be deleted
    timestamps(t, knex);
  });

  await knex.schema.createTable('permissions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('key', 60).notNullable().unique();        // e.g. 'stores.issue'
    t.string('module', 40).notNullable();              // groups the list in the roles screen
    t.string('description', 255).notNullable();
  });

  await knex.schema.createTable('role_permissions', (t) => {
    tableDefaults(t);
    t.integer('role_id').unsigned().notNullable().references('roles.id').onDelete('CASCADE');
    t.integer('permission_id').unsigned().notNullable().references('permissions.id').onDelete('CASCADE');
    t.primary(['role_id', 'permission_id']);
  });

  await knex.schema.createTable('users', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 100).notNullable();
    t.string('phone', 20).notNullable().unique();      // login name, stored as +254712345678
    t.string('email', 120).nullable().unique();        // optional, also accepted at login
    t.string('password_hash', 255).notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('must_change_password').notNullable().defaultTo(false);
    t.integer('default_site_id').unsigned().nullable().references('sites.id').onDelete('SET NULL');
    t.string('theme', 10).notNullable().defaultTo('system'); // light | dark | system
    t.integer('failed_logins').unsigned().notNullable().defaultTo(0);
    t.datetime('locked_until').nullable();
    t.datetime('last_login_at').nullable();
    timestamps(t, knex);
  });

  await knex.schema.createTable('user_roles', (t) => {
    tableDefaults(t);
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.integer('role_id').unsigned().notNullable().references('roles.id').onDelete('CASCADE');
    t.primary(['user_id', 'role_id']);
  });

  await knex.schema.createTable('user_sites', (t) => {
    tableDefaults(t);
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.integer('site_id').unsigned().notNullable().references('sites.id').onDelete('CASCADE');
    t.primary(['user_id', 'site_id']);
  });

  // Login sessions (used by express-mysql-session; layout matches its schema.sql).
  await knex.schema.createTable('sessions', (t) => {
    tableDefaults(t);
    t.string('session_id', 128).collate('utf8mb4_bin').primary();
    t.integer('expires').unsigned().notNullable().index();
    t.specificType('data', 'MEDIUMTEXT').collate('utf8mb4_bin');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  for (const table of ['sessions', 'user_sites', 'user_roles', 'users', 'role_permissions', 'permissions', 'roles']) {
    await knex.schema.dropTable(table);
  }
}
