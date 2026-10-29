# Jome-Tech

Fabrication and workshop management system: check-in, jobs, stores, purchasing, attendance, payroll and invoicing.

The project plan is in [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

## Requirements

- Node.js 24 or later
- MySQL 8.4 LTS in production. Development also runs on MySQL 9.x; keep SQL to features both versions have.

## Run it

```bash
npm install
cp .env.example .env     # then edit .env
npm run dev              # http://localhost:3000, restarts when a file changes
npm test                 # runs everything in test/
```

## Stack

| Layer | Tool |
|---|---|
| Server | Express 5, plain JavaScript (ES modules), no build step |
| Pages | EJS templates + `express-ejs-layouts` |
| UI | Bootstrap 5.3, Bootstrap Icons, Alpine.js |
| Fonts | Archivo (headings), Figtree (text), IBM Plex Mono (numbers, codes), served locally from `@fontsource` |
| Logging | pino + pino-http |
| Tests | `node --test` + supertest |

Front-end libraries are served straight from `node_modules` under `/vendor/...` (see `src/app.js`).

## Folders

```
src/
  server.js          starts the HTTP server
  app.js             Express setup: views, security headers, static files, routes, errors
  config.js          every setting read from .env
  core/              shared code (logger, navigation; later db, auth, audit…)
  modules/<name>/    one folder per feature: routes.js + views/
  views/             layout.ejs, partials/, error.ejs
public/
  css/app.css        Jome-Tech theme on top of Bootstrap (light + dark)
  js/theme.js        light / dark / match-device switch
  js/app.js          small shared behaviours
test/                node --test files
```

## Theme

The theme button in the top bar switches between Light, Dark and Match device. Bootstrap 5.3 reads `data-bs-theme` on `<html>`, and `public/js/theme.js` sets it before the page draws. Colours are CSS variables at the top of `public/css/app.css`; change them there, not in individual pages.
