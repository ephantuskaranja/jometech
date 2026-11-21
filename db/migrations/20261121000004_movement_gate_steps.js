// A vehicle moving between sites passes both gates, then the receiving site confirms it:
//
//   sent ─▶ cleared out at the sending gate ─▶ logged in at the receiving gate ─▶ received (admin, manager or supervisor)
//
// The movement stays "in_transit" until it is received; these columns say how far it has got.
// It can be cancelled only before it leaves the sending gate. Moves already on the road when this
// runs count as cleared out (they left before the gate step existed); the receiving gate logs them in.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('vehicle_movements', (t) => {
    t.datetime('gate_out_at').nullable();
    t.integer('gate_out_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('gate_in_at').nullable();
    t.integer('gate_in_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('gate_in_note', 255).nullable();
  });
  await knex('vehicle_movements').where({ status: 'in_transit' }).update({ gate_out_at: knex.ref('sent_at') });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('vehicle_movements', (t) => {
    t.dropForeign('gate_out_by');
    t.dropForeign('gate_in_by');
    t.dropColumn('gate_out_at');
    t.dropColumn('gate_out_by');
    t.dropColumn('gate_in_at');
    t.dropColumn('gate_in_by');
    t.dropColumn('gate_in_note');
  });
}
