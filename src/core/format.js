// Display formats used in every view as `fmt.money(...)`, `fmt.date(...)` etc.
// Kenyan conventions: KES with thousands separators, day-month-year, Nairobi time.
import { config } from '../config.js';
import { formatPhone } from './phone.js';

const tz = config.timezone;
const moneyFmt = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 3 });

export const fmt = {
  /** 1234.5 or "1234.50" → "1,234.50" (add "KES " yourself where the column doesn't say it) */
  money: (value) => (value === null || value === undefined || value === '' ? '' : moneyFmt.format(Number(value))),
  /** 12.500 → "12.5" */
  qty: (value) => (value === null || value === undefined || value === '' ? '' : qtyFmt.format(Number(value))),
  /** → "30 Oct 2026" */
  date: (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }) : ''),
  /** → "30 Oct 2026, 14:05" */
  dateTime: (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz }) : ''),
  /** → "14:05" */
  time: (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : ''),
  /** +254712345678 → "0712 345 678" */
  phone: formatPhone,
};
