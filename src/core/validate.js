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

/** An Error carrying an HTTP status, for the error page. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}
