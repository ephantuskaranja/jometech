import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let store, manager, supervisor, supervisor2, technician, plate4, bolt, supplier;

before(async () => {
  store = await loginAs(app, await makeUser(55, ['storekeeper']));
  manager = await loginAs(app, await makeUser(56, ['manager']));
  supervisor = await loginAs(app, await makeUser(57, ['supervisor']));
  supervisor2 = await loginAs(app, await makeUser(58, ['supervisor']));
  technician = await loginAs(app, await makeUser(59, ['technician']));
  await post(store, '/items', { name: 'Test PR Plate 4 mm', category: 'Plates', priced_by: 'area', thickness_mm: '4' });
  await post(store, '/items', { name: 'Test PR U-bolt', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  plate4 = await db('items').where({ name: 'Test PR Plate 4 mm' }).first();
  bolt = await db('items').where({ name: 'Test PR U-bolt' }).first();
  await post(store, '/suppliers', { name: 'Test PR Supplier' });
  supplier = await db('suppliers').where({ name: 'Test PR Supplier' }).first();
});

after(async () => {
  const userIds = await db('users').where('phone', 'like', '+25470000%').pluck('id');
  const requestIds = await db('purchase_requests').whereIn('requested_by', userIds).pluck('id');
  await db('audit_log').where({ entity: 'purchase_request' }).whereIn('entity_id', requestIds).delete();
  await db('purchase_requests').whereIn('id', requestIds).delete();
  const orderIds = await db('purchase_orders').where({ supplier_id: supplier.id }).pluck('id');
  await db('audit_log').where({ entity: 'purchase_order' }).whereIn('entity_id', orderIds).delete();
  await db('purchase_orders').whereIn('id', orderIds).delete();
  await db('audit_log').where({ entity: 'supplier', entity_id: supplier.id }).delete();
  await db('suppliers').where({ id: supplier.id }).delete();
  const itemIds = [plate4.id, bolt.id];
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const idOf = (location) => Number(location.split('/')[2]);
const line = (item, extra = {}) => ({ item_id: item.id, item_name: item.name, quantity: '', length: '', width: '', size_unit: 'ft', for: '', ...extra });
const lines = (...rows) => Object.fromEntries(['item_id', 'item_name', 'quantity', 'length', 'width', 'size_unit', 'for'].map((k) => [`line_${k}`, rows.map((r) => r[k])]));
const get = (id) => db('purchase_requests').where({ id }).first();

async function ask(agent, ...rows) {
  const res = await post(agent, '/purchase-requests', { needed_by: '', notes: '', ...lines(...rows) });
  assert.equal(res.status, 302, res.text);
  return idOf(res.headers.location);
}

test('who can ask, and who can see requests', async () => {
  await supervisor.get('/purchase-requests').expect(200);
  await supervisor.get('/purchase-requests/new').expect(200);
  await store.get('/purchase-requests/new').expect(200);
  await technician.get('/purchase-requests').expect(403);
  await supervisor.get('/purchase-orders').expect(403); // asking isn't ordering
  const page = await supervisor.get('/').expect(200);
  assert.match(page.text, /href="\/purchase-requests"/, 'the menu has Purchase requests');
  assert.match(page.text, /Ask for materials/, 'a quick button on the dashboard');
});

test('a request needs materials, and a needed-by date that hasn’t passed', async () => {
  let res = await post(supervisor, '/purchase-requests', { needed_by: '', ...lines(line({ id: '', name: '' })) });
  assert.equal(res.status, 422);
  assert.match(res.text, /Add at least one item/);
  res = await post(supervisor, '/purchase-requests', { needed_by: '2020-01-01', ...lines(line(bolt, { quantity: '2' })) });
  assert.equal(res.status, 422);
  assert.match(res.text, /That date has passed/);
  res = await post(supervisor, '/purchase-requests', lines(line(plate4, { quantity: '6' })));
  assert.equal(res.status, 422);
  assert.match(res.text, /length and width/);
});

let first, second;
test('a supervisor asks; it waits for a manager, who approves or declines', async () => {
  first = await ask(supervisor, line(plate4, { quantity: '6', length: '8', width: '4', for: 'Trailer' }), line(bolt, { quantity: '12' }));
  let r = await get(first);
  assert.equal(r.status, 'pending');
  assert.match(r.number, /^PR-\d{4}-\d{4,}$/);
  const saved = await db('purchase_request_lines').where({ request_id: first }).orderBy('sort_order');
  assert.equal(saved.length, 2);
  assert.equal(Number(saved[0].area_sq_ft), 32);
  assert.equal(saved[0].for_text, 'Trailer');

  // No prices on a request.
  const page = await supervisor.get(`/purchase-requests/${first}`).expect(200);
  assert.match(page.text, /Waiting for a manager to approve it/);
  assert.doesNotMatch(page.text, /name="line_price"/);
  assert.doesNotMatch((await supervisor.get('/purchase-requests/new')).text, /name="line_price"/);

  // The manager sees it on the dashboard.
  assert.match((await manager.get('/').expect(200)).text, new RegExp(`${r.number}`));

  assert.equal((await post(supervisor, `/purchase-requests/${first}/approve`)).status, 403);
  assert.equal((await post(manager, `/purchase-requests/${first}/approve`)).status, 302);
  r = await get(first);
  assert.equal(r.status, 'approved');
  assert.ok(r.decided_by);

  // Approved: whoever asked can no longer change it.
  await supervisor.get(`/purchase-requests/${first}/edit`).expect(409);

  second = await ask(supervisor, line(bolt, { quantity: '4' }));
  await post(manager, `/purchase-requests/${second}/decline`, { reason: '' });
  assert.equal((await get(second)).status, 'pending', 'declining needs a reason');
  await post(manager, `/purchase-requests/${second}/decline`, { reason: 'Use the ones in stock' });
  r = await get(second);
  assert.equal(r.status, 'declined');
  assert.equal(r.reason, 'Use the ones in stock');
});

test('only whoever asked, or stores, can change or cancel a request', async () => {
  const id = await ask(supervisor, line(bolt, { quantity: '1' }));
  await supervisor2.get(`/purchase-requests/${id}/edit`).expect(403);
  assert.equal((await post(supervisor2, `/purchase-requests/${id}/cancel`, { reason: 'Not mine' })).status, 403);

  const res = await post(supervisor, `/purchase-requests/${id}`, { needed_by: localDay(), notes: 'Urgent', ...lines(line(bolt, { quantity: '3' })) });
  assert.equal(res.status, 302, res.text);
  assert.equal(Number((await db('purchase_request_lines').where({ request_id: id }).first()).quantity), 3);

  await post(store, `/purchase-requests/${id}/cancel`, { reason: 'Found some in the other store' });
  assert.equal((await get(id)).status, 'cancelled');
});

test('a manager’s own request starts approved', async () => {
  const id = await ask(manager, line(bolt, { quantity: '2' }));
  assert.equal((await get(id)).status, 'approved');
});

test('stores put approved requests on one order; cancelling the order puts them back', async () => {
  const third = await ask(supervisor2, line(bolt, { quantity: '5' }));
  await post(manager, `/purchase-requests/${third}/approve`);

  // A declined request can't be ordered.
  await store.get(`/purchase-orders/new?requests=${second}`).expect(409);

  // Stores see the approved ones to tick.
  const list = await store.get('/purchase-requests').expect(200);
  assert.match(list.text, /Make a purchase order/);
  assert.match(list.text, /x-model="picked"/);

  const form = await store.get(`/purchase-orders/new?requests=${first},${third}`).expect(200);
  assert.match(form.text, /name="request_id" value="\d+"/);
  assert.match(form.text, /From purchase requests/);
  assert.match(form.text, /Test PR Plate 4 mm/);
  assert.match(form.text, /&#34;quantity&#34;:&#34;17&#34;|"quantity":"17"/, 'the same bolts in both requests: one line of 12 + 5');

  const res = await post(store, '/purchase-orders', {
    supplier_id: supplier.id, order_date: localDay(), request_id: [first, third],
    ...lines(line(plate4, { quantity: '6', length: '8', width: '4', for: 'Trailer' }), line(bolt, { quantity: '17' })),
    line_price: ['', ''],
  });
  assert.equal(res.status, 302, res.text);
  const orderId = idOf(res.headers.location);
  for (const id of [first, third]) {
    const r = await get(id);
    assert.equal(r.status, 'ordered');
    assert.equal(r.order_id, orderId);
  }
  const order = await store.get(`/purchase-orders/${orderId}`).expect(200);
  assert.match(order.text, /Asked for in/);
  // The supervisor sees which order it is on.
  assert.match((await supervisor.get(`/purchase-requests/${first}`)).text, /On purchase order/);

  // Ordered once only.
  await store.get(`/purchase-orders/new?requests=${first}`).expect(409);

  await post(store, `/purchase-orders/${orderId}/cancel`, { reason: 'Supplier has none' });
  for (const id of [first, third]) {
    const r = await get(id);
    assert.equal(r.status, 'approved', 'back to be ordered again');
    assert.equal(r.order_id, null);
  }
});
