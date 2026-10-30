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
- Admins manage people at **System → Users** (`/admin/users`): add (a temporary password is shown once), edit roles and sites, reset password, switch off. Nobody can remove their own Admin role or switch themselves off, and the last admin can't be removed.
- **First admin:** `npm run db:seed` creates one while no admin exists, and they must change the password at first login. Development uses **0711 000 000 / jometech-admin-1**; on the server, set `ADMIN_PHONE` and `ADMIN_PASSWORD` in `.env` (see `.env.example`).
- `npm run user:create` adds a user from the terminal. Run it with an existing phone number to reset that person's password.
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

## Deploying

Every push to `master` runs the tests and, if they pass, deploys to the server. One-time server setup: [docs/DEPLOY.md](docs/DEPLOY.md).

## Stack

| Layer | Tool |
|---|---|
| Server | Express 5, plain JavaScript (ES modules), no build step |
| Pages | EJS templates + `express-ejs-layouts` |
| UI | Bootstrap 5.3, Bootstrap Icons, Alpine.js, Tom Select (searchable dropdowns) |
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

## Customers and vehicles

- **Customers** (`/customers`): only name and phone are required; the number (`CUS-0001`), type Individual and Cash terms are filled in. Companies, government and NGOs have **contact people** (salesman, fleet manager, accounts…); the first can be entered on the add form.
- **Vehicles** (`/vehicles`): reg **or** chassis number (trailers often have only a chassis), owner and type. A vehicle can name the contact who brings it in. Reg plates are stored as `KDA 123A` however they're typed (`src/core/vehicle-format.js`, same rules in `public/js/app.js`).
- **Warnings while typing**: a phone number that already belongs to a customer, and a reg/chassis already registered.
- **Add in place**: in the vehicle form's customer dropdown, type a new name and choose "Add new customer"; a small window saves it and selects it (`customers/views/quick-add.ejs`).
- **Global search** (top bar): reg in any format, chassis, phone, customer name, `CUS` number or KRA PIN. One exact hit opens it directly.
- Who sees what: `src/core/access.js`. Supervisors can add vehicles (and quick-add customers) for check-in; editing customers needs `customers.manage`.

## History and document numbers

Every service function that changes data does both of these inside one `db.transaction()`:

```js
import { audit } from '../../core/audit.js';
import { nextNumber } from '../../core/numbering.js';

await db.transaction(async (trx) => {
  const number = await nextNumber(trx, 'job');                 // 'JOB-2026-0148'
  const [id] = await trx('jobs').insert({ number, ... });
  await audit(trx, req, { entity: 'job', id, action: 'create', after: { number, ... } });
});
```

- **History** (`src/core/audit.js`): `audit()` stores who, when, from which IP, and `{ field: [before, after] }` for what changed. Pass readable values (role names, not ids). Passwords are never stored. Show it with `include('partials/history', { entries: await history('job', id) })`. Rows are never edited or deleted.
- **Numbers** (`src/core/numbering.js`): formats for every document type are in `NUMBER_FORMATS` (e.g. `JOB-2026-0001`, restarting each January in Nairobi time; `CUS-0001` never restarts). Must be called inside the transaction: a failed save hands the number back, so there are no gaps, and two people saving at once get different numbers.

## Building screens: the UI kit

Open **`/dev/ui`** (in development, or as an admin on the server). It shows every building block, with the line to copy:

| Partial | Use |
|---|---|
| `partials/page-header` | Breadcrumb, title, one-line explanation, action buttons |
| `partials/field` | Any input: text, tel, email, number, money (KES), date, textarea, select, searchable select (Tom Select, optionally loading from a URL) |
| `partials/choices` | Big tappable checkboxes / radios, for up to ~8 options |
| `partials/pill`, `partials/plate` | Status pill; yellow reg plate |
| `partials/empty` | Empty list or no search results |

CSS patterns: `jt-fields` (two-column form grid), `jt-toolbar` + `jt-table` (list pages), `jt-savebar` (sticky Save at the bottom). Formatting in views: `fmt.money()`, `fmt.date()`, `fmt.dateTime()`, `fmt.phone()`. The users module (`src/modules/users`) is the worked example of a list + form screen.

## Theme

The theme button in the top bar (and on the login page) switches between Light, Dark and Match device. Bootstrap 5.3 reads `data-bs-theme` on `<html>`, and `public/js/theme.js` sets it before the page draws. The choice is saved to the user's account, so it follows them to other devices. Colours are CSS variables at the top of `public/css/app.css`; change them there, not in individual pages.
