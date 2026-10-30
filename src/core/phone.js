// Phone numbers are stored in one format, +254712345678, so "0712 345 678",
// "712345678" and "+254 712-345-678" all find the same person.

/**
 * @param {string} input
 * @returns {string | null} +2547XXXXXXXX style number, or null if it isn't a phone number
 */
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');

  // Kenyan numbers: 07.., 01.., 7.., 1.., 2547.., 2541..
  if (/^0[17]\d{8}$/.test(digits)) return '+254' + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return '+254' + digits;
  if (/^254[17]\d{8}$/.test(digits)) return '+' + digits;

  // Other countries, only when written with a leading +
  if (trimmed.startsWith('+') && /^\d{8,15}$/.test(digits)) return '+' + digits;

  return null;
}

/** +254712345678 → 0712 345 678 (for display) */
export function formatPhone(phone) {
  const m = /^\+254(\d{3})(\d{3})(\d{3})$/.exec(phone ?? '');
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : phone;
}
