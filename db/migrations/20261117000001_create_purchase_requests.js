import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Purchase requests: the workshop asks stores for materials ("6 sheets of 4 mm plate for JOB-2026-0003,
// needed by Friday"). A manager approves or declines; stores put approved requests on a purchase order.
//
//   pending ──▶ approved ──▶ ordered        (declined, or cancelled by whoever asked or by stores)
//
// Several requests can go on one order. If that order is cancelled, its requests go back to approved.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('purchase_requests', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                         // PR-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id');
    t.date('needed_by').nullable();
    t.text('notes').nullable();
    t.enum('status', ['pending', 'approved', 'declined', 'ordered', 'cancelled']).notNullable().defaultTo('pending');
    t.integer('requested_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('decided_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('decided_at').nullable();
    t.string('reason', 255).nullable();                                     // why declined or cancelled
    t.integer('order_id').unsigned().nullable().references('purchase_orders.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['status']);
  });

  await knex.schema.createTable('purchase_request_lines', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('request_id').unsigned().notNullable().references('purchase_requests.id').onDelete('CASCADE');
    t.smallint('sort_order').unsigned().notNullable();
    t.integer('item_id').unsigned().notNullable().references('items.id');
    t.decimal('quantity', 14, 3).notNullable();                            // pieces, for a plate
    t.decimal('length', 10, 2).nullable();
    t.decimal('width', 10, 2).nullable();
    t.enum('size_unit', ['ft', 'mm']).nullable();
    t.decimal('area_sq_ft', 12, 4).nullable();                             // of one piece
    t.integer('job_id').unsigned().nullable().references('jobs.id').onDelete('SET NULL');
    t.string('for_text', 60).nullable();
    t.index(['request_id', 'sort_order']);
    t.index(['job_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('purchase_request_lines');
  await knex.schema.dropTable('purchase_requests');
  await knex('number_sequences').where({ seq_key: 'PR' }).delete();
}
