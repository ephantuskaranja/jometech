import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Invoices and the money received for jobs.
//
//   jobs ──< invoices ──< invoice_lines     one invoice per job (a cancelled one can be replaced)
//   jobs ──< payments                       deposits and payments, from the client or the bank financing the vehicle
//
// Payments belong to the job, not the invoice, so a deposit can be recorded the day work starts.
// The invoice shows what was paid and the balance. Prices include VAT, as on proformas.
//
//   draft (no number, editable) ──▶ issued (numbered 105, 106 … and locked) ──▶ cancelled (with a reason)
//
// The number is given when it is issued, so a draft that is thrown away doesn't use one up.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('invoices', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).nullable().unique();                            // 105; null while a draft
    t.integer('job_id').unsigned().notNullable().references('jobs.id');
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.integer('customer_id').unsigned().notNullable().references('customers.id');
    t.integer('financier_id').unsigned().nullable().references('customers.id'); // "… & The Co-operative Bank of Kenya"
    t.integer('vehicle_id').unsigned().nullable().references('vehicles.id').onDelete('SET NULL');
    t.string('vehicle_description', 150).nullable();
    t.date('invoice_date').nullable();                                     // the day it was issued
    t.string('etims_number', 40).nullable();                               // the KRA eTIMS invoice it goes with
    t.text('notes').nullable();
    t.decimal('total', 14, 2).notNullable().defaultTo(0);                  // VAT included
    t.enum('status', ['draft', 'issued', 'cancelled']).notNullable().defaultTo('draft');
    t.datetime('issued_at').nullable();
    t.datetime('cancelled_at').nullable();
    t.string('cancelled_reason', 255).nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['job_id']);
    t.index(['status']);
    t.index(['customer_id']);
  });

  await knex.schema.createTable('invoice_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('invoice_id').unsigned().notNullable().references('invoices.id').onDelete('CASCADE');
    t.smallint('sort_order').unsigned().notNullable();
    t.decimal('quantity', 10, 2).notNullable().defaultTo(1);
    t.string('unit', 20).notNullable().defaultTo('Unit');
    t.text('description').notNullable();
    t.decimal('unit_price', 14, 2).notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.index(['invoice_id', 'sort_order']);
  });

  await knex.schema.createTable('payments', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // RCT-2026-0001
    t.integer('job_id').unsigned().notNullable().references('jobs.id');
    t.date('paid_on').notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.enum('method', ['cash', 'mpesa', 'bank', 'cheque']).notNullable();
    t.string('reference', 60).nullable();                                  // M-Pesa code, cheque or bank reference
    t.enum('payer', ['client', 'financier']).notNullable().defaultTo('client');
    t.string('notes', 255).nullable();
    t.integer('received_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    // A payment entered by mistake is voided with a reason, never deleted.
    t.datetime('voided_at').nullable();
    t.integer('voided_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('void_reason', 255).nullable();
    timestamps(t, knex);
    t.index(['job_id']);
    t.index(['paid_on']);
  });

  await knex.schema.alterTable('vehicles', (t) => {
    t.string('engine_no', 30).nullable().after('chassis_no');              // printed on the invoice
  });

  // Invoices are for admins and managers (agreed 2026-11-05); the Sales role started with this permission.
  await knex.raw('DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id'
    + ' WHERE r.`key` = ? AND p.`key` = ?', ['sales', 'invoices.manage']);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('vehicles', (t) => t.dropColumn('engine_no'));
  await knex.schema.dropTable('payments');
  await knex.schema.dropTable('invoice_lines');
  await knex.schema.dropTable('invoices');
  await knex('number_sequences').whereIn('seq_key', ['INV', 'RCT']).delete();
}
