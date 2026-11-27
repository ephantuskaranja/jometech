// Stock builds (sheet row 58): bodies built before there is a customer, sold to whoever comes.
//
// Jobs, check-ins and vehicles all need a customer, so one built-in customer stands for "no customer
// yet": customers.is_stock. It is named for what it shows ("Stock build: awaiting customer"), so any
// list that shows a job's or vehicle's customer reads right, and it is left out of customer lists,
// pickers and search. jobs.stock_build marks a job built for stock, and stays once a customer buys it.

const STOCK = { number: 'CUS-STOCK', name: 'Stock build: awaiting customer', category: 'company', phone: '', credit_days: 0, is_active: true,
  notes: 'Built-in: owns vehicles and jobs built for stock until a customer is assigned. Not a real customer.' };

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.boolean('is_stock').notNullable().defaultTo(false).after('is_active');
  });
  await knex.schema.alterTable('jobs', (t) => {
    t.boolean('stock_build').notNullable().defaultTo(false).after('proforma_id');
  });
  await knex('customers').insert({ ...STOCK, is_stock: true });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex('customers').where({ number: STOCK.number, is_stock: true }).delete();
  await knex.schema.alterTable('jobs', (t) => t.dropColumn('stock_build'));
  await knex.schema.alterTable('customers', (t) => t.dropColumn('is_stock'));
}
