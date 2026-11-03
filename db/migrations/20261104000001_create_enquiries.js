import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Enquiries, mostly from phone calls:
//
//   enquiries ──< enquiry_notes     each call back: what was said, when to call next
//   enquiry_work_types: quick picks for "what they want" (tipper, dropside …), editable
//
// A caller who isn't a customer yet stays a prospect (caller_name / caller_phone)
// until someone adds them as a customer or a proforma is made for them.
//
//   open ──▶ quoted (proforma sent) ──▶ won (became a job) | lost (with a reason)

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('enquiry_work_types', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 60).notNullable().unique();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(t, knex);
  });

  await knex.schema.createTable('enquiries', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();                       // ENQ-2026-0001
    t.integer('site_id').unsigned().nullable().references('sites.id');
    t.integer('customer_id').unsigned().nullable().references('customers.id');
    // Who called: always kept (it may be the customer's driver); for a prospect it is all we have.
    t.string('caller_name', 100).notNullable();
    t.string('caller_phone', 20).nullable();
    t.integer('vehicle_id').unsigned().nullable().references('vehicles.id').onDelete('SET NULL');
    t.string('vehicle_description', 150).nullable();                      // "new Isuzu FRR chassis"
    t.string('work_type', 60).notNullable();
    t.text('description').notNullable();
    t.decimal('budget', 14, 2).nullable();
    t.enum('source', ['call', 'walk_in', 'whatsapp', 'referral', 'other']).notNullable().defaultTo('call');
    t.enum('status', ['open', 'quoted', 'won', 'lost']).notNullable().defaultTo('open');
    t.string('lost_reason', 255).nullable();
    t.date('follow_up_on').nullable();
    t.integer('assigned_to').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('closed_at').nullable();
    timestamps(t, knex);
    t.index(['status', 'follow_up_on']);
    t.index(['caller_phone']);
    t.index(['customer_id']);
  });

  await knex.schema.createTable('enquiry_notes', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('enquiry_id').unsigned().notNullable().references('enquiries.id').onDelete('CASCADE');
    t.text('note').notNullable();
    t.date('follow_up_on').nullable();                                    // the next call-back set with this note
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['enquiry_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('enquiry_notes');
  await knex.schema.dropTable('enquiries');
  await knex.schema.dropTable('enquiry_work_types');
}
