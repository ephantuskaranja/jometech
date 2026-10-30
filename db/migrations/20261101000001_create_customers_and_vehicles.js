import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Customers, their contact people, and their vehicles / trailers.
//
//   customers ──< customer_contacts
//   customers ──< vehicles >── customer_contacts (who brings this vehicle in, e.g. the salesman)

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('customers', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();            // CUS-0001
    t.string('name', 150).notNullable().index();
    t.string('category', 20).notNullable().defaultTo('individual'); // individual | company | government | ngo
    t.string('phone', 20).notNullable().index();               // +254712345678 (not unique: a warning, not a block)
    t.string('email', 120).nullable();
    t.string('kra_pin', 11).nullable().unique();               // A123456789B
    t.string('town', 80).nullable();
    t.string('address', 255).nullable();
    t.smallint('credit_days').unsigned().notNullable().defaultTo(0); // 0 = cash
    t.text('notes').nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
  });

  await knex.schema.createTable('customer_contacts', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('customer_id').unsigned().notNullable().references('customers.id').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('role', 60).nullable();                           // Salesman, Fleet manager, Accounts …
    t.string('phone', 20).nullable();
    t.string('email', 120).nullable();
    timestamps(t, knex);
  });

  await knex.schema.createTable('vehicles', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('reg_no', 15).nullable().unique();                // stored as "KDA 123A"
    t.string('chassis_no', 30).nullable().unique();            // stored uppercase, no spaces
    t.integer('customer_id').unsigned().notNullable().references('customers.id').onDelete('RESTRICT');
    t.integer('contact_id').unsigned().nullable().references('customer_contacts.id').onDelete('SET NULL');
    t.string('type', 20).notNullable().defaultTo('truck');     // truck | trailer | semi_trailer | pickup | van | bus | other
    t.string('make', 40).nullable();
    t.string('model', 60).nullable();
    t.smallint('year').unsigned().nullable();
    t.string('body_type', 60).nullable();                      // "Dropside 14 ft"
    t.string('colour', 30).nullable();
    t.text('notes').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['customer_id']);
  });
  // A vehicle needs at least one way to identify it (trailers often have only a chassis number).
  await knex.raw('ALTER TABLE `vehicles` ADD CONSTRAINT `vehicles_reg_or_chassis` CHECK (`reg_no` IS NOT NULL OR `chassis_no` IS NOT NULL)');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('vehicles');
  await knex.schema.dropTable('customer_contacts');
  await knex.schema.dropTable('customers');
}
