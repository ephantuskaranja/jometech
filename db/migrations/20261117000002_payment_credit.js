// Using a customer's credit on another job: the money moves between their jobs as two linked
// payments, method 'credit': minus on the job that was overpaid, plus on the job it pays for.
// Voiding either one voids both. Reports of money received leave these out (nothing new came in).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw("ALTER TABLE `payments` MODIFY `method` ENUM('cash', 'mpesa', 'bank', 'cheque', 'credit') NOT NULL");
  await knex.schema.alterTable('payments', (t) => {
    t.integer('linked_payment_id').unsigned().nullable().after('payer').references('payments.id').onDelete('SET NULL'); // the other half of a credit move
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('payments', (t) => {
    t.dropForeign(['linked_payment_id']);
    t.dropColumn('linked_payment_id');
  });
  await knex('payments').where({ method: 'credit' }).delete();
  await knex.raw("ALTER TABLE `payments` MODIFY `method` ENUM('cash', 'mpesa', 'bank', 'cheque') NOT NULL");
}
