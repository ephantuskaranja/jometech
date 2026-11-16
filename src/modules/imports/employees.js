import { db } from '../../core/db.js';
import { normalizePhone, formatPhone } from '../../core/phone.js';
import { tidyIdNo } from '../../core/validate.js';
import { isDay } from '../../core/dates.js';
import { CATEGORIES, TRADES, createEmployee, parseClockIds } from '../employees/service.js';
import { template as makeTemplate } from './sheet.js';

// Import: employees, with their clock IDs and daily rates. Same rules as the form: one ID number per
// person, a clock ID belongs to one person. Someone already on file (same ID number, or same phone)
// is skipped. Admins import, so the daily rate is set too.

export const KIND = 'employees';
export const TITLE = 'Employees';

const FIELDS = { name: 'Name', site: 'Site', category: 'Category', trade: 'Trade', phone: 'Phone', id_no: 'ID number', clock_ids: 'Clock IDs',
  daily_rate: 'Daily rate', joined_on: 'Joined on', mpesa_phone: 'M-Pesa phone', emergency_name: 'Emergency contact', emergency_phone: 'Emergency phone', notes: 'Notes' };
export const SHEETS = [{ name: 'Employees', fields: FIELDS }];

export function template() {
  return makeTemplate([
    { name: 'Employees', columns: [['Name', 26, true], ['Site', 12, true], ['Category', 12], ['Trade', 16], ['Phone', 15, false, true], ['ID number', 14, false, true], ['Clock IDs', 12, false, true],
      ['Daily rate', 11], ['Joined on', 12, false, true], ['M-Pesa phone', 15, false, true], ['Emergency contact', 22], ['Emergency phone', 16, false, true], ['Notes', 30]],
      example: ['John Otieno', 'HQ', 'Casual', 'Welder', '0712 345 678', '29967996', '61', '1200', '2025-03-01', '', 'Mary Otieno', '0722 000 111', ''] },
  ], [
    ['Employees', 'One row per person. Name and site are needed. Someone already in the app (same ID number, or same phone) is skipped.'],
    ['Site', 'The site name or code where they normally work, e.g. HQ.'],
    ['Category', `${Object.values(CATEGORIES).join(' or ')}. Empty = Casual.`],
    ['Trade', `e.g. ${TRADES.slice(0, 6).join(', ')} …`],
    ['Clock IDs', 'Their number(s) on the clock-in machine, e.g. 61, or 61, 67 if they have two. Each belongs to one person.'],
    ['Daily rate', 'KES per day, used by payroll. Only managers and admins see it in the app.'],
    ['Joined on', 'A date, e.g. 2025-03-01 or 01/03/2025.'],
  ]);
}

/** 2025-03-01, 01/03/2025 or 1-3-2025 (day first, as in Kenya) → '2025-03-01'; '' → null. */
function dayOf(text) {
  const t = String(text ?? '').trim();
  if (!t) return { value: null };
  if (isDay(t)) return { value: t };
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  const day = m && `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return day && isDay(day) ? { value: day } : { error: `Check the date “${t}”` };
}

export async function check(sheets) {
  const sites = await db('sites').where({ is_active: true }).select('id', 'name', 'code');
  const rows = [];
  const seen = { id: new Map(), phone: new Map(), clock: new Map() };
  for (const r of sheets.Employees ?? []) {
    const problems = [];
    const name = r.name.replace(/\s+/g, ' ').trim();
    if (name.length < 2) problems.push('Name is missing');
    const site = sites.find((s) => s.name.toLowerCase() === r.site.trim().toLowerCase() || s.code.toLowerCase() === r.site.trim().toLowerCase());
    if (!site) problems.push(r.site ? `No site “${r.site}”` : 'Site is missing');
    const c = r.category.trim().toLowerCase();
    const category = !c ? 'casual' : Object.keys(CATEGORIES).find((k) => k === c || CATEGORIES[k].toLowerCase() === c);
    if (!category) problems.push(`Category “${r.category}”: use Casual or Permanent`);
    const phoneOf = (field, label) => {
      if (!r[field]) return null;
      const p = normalizePhone(r[field]);
      if (!p) problems.push(`${label} “${r[field]}” isn’t a phone number`);
      return p;
    };
    const phone = phoneOf('phone', 'Phone');
    const mpesa = phoneOf('mpesa_phone', 'M-Pesa phone');
    const emergencyPhone = phoneOf('emergency_phone', 'Emergency phone');
    const idNo = r.id_no ? tidyIdNo(r.id_no) : null;
    if (idNo && !/^[A-Z0-9]{5,20}$/.test(idNo)) problems.push(`Check the ID number “${r.id_no}”`);
    const clockIds = parseClockIds(r.clock_ids);
    const rate = r.daily_rate ? Number(String(r.daily_rate).replace(/[,\s]/g, '')) : null;
    if (r.daily_rate && !(rate >= 0 && rate <= 99_999)) problems.push(`Check the daily rate “${r.daily_rate}”`);
    const joined = dayOf(r.joined_on);
    if (joined.error) problems.push(joined.error);
    const data = { name: name.slice(0, 100), site_id: site?.id ?? null, category: category ?? 'casual', trade: r.trade.trim().slice(0, 40) || null, phone, id_no: idNo,
      clock_ids: clockIds, daily_rate: rate, joined_on: joined.value ?? null, mpesa_phone: mpesa, emergency_name: r.emergency_name.trim().slice(0, 100) || null,
      emergency_phone: emergencyPhone, notes: r.notes ? r.notes.slice(0, 2000) : null };

    let status = 'add';
    let message = '';
    if (problems.length) { status = 'error'; message = problems.join('; '); }
    else {
      const twice = (idNo && seen.id.get(idNo)) || (phone && seen.phone.get(phone));
      const clockTwice = clockIds.find((id) => seen.clock.has(id));
      if (twice) { status = 'error'; message = `Same person as row ${twice} of this sheet`; }
      else if (clockTwice) { status = 'error'; message = `Clock ID ${clockTwice} is also on row ${seen.clock.get(clockTwice)}`; }
      else {
        const existing = (idNo && await db('employees').where({ id_no: idNo }).first('name', 'number'))
          || (phone && await db('employees').where({ phone }).first('name', 'number'));
        if (existing) { status = 'skip'; message = `Already in the app: ${existing.name} (${existing.number})`; }
        else if (clockIds.length) {
          const taken = await db('employee_clock_ids as c').join('employees as e', 'e.id', 'c.employee_id').whereIn('c.clock_id', clockIds).first('c.clock_id', 'e.name');
          if (taken) { status = 'error'; message = `Clock ID ${taken.clock_id} is already ${taken.name}’s`; }
        }
      }
    }
    if (idNo && !seen.id.has(idNo)) seen.id.set(idNo, r.row);
    if (phone && !seen.phone.has(phone)) seen.phone.set(phone, r.row);
    for (const id of clockIds) if (!seen.clock.has(id)) seen.clock.set(id, r.row);
    rows.push({ row: r.row, status, message, data,
      show: [name, site?.name ?? r.site, [CATEGORIES[data.category], data.trade].filter(Boolean).join(' · '), phone ? formatPhone(phone) : '', clockIds.length ? `clock ${clockIds.join(', ')}` : ''] });
  }
  return { Employees: rows };
}

export async function run(sheets, actor) {
  const failed = [];
  let added = 0;
  for (const e of sheets.Employees) {
    if (e.status !== 'add') continue;
    try {
      await createEmployee(e.data, actor, { withRate: true });
      added++;
    } catch (err) {
      failed.push(`Employees row ${e.row}: ${err.message}`);
    }
  }
  return { summary: `${added} employee${added === 1 ? '' : 's'} added`, failed };
}
