// One employee's punches on one day → when they came and went, hours worked (lunch excluded) and a
// suggested status. The supervisor sees the suggestion and the punches, and can change it.
//
// With punch states (1 morning in, 3 lunch out, 4 lunch in, 2 evening out) they decide. Without them
// (the sample export has none), the time of day does:
//   the first punch is in; the last punch after 15:30 is out; punches 11:00–15:30 are lunch.
//   One lunch punch and no evening punch: they went home at lunch.
// A day with no evening punch is flagged, not guessed: they may have forgotten, or the export was early.

const LUNCH_FROM = 11 * 60;
const LUNCH_TO = 15 * 60 + 30;
const SAME_PUNCH = 5; // minutes: a second punch this soon after is the same one, pressed twice

const toMin = (t) => { const [h, m, s = 0] = String(t).split(':').map(Number); return h * 60 + m + s / 60; };
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;

export const FLAGS = {
  no_out: 'No evening punch',
  short: 'Short day',
};

/**
 * @param {{ time: string, state: number|null }[]} punches  one employee, one day
 * @param {{ fullDayHours: number, halfDayHours: number }} rules
 * @returns {{ first_in: string, last_out: string|null, hours: number|null, status: 'present'|'half'|'absent', flag: keyof FLAGS|null, punches: string[] } | null}
 */
export function summarize(punches, { fullDayHours, halfDayHours }) {
  const sorted = punches.map((p) => ({ min: toMin(p.time), state: p.state ?? null })).sort((a, b) => a.min - b.min);
  const kept = [];
  for (const p of sorted) {
    const last = kept[kept.length - 1];
    if (last && p.min - last.min < SAME_PUNCH && (p.state === last.state || p.state === null)) continue;
    kept.push(p);
  }
  if (!kept.length) return null;

  const withState = (s) => kept.filter((p) => p.state === s);
  const hasStates = kept.some((p) => p.state !== null);
  const first = withState(1)[0] ?? kept[0];
  let out;
  let lunchOut;
  let lunchIn;
  if (hasStates) {
    out = withState(2).at(-1) ?? kept.filter((p) => p !== first && p.state === null && p.min > LUNCH_TO).at(-1) ?? null;
    lunchOut = withState(3)[0] ?? null;
    lunchIn = withState(4).at(-1) ?? null;
  } else {
    const rest = kept.slice(1);
    out = rest.filter((p) => p.min > LUNCH_TO).at(-1) ?? null;
    const lunch = rest.filter((p) => p.min >= LUNCH_FROM && p.min <= LUNCH_TO);
    if (lunch.length >= 2) [lunchOut, lunchIn] = [lunch[0], lunch.at(-1)];
    else if (lunch.length === 1 && !out) out = lunch[0]; // left at lunch
  }
  if (!out && lunchOut && !lunchIn) out = lunchOut; // punched out for lunch and didn't come back

  const result = { first_in: hhmm(first.min), last_out: out ? hhmm(out.min) : null, hours: null, status: 'present', flag: null, punches: kept.map((p) => hhmm(p.min)) };
  if (!out || out.min <= first.min) return { ...result, last_out: null, flag: 'no_out' };

  let minutes = out.min - first.min;
  if (lunchOut && lunchIn && lunchIn.min > lunchOut.min && lunchOut.min > first.min && lunchIn.min < out.min) minutes -= lunchIn.min - lunchOut.min;
  const hours = Math.round((minutes / 60) * 100) / 100;
  if (hours >= fullDayHours) return { ...result, hours, status: 'present' };
  if (hours >= halfDayHours) return { ...result, hours, status: 'half' };
  return { ...result, hours, status: 'absent', flag: 'short' };
}
