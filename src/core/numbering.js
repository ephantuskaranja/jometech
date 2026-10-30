import { config } from '../config.js';

// Document numbers: JOB-2026-0147, CUS-0042 …
//
//   await db.transaction(async (trx) => {
//     const number = await nextNumber(trx, 'job');      // 'JOB-2026-0148'
//     await trx('jobs').insert({ number, ... });
//   });
//
// Always inside the same transaction as the insert: if the save fails, the
// number is handed back, so there are never gaps. Two people saving at the
// same moment get different numbers because the counter row is locked until
// the first transaction finishes.

/** Every numbered document. `yearly`: the count restarts at 1 each January. */
export const NUMBER_FORMATS = {
  customer:  { prefix: 'CUS', yearly: false },
  vehicle:   { prefix: 'VEH', yearly: false },
  temp_tag:  { prefix: 'JTT', yearly: true },   // painted on trailers that have no reg/chassis number yet
  checkin:   { prefix: 'CHK', yearly: true },
  enquiry:   { prefix: 'ENQ', yearly: true },
  quotation: { prefix: 'QT', yearly: true },
  job:       { prefix: 'JOB', yearly: true },
  issue:     { prefix: 'ISS', yearly: true },
  request:   { prefix: 'PR', yearly: true },
  order:     { prefix: 'PO', yearly: true },
  receipt:   { prefix: 'GRN', yearly: true },
  invoice:   { prefix: 'INV', yearly: true },
  payment:   { prefix: 'RCT', yearly: true },
  release:   { prefix: 'RN', yearly: true },
  backup:    { prefix: 'BKP', yearly: true },
};

const PAD = 4; // 0001; grows to 10000 by itself if a year is that busy

/** The year in Nairobi (31 Dec 23:30 in Nairobi is already the new year in UTC). */
function nairobiYear(date) {
  return new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: config.timezone }).format(date);
}

/**
 * @param {import('knex').Knex.Transaction} trx  must be a transaction
 * @param {keyof typeof NUMBER_FORMATS} type
 * @param {Date} [date] the document's date (defaults to now)
 */
export async function nextNumber(trx, type, date = new Date()) {
  if (!trx?.isTransaction) throw new Error('nextNumber() must run inside db.transaction(), so a failed save gives the number back.');
  const format = NUMBER_FORMATS[type];
  if (!format) throw new Error(`No number format for "${type}". Add it to NUMBER_FORMATS in src/core/numbering.js.`);

  const period = format.yearly ? nairobiYear(date) : '';

  // One statement: create the counter at 1, or add 1 to it. The row stays
  // locked until this transaction commits or rolls back.
  await trx.raw(
    'INSERT INTO `number_sequences` (`seq_key`, `period`, `counter`) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE `counter` = `counter` + 1',
    [format.prefix, period],
  );
  const { counter: value } = await trx('number_sequences').where({ seq_key: format.prefix, period }).first('counter');

  const count = String(value).padStart(PAD, '0');
  return format.yearly ? `${format.prefix}-${period}-${count}` : `${format.prefix}-${count}`;
}
