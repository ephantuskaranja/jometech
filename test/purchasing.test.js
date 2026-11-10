import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let store, manager, supervisor, siteBOnly, plate4, bolt, supplier;

before(async () => {
  store = await loginAs(app, await makeUser(55, ['storekeeper']));
  manager = await loginAs(app, await makeUser(56, ['manager']));
  supervisor = await loginAs(app, await makeUser(57, ['supervisor']));
  const siteB = await db('sites').where({ code: 'SITEB' }).first();
  siteBOnly = await loginAs(app, await makeUser(58, ['storekeeper'], { siteIds: [siteB.id] }));
  await post(store, '/items', { name: 'Test Plate 4 mm', category: 'Plates', priced_by: 'area', thickness_mm: '4', current_price: '300' });
  await post(store, '/items', { name: 'Test U-bolt', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  plate4 = await db('items').where({ name: 'Test Plate 4 mm' }).first();
  bolt = await db('items').where({ name: 'Test U-bolt' }).first();
});

after(async () => {
  const supplierIds = await db('suppliers').where('name', 'like', 'Test %').pluck('id');
  const orderIds = await db('purchase_orders').whereIn('supplier_id', supplierIds).pluck('id');
  await db('audit_log').where({ entity: 'purchase_order' }).whereIn('entity_id', orderIds).delete();
  await db('purchase_orders').whereIn('id', orderIds).delete();
  await db('audit_log').where({ entity: 'supplier' }).whereIn('entity_id', supplierIds).delete();
  await db('suppliers').whereIn('id', supplierIds).delete();
  const itemIds = await db('items').where('name', 'like', 'Test %').pluck('id');
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const idOf = (location) => Number(location.split('/')[2]);
const line = (item, extra = {}) => ({ item_id: item.id, item_name: item.name, quantity: '', length: '', width: '', size_unit: 'ft', for: '', price: '', ...extra });
const lines = (...rows) => Object.fromEntries(['item_id', 'item_name', 'quantity', 'length', 'width', 'size_unit', 'for', 'price'].map((k) => [`line_${k}`, rows.map((r) => r[k])]));
const order = (...rows) => ({ supplier_id: supplier.id, order_date: localDay(), ...lines(...rows) });
const status = async (id) => (await db('purchase_orders').where({ id }).first()).status;

test('who can do what', async () => {
  await store.get('/suppliers').expect(200);
  await store.get('/purchase-orders/new').expect(200);
  await supervisor.get('/suppliers').expect(403);
  await supervisor.get('/purchase-orders').expect(403);
  assert.equal((await post(supervisor, '/suppliers', { name: 'Test nope' })).status, 403);
});

test('a supplier only needs a name; the same name twice is refused', async () => {
  let res = await post(store, '/suppliers', { name: '', kra_pin: 'nonsense' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Enter the supplier/);
  assert.match(res.text, /A KRA PIN looks like/);

  res = await post(store, '/suppliers', { name: 'Test Tononoka Rolling Mills', kra_pin: 'p052233213i', phone: '0700 000 830', materials: 'Plates' });
  assert.equal(res.status, 302, res.text);
  supplier = await db('suppliers').where({ name: 'Test Tononoka Rolling Mills' }).first();
  assert.match(supplier.number, /^SUP-\d{4,}$/);
  assert.equal(supplier.kra_pin, 'P052233213I');
  assert.equal(supplier.phone, '+254700000830');
  await store.get(`/suppliers/${supplier.id}/edit`).expect(200);

  res = await post(store, '/suppliers', { name: 'test tononoka  rolling mills' });
  assert.equal(res.status, 422);
  assert.match(res.text, /already a supplier/);
  assert.match(res.text, /Open that supplier/);

  const found = await store.get('/api/suppliers?q=tononoka').expect(200);
  assert.ok(found.body.some((o) => o.value === supplier.id));
});

test('a supplier and an item can be added in place, from the order form', async () => {
  const csrf = csrfFrom((await store.get('/purchase-orders/new')).text);
  let res = await store.post('/api/suppliers').set('x-csrf-token', csrf).send({ name: 'Test Quick Supplier', phone: '' });
  assert.equal(res.status, 201, res.text);
  assert.match(res.body.label, /Test Quick Supplier \(SUP-/);
  res = await store.post('/api/suppliers').set('x-csrf-token', csrf).send({ name: 'Test Quick Supplier' });
  assert.equal(res.status, 422);
  assert.match(res.body.errors.name, /already a supplier/);

  res = await store.post('/api/items').set('x-csrf-token', csrf).send({ name: 'Test Plate 9 mm', category: 'Plates', priced_by: 'area', thickness_mm: '9' });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.priced_by, 'area');
  assert.equal(res.body.unit, 'sq ft');
  res = await store.post('/api/items').set('x-csrf-token', csrf).send({ name: 'Test Plate 9 mm', category: 'Plates', priced_by: 'area' });
  assert.equal(res.status, 422);
  assert.ok(res.body.errors.thickness_mm);
});

test('an order needs a supplier and an item; a plate needs its size in whole pieces', async () => {
  let res = await post(store, '/purchase-orders', { supplier_id: '', order_date: localDay(), ...lines(line({ id: '', name: '' })) });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the supplier/);
  assert.match(res.text, /Add at least one item/);

  res = await post(store, '/purchase-orders', { ...order(line(bolt, { quantity: '1' })), order_date: '2026-11-10', expected_on: '2026-11-09' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Delivery can’t be before the order date/);

  res = await post(store, '/purchase-orders', order(line({ id: '', name: 'Not an item' }, { quantity: '2' })));
  assert.match(res.text, /Line 1: choose an item from the list/);
  assert.match(res.text, /Not an item/, 'what was typed stays');

  res = await post(store, '/purchase-orders', order(line(plate4, { quantity: '9' })));
  assert.match(res.text, /Line 1: enter the plate/);
  res = await post(store, '/purchase-orders', order(line(plate4, { quantity: '1.5', length: '12', width: '4' })));
  assert.match(res.text, /whole pieces/);
  res = await post(store, '/purchase-orders', order(line(plate4, { quantity: '9', length: '12', width: '4', for: 'JOB-2026-99999' })));
  assert.match(res.text, /there is no job/);
});

test('with no prices, like the paper order; a plate is sized in feet or mm', async () => {
  const res = await post(store, '/purchase-orders', order(
    line(plate4, { quantity: '9', length: '12', width: '4', size_unit: 'ft', for: 'Trailer' }),
    line(plate4, { quantity: '2', length: '2,600', width: '1,220', size_unit: 'mm', for: 'Trailer' }),
    line({ id: '', name: '' }),
  ));
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  const po = await db('purchase_orders').where({ id }).first();
  assert.match(po.number, /^PO-\d{4}-\d{4,}$/);
  assert.equal(po.status, 'draft');
  assert.equal(po.total, null);
  const rows = await db('purchase_order_lines').where({ order_id: id }).orderBy('sort_order');
  assert.equal(rows.length, 2, 'the empty row is skipped');
  assert.equal(Number(rows[0].area_sq_ft), 48);
  assert.equal(Number(rows[1].area_sq_ft), 34.1431);
  assert.equal(rows[1].size_unit, 'mm');
  assert.equal(rows[0].for_text, 'Trailer');

  const print = (await store.get(`/purchase-orders/${id}/print`).expect(200)).text;
  assert.match(print, new RegExp(po.number));
  assert.match(print, /Test Tononoka Rolling Mills/);
  assert.match(print, /Test Plate 4 mm, 12 × 4 ft/);
  assert.match(print, /Test Plate 4 mm, 2600 × 1220 mm/);
  assert.doesNotMatch(print, /po-blank|<tr[^>]*>(\s*<td><\/td>)+\s*<\/tr>/, 'no empty lines under the items');
  assert.match(print, /9 pcs/);
  assert.match(print, /eTIMS receipt/);
  assert.match(print, /is-draft/, 'not approved: marked as a draft');
  assert.doesNotMatch(print, /Total excluding VAT/, 'no prices, no total');
});

test('with prices: a plate by sq ft, the rest by unit, excluding VAT', async () => {
  const res = await post(store, '/purchase-orders', order(
    line(plate4, { quantity: '9', length: '12', width: '4', price: '300' }),
    line(bolt, { quantity: '20', price: '1,250.50' }),
    line(bolt, { quantity: '4' }),
  ));
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  const rows = await db('purchase_order_lines').where({ order_id: id }).orderBy('sort_order');
  assert.equal(Number(rows[0].amount), 129600, '9 × 48 sq ft × 300');
  assert.equal(Number(rows[1].amount), 25010);
  assert.equal(rows[2].amount, null);
  assert.equal(Number((await db('purchase_orders').where({ id }).first()).total), 154610);
  const page = (await store.get(`/purchase-orders/${id}`)).text;
  assert.match(page, /154,610\.00/);
  assert.match(page, /lines with a price/);
  assert.match((await store.get(`/purchase-orders/${id}/print`)).text, /Total excluding VAT/);
});

test('a line can be for a job, and the job shows the order', async () => {
  const customerId = (await db('customers').insert({ number: 'CUS-T855', name: 'Test Haulier', phone: '+254700000855', category: 'individual' }))[0];
  const site = await db('sites').where({ code: 'HQ' }).first();
  const [jobId] = await db('jobs').insert({ number: 'JOB-2026-8855', site_id: site.id, customer_id: customerId });
  assert.match((await store.get('/purchase-orders/new')).text, /JOB-2026-8855 Test Haulier/, 'offered as a suggestion');

  const res = await post(store, '/purchase-orders', order(line(bolt, { quantity: '4', for: 'JOB-2026-8855 Test Haulier' })));
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  const [row] = await db('purchase_order_lines').where({ order_id: id });
  assert.equal(row.job_id, jobId);
  assert.equal(row.for_text, null);
  assert.match((await store.get(`/purchase-orders/${id}/print`)).text, /JOB-2026-8855/);
  assert.match((await manager.get(`/jobs/${jobId}`)).text, new RegExp(`/purchase-orders/${id}"`));
  assert.doesNotMatch((await supervisor.get(`/jobs/${jobId}`)).text, new RegExp(`/purchase-orders/${id}"`), 'not for those who can’t open it');
  await db('jobs').where({ id: jobId }).delete();
});

test('draft → approval → sent; a storekeeper can’t approve, and only a draft can be edited', async () => {
  const res = await post(store, '/purchase-orders', order(line(bolt, { quantity: '4' })));
  const id = idOf(res.headers.location);
  const edit = () => post(store, `/purchase-orders/${id}`, order(line(bolt, { quantity: '8' })));

  assert.equal((await edit()).status, 302);
  assert.equal(Number((await db('purchase_order_lines').where({ order_id: id }).first()).quantity), 8);
  assert.match((await store.get(`/purchase-orders/${id}`)).text, /Send for approval/);
  assert.equal((await post(store, `/purchase-orders/${id}/send`)).status, 409, 'must be approved first');
  assert.equal((await post(store, `/purchase-orders/${id}/approve`)).status, 403);

  await post(store, `/purchase-orders/${id}/submit`);
  assert.equal(await status(id), 'pending');
  assert.equal((await edit()).status, 409);
  await store.get(`/purchase-orders/${id}/edit`).expect(409);

  await post(manager, `/purchase-orders/${id}/approve`);
  const approved = await db('purchase_orders').where({ id }).first();
  assert.equal(approved.status, 'approved');
  assert.ok(approved.approved_at);
  assert.doesNotMatch((await store.get(`/purchase-orders/${id}/print`)).text, /is-draft/, 'approved: a real order');

  await post(store, `/purchase-orders/${id}/send`);
  assert.equal(await status(id), 'sent');
  assert.match((await store.get('/purchase-orders?show=sent')).text, new RegExp(`/purchase-orders/${id}"`));

  // Changing it means approving it again.
  await post(store, `/purchase-orders/${id}/draft`, { reason: 'Add more bolts' });
  const redraft = await db('purchase_orders').where({ id }).first();
  assert.equal(redraft.status, 'draft');
  assert.equal(redraft.approved_by, null);
  assert.match((await store.get(`/purchase-orders/${id}`)).text, /Add more bolts/);

  // Someone who can approve doesn't need to send it to themselves first.
  await post(manager, `/purchase-orders/${id}/approve`);
  assert.equal(await status(id), 'approved');
});

test('cancelling needs a reason', async () => {
  const res = await post(store, '/purchase-orders', order(line(bolt, { quantity: '4' })));
  const id = idOf(res.headers.location);
  await post(store, `/purchase-orders/${id}/cancel`, { reason: '' });
  assert.equal(await status(id), 'draft');
  await post(store, `/purchase-orders/${id}/cancel`, { reason: 'Bought elsewhere' });
  const po = await db('purchase_orders').where({ id }).first();
  assert.equal(po.status, 'cancelled');
  assert.equal(po.cancelled_reason, 'Bought elsewhere');
  assert.equal((await post(store, `/purchase-orders/${id}/approve`)).status, 403);
  assert.equal((await post(manager, `/purchase-orders/${id}/approve`)).status, 409);
  assert.equal((await post(store, `/purchase-orders/${id}/draft`)).status, 409);
  assert.match((await store.get(`/purchase-orders/${id}/print`)).text, /is-draft/);
});

test('orders stay at their site, and are found by number, supplier or item', async () => {
  const po = await db('purchase_orders').where({ supplier_id: supplier.id }).first();
  await siteBOnly.get(`/purchase-orders/${po.id}`).expect(403);
  const link = new RegExp(`/purchase-orders/${po.id}"`);
  assert.doesNotMatch((await siteBOnly.get('/purchase-orders?show=all')).text, link);
  assert.match((await store.get(`/purchase-orders?q=${po.number}`)).text, link);
  assert.match((await store.get('/purchase-orders?q=tononoka')).text, link);
  assert.match((await store.get('/purchase-orders?q=Test Plate')).text, link);
  assert.match((await store.get(`/suppliers/${supplier.id}`)).text, link, 'the supplier’s page lists its orders');
});

test('a switched-off item or supplier can’t go on a new order', async () => {
  const off = await post(store, '/items', { name: 'Test Old item', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  const itemId = idOf(off.headers.location);
  await post(store, `/items/${itemId}/switch-off`);
  let res = await post(store, '/purchase-orders', order(line({ id: itemId, name: 'Test Old item' }, { quantity: '1' })));
  assert.match(res.text, /Line 1: choose an item from the list/);

  await post(store, '/suppliers', { name: 'Test Old supplier' });
  const old = await db('suppliers').where({ name: 'Test Old supplier' }).first();
  await post(store, `/suppliers/${old.id}/switch-off`);
  res = await post(store, '/purchase-orders', { supplier_id: old.id, order_date: localDay(), ...lines(line(bolt, { quantity: '1' })) });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose an active supplier/);
});
