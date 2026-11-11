import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

// Supplier deliveries at the gate (step 26b): the gate logs the truck in, stores receive only against that.
const app = createApp();
let store, manager, gate, bolt, supplier;

before(async () => {
  store = await loginAs(app, await makeUser(5, ['storekeeper']));
  manager = await loginAs(app, await makeUser(6, ['manager']));
  gate = await loginAs(app, await makeUser(7, ['gate']));
  await post(store, '/items', { name: 'Test Dlv Bolt', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  bolt = await db('items').where({ name: 'Test Dlv Bolt' }).first();
  await post(store, '/suppliers', { name: 'Test Dlv Supplies' });
  supplier = await db('suppliers').where({ name: 'Test Dlv Supplies' }).first();
});

after(async () => {
  const itemIds = await db('items').where('name', 'like', 'Test Dlv %').pluck('id');
  const supplierIds = await db('suppliers').where('name', 'like', 'Test Dlv %').pluck('id');
  const orderIds = await db('purchase_orders').whereIn('supplier_id', supplierIds).pluck('id');
  const receiptIds = await db('goods_receipts').whereIn('order_id', orderIds).pluck('id');
  const arrivalIds = await db('gate_deliveries').whereIn('order_id', orderIds).orWhere('supplier_name', 'like', 'Test Dlv %').pluck('id');
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
const idOf = (location) => Number(location.split('/')[2]);
const latestArrival = () => db('gate_deliveries').orderBy('id', 'desc').first();

async function approvedOrder(qty) {
  const res = await post(store, '/purchase-orders', {
    supplier_id: supplier.id, order_date: localDay(),
    line_item_id: [bolt.id], line_item_name: [bolt.name], line_quantity: [String(qty)], line_length: [''], line_width: [''], line_size_unit: ['ft'], line_for: [''], line_price: [''],
  });
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  await post(manager, `/purchase-orders/${id}/approve`);
  return id;
}
async function receive(orderId, deliveryId, qty, extra = {}) {
  const [line] = await db('purchase_order_lines').where({ order_id: orderId });
  return post(store, `/purchase-orders/${orderId}/receive`, {
    delivery_id: String(deliveryId), received_on: localDay(), line_id: [line.id], line_quantity: [String(qty)], line_price: ['40'], line_rejected: [''], ...extra,
  });
}

test('the gate logs a truck in against the open order; stores receive it, once', async () => {
  const id = await approvedOrder(10);
  const order = await db('purchase_orders').where({ id }).first();
  const page = (await gate.get('/gate/goods')).text;
  assert.match(page, new RegExp(order.number), 'the open order is on the gate’s list');
  assert.doesNotMatch(page, /&#34;unit_price&#34;|40\.00/, 'no prices at the gate');
  assert.match((await manager.get(`/purchase-orders/${id}`)).text, /once the gate logs the delivery in/);

  const res = await post(gate, '/gate/deliveries', { order_id: String(id), delivery_note: 'DN 5501', vehicle_reg: 'kcb 123a', driver_name: 'Test Driver Otieno' });
  assert.equal(res.status, 302, res.text);
  const d = await latestArrival();
  assert.equal(d.order_id, id);
  assert.equal(d.status, 'waiting');
  assert.equal(d.vehicle_reg, 'KCB 123A');
  assert.match((await gate.get('/gate/goods')).text, /Deliveries logged today \(\d+\)[\s\S]*Test Dlv Supplies/);

  assert.match((await store.get('/goods-received')).text, new RegExp(d.number), 'waiting for stores');
  assert.match((await store.get(`/purchase-orders/${id}`)).text, new RegExp(`/receive\\?delivery=${d.id}`));
  const form = await store.get(`/purchase-orders/${id}/receive`);
  assert.equal(form.status, 200);
  assert.match(form.text, /DN 5501/, 'the delivery note carries over');

  const done = await receive(id, d.id, 6);
  assert.equal(done.status, 302, done.text);
  const grn = await db('goods_receipts').where({ order_id: id }).first();
  assert.equal(grn.delivery_note, 'DN 5501');
  const after = await db('gate_deliveries').where({ id: d.id }).first();
  assert.equal(after.status, 'received');
  assert.equal(after.receipt_id, grn.id);
  assert.match((await store.get(`/goods-received/${grn.id}`)).text, new RegExp(`${d.number}[\\s\\S]*Test Driver Otieno`));

  // The same arrival can't make a second GRN; the rest needs its own arrival.
  assert.equal((await store.get(`/purchase-orders/${id}/receive`)).status, 409);
  const again = await receive(id, d.id, 4);
  assert.equal(again.status, 409);
  assert.equal(await db('goods_receipts').where({ order_id: id }).count('* as n').first().then((r) => Number(r.n)), 1);
});

test('the gate must say which order (or no order), and who drove it', async () => {
  let res = await post(gate, '/gate/deliveries', { driver_name: 'Test Driver' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Choose the order on the delivery note/);
  res = await post(gate, '/gate/deliveries', { order_id: 'none', driver_name: 'Test Driver' });
  assert.match(res.text, /Type who it is from/);
  const draft = await post(store, '/purchase-orders', {
    supplier_id: supplier.id, order_date: localDay(), line_item_id: [bolt.id], line_item_name: [bolt.name], line_quantity: ['1'], line_length: [''], line_width: [''], line_size_unit: ['ft'], line_for: [''], line_price: [''],
  });
  res = await post(gate, '/gate/deliveries', { order_id: String(idOf(draft.headers.location)), driver_name: 'Test Driver' });
  assert.equal(res.status, 422);
  assert.match(res.text, /isn’t open at this site/, 'an order not yet approved can’t be delivered against');
  res = await post(gate, '/gate/deliveries', { order_id: 'none', supplier_name: 'Test Dlv Walk-in', driver_name: '' });
  assert.match(res.text, /Type the driver’s name/);
});

test('no order: stores match it to an open order, then receive it', async () => {
  const id = await approvedOrder(3);
  await post(gate, '/gate/deliveries', { order_id: 'none', supplier_name: 'Test Dlv Unknown Truck', driver_name: 'Test Driver' });
  const d = await latestArrival();
  assert.equal(d.order_id, null);
  assert.match((await store.get('/goods-received')).text, /Match to an order/);
  const res = await post(store, `/deliveries/${d.id}/link`, { order_id: String(id) });
  assert.equal(res.headers.location, `/purchase-orders/${id}/receive?delivery=${d.id}`);
  assert.equal((await db('gate_deliveries').where({ id: d.id }).first()).order_id, id);
  assert.equal((await receive(id, d.id, 3)).status, 302);
  assert.equal((await db('purchase_orders').where({ id }).first()).status, 'received');
});

test('stores can close an arrival they aren’t receiving; it can’t be received after', async () => {
  const id = await approvedOrder(2);
  await post(gate, '/gate/deliveries', { order_id: String(id), driver_name: 'Test Driver' });
  const d = await latestArrival();
  await post(store, `/deliveries/${d.id}/close`, { reason: '' });
  assert.equal((await db('gate_deliveries').where({ id: d.id }).first()).status, 'waiting', 'it needs a reason');
  await post(store, `/deliveries/${d.id}/close`, { reason: 'Wrong size, sent back' });
  const closed = await db('gate_deliveries').where({ id: d.id }).first();
  assert.equal(closed.status, 'closed');
  assert.equal(closed.close_reason, 'Wrong size, sent back');
  assert.equal((await store.get(`/purchase-orders/${id}/receive`)).status, 409);
});

test('only the gate logs deliveries in; the gate can’t receive into stock', async () => {
  assert.equal((await post(store, '/gate/deliveries', { order_id: 'none', supplier_name: 'Test Dlv X', driver_name: 'Test Driver' })).status, 403);
  const id = await approvedOrder(1);
  await gate.get(`/purchase-orders/${id}/receive`).expect(403);
  assert.equal((await post(gate, `/deliveries/1/close`, { reason: 'Not mine to close' })).status, 403);
});
