import { config } from '../config.js';

// Calendar days in the company's time zone (config.timezone), for "today" filters.
// The database stores UTC, so a Nairobi day starts at 21:00 UTC the evening before.
//
//   localDay()                 → '2026-11-03' (today in Nairobi)
//   dayStart('2026-11-03')     → Date for 00:00 Nairobi that day

const tz = () => config.timezone;

/** 'YYYY-MM-DD' of a moment, in the company's time zone. */
export function localDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** How far the time zone is ahead of UTC at that moment, in ms. */
function offsetMs(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The moment a local day starts. */
export function dayStart(day) {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  return new Date(utcMidnight - offsetMs(new Date(utcMidnight)));
}

/** True for a 'YYYY-MM-DD' string that is a real date. */
export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s; // 2026-02-30 is not a day

/** The day after a 'YYYY-MM-DD' day. */
export function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
