import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let storekeeper, sales;

before(async () => {
  storekeeper = await loginAs(app, await makeUser(23, ['storekeeper']));
  sales = await loginAs(app, await makeUser(30, ['sales']));
});

after(async () => {
  const ids = await db('items').where('name', 'like', 'Test Cat %').pluck('id');
  const catIds = await db('item_categories').where('name', 'like', 'Test %').pluck('id');
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', ids).delete();
  const me = await db('users').where({ phone: '+254700000023' }).first('id');
  await db('audit_log').where({ entity: 'item_category', user_id: me.id }).delete();
  await db('items').whereIn('id', ids).delete();
  await db('item_categories').whereIn('id', catIds).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const category = (name) => db('item_categories').where({ name }).first();
const order = () => db('item_categories').orderBy('sort_order').orderBy('name').pluck('name');

test('only those who manage stock see the categories page', async () => {
  await storekeeper.get('/items/categories').expect(200);
  await sales.get('/items/categories').expect(403);
  assert.equal((await post(sales, '/items/categories', { name: 'Test Nope' })).status, 403);
  assert.match((await storekeeper.get('/items')).text, /href="\/items\/categories"/);
});

test('a new category goes at the end; the same name twice is refused however it is typed', async () => {
  let res = await post(storekeeper, '/items/categories', { name: '  Test   Paint ' });
  assert.equal(res.status, 302, res.text);
  assert.ok(await category('Test Paint'), 'spaces tidied');
  assert.equal((await order()).at(-1), 'Test Paint');

  res = await post(storekeeper, '/items/categories', { name: 'test paint' });
  assert.equal(res.status, 422);
  assert.match(res.text, /“Test Paint” is already a category/);
  assert.match(res.text, /Open that category/);
});

test('reorder: up and down swap with the neighbour', async () => {
  await post(storekeeper, '/items/categories', { name: 'Test Paints' });
  const paints = await category('Test Paints');
  await post(storekeeper, `/items/categories/${paints.id}/move`, { direction: 'up' });
  assert.deepEqual((await order()).slice(-2), ['Test Paints', 'Test Paint']);
  await post(storekeeper, `/items/categories/${paints.id}/move`, { direction: 'down' });
  assert.deepEqual((await order()).slice(-2), ['Test Paint', 'Test Paints']);
});

test('rename: items follow; the item form only takes names on the list', async () => {
  const res = await post(storekeeper, '/items', { name: 'Test Cat Red oxide', category: 'Test Paints', priced_by: 'unit', unit: 'Litre' });
  assert.equal(res.status, 302, res.text);
  const form = (await storekeeper.get('/items/new')).text;
  assert.match(form, /<option value="Test Paints">/, 'the category is a dropdown');

  const paints = await category('Test Paints');
  await post(storekeeper, `/items/categories/${paints.id}`, { name: 'Test Paints & primers' });
  const item = await db('items as i').join('item_categories as c', 'c.id', 'i.category_id').where('i.name', 'Test Cat Red oxide').first('c.name');
  assert.equal(item.name, 'Test Paints & primers');
  assert.match((await storekeeper.get(`/items/categories/${paints.id}`)).text, /Test Paints &amp; primers/);
});

test('a category with items can’t be deleted; merge moves them and removes it', async () => {
  const from = await category('Test Paints & primers');
  const into = await category('Test Paint');
  assert.equal((await post(storekeeper, `/items/categories/${from.id}/delete`)).status, 409);

  let res = await post(storekeeper, `/items/categories/${from.id}/merge`, { into: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the category to move the items into/);

  res = await post(storekeeper, `/items/categories/${from.id}/merge`, { into: into.id });
  assert.equal(res.status, 302, res.text);
  assert.equal(await category('Test Paints & primers'), undefined);
  const item = await db('items').where({ name: 'Test Cat Red oxide' }).first();
  assert.equal(item.category_id, into.id);
  const moved = await db('audit_log').where({ entity: 'item', entity_id: item.id, action: 'update' }).orderBy('id', 'desc').first();
  assert.match(JSON.stringify(moved.changes), /Test Paint/, 'the item’s history shows the move');
  assert.match((await storekeeper.get(`/items/categories/${into.id}`)).text, /moved items in from another category/);
});

test('an empty category can be deleted', async () => {
  await post(storekeeper, '/items/categories', { name: 'Test Empty' });
  const empty = await category('Test Empty');
  const res = await post(storekeeper, `/items/categories/${empty.id}/delete`);
  assert.equal(res.status, 302);
  assert.equal(await category('Test Empty'), undefined);
});
