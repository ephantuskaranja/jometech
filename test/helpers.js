// Shared test helpers. Test users use phone numbers 0700 000 001–099,
// which are removed after each test file.
import request from 'supertest';
import { db } from '../src/core/db.js';
import { sessionStore } from '../src/core/session.js';
import { createUser } from '../src/modules/users/service.js';
import { removeFile } from '../src/core/storage.js';

export const PASSWORD = 'workshop-test-1';

// Counter values before this test file ran (restored in cleanup).
const counters = await db('number_sequences').select('seq_key', 'period', 'counter');

/** Creates a test user at HQ (or the sites in extra.siteIds); returns the phone number as typed (07…). */
export async function makeUser(phoneSuffix, roles, extra = {}) {
  const phone = `07000000${String(phoneSuffix).padStart(2, '0')}`;
  const site = await db('sites').where({ code: 'HQ' }).first('id');
  await createUser({ name: `Test ${roles.join(' ')}`, phone, password: PASSWORD, roles, siteIds: [site.id], ...extra }, { user: null });
  return phone;
}

/** Reads the CSRF token out of a rendered page. */
export function csrfFrom(html) {
  return /name="csrf-token" content="([^"]+)"/.exec(html)?.[1];
}

/** A supertest agent (keeps cookies) that is logged in as `phone`. */
export async function loginAs(app, phone, password = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), identifier: phone, password }).expect(302);
  return agent;
}

export async function cleanup() {
  // Test customers use phones 0700 00x xxx too; remove their vehicles first (a customer with vehicles can't be deleted).
  const customerIds = await db('customers').where('phone', 'like', '+25470000%').pluck('id');
  const vehicleIds = await db('vehicles').whereIn('customer_id', customerIds).pluck('id');
  const checkinIds = await db('checkins').whereIn('vehicle_id', vehicleIds).pluck('id');
  const enquiryIds = await db('enquiries').where('caller_phone', 'like', '+25470000%').orWhereIn('customer_id', customerIds).pluck('id');
  const proformaIds = await db('proformas').whereIn('customer_id', customerIds).orWhereIn('enquiry_id', enquiryIds).pluck('id');
  const jobIds = await db('jobs').whereIn('customer_id', customerIds).pluck('id');
  const invoiceIds = await db('invoices').whereIn('job_id', jobIds).orWhereIn('financier_id', customerIds).pluck('id');
  await db('audit_log').where({ entity: 'invoice' }).whereIn('entity_id', invoiceIds).delete();
  await db('invoices').whereIn('id', invoiceIds).delete(); // lines go with them
  await db('payments').whereIn('job_id', jobIds).delete();
  await db('audit_log').where({ entity: 'job' }).whereIn('entity_id', jobIds).delete();
  await db('jobs').whereIn('id', jobIds).delete(); // lines go with them
  await db('audit_log').where({ entity: 'proforma' }).whereIn('entity_id', proformaIds).delete();
  await db('proformas').whereIn('id', proformaIds).update({ replaced_by: null });
  await db('proformas').whereIn('id', proformaIds).delete(); // lines go with them
  await db('audit_log').where({ entity: 'enquiry' }).whereIn('entity_id', enquiryIds).delete();
  await db('enquiries').whereIn('id', enquiryIds).delete(); // notes go with them
  // A file another process still holds open (Windows: EBUSY) only warns; failing here would leave the database open and the run hanging.
  const files = [
    ...await db('checkins').whereIn('id', checkinIds).whereNotNull('driver_signature_path').pluck('driver_signature_path'),
    ...await db('vehicle_releases').whereIn('checkin_id', checkinIds).pluck('signature_path'),
    ...(await db('checkin_photos').whereIn('checkin_id', checkinIds).select('path', 'thumb_path')).flatMap((p) => [p.path, p.thumb_path]),
  ];
  for (const file of files) await removeFile(file).catch((err) => console.warn(`Test file left behind: ${err.message}`));
  await db('audit_log').where({ entity: 'checkin' }).whereIn('entity_id', checkinIds).delete();
  await db('checkins').whereIn('id', checkinIds).delete(); // items and photos go with them
  await db('audit_log').where({ entity: 'vehicle' }).whereIn('entity_id', vehicleIds).delete();
  await db('vehicles').whereIn('id', vehicleIds).delete();
  await db('audit_log').where({ entity: 'customer' }).whereIn('entity_id', customerIds).delete();
  await db('customers').whereIn('id', customerIds).delete();
  // Put document counters back, so tests don't use up real numbers (CUS-0001…).
  const key = (r) => `${r.seq_key}|${r.period}`;
  const before = new Map(counters.map((r) => [key(r), r.counter]));
  for (const row of await db('number_sequences').select('seq_key', 'period', 'counter')) {
    const where = { seq_key: row.seq_key, period: row.period };
    if (!before.has(key(row))) await db('number_sequences').where(where).delete();           // created by this test file
    else if (before.get(key(row)) !== row.counter) await db('number_sequences').where(where).update({ counter: before.get(key(row)) });
  }
  const visitorIds = await db('visitors').where('phone', 'like', '+25470000%').pluck('id');
  await db('audit_log').where({ entity: 'visitor' }).whereIn('entity_id', visitorIds).delete();
  await db('visitors').whereIn('id', visitorIds).delete();
  const ids = await db('users').where('phone', 'like', '+25470000%').pluck('id');
  // Staff and attendance made by test users; test machines are named TEST-…
  const staffIds = await db('employees').whereIn('created_by', ids).pluck('id');
  await db('attendance_days').whereIn('employee_id', staffIds).delete();
  await db('attendance_confirmations').whereIn('confirmed_by', ids).delete();
  await db('audit_log').where({ entity: 'employee' }).whereIn('entity_id', staffIds).delete();
  await db('employees').whereIn('id', staffIds).delete(); // clock IDs go with them
  const importIds = await db('attendance_imports').whereIn('created_by', ids).pluck('id');
  await db('attendance_punches').whereIn('import_id', importIds).delete();
  await db('attendance_imports').whereIn('id', importIds).delete();
  await db('clock_devices').where('name', 'like', 'TEST-%').delete();
  await db('audit_log').whereIn('entity', ['attendance', 'attendance_import', 'clock_device']).whereIn('user_id', ids).delete();
  await db('audit_log').where({ entity: 'user' }).whereIn('entity_id', ids).delete();
  await db('users').whereIn('id', ids).delete();
  await sessionStore.close();
  await db.destroy();
}
