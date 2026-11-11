import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { shareTransport } from '../src/modules/stock/service.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let store, manager, supervisor, gate, plate, bolt, supplier;

before(async () => {
  store = await loginAs(app, await makeUser(45, ['storekeeper']));
  manager = await loginAs(app, await makeUser(46, ['manager']));
  supervisor = await loginAs(app, await makeUser(47, ['supervisor']));
  gate = await loginAs(app, await makeUser(4, ['gate']));
  await post(store, '/items', { name: 'Test Plate 4 mm', category: 'Plates', priced_by: 'area', thickness_mm: '4', reorder_level: '100' });
  await post(store, '/items', { name: 'Test U-bolt', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  plate = await item('Test Plate 4 mm');
  bolt = await item('Test U-bolt');
  await post(store, '/suppliers', { name: 'Test Mills' });
  supplier = await db('suppliers').where({ name: 'Test Mills' }).first();
});

after(async () => {
  const itemIds = await db('items').where('name', 'like', 'Test %').pluck('id');
  const supplierIds = await db('suppliers').where('name', 'like', 'Test %').pluck('id');
  const orderIds = await db('purchase_orders').whereIn('supplier_id', supplierIds).pluck('id');
  const receiptIds = await db('goods_receipts').whereIn('order_id', orderIds).pluck('id');
  const arrivalIds = await db('gate_deliveries').whereIn('order_id', orderIds).pluck('id');
  await db('audit_log').where({ entity: 'gate_delivery' }).whereIn('entity_id', arrivalIds).delete();
  await db('gate_deliveries').whereIn('id', arrivalIds).delete();
  await db('stock_movements').whereIn('item_id', itemIds).delete();
  await db('stock_balances').whereIn('item_id', itemIds).delete();
  await db('audit_log').where({ entity: 'goods_receipt' }).whereIn('entity_id', receiptIds).delete();
  await db('goods_receipts').whereIn('id', receiptIds).delete();
  await db('audit_log').where({ entity: 'purchase_order' }).whereIn('entity_id', orderIds).delete();
  await db('purchase_orders').whereIn('id', orderIds).delete();
  await db('audit_log').where({ entity: 'supplier' }).whereIn('entity_id', supplierIds).delete();
  await db('suppliers').whereIn('id', supplierIds).delete();
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const item = (name) => db('items').where({ name }).first();
const idOf = (location) => Number(location.split('/')[2]);
const orderStatus = async (id) => (await db('purchase_orders').where({ id }).first()).status;
const num = (v) => Number(v);

/** An approved order; each line is [item, quantity, length?, width?, unit?]. */
async function approvedOrder(...rows) {
  const res = await post(store, '/purchase-orders', {
    supplier_id: supplier.id, order_date: localDay(),
    line_item_id: rows.map(([i]) => i.id), line_item_name: rows.map(([i]) => i.name), line_quantity: rows.map((r) => String(r[1])),
    line_length: rows.map((r) => String(r[2] ?? '')), line_width: rows.map((r) => String(r[3] ?? '')), line_size_unit: rows.map((r) => r[4] ?? 'ft'),
    line_for: rows.map(() => ''), line_price: rows.map(() => ''),
  });
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  await post(manager, `/purchase-orders/${id}/approve`);
  return id;
}
const orderLines = (orderId) => db('purchase_order_lines').where({ order_id: orderId }).orderBy('sort_order');

/** The gate logs the supplier's truck in against the order. */
const arrive = (orderId) => post(gate, '/gate/deliveries', { order_id: String(orderId), driver_name: 'Test Driver', delivery_note: 'DN-T1' });
const waitingArrival = (orderId) => db('gate_deliveries').where({ order_id: orderId, status: 'waiting' }).first();

/** lines: [[quantity, price, rejected?], …], in the order's line order. Logs it in at the gate first if needed. */
async function receive(orderId, lines, extra = {}) {
  const ids = (await orderLines(orderId)).map((l) => l.id);
  if (!(await waitingArrival(orderId))) await arrive(orderId);
  return post(store, `/purchase-orders/${orderId}/receive`, {
    delivery_id: (await waitingArrival(orderId)).id, received_on: localDay(), line_id: ids,
    line_quantity: lines.map((l) => String(l[0])), line_price: lines.map((l) => String(l[1] ?? '')), line_rejected: lines.map((l) => String(l[2] ?? '')),
    ...extra,
  });
}

test('transport is shared by value, and the shares add up exactly', () => {
  assert.deepEqual(shareTransport([2000, 4800], 680), [200, 480]);
  assert.deepEqual(shareTransport([100, 100, 100], 100), [33.33, 33.33, 33.34].map((v, i) => [33.34, 33.33, 33.33][i]));
  assert.equal(shareTransport([100, 100, 100], 100).reduce((a, b) => a + b, 0).toFixed(2), '100.00');
  assert.deepEqual(shareTransport([100, 0], 50), [50, 0]);
  assert.deepEqual(shareTransport([100], 0), [0]);
});

test('only an approved order can receive goods; those who can’t buy can’t receive', async () => {
  const res = await post(store, '/purchase-orders', {
    supplier_id: supplier.id, order_date: localDay(), line_item_id: [bolt.id], line_item_name: [bolt.name], line_quantity: ['1'], line_length: [''], line_width: [''], line_size_unit: ['ft'], line_for: [''], line_price: [''],
  });
  const id = idOf(res.headers.location);
  await store.get(`/purchase-orders/${id}/receive`).expect(409);
  await supervisor.get(`/purchase-orders/${id}/receive`).expect(403);
  await supervisor.get('/inventory').expect(403);
  await supervisor.get('/goods-received').expect(403);
  await store.get('/inventory').expect(200);
  await store.get('/goods-received').expect(200);
});

test('a price is needed for what arrived, and you can’t receive more than is left', async () => {
  const id = await approvedOrder([plate, 9, 12, 4, 'ft']);
  let res = await receive(id, [[9, '']]);
  assert.equal(res.status, 422);
  assert.match(res.text, /enter the price from the receipt/);
  res = await receive(id, [[0, '']]);
  assert.match(res.text, /Enter what arrived/);
  res = await receive(id, [[1.5, '300']]);
  assert.match(res.text, /whole pieces/);
  res = await receive(id, [[10, '300']]);
  assert.equal(res.status, 422);
  assert.match(res.text, /Only 9 left/);
  assert.equal(num((await item(plate.name)).on_hand_qty), 0, 'nothing went into stock');
  assert.equal(await orderStatus(id), 'approved');
  await db('purchase_orders').where({ id }).update({ status: 'cancelled' });
});

test('a plate goes in by sq ft and by sheet; the average follows each delivery; part deliveries are tracked', async () => {
  const id = await approvedOrder([plate, 9, 12, 4, 'ft']);
  const notYet = await store.get(`/purchase-orders/${id}/receive`);
  assert.equal(notYet.status, 409, 'nothing is received until the gate logs it in');
  assert.match(notYet.text, /logged in at the gate yet/);
  await arrive(id);
  // What's left is filled in, ready for "it all came".
  assert.match((await store.get(`/purchase-orders/${id}/receive`)).text, /&#34;quantity&#34;:&#34;9&#34;/);

  // 5 of 9 sheets at 300 per sq ft: 240 sq ft, KES 72,000
  let res = await receive(id, [[5, '300']], { invoice_ref: 'ETIMS-1' });
  assert.equal(res.status, 302, res.text);
  let p = await item(plate.name);
  assert.equal(num(p.on_hand_qty), 240);
  assert.equal(num(p.stock_value), 72000);
  assert.equal(num(p.avg_cost), 300);
  assert.equal(num(p.current_price), 300);
  assert.equal(await orderStatus(id), 'partly_received');
  const [balance] = await db('stock_balances').where({ item_id: plate.id });
  assert.equal(num(balance.quantity), 5);
  assert.equal(balance.size_key, '12x4ft');

  await store.get(`/purchase-orders/${id}/draft`).expect(404);
  assert.equal((await post(store, `/purchase-orders/${id}/draft`)).status, 409, 'goods have arrived: it can’t go back to draft');
  assert.equal((await post(store, `/purchase-orders/${id}/cancel`, { reason: 'No longer needed' })).status, 409, 'or be cancelled');

  // Only 4 left, and the price went up to 330: (72,000 + 63,360) ÷ 432 = 313.3333
  res = await receive(id, [[5, '330']]);
  assert.match(res.text, /Only 4 left/);
  res = await receive(id, [[4, '330']]);
  assert.equal(res.status, 302, res.text);
  p = await item(plate.name);
  assert.equal(num(p.on_hand_qty), 432);
  assert.equal(num(p.stock_value), 135360);
  assert.equal(num(p.avg_cost), 313.3333);
  assert.equal(num(p.current_price), 330, 'the price last paid, for quoting');
  assert.equal(await orderStatus(id), 'received');
  await store.get(`/purchase-orders/${id}/receive`).expect(409);

  const grn = (await store.get(res.headers.location)).text;
  assert.match(grn, /was 300\.00 \(\+10%\)/, 'the price rise shows');
  assert.match((await store.get(res.headers.location)).text, /GRN-/);
  const itemPage = (await store.get(`/items/${plate.id}`)).text;
  assert.match(itemPage, /313\.33/);
  assert.match(itemPage, /GRN-/, 'its movements are listed');
  assert.match(itemPage, /price updated from goods received/);

  const inv = (await store.get('/inventory')).text;
  assert.match(inv, /Test Plate 4 mm/);
  assert.match(inv, /9 × 12 × 4 ft/, 'sheets by size');
  assert.match(inv, /135,360\.00/);
  assert.equal((await db('stock_movements').where({ item_id: plate.id })).length, 2);
});

test('transport goes into the cost by value; rejected goods stay out of stock', async () => {
  const before = await item(bolt.name);
  const id = await approvedOrder([bolt, 25], [plate, 1, 12, 4, 'ft']);
  // Bolts: 20 accepted at 100 = 2,000. Plate: 48 sq ft at 100 = 4,800. Transport 680: shared 200 and 480.
  const res = await receive(id, [[20, '100', 5], [1, '100']], { transport_cost: '680' });
  assert.equal(res.status, 302, res.text);
  const receipt = await db('goods_receipts').where({ id: idOf(res.headers.location) }).first();
  assert.equal(num(receipt.goods_total), 6800);
  assert.equal(num(receipt.transport_cost), 680);
  const lines = await db('goods_receipt_lines').where({ receipt_id: receipt.id }).orderBy('item_id');
  const byItem = Object.fromEntries(lines.map((l) => [l.item_id, l]));
  assert.equal(num(byItem[bolt.id].transport_share), 200);
  assert.equal(num(byItem[plate.id].transport_share), 480);
  assert.equal(num(byItem[bolt.id].rejected_qty), 5);

  const b = await item(bolt.name);
  assert.equal(num(b.on_hand_qty), num(before.on_hand_qty) + 20, 'the 5 rejected aren’t in stock');
  assert.equal(num(b.avg_cost), 110, '2,200 ÷ 20');
  assert.equal(num(b.current_price), 100, 'the price paid, without transport');
  assert.equal(await orderStatus(id), 'partly_received', '5 bolts are still to come');
  assert.match((await store.get(`/goods-received/${receipt.id}`)).text, /5 rejected or damaged/);
});

test('a partly received order can be closed when nothing more is coming', async () => {
  const po = await db('purchase_orders').where({ supplier_id: supplier.id, status: 'partly_received' }).first();
  await post(store, `/purchase-orders/${po.id}/close`, { reason: '' });
  assert.equal(await orderStatus(po.id), 'partly_received', 'it needs a reason');
  await post(store, `/purchase-orders/${po.id}/close`, { reason: 'Supplier out of stock' });
  assert.equal(await orderStatus(po.id), 'received');
  assert.match((await store.get(`/purchase-orders/${po.id}`)).text, /Supplier out of stock/);
});

test('a wrong delivery is reversed: stock, average, price and order all go back', async () => {
  const before = await item(plate.name);
  const id = await approvedOrder([plate, 2, 12, 4, 'ft']);
  const res = await receive(id, [[2, '500']], { transport_cost: '0' });
  assert.equal(res.status, 302, res.text);
  const receiptId = idOf(res.headers.location);
  assert.notEqual(num((await item(plate.name)).avg_cost), num(before.avg_cost));

  await post(store, `/goods-received/${receiptId}/reverse`, { reason: '' });
  assert.equal((await db('goods_receipts').where({ id: receiptId }).first()).reversed_at, null, 'it needs a reason');
  await post(store, `/goods-received/${receiptId}/reverse`, { reason: 'Wrong price typed' });
  assert.equal((await waitingArrival(id))?.receipt_id, null, 'its gate arrival waits to be received again');
  const after = await item(plate.name);
  assert.equal(num(after.on_hand_qty), num(before.on_hand_qty));
  assert.equal(num(after.stock_value), num(before.stock_value));
  assert.equal(num(after.current_price), num(before.current_price));
  assert.equal(await orderStatus(id), 'sent', 'waiting for those goods again');
  assert.equal(num((await orderLines(id))[0].received_qty), 0);
  assert.match((await store.get(`/goods-received/${receiptId}`)).text, /Wrong price typed/);
  assert.equal((await post(store, `/goods-received/${receiptId}/reverse`, { reason: 'Again please' })).status, 409);

  // The ledger keeps both.
  const moves = await db('stock_movements').where({ receipt_id: receiptId }).orderBy('id');
  assert.deepEqual(moves.map((m) => m.type), ['receive', 'reverse']);
  assert.equal(num(moves[1].stock_qty), -96);

  // A delivery stays on record, so the order can't be rewritten after it, even once reversed.
  const redraft = await post(store, `/purchase-orders/${id}/draft`);
  assert.equal(redraft.status, 409);
  assert.match(redraft.text, /has had a delivery recorded/);
  assert.doesNotMatch((await store.get(`/purchase-orders/${id}`)).text, /back to draft/);

  // Received again correctly.
  assert.equal((await receive(id, [[2, '330']])).status, 302);
  assert.equal(await orderStatus(id), 'received');
});

test('a delivery can’t be reversed once its stock has left', async () => {
  const id = await approvedOrder([bolt, 1000]);
  const res = await receive(id, [[1000, '50']]);
  const receiptId = idOf(res.headers.location);
  const balance = await db('stock_balances').where({ item_id: bolt.id }).first();
  await db('stock_balances').where({ id: balance.id }).update({ quantity: 10 });
  const out = await post(store, `/goods-received/${receiptId}/reverse`, { reason: 'Wrong price typed' });
  assert.equal(out.status, 409);
  assert.match(out.text, /already left the store/);
  assert.equal((await db('goods_receipts').where({ id: receiptId }).first()).reversed_at, null);
  await db('stock_balances').where({ id: balance.id }).update({ quantity: balance.quantity });
});

test('low stock shows once it falls to the reorder level', async () => {
  const [before] = [await item(plate.name)];
  await db('items').where({ id: plate.id }).update({ reorder_level: num(before.on_hand_qty) });
  const low = (await store.get('/inventory?show=low')).text;
  assert.match(low, /Test Plate 4 mm/);
  assert.match(low, /Low stock/);
  assert.match((await store.get('/items')).text, /Low stock/);
  await db('items').where({ id: plate.id }).update({ reorder_level: 1 });
  assert.doesNotMatch((await store.get('/inventory?show=low')).text, /Test Plate 4 mm/);
});

test('once an item has stock history, how it is priced can’t change', async () => {
  const res = await post(store, `/items/${plate.id}`, { name: plate.name, category: 'Plates', priced_by: 'unit', unit: 'Pc' });
  assert.equal(res.status, 422);
  assert.match(res.text, /stock history/);
  const same = await post(store, `/items/${plate.id}`, { name: 'Test Plate 4 mm', category: 'Plates', priced_by: 'area', thickness_mm: '4', notes: 'Still editable' });
  assert.equal(same.status, 302, same.text);
});

test('an item’s stock figures can’t be typed over from its form', async () => {
  const before = await item(plate.name);
  await post(store, `/items/${plate.id}`, { name: 'Test Plate 4 mm', category: 'Plates', priced_by: 'area', thickness_mm: '4', on_hand_qty: '99999', avg_cost: '1', stock_value: '1' });
  const after = await item(plate.name);
  assert.equal(num(after.on_hand_qty), num(before.on_hand_qty));
  assert.equal(num(after.avg_cost), num(before.avg_cost));
});
