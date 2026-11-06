import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Staff and attendance (step 22). Payroll (step 23) builds on attendance_days.
//
//   employees ──< employee_clock_ids        the number(s) the clock-in machine knows them by (some have two)
//   clock_devices                           JOMETECH 1, JOMETECH2 …; each belongs to a site
//   attendance_imports ──< attendance_punches   every punch from the machine export, kept as it came
//   attendance_days                         one row per employee per day: what counts for pay
//   attendance_confirmations                a site's day, confirmed by its supervisor (locked for payroll)
//
// Punches are kept by the machine's number, not the employee: an unknown number can be linked later.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('employees', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // EMP-0001
    t.string('name', 100).notNullable();
    t.string('phone', 20).nullable();
    t.string('id_no', 20).nullable();
    t.string('trade', 40).nullable();                                      // Welder, Fabricator, Painter …
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.enum('category', ['permanent', 'casual']).notNullable().defaultTo('casual');
    t.decimal('daily_rate', 10, 2).nullable();                             // KES; seen by managers and admins only
    t.date('joined_on').nullable();
    t.string('mpesa_phone', 20).nullable();
    t.string('emergency_name', 100).nullable();
    t.string('emergency_phone', 20).nullable();
    t.text('notes').nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.date('left_on').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['site_id', 'is_active']);
    t.index(['name']);
  });

  await knex.schema.createTable('employee_clock_ids', (t) => {
    tableDefaults(t);
    t.string('clock_id', 30).primary();                                    // "70", "3513165238"
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.index(['employee_id']);
  });

  await knex.schema.createTable('clock_devices', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 60).notNullable().unique();                           // as in the export: "JOMETECH 1"
    t.string('serial', 40).nullable();
    t.integer('site_id').unsigned().nullable().references('sites.id');     // set once by an admin or manager
    timestamps(t, knex);
  });

  await knex.schema.createTable('attendance_imports', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('file_name', 255).notNullable();
    t.integer('rows').unsigned().notNullable().defaultTo(0);
    t.integer('added').unsigned().notNullable().defaultTo(0);              // new punches
    t.date('first_day').nullable();
    t.date('last_day').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
  });

  await knex.schema.createTable('attendance_punches', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('clock_id', 30).notNullable();
    t.string('clock_name', 100).nullable();                                // the name on the machine
    t.date('day').notNullable();                                           // local day
    t.time('time').notNullable();                                          // local time
    t.integer('device_id').unsigned().nullable().references('clock_devices.id');
    t.tinyint('state').unsigned().nullable();                              // 1 morning in, 3 lunch out, 4 lunch in, 2 evening out; null if not given
    t.integer('import_id').unsigned().nullable().references('attendance_imports.id').onDelete('SET NULL');
    t.unique(['clock_id', 'day', 'time', 'device_id']);                    // the same export twice adds nothing
    t.index(['day', 'clock_id']);
  });

  await knex.schema.createTable('attendance_days', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('employee_id').unsigned().notNullable().references('employees.id');
    t.date('day').notNullable();
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.enum('status', ['present', 'half', 'absent', 'sick', 'leave', 'off', 'holiday']).notNullable();
    t.time('first_in').nullable();
    t.time('last_out').nullable();
    t.decimal('hours', 4, 2).nullable();                                   // worked, lunch excluded, from the punches
    t.string('note', 255).nullable();
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.unique(['employee_id', 'day']);
    t.index(['site_id', 'day']);
  });

  await knex.schema.createTable('attendance_confirmations', (t) => {
    tableDefaults(t);
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.date('day').notNullable();
    t.integer('confirmed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('confirmed_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['site_id', 'day']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  for (const table of ['attendance_confirmations', 'attendance_days', 'attendance_punches', 'attendance_imports', 'clock_devices', 'employee_clock_ids', 'employees']) {
    await knex.schema.dropTable(table);
  }
  await knex('number_sequences').where({ seq_key: 'EMP' }).delete();
}
