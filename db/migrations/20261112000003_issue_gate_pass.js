// Materials leaving the site on a job (step 26c). An issue ticked "Leaves the site" (e.g. to a customer's
// site or an outside fabricator) gets a gate pass: it waits at the gate until the guard checks the load
// and lets it out. Stores can cancel the pass before then (the materials stay; the issue doesn't change).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('material_issues', (t) => {
    t.boolean('leaves_site').notNullable().defaultTo(false);
    t.string('destination', 150).nullable();                               // where it is going
    t.datetime('gate_out_at').nullable();
    t.integer('gate_out_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('gate_out_note', 255).nullable();                             // who carried it, the vehicle
    t.datetime('pass_cancelled_at').nullable();
    t.integer('pass_cancelled_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('pass_cancel_reason', 255).nullable();
    t.index(['site_id', 'leaves_site']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('material_issues', (t) => {
    t.dropForeign('gate_out_by');
    t.dropForeign('pass_cancelled_by');
    t.dropIndex(['site_id', 'leaves_site']);
    for (const c of ['leaves_site', 'destination', 'gate_out_at', 'gate_out_by', 'gate_out_note', 'pass_cancelled_at', 'pass_cancelled_by', 'pass_cancel_reason']) t.dropColumn(c);
  });
}
