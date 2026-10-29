import path from 'node:path';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './core/logger.js';
import { nav, isActive } from './core/nav.js';
import { router as dashboardRoutes } from './modules/dashboard/routes.js';

const root = path.resolve(import.meta.dirname, '..');

export function createApp() {
  const app = express();

  // ---- Views: EJS + one shared layout (src/views/layout.ejs) ----
  // Two view folders: shared views (layout, partials, error pages) and modules,
  // so a module renders its own files, e.g. res.render('dashboard/views/index').
  app.set('view engine', 'ejs');
  app.set('views', [path.join(root, 'src/views'), path.join(root, 'src/modules')]);
  app.use(expressLayouts);
  app.set('layout', 'layout');

  // ---- Security headers ----
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        // Alpine.js evaluates its x-data / @click expressions with new Function(),
        // which the browser treats like eval, so it needs 'unsafe-eval'.
        'script-src': ["'self'", "'unsafe-eval'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        // Would break plain-http testing from a tablet on the LAN; Caddy serves https in production.
        'upgrade-insecure-requests': config.isProd ? [] : null,
      },
    },
  }));

  // ---- Request logging (skip static files to keep the log readable) ----
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => /^\/(vendor|css|js|img)\//.test(req.url) },
    customSuccessMessage: (req, res, ms) => `${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(ms)}ms`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.originalUrl} ${res.statusCode} ${err.message}`,
  }));

  // ---- Static files ----
  // Our own files, then front-end libraries served straight from node_modules
  // (no copying, no build step; `npm update` updates them).
  app.use(express.static(path.join(root, 'public')));
  const vendor = (url, dir) => app.use(url, express.static(path.join(root, 'node_modules', dir)));
  vendor('/vendor/bootstrap', 'bootstrap/dist');
  vendor('/vendor/bootstrap-icons', 'bootstrap-icons/font');
  vendor('/vendor/alpinejs', 'alpinejs/dist');
  vendor('/vendor/fonts', '@fontsource');

  // ---- Values every view can use ----
  app.use((req, res, next) => {
    res.locals.appName = config.appName;
    res.locals.title = config.appName;
    res.locals.path = req.path;
    res.locals.nav = nav;
    res.locals.isActive = isActive;
    // Placeholder until login is built.
    res.locals.user = { name: 'Demo user', initials: 'DU', role: 'Not signed in' };
    res.locals.site = { name: 'Ruaraka Workshop' };
    next();
  });

  // ---- Routes ----
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use(dashboardRoutes);

  // ---- 404 and errors ----
  app.use((req, res) => {
    res.status(404).render('error', { title: 'Page not found', status: 404, message: "We couldn't find that page. Check the address, or go back to the dashboard." });
  });

  // Express 5 sends errors thrown in async handlers here automatically.
  app.use((err, req, res, next) => {
    req.log.error(err);
    const status = err.status ?? 500;
    res.status(status).render('error', {
      title: 'Something went wrong',
      status,
      message: config.isProd ? 'The error has been logged. Try again, and tell the administrator if it keeps happening.' : err.message,
    });
  });

  return app;
}
