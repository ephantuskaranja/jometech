import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Weekly payroll (step 23). No statutory deductions: daily-paid staff are paid days × daily rate,
// plus or minus adjustments (an advance, transport, Sunday work).
//
//   payrolls ──< payslips ──< payslip_adjustments
//
//   draft (prepared from confirmed attendance) ──▶ checked (supervisor: the days are right)
//     ──▶ approved (manager: locked) ──▶ paid (every slip paid) ──▶ closed
//
// One payroll per site per week, Monday to Saturday, paid on the Saturday. A payslip copies the
// rate and the days, so a later change to either leaves a paid week as it was.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('payrolls', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // PAY-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.date('week_start').notNullable();                                    // the Monday
    t.date('pay_day').notNullable();                                       // the Saturday
    t.enum('status', ['draft', 'checked', 'approved', 'paid', 'closed']).notNullable().defaultTo('draft');
    t.decimal('total', 14, 2).notNullable().defaultTo(0);
    t.integer('prepared_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('checked_at').nullable();
    t.integer('checked_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('approved_at').nullable();
    t.integer('approved_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('closed_at').nullable();
    t.integer('closed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.unique(['site_id', 'week_start']);
  });

  await knex.schema.createTable('payslips', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('payroll_id').unsigned().notNullable().references('payrolls.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id');
    t.decimal('days', 4, 1).notNullable().defaultTo(0);                    // 5.5
    t.text('days_detail').notNullable();                                   // JSON: the status of each day, Monday to Saturday
    t.decimal('daily_rate', 10, 2).nullable();                             // as it was when prepared
    t.decimal('base', 12, 2).notNullable().defaultTo(0);                   // days × rate
    t.decimal('adjustments', 12, 2).notNullable().defaultTo(0);
    t.decimal('net', 12, 2).notNullable().defaultTo(0);
    t.datetime('paid_at').nullable();
    t.enum('paid_method', ['mpesa', 'cash', 'bank']).nullable();
    t.string('paid_reference', 60).nullable();
    t.integer('paid_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.unique(['payroll_id', 'employee_id']);
    t.index(['employee_id']);
  });

  await knex.schema.createTable('payslip_adjustments', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('payslip_id').unsigned().notNullable().references('payslips.id').onDelete('CASCADE');
    t.decimal('amount', 10, 2).notNullable();                              // + an allowance, − an advance
    t.string('reason', 120).notNullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('payslip_adjustments');
  await knex.schema.dropTable('payslips');
  await knex.schema.dropTable('payrolls');
  await knex('number_sequences').where({ seq_key: 'PAY' }).delete();
}
