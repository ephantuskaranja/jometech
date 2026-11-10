import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { sheetSize } from '../src/core/sheet.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let storekeeper, supervisor, sales;

before(async () => {
  storekeeper = await loginAs(app, await makeUser(65, ['storekeeper']));
  supervisor = await loginAs(app, await makeUser(66, ['supervisor']));
  sales = await loginAs(app, await makeUser(67, ['sales']));
});

after(async () => {
  const ids = await db('items').where('name', 'like', 'Test %').pluck('id');
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', ids).delete();
  await db('items').whereIn('id', ids).delete();
  await db('item_categories').where('name', 'like', 'Test %').delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const plate = { name: 'Test Plate 4 mm', category: 'Plates', priced_by: 'area', thickness_mm: '4', current_price: '300' };
const idOf = (location) => Number(location.split('/')[2]);

test('sheet sizes from the Tononoka order, in feet and mm', () => {
  const area = (length, width, unit) => sheetSize({ length, width, unit }).sqFt;
  assert.equal(area(12, 4, 'ft'), 48);
  assert.equal(area(11, 4, 'ft'), 44);
  assert.equal(area(2600, 1220, 'mm').toFixed(2), '34.14');
  assert.equal(area(2590, 1220, 'mm').toFixed(2), '34.01');
  assert.equal(area(2520, 1220, 'mm').toFixed(2), '33.09');
  assert.equal(area(2440, 1220, 'mm').toFixed(2), '32.04');
  assert.equal(sheetSize({ length: 12, width: 4, unit: 'ft', thicknessMm: 4 }).kg.toFixed(0), '140');
});

test('storekeepers manage items; those who don’t buy or issue stock can’t see prices', async () => {
  await storekeeper.get('/items').expect(200);
  await storekeeper.get('/items/new').expect(200);
  await supervisor.get('/items').expect(403);
  await sales.get('/items').expect(403);
  assert.equal((await post(sales, '/items', plate)).status, 403);
  assert.match((await storekeeper.get('/')).text, /href="\/items"/);
});

test('an item needs a name and a category; a plate its thickness; anything else its unit', async () => {
  let res = await post(storekeeper, '/items', { name: '', category: '', priced_by: 'area' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Give the item a name/);
  assert.match(res.text, /Choose a category/);
  assert.match(res.text, /Enter the thickness/);
  res = await post(storekeeper, '/items', { name: 'Test bolt', category: 'Other', priced_by: 'unit', unit: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Say what it is counted in/);
});

test('a plate is priced per sq ft and gets a code; the calculator works for any size', async () => {
  const res = await post(storekeeper, '/items', plate);
  assert.equal(res.status, 302, res.text);
  const item = await db('items').where({ id: idOf(res.headers.location) }).first();
  assert.match(item.code, /^ITM-\d{4,}$/);
  assert.equal(item.unit, 'sq ft');
  assert.equal(Number(item.current_price), 300);
  const page = (await storekeeper.get(`/items/${item.id}`).expect(200)).text;
  assert.match(page, /What does a sheet come to/);
  assert.match(page, /300\.00 per sq ft/);

  // 9 pieces of 12 ft × 4 ft
  let { body } = await storekeeper.get(`/api/items/${item.id}/sheet?length=12&width=4&unit=ft&pieces=9`).expect(200);
  assert.equal(body.total_sq_ft, 432);
  assert.equal(body.cost, 129600);
  assert.equal(Math.round(body.total_kg), 1260);
  // 2 pieces of 2,600 × 1,220 mm, typed with commas
  ({ body } = await storekeeper.get(`/api/items/${item.id}/sheet?length=2,600&width=1,220&unit=mm&pieces=2`).expect(200));
  assert.equal(body.total_sq_ft.toFixed(2), '68.29');
  assert.equal(body.cost, 20485.87);

  await storekeeper.get(`/api/items/${item.id}/sheet?length=0&width=4&unit=ft`).expect(422);
  await storekeeper.get(`/api/items/${item.id}/sheet?length=12&width=4&unit=yards`).expect(422);
});

test('a piece item has a price per unit and no calculator', async () => {
  const typed = await post(storekeeper, '/items', { name: 'Test U-bolt 20 mm', category: 'Test Axle bits', priced_by: 'unit', unit: 'Pc' });
  assert.equal(typed.status, 422, 'a category not on the list is refused (added under Items → Categories)');
  assert.match(typed.text, /Choose a category from the list/);
  assert.equal(await db('item_categories').where({ name: 'Test Axle bits' }).first(), undefined);
  await post(storekeeper, '/items/categories', { name: 'Test Axle bits' });

  const res = await post(storekeeper, '/items', { name: 'Test U-bolt 20 mm', category: 'Test Axle bits', priced_by: 'unit', unit: 'Pc', thickness_mm: '9', current_price: '1,250.50', reorder_level: '20' });
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  const item = await db('items').where({ id }).first();
  assert.equal(item.thickness_mm, null, 'thickness only applies to plates');
  assert.equal(Number(item.current_price), 1250.5);
  assert.doesNotMatch((await storekeeper.get(`/items/${id}`)).text, /What does a sheet come to/);
  await storekeeper.get(`/api/items/${id}/sheet?length=1&width=1&unit=ft`).expect(422);
});

test('the same name twice is refused, however it is spaced', async () => {
  const res = await post(storekeeper, '/items', { ...plate, name: 'test plate 4mm' });
  assert.equal(res.status, 422);
  assert.match(res.text, /already an item/);
  assert.match(res.text, /Open that item/);
});

test('a price change is kept in the history', async () => {
  const item = await db('items').where({ name: 'Test Plate 4 mm' }).first();
  const res = await post(storekeeper, `/items/${item.id}`, { ...plate, current_price: '330' });
  assert.equal(res.status, 302, res.text);
  assert.equal(Number((await db('items').where({ id: item.id }).first()).current_price), 330);
  const page = (await storekeeper.get(`/items/${item.id}`)).text;
  assert.match(page, /Price excl\. VAT/);
  assert.match(page, /300/);
  assert.match(page, /330/);
});

test('items are found by name without worrying about spaces, and by category', async () => {
  const item = await db('items').where({ name: 'Test Plate 4 mm' }).first();
  const link = new RegExp(`/items/${item.id}"`);
  assert.match((await storekeeper.get('/items?q=test plate 4mm')).text, link);
  assert.match((await storekeeper.get(`/items?q=${item.code}`)).text, link);
  assert.match((await storekeeper.get(`/items?category=${item.category_id}`)).text, link);
  assert.doesNotMatch((await storekeeper.get('/items?q=nothing-like-this')).text, link);
});

test('switching off hides an item; it can come back', async () => {
  const item = await db('items').where({ name: 'Test Plate 4 mm' }).first();
  const link = new RegExp(`/items/${item.id}"`);
  await post(storekeeper, `/items/${item.id}/switch-off`);
  assert.doesNotMatch((await storekeeper.get('/items')).text, link);
  assert.match((await storekeeper.get('/items?status=inactive')).text, link);
  await post(storekeeper, `/items/${item.id}/switch-on`);
  assert.match((await storekeeper.get('/items')).text, link);
});
