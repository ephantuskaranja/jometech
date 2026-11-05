import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';

// Sites, kept by an admin. A site is switched off, never deleted: records point to it.
// The short code is made once from the name and never changes, because the seed recognises
// existing sites by it (a site renamed here must not reappear under its old name after a deploy).

const FIELDS = ['name', 'address', 'phone'];
const pick = (input) => Object.fromEntries(FIELDS.map((k) => [k, input[k] ?? null]));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = async (q) => Number((await q.count({ n: '*' }))[0].n);

async function checkName(trx, name, exceptId = null) {
  const q = trx('sites').whereRaw("REPLACE(`name`, ' ', '') = ?", [name.replace(/\s+/g, '')]);
  if (exceptId) q.whereNot({ id: exceptId });
  const match = await q.first('id', 'name', 'is_active');
  if (match) {
    throw Object.assign(httpError(409, match.is_active ? `“${match.name}” is already a site.` : `“${match.name}” is already a site, but it is switched off.`), { field: 'name', existingId: match.id });
  }
}

/** "Mombasa Road Yard" → MOMBASAROA; a second one with the same start → MOMBASARO2. */
async function makeCode(trx, name) {
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'SITE';
  for (let i = 1; ; i += 1) {
    const code = i === 1 ? base : `${base.slice(0, 10 - String(i).length)}${i}`;
    if (!(await trx('sites').where({ code }).first('id'))) return code;
  }
}

/** @returns {Promise<number>} */
export async function createSite(input, actor) {
  return db.transaction(async (trx) => {
    await checkName(trx, input.name);
    const [id] = await trx('sites').insert({ ...pick(input), code: await makeCode(trx, input.name) });
    await audit(trx, actor, { entity: 'site', id, action: 'create', summary: input.name });
    return id;
  });
}

export async function updateSite(id, input, actor) {
  await db.transaction(async (trx) => {
    const before = await trx('sites').where({ id }).forUpdate().first();
    if (!before) throw httpError(404, 'That site doesn’t exist.');
    await checkName(trx, input.name, id);
    await trx('sites').where({ id }).update(pick(input));
    await audit(trx, actor, { entity: 'site', id, action: 'update', before: pick(before), after: pick(input) });
  });
}

/** Active users who can reach this site and no other. Roles covering all sites never count. */
function staffOnlyHere(q, siteId) {
  return q('users as u').join('user_sites as us', 'us.user_id', 'u.id')
    .where({ 'us.site_id': siteId, 'u.is_active': true })
    .whereNotExists(q('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').whereRaw('ur.user_id = u.id').where('r.all_sites', true))
    .whereNotExists(q('user_sites as other').join('sites as s', 's.id', 'other.site_id').whereRaw('other.user_id = u.id').whereNot('other.site_id', siteId).where('s.is_active', true))
    .orderBy('u.name').pluck('u.name');
}

/** What must be dealt with before a site can be switched off. Empty when it is safe. */
export async function blockers(siteId, q = db) {
  const out = [];
  const add = (n, text) => { if (n) out.push(text(n)); };
  if (!(await count(q('sites').where({ is_active: true }).whereNot({ id: siteId })))) out.push('It is the only active site.');
  add(await count(q('checkins').where({ site_id: siteId }).whereIn('status', ['in_workshop', 'released'])), (n) => `${plural(n, 'vehicle')} still in the workshop.`);
  add(await count(q('vehicle_movements').where({ status: 'in_transit' }).where((w) => w.where('from_site_id', siteId).orWhere('to_site_id', siteId))), (n) => `${plural(n, 'vehicle')} on the way to or from here.`);
  add(await count(q('jobs').where({ site_id: siteId }).whereIn('status', ['open', 'in_progress'])), (n) => `${plural(n, 'active job')}.`);
  add(await count(q('stock_balances').where({ site_id: siteId }).where('quantity', '>', 0)), (n) => `Stock of ${plural(n, 'item or sheet size', 'items or sheet sizes')} still here.`);
  add(await count(q('purchase_orders').where({ site_id: siteId }).whereIn('status', ['draft', 'pending', 'approved', 'sent', 'partly_received'])), (n) => `${plural(n, 'purchase order')} not finished.`);
  add(await count(q('visitors').where({ site_id: siteId }).whereNot({ status: 'cleared' })), (n) => `${plural(n, 'visitor')} still signed in.`);
  const staff = await staffOnlyHere(q, siteId);
  if (staff.length) out.push(`${plural(staff.length, 'person', 'people')} who work only here: ${staff.join(', ')}. Add them to another site first, or they can’t log in.`);
  return out;
}

export async function setActive(id, active, actor) {
  await db.transaction(async (trx) => {
    const site = await trx('sites').where({ id }).forUpdate().first();
    if (!site) throw httpError(404, 'That site doesn’t exist.');
    if (Boolean(site.is_active) === active) return;
    if (!active) {
      const reasons = await blockers(id, trx);
      if (reasons.length) throw httpError(409, `${site.name} can’t be switched off yet. ${reasons.join(' ')}`);
    }
    await trx('sites').where({ id }).update({ is_active: active });
    await audit(trx, actor, { entity: 'site', id, action: active ? 'record_on' : 'record_off', summary: site.name });
  });
}

export function getSite(id) {
  return db('sites').where({ id }).first();
}

/** All sites, active first, with how many staff are linked to each. */
export function listSites() {
  return db('sites as s').orderBy('s.is_active', 'desc').orderBy('s.name')
    .select('s.*', db('user_sites as us').join('users as u', 'u.id', 'us.user_id').whereRaw('us.site_id = s.id').where('u.is_active', true).count('*').as('staff_count'));
}
