import { tableDefaults, timestamps } from '../../src/core/schema.js';

// Vehicle check-in: the digital "Truck Receiving Document".
//
//   vehicles ──< checkins ──< checkin_items     (loose items received with the truck)
//                         ──< checkin_photos    (optional)
//   checkin_item_presets: quick picks for items (spare wheel, jack …), editable, not hard-coded.
//
// Paper form → columns: Received by = received_by (logged-in user);
// Confirmed by = the driver, who signs on the device (driver_*), or a reason why not.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // Trailers being built often have no reg or chassis number yet: they get a JTT-2026-0007 tag painted on the frame.
  await knex.schema.alterTable('vehicles', (t) => {
    t.string('temp_tag', 20).nullable().unique().after('chassis_no');
  });
  await knex.raw('ALTER TABLE `vehicles` DROP CHECK `vehicles_reg_or_chassis`');
  await knex.raw('ALTER TABLE `vehicles` ADD CONSTRAINT `vehicles_has_identifier` CHECK (`reg_no` IS NOT NULL OR `chassis_no` IS NOT NULL OR `temp_tag` IS NOT NULL)');

  await knex.schema.createTable('checkin_item_presets', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 80).notNullable().unique();
    t.smallint('sort_order').unsigned().notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(t, knex);
  });

  await knex.schema.createTable('checkins', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).notNullable().unique();             // CHK-2026-0001
    t.integer('site_id').unsigned().notNullable().references('sites.id').onDelete('RESTRICT');
    t.integer('vehicle_id').unsigned().notNullable().references('vehicles.id').onDelete('RESTRICT');
    // Owner and "brought in by" as they were on the day (the vehicle's own may change later).
    t.integer('customer_id').unsigned().notNullable().references('customers.id').onDelete('RESTRICT');
    t.integer('contact_id').unsigned().nullable().references('customer_contacts.id').onDelete('SET NULL');
    t.datetime('checked_in_at').notNullable().defaultTo(knex.fn.now());
    t.integer('odometer_km').unsigned().nullable();             // optional
    t.boolean('odometer_not_working').notNullable().defaultTo(false);
    t.tinyint('fuel_quarters').unsigned().nullable();           // 0 = empty … 4 = full; null = not recorded
    t.text('remarks').nullable();
    t.string('status', 20).notNullable().defaultTo('in_workshop'); // in_workshop | checked_out | cancelled
    t.integer('received_by').unsigned().notNullable().references('users.id').onDelete('RESTRICT');
    // The person delivering the truck confirms by signing on the phone/tablet; they are not users.
    t.string('driver_name', 100).nullable();
    t.string('driver_phone', 20).nullable();
    t.string('driver_id_no', 20).nullable();
    t.string('driver_signature_path', 255).nullable();         // storage/signatures/YYYY/MM/…png
    t.datetime('driver_signed_at').nullable();
    t.string('not_signed_reason', 255).nullable();             // when the driver left without signing
    t.datetime('checked_out_at').nullable();
    t.integer('checked_out_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    timestamps(t, knex);
    t.index(['vehicle_id', 'checked_in_at']);
    t.index(['status', 'site_id']);
  });
  await knex.raw('ALTER TABLE `checkins` ADD CONSTRAINT `checkins_fuel_range` CHECK (`fuel_quarters` IS NULL OR `fuel_quarters` <= 4)');

  await knex.schema.createTable('checkin_items', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('checkin_id').unsigned().notNullable().references('checkins.id').onDelete('CASCADE');
    t.string('description', 120).notNullable();
    t.smallint('quantity').unsigned().notNullable().defaultTo(1);
    t.smallint('sort_order').unsigned().notNullable().defaultTo(0);
    t.index(['checkin_id', 'sort_order']);
  });

  await knex.schema.createTable('checkin_photos', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('checkin_id').unsigned().notNullable().references('checkins.id').onDelete('CASCADE');
    t.string('path', 255).notNullable();                       // storage/uploads/checkins/YYYY/MM/…webp (1280 px)
    t.string('thumb_path', 255).notNullable();                 // 320 px
    t.integer('bytes').unsigned().notNullable();
    t.integer('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['checkin_id']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable('checkin_photos');
  await knex.schema.dropTable('checkin_items');
  await knex.schema.dropTable('checkins');
  await knex.schema.dropTable('checkin_item_presets');
  await knex.raw('ALTER TABLE `vehicles` DROP CHECK `vehicles_has_identifier`');
  await knex.raw('ALTER TABLE `vehicles` ADD CONSTRAINT `vehicles_reg_or_chassis` CHECK (`reg_no` IS NOT NULL OR `chassis_no` IS NOT NULL)');
  await knex.schema.alterTable('vehicles', (t) => {
    t.dropColumn('temp_tag');
  });
}
