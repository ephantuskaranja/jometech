import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let store, manager, hq, category, plate, bolt, old;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  store = await loginAs(app, await makeUser(50, ['storekeeper']));
  manager = await loginAs(app, await makeUser(53, ['manager']));
  // Counts here only ever list this test category, never the real items in the database.
  await post(store, '/items/categories', { name: 'Test Count Shelf' });
  category = await db('item_categories').where({ name: 'Test Count Shelf' }).first();
  await post(store, '/items', { name: 'Test Cnt Plate 5 mm', category: category.name, priced_by: 'area', thickness_mm: '5' });
  await post(store, '/items', { name: 'Test Cnt Bolt', category: category.name, priced_by: 'unit', unit: 'Pc' });
  await post(store, '/items', { name: 'Test Cnt Old', category: category.name, priced_by: 'unit', unit: 'Pc' });
  [plate, bolt, old] = await Promise.all(['Test Cnt Plate 5 mm', 'Test Cnt Bolt', 'Test Cnt Old'].map((name) => db('items').where({ name }).first()));
  // On the racks: 10 bolts at 50; plates 3 × (12 × 4 ft) and 2 × (8 × 4 ft) at 400 per sq ft; 4 of an item since switched off.
  await post(store, '/inventory/opening', {
    line_item_id: [bolt.id, plate.id, plate.id, old.id], line_item_name: [bolt.name, plate.name, plate.name, old.name],
    line_quantity: ['10', '3', '2', '4'], line_length: ['', '12', '8', ''], line_width: ['', '4', '4', ''], line_size_unit: ['ft', 'ft', 'ft', 'ft'],
    line_price: ['50', '400', '400', '20'],
  });
  await db('items').where({ id: old.id }).update({ is_active: false });
});

after(async () => {
  const itemIds = await db('items').where('name', 'like', 'Test Cnt %').pluck('id');
  const countIds = await db('stock_counts').where({ category_id: category.id }).pluck('id');
  const adjIds = await db('stock_adjustments').whereIn('count_id', countIds).pluck('id');
  await db('audit_log').where({ entity: 'stock_count' }).whereIn('entity_id', countIds).delete();
  await db('audit_log').where({ entity: 'stock_adjustment' }).whereIn('entity_id', adjIds).delete();
  await db('stock_movements').whereIn('item_id', itemIds).update({ reverses_id: null });
  await db('stock_movements').whereIn('item_id', itemIds).delete();
  await db('stock_counts').whereIn('id', countIds).update({ adjustment_id: null });
  await db('stock_adjustments').whereIn('id', adjIds).delete();
  await db('stock_counts').whereIn('id', countIds).delete();
  await db('stock_balances').whereIn('item_id', itemIds).delete();
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  await db('audit_log').where({ entity: 'item_category', entity_id: category.id }).delete();
  await db('item_categories').where({ id: category.id }).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const balance = async (itemId, sizeKey = '') => Number((await db('stock_balances').where({ site_id: hq.id, item_id: itemId, size_key: sizeKey }).first())?.quantity ?? 0);
const latest = () => db('stock_counts').where({ category_id: category.id }).orderBy('id', 'desc').first();
const lineOf = (countId, itemId, sizeKey = '') => db('stock_count_lines').where({ count_id: countId, item_id: itemId, size_key: sizeKey }).first();
const start = () => post(store, '/inventory/counts', { category_id: category.id });

test('a count lists each item, each plate size on the racks, and switched-off items still in stock; one at a time', async () => {
  assert.equal((await start()).status, 302);
  const count = await latest();
  const lines = await db('stock_count_lines').where({ count_id: count.id }).select('item_id', 'size_key');
  assert.deepEqual(lines.map((l) => `${l.item_id}:${l.size_key}`).sort(), [`${bolt.id}:`, `${old.id}:`, `${plate.id}:12x4ft`, `${plate.id}:8x4ft`].sort());

  await start();
  assert.match((await store.get('/inventory/counts')).text, new RegExp(`${count.number} is still being counted here`));
});

test('the sheet is blind: no system figures until the review', async () => {
  const count = await latest();
  const sheet = (await store.get(`/inventory/counts/${count.id}`)).text;
  assert.match(sheet, /Count sheet/);
  assert.doesNotMatch(sheet, /System had|System now/);
  assert.doesNotMatch(sheet, /value="10"/, 'the bolts’ figure isn’t filled in');
});

test('counting: blanks are not counted, plates in whole pieces, found items added', async () => {
  const count = await latest();
  const [b, p12, p8] = await Promise.all([lineOf(count.id, bolt.id), lineOf(count.id, plate.id, '12x4ft'), lineOf(count.id, plate.id, '8x4ft')]);
  let res = await post(store, `/inventory/counts/${count.id}`, { [`counted_${b.id}`]: '9', [`counted_${p12.id}`]: '2.5', [`counted_${p8.id}`]: '' });
  assert.match((await store.get(`/inventory/counts/${count.id}`)).text, /plates are counted in whole pieces/);
  assert.equal(Number((await lineOf(count.id, bolt.id)).counted), 9, 'the rest was saved');

  res = await post(store, `/inventory/counts/${count.id}`, { [`counted_${p12.id}`]: '3' });
  assert.equal(res.status, 302);
  res = await post(store, `/inventory/counts/${count.id}/lines`, { item_id: plate.id, length: '10', width: '4', size_unit: 'ft', counted: '1' });
  assert.equal(res.status, 302);
  const found = await lineOf(count.id, plate.id, '10x4ft');
  assert.equal(found.added, 1);
  assert.equal(Number(found.counted), 1);
  assert.equal((await lineOf(count.id, plate.id, '8x4ft')).counted, null, 'left blank: not counted');
});

test('review shows the differences against stock now; posting sends them for approval', async () => {
  const count = await latest();
  const review = (await store.get(`/inventory/counts/${count.id}/review`)).text;
  assert.match(review, /System now/);
  assert.match(review, /2 lines were left blank/, 'the 8 × 4 plates and the old item');

  const res = await post(store, `/inventory/counts/${count.id}/post`);
  assert.match(res.headers.location, /^\/inventory\/adjustments\/\d+$/);
  const posted = await latest();
  assert.equal(posted.status, 'posted');
  const adj = await db('stock_adjustments').where({ id: posted.adjustment_id }).first();
  assert.equal(adj.reason, 'count');
  assert.equal(adj.status, 'pending');
  const lines = await db('stock_adjustment_lines').where({ adjustment_id: adj.id }).orderBy('id');
  assert.deepEqual(lines.map((l) => [l.item_id, l.size_key, Number(l.quantity)]).sort(), [[bolt.id, '', -1], [plate.id, '10x4ft', 1]].sort());
  assert.equal(Number((await lineOf(count.id, bolt.id)).system_qty), 10, 'what the system had is kept');
  assert.equal(await balance(bolt.id), 10, 'nothing changes until approved');

  await post(manager, `/inventory/adjustments/${adj.id}/approve`);
  assert.equal(await balance(bolt.id), 9);
  assert.equal(await balance(plate.id, '10x4ft'), 1);
  assert.equal(await balance(plate.id, '8x4ft'), 2, 'not counted: left alone');
  assert.match((await store.get(`/inventory/counts/${count.id}`)).text, /System had/);
});

test('a count where everything matches just closes; nothing counted can’t be posted; a count can be cancelled', async () => {
  await start();
  let count = await latest();
  let res = await post(store, `/inventory/counts/${count.id}/post`);
  assert.match((await store.get(`/inventory/counts/${count.id}`)).text, /Nothing has been counted yet/);

  const b = await lineOf(count.id, bolt.id);
  await post(store, `/inventory/counts/${count.id}`, { [`counted_${b.id}`]: '9' });
  res = await post(store, `/inventory/counts/${count.id}/post`);
  count = await latest();
  assert.equal(count.status, 'posted');
  assert.equal(count.adjustment_id, null);
  assert.match((await store.get(`/inventory/counts/${count.id}`)).text, /everything counted matched/);

  await start();
  count = await latest();
  await post(store, `/inventory/counts/${count.id}/cancel`, { note: 'Wrong shelf' });
  assert.equal((await latest()).status, 'cancelled');
});
