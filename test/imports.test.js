import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, csrfFrom, cleanup } from './helpers.js';

const app = createApp();
let admin, manager, adminId;

before(async () => {
  admin = await loginAs(app, await makeUser(94, ['sysadmin'])); // import is the System Administrator's
  manager = await loginAs(app, await makeUser(95, ['manager']));
  adminId = (await db('users').where({ phone: '+254700000094' }).first('id')).id;
  // Already in the app: a customer with a vehicle.
  await post(admin, '/customers', { name: 'Existing Transporters', phone: '0700000951' });
  const existing = await db('customers').where({ phone: '+254700000951' }).first();
  await db('vehicles').insert({ customer_id: existing.id, reg_no: 'KDT 951A', type: 'truck' });
});

after(async () => {
  // The items test's items (named "Test import …") and their stock.
  const itemIds = await db('items').where('name', 'like', 'Test import %').pluck('id');
  await db('stock_movements').whereIn('item_id', itemIds).delete();
  await db('stock_balances').whereIn('item_id', itemIds).delete();
  await db('audit_log').where({ entity: 'item' }).whereIn('entity_id', itemIds).delete();
  await db('items').whereIn('id', itemIds).delete();
  const ids = await db('imports').where({ created_by: adminId }).pluck('id');
  await db('audit_log').where({ entity: 'import' }).whereIn('entity_id', ids).delete();
  await db('imports').whereIn('id', ids).delete();
  await cleanup();
});

async function post(agent, url, fields = {}) {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post(url).type('form').send({ _csrf: csrf, ...fields });
}

/** A filled-in template as Excel bytes. */
async function workbook(customers, vehicles) {
  const book = new ExcelJS.Workbook();
  const c = book.addWorksheet('Customers');
  c.addRow(['Name *', 'Phone *', 'Category', 'KRA PIN', 'Email', 'Town', 'Address', 'Credit terms', 'Notes']);
  customers.forEach((r) => c.addRow(r));
  const v = book.addWorksheet('Vehicles');
  v.addRow(['Customer phone *', 'Reg no', 'Chassis no', 'Type', 'Make', 'Model', 'Year', 'Body type', 'Colour', 'Notes']);
  vehicles.forEach((r) => v.addRow(r));
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function upload(agent, buffer, name = 'customers.xlsx') {
  const csrf = csrfFrom((await agent.get('/')).text);
  return agent.post('/admin/import/customers').set('x-csrf-token', csrf).set('Accept', 'application/json').attach('file', buffer, name);
}

test('the template downloads with both sheets and the instructions; only admins import', async () => {
  const res = await admin.get('/admin/import/customers/template.xlsx').buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (d) => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.equal(res.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.body);
  assert.deepEqual(book.worksheets.map((w) => w.name), ['Customers', 'Vehicles', 'How to fill']);
  assert.equal(book.getWorksheet('Customers').getRow(1).getCell(2).value, 'Phone *');
  assert.equal((await manager.get('/admin/import')).status, 403);
});

test('a file is checked row by row; nothing is added until Import; then only the rows marked Add', async () => {
  const buffer = await workbook([
    ['Import Haulage Ltd', '0700000961', 'Company', 'p051234567x', '', 'Thika', '', '30 days', ''],
    ['Existing again', '700000951', '', '', '', '', '', '', ''],                // already in the app (Excel dropped the 0)
    ['Bad Phone Co', '12345', 'Company', '', '', '', '', '', ''],
    ['Twice Ltd', '0700 000 961', '', '', '', '', '', '', ''],                  // same phone as row 2
    ['Odd Category', '0700000962', 'Spaceship', '', '', '', '', 'Cash', ''],
    ['Jane Wanjiku', 700000963, '', '', '', '', '', '', ''],                     // 0700 000 963 that Excel stored as a number
  ], [
    ['0700000961', 'kdx 961b', '', 'Truck', 'Isuzu', 'FVR', 2019, 'Tipper', 'White', ''],
    ['0700000951', 'KDX 962B', '', 'trailer', '', '', '', '', '', ''],          // to the customer already in the app
    ['0700000951', 'KDT 951A', '', '', '', '', '', '', '', ''],                 // already registered
    ['0700000999', 'KDX 963B', '', '', '', '', '', '', '', ''],                 // no such customer
    ['0700000961', '', '', '', '', '', '', '', '', ''],                         // no reg or chassis
  ]);
  const res = await upload(admin, buffer);
  assert.equal(res.status, 200, res.text);
  const id = Number(res.body.go.split('/').pop());
  assert.equal(await db('customers').where({ phone: '+254700000961' }).first(), undefined, 'nothing added yet');

  const page = (await admin.get(`/admin/import/${id}`)).text;
  assert.match(page, /Already in the app: Existing Transporters/);
  assert.match(page, /“12345” isn’t a phone number/);
  assert.match(page, /already on row 2 of this sheet/);
  assert.match(page, /“Spaceship” isn’t one of/);
  assert.match(page, /Already registered, to Existing Transporters/);
  assert.match(page, /No customer with phone 0700 000 999/);
  assert.match(page, /Give the reg number, or the chassis number/);
  assert.match(page, /Import 4 rows/, '2 customers + 2 vehicles');

  await post(admin, `/admin/import/${id}/run`);
  const added = await db('customers').where({ phone: '+254700000961' }).first();
  assert.equal(added.name, 'Import Haulage Ltd');
  assert.equal(added.category, 'company');
  assert.equal(added.kra_pin, 'P051234567X');
  assert.equal(added.credit_days, 30);
  assert.match(added.number, /^CUS-/);
  assert.ok(await db('customers').where({ phone: '+254700000963' }).first(), 'a phone Excel stored as a number still works');
  const truck = await db('vehicles').where({ reg_no: 'KDX 961B' }).first();
  assert.equal(truck.customer_id, added.id);
  assert.equal(truck.year, 2019);
  const trailer = await db('vehicles').where({ reg_no: 'KDX 962B' }).first();
  assert.equal(trailer.type, 'trailer');
  assert.equal((await db('customers').where({ id: trailer.customer_id }).first()).phone, '+254700000951');
  assert.equal(await db('customers').where({ phone: '+254700000951' }).count({ n: '*' }).then(([r]) => Number(r.n)), 1, 'not duplicated');

  assert.match((await admin.get(`/admin/import/${id}`)).text, /2 customers and 2 vehicles added/);
  assert.equal((await post(admin, `/admin/import/${id}/run`)).status, 409, 'can’t import twice');

  // The same file again: everything is now skipped.
  const again = Number((await upload(admin, buffer)).body.go.split('/').pop());
  assert.match((await admin.get(`/admin/import/${again}`)).text, /Import 0 rows/);
  await post(admin, `/admin/import/${again}/discard`);
  assert.equal((await db('imports').where({ id: again }).first()).status, 'discarded');
});

test('a file that isn’t Excel, or has no rows, is refused with a message', async () => {
  let res = await upload(admin, Buffer.from('not a spreadsheet'), 'notes.txt');
  assert.equal(res.body.go, '/admin/import');
  assert.match((await admin.get('/admin/import')).text, /isn’t an Excel file/);
  res = await upload(admin, await workbook([], []));
  assert.match((await admin.get('/admin/import')).text, /Nothing to import/);
});

test('items and their opening stock: plates per sq ft by sheet size, other items per unit; nothing counted twice', async () => {
  const category = (await db('item_categories').orderBy('id').first('name')).name;
  const book = new ExcelJS.Workbook();
  const it = book.addWorksheet('Items');
  it.addRow(['Name *', 'Category *', 'Priced by', 'Unit', 'Thickness mm', 'Current price', 'Reorder level', 'Notes']);
  it.addRow(['Test import plate 3 mm', category, 'Per sq ft', '', 3, 90, 10, '']);
  it.addRow(['Test import bolts', category, 'Per unit', 'Pc', '', 12, '', '']);
  it.addRow(['Test import no category', 'Nonsense', '', 'Pc', '', '', '', '']);
  it.addRow(['Test import thin plate', category, 'Per sq ft', '', '', '', '', '']);
  const st = book.addWorksheet('Opening stock');
  st.addRow(['Item *', 'Site *', 'Quantity *', 'Length', 'Width', 'Size unit', 'Cost per unit *']);
  st.addRow(['Test import plate 3 mm', 'HQ', 5, 8, 4, 'ft', 85]);
  st.addRow(['Test import bolts', 'hq', 200, '', '', '', 10.5]);
  st.addRow(['Test import plate 3 mm', 'HQ', 2.5, 8, 4, 'ft', 85]);       // half a sheet
  st.addRow(['Test import bolts', 'Mars', 1, '', '', '', 10]);              // no such site
  st.addRow(['Test import no category', 'HQ', 1, '', '', '', 10]);          // its item has a problem
  const buffer = Buffer.from(await book.xlsx.writeBuffer());

  const csrf = csrfFrom((await admin.get('/')).text);
  const res = await admin.post('/admin/import/items').set('x-csrf-token', csrf).set('Accept', 'application/json').attach('file', buffer, 'items.xlsx');
  const id = Number(res.body.go.split('/').pop());
  const page = (await admin.get(`/admin/import/${id}`)).text;
  assert.match(page, /Category “Nonsense” isn’t on the list/);
  assert.match(page, /A plate needs its thickness in mm/);
  assert.match(page, /Plates are counted in whole sheets/);
  assert.match(page, /No site “Mars”/);
  assert.match(page, /Its item \(row 4 of Items\) has a problem/);
  assert.match(page, /Import 4 rows/, '2 items + 2 stock lines');

  await post(admin, `/admin/import/${id}/run`);
  const plate = await db('items').where({ name: 'Test import plate 3 mm' }).first();
  assert.equal(plate.priced_by, 'area');
  assert.equal(plate.unit, 'sq ft');
  assert.equal(Number(plate.on_hand_qty), 160, '5 sheets of 8 × 4 ft');
  assert.equal(Number(plate.avg_cost), 85);
  const hq = await db('sites').where({ code: 'HQ' }).first('id');
  const sheets = await db('stock_balances').where({ item_id: plate.id, site_id: hq.id }).first();
  assert.equal(Number(sheets.quantity), 5);
  const bolts = await db('items').where({ name: 'Test import bolts' }).first();
  assert.equal(Number(bolts.on_hand_qty), 200);
  assert.equal(Number(bolts.stock_value), 2100);

  // The same file again: items skipped, and their opening stock isn't counted twice.
  const again = Number((await admin.post('/admin/import/items').set('x-csrf-token', csrf).set('Accept', 'application/json').attach('file', buffer, 'items.xlsx')).body.go.split('/').pop());
  const second = (await admin.get(`/admin/import/${again}`)).text;
  assert.match(second, /Already an item: Test import plate 3 mm/);
  assert.match(second, /Opening stock already entered for this item, site and size/);
  assert.match(second, /Import 0 rows/);
});

test('employees with clock IDs and daily rates; someone already on file is skipped; a clock ID belongs to one person', async () => {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Employees');
  ws.addRow(['Name *', 'Site *', 'Category', 'Trade', 'Phone', 'ID number', 'Clock IDs', 'Daily rate', 'Joined on', 'M-Pesa phone', 'Emergency contact', 'Emergency phone', 'Notes']);
  ws.addRow(['Test Welder One', 'HQ', 'Permanent', 'Welder', '0700000971', '9900971', 'T971, T972', '1,500', '01/03/2025', '', 'Mary', '0700000979', '']);
  ws.addRow(['Test Welder Again', 'hq', '', '', '0700000971', '', '', '', '', '', '', '', '']);     // same phone as row 2
  ws.addRow(['Test Clock Clash', 'HQ', '', '', '0700000973', '', 'T972', '', '', '', '', '', '']);    // clock ID on row 2
  ws.addRow(['Test Bad Date', 'HQ', 'Casual', '', '', '', '', '', '31/02/2025', '', '', '', '']);
  ws.addRow(['Test Casual', 'HQ', '', 'Grinder', '0700000974', '', 'T974', '800', '', '', '', '', '']);
  const buffer = Buffer.from(await book.xlsx.writeBuffer());
  const csrf = csrfFrom((await admin.get('/')).text);
  const send = async () => Number((await admin.post('/admin/import/employees').set('x-csrf-token', csrf).set('Accept', 'application/json').attach('file', buffer, 'staff.xlsx')).body.go.split('/').pop());

  const id = await send();
  const page = (await admin.get(`/admin/import/${id}`)).text;
  assert.match(page, /Same person as row 2/);
  assert.match(page, /Clock ID T972 is also on row 2/);
  assert.match(page, /Check the date “31\/02\/2025”/);
  assert.match(page, /Import 2 rows/);
  await post(admin, `/admin/import/${id}/run`);

  const welder = await db('employees').where({ phone: '+254700000971' }).first();
  assert.equal(welder.category, 'permanent');
  assert.equal(Number(welder.daily_rate), 1500);
  assert.equal(welder.joined_on, '2025-03-01');
  assert.match(welder.number, /^EMP-/);
  assert.deepEqual((await db('employee_clock_ids').where({ employee_id: welder.id }).orderBy('clock_id').pluck('clock_id')), ['T971', 'T972']);
  assert.equal(Number((await db('employees').where({ phone: '+254700000974' }).first()).daily_rate), 800);

  assert.match((await admin.get(`/admin/import/${await send()}`)).text, /Already in the app: Test Welder One/);
});
