import ExcelJS from 'exceljs';

// Reads a clock-in machine export (ZKTeco / ZKBio Time "Transaction" report) saved as Excel or CSV.
// The header row is found by its column names, so extra title rows above it and extra columns don't matter:
//
//   First Name | Last Name | ID | Department | Date | Time | … | Device Name | Device Serial No. | Punch State …
//
// Some exports put date and time in one column ("Punch Time 2026-10-30 07:09:00"). Punch State is
// Jome-Tech's code (1 morning in, 3 lunch out, 4 lunch in, 2 evening out) or ZKTeco's words; "--" is none.

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const COLUMNS = {
  first: ['first name'],
  last: ['last name'],
  name: ['name', 'employee name', 'full name'],
  id: ['id', 'person id', 'employee id', 'emp id', 'user id', 'ac no', 'personnel id', 'no'],
  date: ['date'],
  time: ['time'],
  datetime: ['punch time', 'date time', 'datetime', 'check time', 'attendance time'],
  device: ['device name', 'device', 'terminal', 'terminal name'],
  serial: ['device serial no', 'serial no', 'device sn', 'sn'],
  state: ['punch state', 'state', 'status', 'check type'],
};

const STATE_WORDS = { 'check in': 1, 'checkin': 1, 'in': 1, 'check out': 2, 'checkout': 2, 'out': 2, 'break out': 3, 'breakout': 3, 'break in': 4, 'breakin': 4 };

/** 1 morning in, 2 evening out, 3 lunch out, 4 lunch in; null when not given. */
export function punchState(value) {
  const s = norm(value);
  if (!s) return null;
  if (/^[1-4]$/.test(s)) return Number(s);
  return STATE_WORDS[s] ?? null;
}

const pad = (n) => String(n).padStart(2, '0');

/** A date as YYYY-MM-DD from "2026-10-30", "30/10/2026", "30-10-2026" or an Excel date. */
export function readDay(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Excel stores the wall-clock time; exceljs hands it over as that time in UTC.
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  const s = String(value ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return valid(m[1], m[2], m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s); // day first, as in Kenya
  if (m) return valid(m[3], m[2], m[1]);
  return null;
}

function valid(y, mo, d) {
  const day = `${y}-${pad(mo)}-${pad(d)}`;
  const t = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(day) ? day : null;
}

/** A time as HH:MM:SS from "07:09", "7:09:30", "07:09 AM" or an Excel time. */
export function readTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  if (typeof value === 'number' && value >= 0 && value < 1) { // Excel fraction of a day
    const secs = Math.round(value * 86400);
    return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  }
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(value ?? ''));
  if (!m) return null;
  let h = Number(m[1]);
  if (m[4]) h = (h % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0);
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${pad(h)}:${m[2]}:${m[3] ?? '00'}`;
}

/** Simple CSV: quotes, and a comma, semicolon or tab as the separator (whichever the header row uses most). */
export function parseCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const sample = lines.find((l) => l.trim()) ?? '';
  const sep = [',', ';', '\t'].sort((a, b) => sample.split(b).length - sample.split(a).length)[0];
  return lines.filter((l) => l.trim()).map((line) => {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === sep) { cells.push(cur); cur = ''; } else cur += c;
    }
    cells.push(cur);
    return cells;
  });
}

async function readSheet(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const ws = book.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push(row.values.slice(1).map((v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.text ?? v.result ?? '') : v)));
  });
  return rows;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const names = rows[i].map(norm);
    const col = (key) => names.findIndex((n) => COLUMNS[key].includes(n));
    const cols = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, col(k)]));
    const hasWhen = cols.datetime >= 0 || (cols.date >= 0 && cols.time >= 0);
    if (cols.id >= 0 && hasWhen) return { index: i, cols };
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @param {string} fileName  .xlsx or .csv
 * @returns {Promise<{ punches: { clock_id: string, name: string|null, day: string, time: string, device: string|null, serial: string|null, state: number|null }[], skipped: number, error?: string }>}
 */
export async function readPunchFile(buffer, fileName) {
  const ext = String(fileName).toLowerCase().split('.').pop();
  let rows;
  try {
    rows = ext === 'xlsx' ? await readSheet(buffer) : parseCsv(buffer.toString('utf8'));
  } catch {
    return { punches: [], skipped: 0, error: 'That file couldn’t be read. Export the report as Excel (.xlsx) or CSV and try again.' };
  }
  const header = findHeader(rows);
  if (!header) return { punches: [], skipped: 0, error: 'No ID, Date and Time columns were found. Export the “Transaction” report with those columns.' };
  const { cols } = header;
  const cell = (row, key) => (cols[key] >= 0 ? row[cols[key]] : null);
  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const punches = [];
  let skipped = 0;
  for (const row of rows.slice(header.index + 1)) {
    const clockId = text(cell(row, 'id')).replace(/\.0$/, '');
    const when = cell(row, 'datetime');
    const day = readDay(when ?? cell(row, 'date'));
    const time = readTime(when ?? cell(row, 'time'));
    if (!clockId || !day || !time) { if (row.some((v) => text(v))) skipped++; continue; }
    const name = [text(cell(row, 'first')), text(cell(row, 'last'))].filter(Boolean).join(' ') || text(cell(row, 'name')) || null;
    punches.push({
      clock_id: clockId.slice(0, 30), name: name?.replace(/\s+/g, ' ').slice(0, 100) ?? null, day, time,
      device: text(cell(row, 'device')).slice(0, 60) || null, serial: text(cell(row, 'serial')).slice(0, 40) || null, state: punchState(cell(row, 'state')),
    });
  }
  return { punches, skipped };
}
