import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let hqStore, bStore, manager, hq, siteB, plate, bolt;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  siteB = await db('sites').where({ code: 'SITEB' }).first();
  hqStore = await loginAs(app, await makeUser(54, ['storekeeper']));
  bStore = await loginAs(app, await makeUser(59, ['storekeeper'], { siteIds: [siteB.id] }));
  manager = await loginAs(app, await makeUser(60, ['manager']));
  await post(hqStore, '/items', { name: 'Test Trf Plate 6 mm', category: 'Plates', priced_by: 'area', thickness_mm: '6' });
  await post(hqStore, '/items', { name: 'Test Trf Bolt', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  [plate, bolt] = await Promise.all(['Test Trf Plate 6 mm', 'Test Trf Bolt'].map((name) => db('items').where({ name }).first()));
  // At HQ: 10 bolts at 50, 3 sheets of 12 × 4 ft at 400 per sq ft.
  await post(hqStore, '/inventory/opening', {
    line_item_id: [bolt.id, plate.id], line_item_name: [bolt.name, plate.name], line_quantity: ['10', '3'],
    line_length: ['', '12'], line_width: ['', '4'], line_size_unit: ['ft', 'ft'], line_price: ['50', '400'],
  });
});

after(async () => {
  const itemIds = await db('items').where('name', 'like', 'Test Trf %').pluck('id');
  const trfIds = await db('stock_transfer_lines').whereIn('item_id', itemIds).distinct().pluck('transfer_id');
  const adjIds = await db('stock_adjustment_lines').whereIn('item_id', itemIds).distinct().pluck('adjustment_id');
  await db('audit_log').where({ entity: 'stock_transfer' }).whereIn('entity_id', trfIds).delete();
  await db('audit_log').where({ entity: 'stock_adjustment' }).whereIn('entity_id', adjIds).delete();
  await db('stock_movements').whereIn('item_id', itemIds).update({ reverses_id: null });
  await db('stock_movements').whereIn('item_id', itemIds).delete();
  await db('stock_transfers').whereIn('id', trfIds).update({ adjustment_id: null });
  await db('stock_adjustments').whereIn('id', adjIds).delete();
  await db('stock_transfers').whereIn('id', trfIds).delete();
  await db('stock_balances').whereIn('item_id', itemIds).delete();
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const balanceRow = (site, itemId, sizeKey = '') => db('stock_balances').where({ site_id: site.id, item_id: itemId, size_key: sizeKey }).first();
const balance = async (site, itemId, sizeKey = '') => Number((await balanceRow(site, itemId, sizeKey))?.quantity ?? 0);
const latest = () => db('stock_transfers').where({ from_site_id: hq.id }).orderBy('id', 'desc').first();
const linesOf = (id) => db('stock_transfer_lines').where({ transfer_id: id }).orderBy('id');

/** Lines picked from HQ's stock: [[itemId, sizeKey, qty], …]. */
async function send(agent, toSite, picks, extra = {}) {
  const rows = await Promise.all(picks.map(async ([itemId, key, qty]) => ({ id: (await balanceRow(hq, itemId, key))?.id ?? '', qty })));
  return post(agent, '/inventory/transfers', {
    to_site_id: toSite.id, carried_by: 'Test Driver', ...extra,
    line_balance_id: rows.map((r) => r.id), line_label: rows.map(() => 'x'), line_quantity: rows.map((r) => String(r.qty)),
  });
}

test('sending takes stock off this site at once; the item’s total and value don’t change', async () => {
  const before = await db('items').where({ id: bolt.id }).first();
  const res = await send(hqStore, siteB, [[bolt.id, '', 4], [plate.id, '12x4ft', 2]]);
  assert.equal(res.status, 302, res.text);
  const t = await latest();
  assert.equal(t.status, 'in_transit');
  assert.equal(t.carried_by, 'Test Driver');
  assert.equal(await balance(hq, bolt.id), 6);
  assert.equal(await balance(hq, plate.id, '12x4ft'), 1);
  const after = await db('items').where({ id: bolt.id }).first();
  assert.equal(Number(after.on_hand_qty), Number(before.on_hand_qty), 'in transit still counts');
  assert.equal(Number(after.stock_value), Number(before.stock_value));
  const out = await db('stock_movements').where({ transfer_id: t.id, item_id: bolt.id }).first();
  assert.equal(out.type, 'transfer_out');
  assert.equal(Number(out.quantity), -4);
});

test('can’t send more than is here, half a plate, or to the same site', async () => {
  let res = await send(hqStore, siteB, [[bolt.id, '', 7]]);
  assert.equal(res.status, 422);
  assert.match(res.text, /only 6 here/);
  res = await send(hqStore, siteB, [[plate.id, '12x4ft', 0.5]]);
  assert.match(res.text, /plates go as whole pieces/);
  res = await send(hqStore, hq, [[bolt.id, '', 1]]);
  assert.match(res.text, /Choose the site it is going to/);
});

test('only the receiving site receives; everything arriving lands in its stock', async () => {
  const t = await db('stock_transfers').where({ from_site_id: hq.id, status: 'in_transit' }).orderBy('id').first();
  const lines = await linesOf(t.id);
  const all = Object.fromEntries(lines.map((l) => [`received_${l.id}`, String(Number(l.quantity))]));
  assert.equal((await post(hqStore, `/inventory/transfers/${t.id}/receive`, all)).status, 403, 'the sender can’t receive it');

  assert.match((await bStore.get('/inventory/transfers')).text, new RegExp(t.number), 'on Site B’s “to receive” list');
  const res = await post(bStore, `/inventory/transfers/${t.id}/receive`, all);
  assert.equal(res.status, 302);
  const done = await db('stock_transfers').where({ id: t.id }).first();
  assert.equal(done.status, 'received');
  assert.equal(done.adjustment_id, null);
  assert.equal(await balance(siteB, bolt.id), 4);
  assert.equal(await balance(siteB, plate.id, '12x4ft'), 2);
});

test('fewer arrived: the shortfall becomes a “lost” adjustment at the receiving site, for approval', async () => {
  await send(hqStore, siteB, [[bolt.id, '', 3]]);
  const t = await latest();
  const [line] = await linesOf(t.id);
  let res = await post(bStore, `/inventory/transfers/${t.id}/receive`, { [`received_${line.id}`]: '4' });
  assert.equal((await db('stock_transfers').where({ id: t.id }).first()).status, 'in_transit', 'more than was sent is refused');

  res = await post(bStore, `/inventory/transfers/${t.id}/receive`, { [`received_${line.id}`]: '2', note: 'One fell off' });
  assert.equal(res.status, 302);
  const done = await db('stock_transfers').where({ id: t.id }).first();
  const adj = await db('stock_adjustments').where({ id: done.adjustment_id }).first();
  assert.equal(adj.reason, 'lost');
  assert.equal(adj.status, 'pending');
  assert.equal(adj.site_id, siteB.id);
  assert.match(adj.note, /One fell off/);
  assert.equal(await balance(siteB, bolt.id), 7, 'all 3 land until the loss is approved');

  const onHand = Number((await db('items').where({ id: bolt.id }).first()).on_hand_qty);
  await post(manager, `/inventory/adjustments/${adj.id}/approve`);
  assert.equal(await balance(siteB, bolt.id), 6);
  assert.equal(Number((await db('items').where({ id: bolt.id }).first()).on_hand_qty), onHand - 1);
});

test('the sender can cancel while it is in transit; the stock goes back', async () => {
  await send(hqStore, siteB, [[bolt.id, '', 1]]);
  const t = await latest();
  assert.equal(await balance(hq, bolt.id), 2);
  assert.equal((await post(bStore, `/inventory/transfers/${t.id}/cancel`, { reason: 'Not ours to cancel' })).status, 403);
  await post(hqStore, `/inventory/transfers/${t.id}/cancel`, { reason: 'Truck didn’t leave' });
  assert.equal((await db('stock_transfers').where({ id: t.id }).first()).status, 'cancelled');
  assert.equal(await balance(hq, bolt.id), 3);
});
