// Transfers pass the gates (step 26a): the sending gate clears the truck out, the receiving gate
// logs it in, and only then can stores receive it into stock. A transfer can be cancelled only
// before it has left the gate.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('stock_transfers', (t) => {
    t.datetime('gate_out_at').nullable();
    t.integer('gate_out_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('gate_in_at').nullable();
    t.integer('gate_in_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('gate_in_note', 255).nullable();                              // who brought it, the vehicle
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('stock_transfers', (t) => {
    t.dropForeign('gate_out_by');
    t.dropForeign('gate_in_by');
    t.dropColumn('gate_out_at');
    t.dropColumn('gate_out_by');
    t.dropColumn('gate_in_at');
    t.dropColumn('gate_in_by');
    t.dropColumn('gate_in_note');
  });
}
