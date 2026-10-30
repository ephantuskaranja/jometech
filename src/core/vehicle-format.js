// Cleaning up what people type, so "kda123a", "KDA-123A" and "kda 123 a"
// are all stored, shown and found as "KDA 123A".
// public/js/app.js has the same formatReg() for tidying as you type.

/** Kenyan plates: KDA 123A, ZE 4512 (trailers), GKB 123A. Anything else: uppercase, single spaces. */
export function formatReg(input) {
  if (typeof input !== 'string') return null;
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return null;
  const m = /^([A-Z]{2,3})(\d{1,4})([A-Z]?)$/.exec(compact);
  return m ? `${m[1]} ${m[2]}${m[3]}` : input.toUpperCase().trim().replace(/\s+/g, ' ');
}

/** Chassis / VIN: uppercase, no spaces or dashes. */
export function formatChassis(input) {
  if (typeof input !== 'string') return null;
  const clean = input.toUpperCase().replace(/[\s-]/g, '');
  return clean || null;
}

/** KRA PIN: a letter, 9 digits, a letter (A123456789B). Returns null if it isn't one. */
export function formatKraPin(input) {
  if (typeof input !== 'string') return null;
  const clean = input.toUpperCase().replace(/\s/g, '');
  return /^[AP]\d{9}[A-Z]$/.test(clean) ? clean : null;
}

/** For searching: letters and digits only. */
export const compact = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
