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

/** An Error carrying an HTTP status, for the error page. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}
