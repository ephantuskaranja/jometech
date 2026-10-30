# Jome-Tech

Fabrication and workshop management system: check-in, jobs, stores, purchasing, attendance, payroll and invoicing.

The project plan is in [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

## Requirements

- Node.js 24 or later
- MySQL: the server runs 8.0 (upgrade to 8.4 LTS planned), development runs 9.x. Keep SQL to features both versions have.

## Run it

```bash
npm install
cp .env.example .env     # then fill in DB_* and SESSION_SECRET
npm run db:migrate       # create / update the tables
npm run db:seed          # sites, roles and permissions (safe to run again)
npm run user:create      # first admin account (asks for phone, name, role, password)
npm run dev              # http://localhost:3000, restarts when a file changes
npm test                 # runs every *.test.js in test/ (needs the database)
```

## Users and access

- People log in with their **phone number** (any format: `0712 345 678`, `+254712345678`) or email, plus a password.
- `npm run user:create` adds a user. Run it with an existing phone number to reset that person's password.
- **Roles → permissions**: the permission keys and the six built-in roles (Admin, Manager, Supervisor, Sales, Storekeeper, Technician) are in `src/core/permissions.js`. Admins can do everything.
- Protect a route with `can('permission.key')` from `src/core/auth.js`. The sidebar hides items the user can't use (`permission` in `src/core/nav.js`).
- **Sites**: Admins and Managers see every site; everyone else sees the sites they're assigned to. `req.site` is the current site, chosen in the top bar.
- Security: argon2 password hashes, sessions stored in MySQL (12 hours idle timeout), CSRF token on every form, 5 wrong passwords lock an account for 15 minutes, 20 login attempts per 15 minutes per device.
- Every form needs `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`. `fetch` calls send the `x-csrf-token` header from `<meta name="csrf-token">`.

## Database

| Command | What it does |
|---|---|
| `npm run db:make -- create_customers` | New migration file in `db/migrations/`, from `db/migration.stub` |
| `npm run db:migrate` | Run migrations not yet applied |
| `npm run db:rollback` | Undo the last batch of migrations |
| `npm run db:status` | List applied and pending migrations |
| `npm run db:seed` | Run `db/seeds/` |

- Connection settings: `knexfile.js`, shared by the app and these commands. The app imports the pool from `src/core/db.js`.
- Build every table with `tableDefaults()` and `timestamps()` from `src/core/schema.js`.
- Dates are stored in UTC. DECIMAL values come back as strings so money keeps exact cents.
- Never edit a migration that has already run on the server; add a new one.

## Stack

| Layer | Tool |
|---|---|
| Server | Express 5, plain JavaScript (ES modules), no build step |
| Pages | EJS templates + `express-ejs-layouts` |
| UI | Bootstrap 5.3, Bootstrap Icons, Alpine.js |
| Fonts | Archivo (headings), Figtree (text), IBM Plex Mono (numbers, codes), served locally from `@fontsource` |
| Database | MySQL via Knex.js (query builder, migrations, seeds) + mysql2 |
| Login | express-session + express-mysql-session, argon2, csrf-sync, express-rate-limit |
| Validation | Zod, through `check()` in `src/core/validate.js` |
| Logging | pino + pino-http |
| Tests | `node --test` + supertest |

Front-end libraries are served straight from `node_modules` under `/vendor/...` (see `src/app.js`).

## Folders

```
src/
  server.js          starts the HTTP server
  app.js             Express setup: views, security headers, static files, routes, errors
  config.js          every setting read from .env
  core/              shared code: db, auth, session, permissions, nav, phone, validate, logger
  modules/<name>/    one folder per feature: routes.js (+ service.js) + views/
  views/             layout.ejs (app), layout-auth.ejs (login), partials/, error.ejs
scripts/             command-line tools (create-user.js)
public/
  css/app.css        Jome-Tech theme on top of Bootstrap (light + dark)
  js/theme.js        light / dark / match-device switch
  js/app.js          small shared behaviours
test/                *.test.js files; helpers.js creates and removes test users (phones 0700 000 0xx)
```

## Theme

The theme button in the top bar (and on the login page) switches between Light, Dark and Match device. Bootstrap 5.3 reads `data-bs-theme` on `<html>`, and `public/js/theme.js` sets it before the page draws. The choice is saved to the user's account, so it follows them to other devices. Colours are CSS variables at the top of `public/css/app.css`; change them there, not in individual pages.
