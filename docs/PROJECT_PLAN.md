# Jome-Tech Fabrication & Workshop Management System: Project Plan

Source: `jometech-requirements-v0.2.docx`, which adds §54 Database Backup & Recovery to v0.1.
Status: Draft plan v2, 2026-10-28. The stack now uses JavaScript, Express and Bootstrap, and a usability section has been added.

---

## 1. Guiding principle: usability first

The goal is a system that workshop staff **want** to use. Every screen should ask for the fewest possible inputs. Everything the system already knows should be **prefilled**, and most actions should take one or two taps. Section 5 sets out the concrete rules, and they apply to every module.

---

## 2. Tech stack

Goals: lightweight and fast, built with tools the developer already knows (vanilla JS and Express), on MySQL.

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24 LTS** | Current LTS. |
| Language | **Plain JavaScript (ES modules)** | No build step and no compiler. Optionally add `// @ts-check` + JSDoc comments to get editor autocomplete and error hints for free, with no TypeScript needed. |
| Web framework | **Express 5** | Already familiar. Express 5 catches errors thrown in `async` handlers natively. |
| Views | **Server-rendered EJS templates** | Plain HTML with `<%= %>`. Pages load fast, there is no separate frontend app to build, and it suits forms-heavy ERP screens. |
| UI framework | **Bootstrap 5.3** + **Bootstrap Icons** | Already familiar. Built-in light and dark mode, responsive grid for tablets, ready-made modals, toasts and offcanvas. |
| Interactivity | **Alpine.js** (~15 KB) | Adds small behaviours straight in the HTML (`x-data`, `x-show`, `@click`), such as quotation line totals, show/hide sections and repeating rows. It is plain JS and can be learned in an afternoon. |
| Smart dropdowns | **Tom Select** | Searchable, typeahead selects with remote search and "create new" built in. It drives the prefill experience. Has a Bootstrap 5 theme. |
| DB access | **Knex.js** + `mysql2` | A plain-JS query builder with **migrations and seeds** included. Reads close to SQL, and raw SQL is easy for reports. |
| Database | **MySQL 8.4 LTS** (InnoDB, utf8mb4) in production | As requested. The server currently runs MySQL 8.0 (end of life April 2026; upgrade to 8.4 before go-live) and development runs 9.3, so use only SQL that works on all of them. |
| Validation | **Zod** | Works in plain JS. One schema per form gives clear error messages. |
| Auth / security | `express-session` + `express-mysql-session`, **argon2** passwords, **helmet**, **csrf-sync**, `express-rate-limit` | Session cookies suit server-rendered apps, and CSRF protection is needed because the app posts forms. |
| Uploads / photos | **multer** + **sharp** (resize/compress phone photos) to local disk, behind a small `storage.js` wrapper (S3 later) | |
| PDFs | **pdfmake** | Pure JS, no headless Chrome. Covers quotations, invoices, payslips, release notes and GRNs. |
| Excel export | **exceljs** | |
| Background jobs | Jobs table in MySQL + in-process worker, **croner** for schedules | No Redis needed. Covers backups, alerts and cleanup. |
| Logging | **pino** + `pino-http` | |
| Testing | Node's built-in test runner (`node --test`) + **supertest**, **Playwright** for end-to-end tests later | Nothing extra to learn for unit tests. |
| Deploy | Ubuntu VPS · **Caddy** (auto-HTTPS) · **systemd** or PM2 · MySQL on the same server at first | One Node process. |

**Tailwind:** not used. Bootstrap covers everything needed, and you can customise its look with a few CSS variables (brand colour, radius, font).

**Learning curve:** the new tools are **EJS**, **Alpine.js**, **Tom Select** and **Knex**. Each is small, and the project skeleton will include working examples of all four to copy from.

---

## 3. Architecture

```
       Browser / Tablet (Bootstrap pages + Alpine.js)
                         │  HTTPS
                       Caddy
                         │
       ┌──────────── Node process (Express) ───────────┐
       │  pages  → EJS views (server-rendered)          │
       │  /api/* → small JSON endpoints (lookups,        │
       │           typeahead, prefill, status polling)   │
       │  worker → job queue (backups, alerts, PDFs)     │
       └───────────────┬─────────────────┬──────────────┘
                     MySQL           /var/lib/jometech/{uploads,backups}
```

### Repository layout

```
jometech/
├─ src/
│  ├─ server.js            starts HTTP server + worker
│  ├─ app.js               express setup, middleware, routes
│  ├─ core/                db, auth, rbac, audit, numbering, storage, jobs, pdf, validate
│  ├─ modules/
│  │  └─ customers/        routes.js · service.js · views/*.ejs
│  │     (vehicles, enquiries, quotations, jobs, inventory, purchasing,
│  │      employees, attendance, payroll, qc, invoicing, reports, admin …)
│  └─ views/               layout.ejs, partials (navbar, form fields, tables, flash)
├─ public/                 css/app.css, js/app.js, vendor (bootstrap, alpine, tom-select)
├─ db/migrations/          knex migrations
├─ db/seeds/               roles, permissions, demo data
└─ docs/
```

Each module follows the same pattern: `routes.js` handles HTTP and permission checks, `service.js` holds the business rules, transactions and audit calls, and the views live next to them. Reusable **form-field partials** (`<%- include('partials/field', {...}) %>`) keep every form consistent and quick to build.

---

## 4. Cross-cutting foundations (build first)

1. **Roles and permissions with site scope.** Tables: `permissions` (seeded keys such as `jobs.update`, `inventory.issue`, `system.backup.manage`), `roles`, `role_permissions`, `user_roles`, `user_sites`. Middleware `can('jobs.update')`. List queries are filtered to the user's sites. Roles can be edited in the UI (§5).
2. **Audit trail (§53).** `audit(trx, {entity, id, action, before, after})` writes the user, time and changed fields to `audit_log` in the same transaction.
3. **Document numbering (§59).** A `number_sequences` table, with numbers allocated using `SELECT … FOR UPDATE` so there are no duplicates.
4. **Money and quantities.** Money is `DECIMAL(14,2)` in KES and quantities are `DECIMAL(14,3)`. Units of measure have conversions (sheet, kg, length).
5. **Inventory as a ledger.** A `stock_movements` table that is never edited (receive, issue, return, transfer, adjust, scrap), with an optional `job_id`. `stock_balances` is updated in the same transaction. Costing uses weighted average cost.
6. **Job as the hub (§67).** `job_id` links stock movements, labour, outsourced work, QC, variations and invoices, so job costing is one query.
7. **Configurable workflow.** `job_types` → `stage_templates` → `job_stages`.
8. **Attachments.** One shared `attachments` table for every module.
9. **Usability helpers** (see §5): `user_preferences`, `lookup` endpoints, form templates, draft autosave.

---

## 5. Usability and prefill rules (applies to every screen)

### 5.1 General rules

| Rule | What it means in practice |
|---|---|
| **Ask only for what's missing** | Every form has a short list of required fields (see 5.3). Everything else goes under a collapsed **"More details"** section that can be filled in later. |
| **Default from context** | Site = the user's site. Date/time = now. "Received by / issued by / prepared by" = the logged-in user. Currency = KES. |
| **Remember last used** | The system remembers each user's last supplier, site, driver and item quantities (`user_preferences`) and offers them first. |
| **Never retype** | Enquiry → Quotation → Job → Invoice copies all data forward with one click: **Convert to Quotation**, **Create Job**, **Generate Invoice**. Purchase Request → PO → GRN works the same way. |
| **One search box** | A global search in the navbar accepts a reg number, chassis number, phone, job number or customer name. Selecting a vehicle prefills its customer, and selecting a job prefills its vehicle, customer and site. |
| **Create in place** | If a customer or vehicle isn't found in a dropdown, choosing **"+ Add new"** opens a small modal (name + phone) and returns to the form with the new record selected. You never lose your place. |
| **Templates and "copy from"** | Each job type has a template (stages, standard BOM, spec fields). **Copy from previous job/quotation** for repeat body types (e.g. "14ft dropside"). |
| **Buttons, not forms, for status** | Moving a job to the next stage is one button ("✓ Welding done → Assembly"). Approvals are Approve / Reject buttons with an optional comment. |
| **Auto-clean input** | Reg plates are converted to uppercase without spaces (`kda 123a` → `KDA 123A`). Phones are normalised (`0712…` → `+254712…`). KRA PIN format is checked. Numbers are formatted with thousands separators. |
| **Catch duplicates early** | Typing a phone number or chassis number that already exists shows "Existing customer: ABC Transport. Use this?" |
| **Mobile and tablet first for shop-floor screens** | Large tap targets. `inputmode="numeric"` brings up the number pad. The camera opens directly for photos. Sticky Save button. |
| **Don't lose work** | Long forms (quotation, check-in) autosave a draft in the browser. Validation errors show next to the field and keep everything the user typed. |
| **Show what's next** | Each dashboard shows **"My tasks"** with action buttons: jobs to update, requests to approve, items to receive. |
| **Consistent layout** | List page (search, filters, table) → detail page (header with key info and action buttons, then tabs: Overview · Materials · Labour · Photos · Documents · History). |

### 5.2 Prefill examples by module

| Screen | User enters | System fills in |
|---|---|---|
| **Vehicle check-in** | Reg or chassis no. (search), photos | Customer, vehicle details, site, date/time, received-by. The condition checklist defaults every item to "OK", so the user only taps the exceptions. Last driver for that customer is suggested. |
| **Quick customer** | Name, phone | Customer number, default credit terms, category "Individual". |
| **Enquiry** | Customer/vehicle (search), short description | Site, salesperson = me, date. |
| **Quotation** | Pick a job type template, adjust quantities | Lines from the template BOM, **latest material prices**, labour estimate from template days × standard rate, tax, validity (e.g. 30 days), standard T&Cs, totals. |
| **Create job** | One click on an approved quotation | Customer, vehicle, spec, BOM, stages from the job type, supervisor = the site's default. |
| **Material issue** | Job (scan or search), quantities | Lines prefilled with **BOM quantity still to issue**, unit, cost, issued-by, site store. |
| **Material return** | Quantities returned | Lines = items issued to that job and not yet returned. |
| **Purchase request** | Item, quantity | Requested by, site, and the job if raised from a job's shortage list (one click, **"Request shortages"**). |
| **Purchase order** | Approve the request(s) | Supplier = the item's default or last supplier, last unit price, site, delivery date = today + supplier lead time. |
| **Goods received** | Tick **"Receive all"** or edit quantities | PO lines, quantities, unit costs, supplier, received-by, date. |
| **Attendance** | Tap exceptions only | Grid of all active staff at the site, preset to **Present**. **"Copy yesterday"** button. |
| **Labour allocation** | Confirm | Each present technician is assigned to the job(s) of their tasks for today. Only splits need editing. |
| **Weekly payroll** | Review → Approve | Days from attendance × daily rate, plus overtime, minus advances and deductions, all computed. |
| **Vehicle movement** | Destination site | From = current site, vehicle, date/time, authorised-by = me, last driver. |
| **QC inspection** | Pass / fail per item | Checklist from the job type. Fail → rework task created automatically, assigned to the stage's last technician. |
| **Invoice** | One click on a completed job | Lines from the quotation plus approved variations, deposits already paid, balance. |
| **Vehicle release** | One click | The system checks the release rules (§40) and shows a green or red checklist. If everything is green, it generates the release document. |

### 5.3 Minimum required fields (target)

| Record | Required | Everything else |
|---|---|---|
| Customer | Name, phone | Optional / "More details" |
| Vehicle | Reg **or** chassis no., customer, type | Optional |
| Check-in | Vehicle, reason | Prefilled or optional |
| Enquiry | Customer, description | Optional |
| Employee | Name, phone, trade, daily rate | Optional |
| Item | Name, category, unit | Optional (code auto-generated) |

### 5.4 UX deliverables

- A **UI kit page** (`/dev/ui`) showing every Bootstrap component, form partial and colour in use. Every screen is built from these pieces.
- **Paper prototypes or clickable mock-ups** of the 6 most-used screens (check-in, job detail, material issue, attendance, quotation, dashboard), reviewed with a supervisor and a storekeeper **before** they are built.
- **Usability test** at the end of each phase: give a real user a task ("check in KDA 123A and start a repair job") and time it. Target: the common tasks take **under 1 minute**.

---

## 6. Database backup from the front end (§54)

**User flow:** Admin → System → Backups → **Back up now**. The status goes from *Queued* to *Running* to *Completed* (or *Failed*). The admin can download, verify or delete the backup, and set the schedule and retention on the same screen.

- **Permission:** `system.backup.manage`. Download and delete also require the password to be entered again. All actions are written to the audit trail.
- **Routes:** `POST /admin/backups` adds the job to the queue and redirects to the list. The list page polls `GET /api/admin/backups/:id` every 3 s while a backup is running. Download streams the file.
- **Worker:** `child_process.spawn('mysqldump', ['--single-transaction','--quick','--routines','--triggers','--events','--no-tablespaces', …])` → `zlib.createGzip()` → AES-256-GCM encrypt (`crypto`) → file in `/var/lib/jometech/backups`. It then calculates a SHA-256 checksum and updates the `system_backups` row.
  - `--single-transaction` means users keep working during the backup.
  - Credentials come from a read-only backup MySQL user via `--defaults-extra-file`, never on the command line.
- **Concurrency:** MySQL `GET_LOCK('jometech_backup', 0)` allows only one backup at a time.
- **Table `system_backups`:** reference (`BKP-2026-00001`), type, status, include_uploads, file_path, size_bytes, sha256, storage, started_at, finished_at, initiated_by, error.
- **Schedules:** `croner` runs a nightly backup at 01:00 and the retention cleanup (7 daily / 4 weekly / 12 monthly). The deploy script takes a backup before each update.
- **Optional extras:** a `tar.gz` of uploads alongside the database dump. Off-site copies (Backblaze B2 / Cloudflare R2) in phase 2.
- **Restore:** a CLI script (`npm run db:restore <file>`) with maintenance mode in v1. A restore button in the UI comes later.

---

## 7. Delivery phases

Assumes one full-time developer. Each phase ends with a demo and a short usability test with real users.

| # | Phase | Scope (requirement §) | Est. |
|---|---|---|---|
| 0 | **Discovery & UX** | §64 Q&A with Jome-Tech, collect real paperwork, sign off v0.2, **mock-ups of the 6 key screens tested with users** | 2 wk |
| 1 | **Foundations** | Skeleton, auth, roles, sites, audit, numbering, attachments, job queue, **DB backups**, layout + UI kit + form partials, global search, deploy to staging | 3 wk |
| 2 | **Customers & vehicles** | Customers, vehicles/trailers, check-in with photos and checklist, movements, visitor register | 2–3 wk |
| 3 | **Sales** | Enquiries → quotations (templates, PDF) → create job | 2 wk |
| 4 | **Jobs & production** | Job types/templates, stages, tasks, progress and photos, BOM, variations, QC and rework, supervisor dashboard | 3 wk |
| 5 | **Inventory & purchasing** | Items, multi-site stock, issue/return, transfers, adjustments, counts, suppliers, PR → PO → GRN, shortages list | 4 wk |
| 6 | **Labour & payroll** | Employees, attendance grid, labour allocation, weekly wages, advances/deductions, payslips | 3 wk |
| 7 | **Finance & costing** | Job costing, invoices (partial), payments, release checklist and document | 2–3 wk |
| 8 | **Dashboards, reports, go-live** | Dashboards, §52 reports with Excel/PDF export, alerts, performance and security pass, data import, training | 3 wk |

**Rough MVP total: about 6 months.** Phase 2 and later work comes from the doc's "Future / Configurable" list (SMS/WhatsApp, M-Pesa API, offcuts, bay locations, customer portal, QR codes, off-site backups, UI restore).

---

## 8. Key risks and decisions to make early

- **Steel units of measure** (pieces, kg or dimensions): affects inventory design. Decide in Phase 0.
- **Labour allocation**: whole days per job, or split across jobs (§34).
- **Statutory deductions** (PAYE/NSSF/SHIF/Housing levy) or casual wages only (§33).
- **KRA eTIMS** e-invoicing, which is likely required. Confirm with Jome-Tech.
- **Accounting integration**: export only, or full sync.
- **Workshop connectivity**: if it's poor, plan offline drafts for attendance and progress updates.
- **Hosting**: a cloud VPS (recommended) or a server on site.

---

## 9. Immediate next steps

1. Send `jometech-requirements-v0.2.docx` to Jome-Tech and schedule the §64 Q&A.
2. Scaffold the project: Express 5 + EJS + Bootstrap 5 + Alpine + Tom Select + Knex + MySQL (Docker for local dev). Include a working example module (Customers) showing the patterns: list, search, quick-add modal, prefill and audit.
3. Mock up the 6 key screens and review them with a supervisor and a storekeeper.
