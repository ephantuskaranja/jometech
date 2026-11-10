import { z } from 'zod';
import { normalizePhone } from './phone.js';

// Runs a Zod schema over form data and returns either clean data or one
// error message per field, ready to show next to each input:
//
//   const { data, errors } = check(loginSchema, req.body);
//   if (errors) return res.status(422).render('...', { errors, values: req.body });

/** @returns {{ data: any, errors: null } | { data: null, errors: Record<string, string> }} */
export function check(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return { data: result.data, errors: null };

  const errors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] ?? '_form';
    errors[field] ??= issue.message;
  }
  return { data: null, errors };
}

// ---------- Reusable Zod pieces for form fields ----------
// Empty inputs arrive as '' from forms; these turn '' into null.

/** Optional text, trimmed, '' → null. */
export const optionalText = (max = 255) =>
  z.string().trim().max(max, `Use ${max} characters or fewer`).optional().transform((v) => v || null);

/** ID or passport number, one format: no spaces or dashes, capitals ("29 967-996" → "29967996"). */
export const tidyIdNo = (v) => (v ? String(v).replace(/[\s./-]/g, '').toUpperCase() : v);

/** Optional ID / passport number, '' → null, stored tidied. */
export const optionalIdNo = () =>
  optionalText(30).transform((v) => v && tidyIdNo(v))
    .refine((v) => v === null || /^[A-Z0-9]{5,20}$/.test(v), 'Use the digits (and letters, for a passport) on the ID, e.g. 29967996');

/** Optional email, '' → null. */
export const optionalEmail = () =>
  optionalText(120).refine((v) => v === null || z.email().safeParse(v).success, 'Check the email address')
    .transform((v) => v && v.toLowerCase());

/** Required phone, stored as +2547…  */
export const phoneField = (missing = 'Enter a phone number') =>
  z.string().trim().min(1, missing)
    .refine((v) => normalizePhone(v), 'Use a format like 0712 345 678')
    .transform((v) => normalizePhone(v));

/** Optional phone, '' → null. */
export const optionalPhone = () =>
  optionalText(30).refine((v) => v === null || normalizePhone(v), 'Use a format like 0712 345 678')
    .transform((v) => v && normalizePhone(v));

/** Optional id from a <select>: '' → null. */
export const optionalId = () =>
  z.union([z.literal(''), z.coerce.number().int().positive()]).optional().transform((v) => (v ? v : null));

/** Optional meter reading (odometer km): "245,300" and "245 300 km" are both 245300; '' → null. */
export const optionalReading = () => z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/[^\d]/g, '') : v),
  z.union([z.literal(''), z.coerce.number().int().max(9_999_999, 'Check the reading')]).optional().transform((v) => (v === '' || v === undefined ? null : v)),
);

/** Optional amount in KES, as typed in a money field: "12,500.50" → 12500.5; '' → null. */
export const optionalAmount = (max = 999_999_999) => z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/[,\s]/g, '').replace(/^KES/i, '') : v),
  z.union([z.literal(''), z.coerce.number({ message: 'Check the amount' }).min(0, 'Check the amount').max(max, 'Check the amount')
    .refine((n) => Number.isInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most two decimals')], { error: 'Check the amount' })
    .optional().transform((v) => (v === '' || v === undefined ? null : v)),
);

/** An Error carrying an HTTP status, for the error page. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}
