import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let store, manager, sales, hq, plate, bolt, rag;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  store = await loginAs(app, await makeUser(44, ['storekeeper']));
  manager = await loginAs(app, await makeUser(48, ['manager']));
  sales = await loginAs(app, await makeUser(49, ['sales']));
  await post(store, '/items', { name: 'Test Adj Plate 3 mm', category: 'Plates', priced_by: 'area', thickness_mm: '3' });
  await post(store, '/items', { name: 'Test Adj Bolt', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  await post(store, '/items', { name: 'Test Adj Rag', category: 'Other', priced_by: 'unit', unit: 'kg' });
  [plate, bolt, rag] = await Promise.all(['Test Adj Plate 3 mm', 'Test Adj Bolt', 'Test Adj Rag'].map(item));
  // On the racks: 10 bolts at 100, 3 sheets of 12 × 4 ft at 300 per sq ft. The rag has no stock and no cost.
  await post(store, '/inventory/opening', {
    line_item_id: [bolt.id, plate.id], line_item_name: [bolt.name, plate.name], line_quantity: ['10', '3'],
    line_length: ['', '12'], line_width: ['', '4'], line_size_unit: ['ft', 'ft'], line_price: ['100', '300'],
  });
});

after(async () => {
  const itemIds = await db('items').where('name', 'like', 'Test Adj %').pluck('id');
  const adjIds = await db('stock_adjustment_lines').whereIn('item_id', itemIds).distinct().pluck('adjustment_id');
  await db('audit_log').where({ entity: 'stock_adjustment' }).whereIn('entity_id', adjIds).delete();
  await db('stock_movements').whereIn('item_id', itemIds).update({ reverses_id: null });
  await db('stock_movements').whereIn('item_id', itemIds).delete();
  await db('stock_adjustments').whereIn('id', adjIds).delete(); // lines go with them
  await db('stock_balances').whereIn('item_id', itemIds).delete();
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const item = (name) => db('items').where({ name }).first();
const balance = async (itemId, sizeKey = '') => Number((await db('stock_balances').where({ site_id: hq.id, item_id: itemId, size_key: sizeKey }).first())?.quantity ?? 0);
const latest = () => db('stock_adjustments').where({ site_id: hq.id }).orderBy('id', 'desc').first();

/** One line: dir 'off' or 'on'. */
const line = (it, quantity, { dir = 'off', length = '', width = '', unit = 'ft', cost = '' } = {}) => ({
  line_dir: dir, line_item_id: it.id, line_item_name: it.name, line_quantity: String(quantity), line_length: String(length), line_width: String(width), line_size_unit: unit, line_cost: String(cost),
});
const record = (reason, ...lines) => post(store, '/inventory/adjustments', {
  reason, note: 'Test', ...Object.fromEntries(['line_dir', 'line_item_id', 'line_item_name', 'line_quantity', 'line_length', 'line_width', 'line_size_unit', 'line_cost'].map((k) => [k, lines.map((l) => l[k])])),
});

test('stores record adjustments; managers approve; sales see nothing', async () => {
  await store.get('/inventory/adjustments/new').expect(200);
  await sales.get('/inventory/adjustments').expect(403);
  assert.equal((await record('damaged', line(bolt, 1))).status, 302);
  const adj = await latest();
  assert.equal((await post(store, `/inventory/adjustments/${adj.id}/approve`)).status, 403, 'stores can’t approve their own');
  assert.equal((await post(sales, `/inventory/adjustments/${adj.id}/approve`)).status, 403);
  await post(store, `/inventory/adjustments/${adj.id}/cancel`, { note: 'Typed by mistake' });
  assert.equal((await latest()).status, 'cancelled');
});

test('nothing changes until approved; then stock comes off at the average cost', async () => {
  await record('damaged', line(bolt, 2));
  const adj = await latest();
  assert.equal(adj.status, 'pending');
  assert.equal(await balance(bolt.id), 10, 'still 10 while it waits');
  assert.match((await manager.get('/inventory')).text, /Adjustments \(1 waiting\)/);

  const res = await post(manager, `/inventory/adjustments/${adj.id}/approve`);
  assert.equal(res.status, 302);
  const after = await item(bolt.name);
  assert.equal(Number(after.on_hand_qty), 8);
  assert.equal(Number(after.stock_value), 800);
  assert.equal(Number(after.avg_cost), 100, 'the average doesn’t move');
  assert.equal(await balance(bolt.id), 8);
  const done = await latest();
  assert.equal(done.status, 'approved');
  assert.equal(Number(done.value), -200);
  const m = await db('stock_movements').where({ adjustment_id: adj.id }).first();
  assert.equal(m.type, 'adjust');
  assert.equal(Number(m.value), -200);
  assert.match((await manager.get(`/items/${bolt.id}`)).text, /adjusted stock/);
});

test('plates come off by sheet size', async () => {
  let res = await record('damaged', line(plate, 1, { length: 10, width: 4 }));
  assert.equal(res.status, 422);
  assert.match(res.text, /only 0 pieces of 10x4ft here/);

  await record('damaged', line(plate, 1, { length: 12, width: 4 }));
  res = await post(manager, `/inventory/adjustments/${(await latest()).id}/approve`);
  assert.equal(await balance(plate.id, '12x4ft'), 2);
  const after = await item(plate.name);
  assert.equal(Number(after.on_hand_qty), 96, '2 sheets of 48 sq ft');
  assert.equal(Number(after.stock_value), 96 * 300);
});

test('can’t take off more than is here; an addition with no average needs a cost', async () => {
  let res = await record('lost', line(bolt, 9));
  assert.equal(res.status, 422);
  assert.match(res.text, /only 8 Pc here/);

  res = await record('found', line(rag, 5, { dir: 'on' }));
  assert.equal(res.status, 422);
  assert.match(res.text, /has no cost yet, so enter the cost/);
  res = await record('found', line(rag, 5, { dir: 'on', cost: '40' }));
  assert.equal(res.status, 302);
  await post(manager, `/inventory/adjustments/${(await latest()).id}/approve`);
  const after = await item(rag.name);
  assert.equal(Number(after.on_hand_qty), 5);
  assert.equal(Number(after.avg_cost), 40);
  assert.equal(await balance(rag.id), 5);
});

test('quantities are checked again on approval; rejecting needs a reason and changes nothing', async () => {
  await record('used', line(bolt, 6));
  const first = await latest();
  await record('lost', line(bolt, 6));
  const second = await latest();
  await post(manager, `/inventory/adjustments/${first.id}/approve`);
  assert.equal(await balance(bolt.id), 2);

  let res = await post(manager, `/inventory/adjustments/${second.id}/approve`);
  assert.equal(res.status, 302);
  assert.match((await manager.get(`/inventory/adjustments/${second.id}`)).text, /only 2 left at this site/);
  assert.equal((await db('stock_adjustments').where({ id: second.id }).first()).status, 'pending');

  res = await post(manager, `/inventory/adjustments/${second.id}/reject`, { note: '' });
  assert.equal((await db('stock_adjustments').where({ id: second.id }).first()).status, 'pending', 'no reason, no reject');
  await post(manager, `/inventory/adjustments/${second.id}/reject`, { note: 'Count them again' });
  const rejected = await db('stock_adjustments').where({ id: second.id }).first();
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decision_note, 'Count them again');
  assert.equal(await balance(bolt.id), 2);
});

test('the reason is required, and “Other” needs a note', async () => {
  let res = await post(store, '/inventory/adjustments', { reason: '', ...line(bolt, 1) });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose why/);
  res = await post(store, '/inventory/adjustments', { reason: 'other', note: '', ...line(bolt, 1) });
  assert.match(res.text, /Say what happened/);
});
