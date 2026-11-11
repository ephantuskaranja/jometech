// Database backups (requirements §54): one row per backup file in storage/backups.
// kind: manual (Back up now), nightly (01:00, cleared by the 7/4/12 rule),
// pre_deploy (made by scripts/deploy.sh; found on disk and listed here).

import { tableDefaults } from '../../src/core/schema.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.createTable('system_backups', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('number', 20).nullable().unique();                       // BKP-2026-00001; null for pre-deploy files
    t.enum('kind', ['manual', 'nightly', 'pre_deploy']).notNullable();
    t.enum('status', ['running', 'done', 'failed']).notNullable().defaultTo('running');
    t.string('file_name', 120).nullable().unique();                   // the database dump (.sql.gz)
    t.bigInteger('size_bytes').unsigned().nullable();
    t.string('sha256', 64).nullable();
    t.boolean('with_files').notNullable().defaultTo(false);           // photos, signatures and other stored files
    t.string('files_name', 120).nullable().unique();                  // .tar.gz beside the dump
    t.bigInteger('files_size_bytes').unsigned().nullable();
    t.string('files_sha256', 64).nullable();
    t.string('error', 1000).nullable();
    t.datetime('started_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('finished_at').nullable();
    t.datetime('checked_at').nullable();                              // last "Check": the file still matches its checksum
    t.boolean('check_ok').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL'); // null = nightly or deploy
    t.index(['status']);
    t.index(['kind', 'started_at']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('system_backups');
}
