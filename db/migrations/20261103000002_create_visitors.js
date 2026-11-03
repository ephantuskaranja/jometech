import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Visitor register, per site:
//
//   arrived   the gate signs the visitor in (or reception, for a walk-in)
//   received  reception confirms they reached reception / the person they came to see
//   cleared   the gate signs them out
//
// Gate and Reception staff pick their site when they log in (roles.site_at_login)
// and keep it until they log out.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('roles', (t) => {
    t.boolean('site_at_login').notNullable().defaultTo(false).after('all_sites');
  });

  await knex.schema.createTable('visitors', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                // VIS-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.string('name', 100).notNullable();
    t.string('phone', 20).notNullable();                          // +2547…; a returning visitor is found by it
    t.string('id_no', 20).nullable();
    t.string('company', 120).nullable();
    t.string('purpose', 60).notNullable();
    t.string('host', 100).nullable();                             // who they came to see (staff are not all users)
    t.string('vehicle_reg', 20).nullable();
    t.string('pass_no', 20).nullable();                           // gate pass / visitor badge handed out
    t.integer('people').unsigned().notNullable().defaultTo(1);    // in the group, including the visitor
    t.string('notes', 500).nullable();
    t.enum('status', ['arrived', 'received', 'cleared']).notNullable().defaultTo('arrived');
    t.datetime('arrived_at').notNullable().defaultTo(knex.fn.now());
    t.integer('arrived_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('received_at').nullable();
    t.integer('received_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('cleared_at').nullable();
    t.integer('cleared_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['site_id', 'status']);
    t.index(['site_id', 'arrived_at']);
    t.index(['phone']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('visitors');
  await knex.schema.alterTable('roles', (t) => {
    t.dropColumn('site_at_login');
  });
}
