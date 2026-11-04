import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Materials issued to jobs, and opening stock.
//
//   material_issues ──< material_issue_lines    what left the store for a job, at the average cost that day
//
// A job keeps the cost it was issued at, whatever the average does later. Returns go back at that
// same cost, and are recorded on the line. Plates are issued as whole sheets until offcuts are built.
// Opening stock is what was already on the racks: a stock movement with its own cost.

const ALL = ['receive', 'reverse', 'issue', 'return', 'opening'];
const enumOf = (list) => `ENUM(${list.map((s) => `'${s}'`).join(', ')}) NOT NULL`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('material_issues', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // ISS-2026-0001
    t.integer('job_id').unsigned().notNullable().references('jobs.id');
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.date('issued_on').notNullable();
    t.string('received_by', 100).nullable();                               // who took them from the store
    t.text('notes').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['job_id']);
  });

  await knex.schema.createTable('material_issue_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('issue_id').unsigned().notNullable().references('material_issues.id').onDelete('CASCADE');
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.string('size_key', 40).notNullable().defaultTo('');
    t.decimal('length', 10, 2).nullable();
    t.decimal('width', 10, 2).nullable();
    t.enum('size_unit', ['ft', 'mm']).nullable();
    t.decimal('area_sq_ft', 12, 4).nullable();
    t.decimal('quantity', 14, 3).notNullable();                            // pieces, for a plate
    t.decimal('stock_qty', 16, 3).notNullable();                           // in the pricing unit
    t.decimal('unit_cost', 14, 4).notNullable();                           // the average that day
    t.decimal('value', 16, 4).notNullable();
    t.decimal('returned_qty', 14, 3).notNullable().defaultTo(0);
    t.decimal('returned_value', 16, 4).notNullable().defaultTo(0);
    t.index(['issue_id']);
  });

  await knex.raw(`ALTER TABLE \`stock_movements\` MODIFY \`type\` ${enumOf(ALL)}`);
  await knex.schema.alterTable('stock_movements', (t) => {
    t.integer('job_id').unsigned().nullable().references('jobs.id').onDelete('SET NULL');
    t.integer('issue_id').unsigned().nullable().references('material_issues.id').onDelete('SET NULL');
    t.integer('reverses_id').unsigned().nullable().references('stock_movements.id').onDelete('SET NULL');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('stock_movements', (t) => {
    t.dropForeign('job_id');
    t.dropForeign('issue_id');
    t.dropForeign('reverses_id');
    t.dropColumn('job_id');
    t.dropColumn('issue_id');
    t.dropColumn('reverses_id');
  });
  await knex('stock_movements').whereIn('type', ['issue', 'return', 'opening']).delete();
  await knex.raw(`ALTER TABLE \`stock_movements\` MODIFY \`type\` ${enumOf(['receive', 'reverse'])}`);
  await knex.schema.dropTable('material_issue_lines');
  await knex.schema.dropTable('material_issues');
  await knex('number_sequences').where({ seq_key: 'ISS' }).delete();
}
