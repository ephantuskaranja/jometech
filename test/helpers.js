// Shared test helpers. Test users use phone numbers 0700 000 001–099,
// which are removed after each test file.
import request from 'supertest';
import { db } from '../src/core/db.js';
import { sessionStore } from '../src/core/session.js';
import { createUser } from '../src/modules/users/service.js';

export const PASSWORD = 'workshop-test-1';

/** Creates a test user at the MAIN site; returns the phone number as typed (07…). */
export async function makeUser(phoneSuffix, roles, extra = {}) {
  const phone = `07000000${String(phoneSuffix).padStart(2, '0')}`;
  const site = await db('sites').where({ code: 'MAIN' }).first('id');
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
  const ids = await db('users').where('phone', 'like', '+25470000%').pluck('id');
  await db('audit_log').where({ entity: 'user' }).whereIn('entity_id', ids).delete();
  await db('users').whereIn('id', ids).delete();
  await sessionStore.close();
  await db.destroy();
}
