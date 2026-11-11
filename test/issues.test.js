import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { localDay } from '../src/core/dates.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let store, technician, manager, siteBStore, plate, bolt, job, hq;

before(async () => {
  hq = await db('sites').where({ code: 'HQ' }).first();
  const siteB = await db('sites').where({ code: 'SITEB' }).first();
  store = await loginAs(app, await makeUser(35, ['storekeeper']));
  technician = await loginAs(app, await makeUser(36, ['technician']));
  manager = await loginAs(app, await makeUser(37, ['manager']));
  siteBStore = await loginAs(app, await makeUser(38, ['storekeeper'], { siteIds: [siteB.id] }));
  await post(store, '/items', { name: 'Test Plate 4 mm', category: 'Plates', priced_by: 'area', thickness_mm: '4' });
  await post(store, '/items', { name: 'Test U-bolt', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  plate = await item('Test Plate 4 mm');
  bolt = await item('Test U-bolt');
  const [customerId] = await db('customers').insert({ number: 'CUS-T835', name: 'Test Haulier', phone: '+254700000835', category: 'individual' });
  const [jobId] = await db('jobs').insert({ number: 'JOB-2026-8835', site_id: hq.id, customer_id: customerId, status: 'in_progress' });
  job = await db('jobs').where({ id: jobId }).first();
});

after(async () => {
  const itemIds = await db('items').where('name', 'like', 'Test %').pluck('id');
  const issueIds = await db('material_issues').where({ job_id: job.id }).pluck('id');
  await db('audit_log').where({ entity: 'material_issue' }).whereIn('entity_id', issueIds).delete();
  await db('stock_movements').whereIn('item_id', itemIds).update({ reverses_id: null });
  await db('stock_movements').whereIn('item_id', itemIds).delete();
  await db('stock_balances').whereIn('item_id', itemIds).delete();
  await db('material_issues').whereIn('id', issueIds).delete();
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}
const item = (name) => db('items').where({ name }).first();
const num = Number;
const idOf = (location) => Number(location.split('/').pop());
const opening = (rows) => post(store, '/inventory/opening', {
  line_item_id: rows.map(([i]) => i.id), line_item_name: rows.map(([i]) => i.name), line_quantity: rows.map((r) => String(r[1])), line_price: rows.map((r) => String(r[2])),
  line_length: rows.map((r) => String(r[3] ?? '')), line_width: rows.map((r) => String(r[4] ?? '')), line_size_unit: rows.map((r) => r[5] ?? 'ft'),
});
const balanceOf = (i, key = '') => db('stock_balances').where({ item_id: i.id, site_id: hq.id, size_key: key }).first();
/** rows: [[balance, quantity], …] */
const issue = (rows, agent = store, jobId = job.id) => post(agent, `/jobs/${jobId}/issue`, {
  issued_on: localDay(), received_by: 'Kamau', line_balance_id: rows.map(([b]) => b.id), line_label: rows.map(() => 'chosen'), line_quantity: rows.map((r) => String(r[1])),
});

test('opening stock: only those who manage inventory; it needs a cost, and a plate its size', async () => {
  assert.equal((await post(technician, '/inventory/opening', {})).status, 403);
  assert.equal((await post(manager, '/inventory/opening', { line_item_id: [plate.id], line_item_name: [plate.name], line_quantity: ['1'], line_price: ['1'], line_length: ['8'], line_width: ['4'], line_size_unit: ['ft'] })).status, 302);
  await db('stock_movements').where({ item_id: plate.id }).delete();
  await db('stock_balances').where({ item_id: plate.id }).delete();
  await db('items').where({ id: plate.id }).update({ on_hand_qty: 0, stock_value: 0, avg_cost: null, current_price: null });

  await store.get('/inventory/opening').expect(200);
  let res = await opening([[plate, 10, '', 12, 4]]);
  assert.equal(res.status, 422);
  assert.match(res.text, /enter the cost/);
  res = await opening([[plate, 10, 300]]);
  assert.match(res.text, /enter the plate/);
  res = await opening([[plate, 1.5, 300, 12, 4]]);
  assert.match(res.text, /whole pieces/);
});

test('opening stock goes in with its cost, and sets the price if there was none', async () => {
  const res = await opening([[plate, 10, 300, 12, 4], [bolt, 50, 100]]);
  assert.equal(res.status, 302, res.text);
  const p = await item(plate.name);
  assert.equal(num(p.on_hand_qty), 480);
  assert.equal(num(p.stock_value), 144000);
  assert.equal(num(p.avg_cost), 300);
  assert.equal(num(p.current_price), 300);
  assert.equal(num((await balanceOf(plate, '12x4ft')).quantity), 10);
  assert.equal(num((await item(bolt.name)).avg_cost), 100);
  assert.match((await store.get('/inventory')).text, /10 × 12 × 4 ft/);
  assert.match((await store.get(`/items/${plate.id}`)).text, /Opening stock/);
});

test('undoing an opening entry takes it out, but not once it has been used', async () => {
  let res = await opening([[plate, 2, 900, 8, 4]]);
  assert.equal(res.status, 302, res.text);
  const entry = await db('stock_movements').where({ item_id: plate.id, type: 'opening', size_key: '8x4ft' }).first();
  assert.notEqual(num((await item(plate.name)).avg_cost), 300);
  res = await post(store, `/inventory/opening/${entry.id}/undo`);
  assert.equal(res.status, 302, res.text);
  const p = await item(plate.name);
  assert.equal(num(p.on_hand_qty), 480);
  assert.equal(num(p.avg_cost), 300, 'the average goes back');
  assert.equal(num((await balanceOf(plate, '8x4ft')).quantity), 0);
  assert.equal((await post(store, `/inventory/opening/${entry.id}/undo`)).status, 409, 'only once');
  assert.match((await store.get('/inventory/opening')).text, /Undone/);
});

test('issuing: whole sheets, only what is in stock, and only to an active job', async () => {
  const b = await balanceOf(plate, '12x4ft');
  assert.equal((await issue([[b, 1]], technician)).status, 403);
  let res = await issue([[b, 1.5]]);
  assert.equal(res.status, 422);
  assert.match(res.text, /whole sheets/);
  res = await issue([[b, 11]]);
  assert.match(res.text, /only 10 in stock/);
  res = await post(store, `/jobs/${job.id}/issue`, { issued_on: localDay(), line_balance_id: [''], line_label: ['Nonsense'], line_quantity: ['1'] });
  assert.match(res.text, /choose an item from what is in stock/);
  assert.match(res.text, /Nonsense/, 'what was typed stays');
  assert.equal(num((await balanceOf(plate, '12x4ft')).quantity), 10, 'nothing left the store');

  // Another site's stock can't be issued from here.
  res = await issue([[b, 1]], siteBStore);
  assert.equal(res.status, 403, 'the job is at HQ');

  await db('jobs').where({ id: job.id }).update({ status: 'completed' });
  assert.equal((await issue([[b, 1]])).status, 409);
  await store.get(`/jobs/${job.id}/issue`).expect(409);
  await db('jobs').where({ id: job.id }).update({ status: 'in_progress' });
});

test('an issue charges the job the average that day, and the job keeps that cost', async () => {
  const b = await balanceOf(plate, '12x4ft');
  let res = await issue([[b, 2]]);
  assert.equal(res.status, 302, res.text);
  const first = idOf(res.headers.location);
  const [line] = await db('material_issue_lines').where({ issue_id: first });
  assert.equal(num(line.unit_cost), 300);
  assert.equal(num(line.value), 28800, '2 × 48 sq ft × 300');
  let p = await item(plate.name);
  assert.equal(num(p.on_hand_qty), 384);
  assert.equal(num(p.stock_value), 115200);
  assert.equal(num(p.avg_cost), 300, 'issuing doesn’t change the average');
  assert.equal(num((await balanceOf(plate, '12x4ft')).quantity), 8);

  // More stock at a higher cost moves the average; the earlier issue stays as it was.
  res = await opening([[plate, 2, 360, 12, 4]]);
  assert.equal(res.status, 302, res.text);
  p = await item(plate.name);
  assert.equal(num(p.avg_cost), 312, '(115,200 + 34,560) ÷ 480');
  assert.equal(num((await db('material_issue_lines').where({ issue_id: first }).first()).value), 28800);

  res = await issue([[await balanceOf(plate, '12x4ft'), 1]]);
  const second = await db('material_issue_lines').where({ issue_id: idOf(res.headers.location) }).first();
  assert.equal(num(second.value), 14976, '48 × 312');
});

test('the job shows its materials; the cost is only for those who run the stores', async () => {
  const forStore = (await store.get(`/jobs/${job.id}`).expect(200)).text;
  assert.match(forStore, /Test Plate 4 mm/);
  assert.match(forStore, /43,776\.00/, '28,800 + 14,976');
  assert.match(forStore, /Issue materials/);
  const forTech = (await technician.get(`/jobs/${job.id}`).expect(200)).text;
  assert.match(forTech, /Test Plate 4 mm/, 'technicians see what was issued');
  assert.doesNotMatch(forTech, /43,776/, 'but not what it cost');
  for (const amount of [/28,800/, /14,976/, /KES/]) assert.doesNotMatch(forTech, amount, 'not in the job’s history either');
  assert.doesNotMatch(forTech, /\/jobs\/\d+\/issue/);
  assert.match((await manager.get(`/jobs/${job.id}`)).text, /43,776\.00/);
  assert.match((await store.get('/stores/issue')).text, /JOB-2026-8835/);
  await technician.get('/stores/issue').expect(403);
});

test('returns go back at the cost they left at, and come off the job', async () => {
  const issueRow = await db('material_issues').where({ job_id: job.id }).orderBy('id').first();
  const [line] = await db('material_issue_lines').where({ issue_id: issueRow.id });
  const before = await item(plate.name);

  // Too many, or part of a sheet: refused.
  let res = await post(store, `/stores/issue/${issueRow.id}/return`, { line_id: [line.id], line_quantity: ['3'] });
  assert.match((await store.get(res.headers.location)).text, /Only 2 can still come back/);
  res = await post(store, `/stores/issue/${issueRow.id}/return`, { line_id: [line.id], line_quantity: ['0.5'] });
  assert.match((await store.get(res.headers.location)).text, /whole sheets/);
  assert.equal(num((await db('material_issue_lines').where({ id: line.id }).first()).returned_qty), 0);

  // One of two sheets back, at 300 although the average is now 312.
  res = await post(store, `/stores/issue/${issueRow.id}/return`, { line_id: [line.id], line_quantity: ['1'] });
  assert.equal(res.status, 302);
  const after = await item(plate.name);
  assert.equal(num(after.on_hand_qty), num(before.on_hand_qty) + 48);
  assert.equal(num(after.stock_value), num(before.stock_value) + 14400);
  const back = await db('material_issue_lines').where({ id: line.id }).first();
  assert.equal(num(back.returned_qty), 1);
  assert.equal(num(back.returned_value), 14400);
  assert.match((await store.get(`/jobs/${job.id}`)).text, /29,376\.00/, '43,776 − 14,400');

  // The other sheet too: the line nets to exactly nothing.
  await post(store, `/stores/issue/${issueRow.id}/return`, { line_id: [line.id], line_quantity: ['1'] });
  const done = await db('material_issue_lines').where({ id: line.id }).first();
  assert.equal(num(done.value) - num(done.returned_value), 0);
  assert.doesNotMatch((await store.get(`/stores/issue/${issueRow.id}`)).text, /Return to store<\/button>/);
});

test('issuing the last of an item leaves no value behind', async () => {
  const b = await balanceOf(bolt);
  // A value that doesn't divide evenly, so rounding would otherwise be stranded.
  await db('items').where({ id: bolt.id }).update({ stock_value: 5000.0003, avg_cost: 100.0000 });
  const res = await issue([[b, 50]]);
  assert.equal(res.status, 302, res.text);
  const i = await item(bolt.name);
  assert.equal(num(i.on_hand_qty), 0);
  assert.equal(num(i.stock_value), 0);
  assert.equal(num(i.avg_cost), 100, 'the last average stays for reference');
  const [line] = await db('material_issue_lines').where({ item_id: bolt.id });
  assert.equal(num(line.value), 5000.0003);
});

test('a delivery can’t be reversed, or opening stock undone, once it has been issued', async () => {
  const entry = await db('stock_movements').where({ item_id: bolt.id, type: 'opening' }).first();
  const res = await post(store, `/inventory/opening/${entry.id}/undo`);
  assert.equal(res.status, 409);
  assert.match(res.text, /already left the store/);
});

test('every movement stays on the permanent record', async () => {
  const types = await db('stock_movements').where({ item_id: plate.id }).pluck('type');
  for (const t of ['opening', 'reverse', 'issue', 'return']) assert.ok(types.includes(t), t);
  const page = (await store.get(`/items/${plate.id}`)).text;
  assert.match(page, /Issued/);
  assert.match(page, /Returned/);
  assert.match(page, /JOB-2026-8835/);
});

test('leaving the site: a gate pass the guard lets out; stores can cancel it before then', async () => {
  const hqGate = await loginAs(app, await makeUser(8, ['gate']));
  const siteB = await db('sites').where({ code: 'SITEB' }).first();
  const bGate = await loginAs(app, await makeUser(9, ['gate'], { siteIds: [siteB.id] }));
  await post(store, '/items', { name: 'Test Gate Bracket', category: 'Other', priced_by: 'unit', unit: 'Pc' });
  const bracket = await item('Test Gate Bracket');
  await opening([[bracket, 6, 100]]);
  const b = await balanceOf(bracket);
  const send = (fields) => post(store, `/jobs/${job.id}/issue`, {
    issued_on: localDay(), received_by: 'Test Fitter', line_balance_id: [b.id], line_label: ['chosen'], line_quantity: ['2'], ...fields,
  });

  let res = await send({ leaves_site: '1', destination: '' });
  assert.equal(res.status, 422);
  assert.match(res.text, /Say where it is going/);
  res = await send({});
  const stays = await db('material_issues').where({ id: idOf(res.headers.location) }).first();
  assert.equal(stays.leaves_site, 0, 'not ticked: no gate pass');

  res = await send({ leaves_site: '1', destination: 'Test customer yard, Athi River' });
  assert.equal(res.status, 302, res.text);
  const id = idOf(res.headers.location);
  const gatePage = (await hqGate.get('/gate/goods')).text;
  assert.match(gatePage, /Materials going out[\s\S]*Test customer yard, Athi River[\s\S]*Test Gate Bracket/);
  assert.doesNotMatch(gatePage, /100\.00/, 'no costs at the gate');
  assert.doesNotMatch((await hqGate.get('/gate/goods')).text, new RegExp(`/gate/issues/${stays.id}/out`));
  assert.match((await store.get(`/stores/issue/${id}`)).text, /Waiting at the gate/);

  assert.equal((await post(store, `/gate/issues/${id}/out`)).status, 403, 'stores don’t let it out');
  await post(bGate, `/gate/issues/${id}/out`);
  assert.equal((await db('material_issues').where({ id }).first()).gate_out_at, null, 'not from another site’s gate');
  await post(hqGate, `/gate/issues/${id}/out`, { note: 'Test Fitter, KDA 001B' });
  const out = await db('material_issues').where({ id }).first();
  assert.ok(out.gate_out_at);
  assert.equal(out.gate_out_note, 'Test Fitter, KDA 001B');
  assert.match((await store.get(`/stores/issue/${id}`)).text, /Left the site/);
  await post(store, `/stores/issue/${id}/cancel-pass`, { reason: 'Too late now' });
  assert.equal((await db('material_issues').where({ id }).first()).pass_cancelled_at, null, 'gone: can’t cancel');

  res = await send({ leaves_site: '1', destination: 'Test outside fabricator' });
  const later = idOf(res.headers.location);
  await post(store, `/stores/issue/${later}/cancel-pass`, { reason: 'Customer will collect next week' });
  const cancelled = await db('material_issues').where({ id: later }).first();
  assert.ok(cancelled.pass_cancelled_at);
  assert.doesNotMatch((await hqGate.get('/gate/goods')).text, /Test outside fabricator/);
  await post(hqGate, `/gate/issues/${later}/out`);
  assert.equal((await db('material_issues').where({ id: later }).first()).gate_out_at, null);
});
