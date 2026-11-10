import path from 'node:path';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './core/logger.js';
import { dbIsUp } from './core/db.js';
import { navFor, isActive } from './core/nav.js';
import { formatPhone } from './core/phone.js';
import { fmt } from './core/format.js';
import { sessionMiddleware, csrfProtection, generateCsrfToken } from './core/session.js';
import { attachUser, requireLogin } from './core/auth.js';
import { router as authRoutes } from './modules/auth/routes.js';
import { router as accountRoutes } from './modules/account/routes.js';
import { router as dashboardRoutes } from './modules/dashboard/routes.js';
import { router as userRoutes } from './modules/users/routes.js';
import { router as devRoutes } from './modules/dev/routes.js';
import { router as customerRoutes } from './modules/customers/routes.js';
import { router as vehicleRoutes } from './modules/vehicles/routes.js';
import { router as searchRoutes } from './modules/search/routes.js';
import { router as checkinRoutes } from './modules/checkins/routes.js';
import { router as movementRoutes } from './modules/movements/routes.js';
import { router as visitorRoutes } from './modules/visitors/routes.js';
import { router as enquiryRoutes } from './modules/enquiries/routes.js';
import { router as proformaRoutes } from './modules/proformas/routes.js';
import { router as jobRoutes } from './modules/jobs/routes.js';
import { router as invoiceRoutes } from './modules/invoices/routes.js';
import { router as employeeRoutes } from './modules/employees/routes.js';
import { router as attendanceRoutes } from './modules/attendance/routes.js';
import { router as payrollRoutes } from './modules/payroll/routes.js';
import { router as jobTypeRoutes } from './modules/job-types/routes.js';
import { router as itemRoutes } from './modules/items/routes.js';
import { router as supplierRoutes } from './modules/suppliers/routes.js';
import { router as purchasingRoutes } from './modules/purchasing/routes.js';
import { router as stockRoutes } from './modules/stock/routes.js';
import { router as issueRoutes } from './modules/issues/routes.js';
import { router as siteRoutes } from './modules/sites/routes.js';
import { router as reportRoutes } from './modules/reports/routes.js';
import { router as privacyRoutes, revealUrl } from './modules/privacy/routes.js';

const root = path.resolve(import.meta.dirname, '..');

export function createApp() {
  const app = express();

  // On the server, Caddy sits in front and handles https. Trusting it lets
  // secure cookies work and gives the real client IP to the login rate limit.
  if (config.isProd) app.set('trust proxy', 1);

  // ---- Views: EJS + shared layouts (src/views/layout.ejs, layout-auth.ejs) ----
  // Two view folders: shared views (layouts, partials, error pages) and modules,
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

  // ---- Defaults every view can rely on, even on an error page shown early ----
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      appName: config.appName, title: config.appName, path: req.path,
      isActive, formatPhone, fmt, revealUrl, nav: [], user: null, site: null, siteLocked: false, flash: null, csrfToken: '',
    });
    next();
  });

  // ---- Request logging (skip static files to keep the log readable) ----
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => /^\/(vendor|css|js|img)\//.test(req.url) },
    customSuccessMessage: (req, res, ms) => `${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(ms)}ms`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.originalUrl} ${res.statusCode} ${err.message}`,
  }));

  // ---- Static files (before sessions, so images and CSS don't touch the database) ----
  // Our own files, then front-end libraries served straight from node_modules
  // (no copying, no build step; `npm update` updates them).
  app.use(express.static(path.join(root, 'public')));
  const vendor = (url, dir) => app.use(url, express.static(path.join(root, 'node_modules', dir)));
  vendor('/vendor/bootstrap', 'bootstrap/dist');
  vendor('/vendor/bootstrap-icons', 'bootstrap-icons/font');
  vendor('/vendor/alpinejs', 'alpinejs/dist');
  vendor('/vendor/tom-select', 'tom-select/dist');
  vendor('/vendor/fonts', '@fontsource');

  // For uptime monitors: 503 when the database can't be reached.
  app.get('/health', async (req, res) => {
    const dbUp = await dbIsUp();
    res.status(dbUp ? 200 : 503).json({ ok: dbUp, db: dbUp ? 'up' : 'down' });
  });

  // ---- Forms, sessions, CSRF, logged-in user ----
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware);
  app.use(attachUser);
  app.use((req, res, next) => {
    res.locals.nav = req.user ? navFor(req.user) : [];
    res.locals.csrfToken = generateCsrfToken(req);
    // One-off message after a redirect ("Password changed."), shown once.
    res.locals.flash = req.session.flash ?? null;
    delete req.session.flash;
    next();
  });
  app.use(csrfProtection); // checks POST/PUT/PATCH/DELETE; GET pages pass through

  // ---- Routes ----
  app.use(authRoutes);          // /login, /logout: open to everyone
  app.use(requireLogin);        // everything below needs a logged-in user
  app.use(accountRoutes);
  app.use(dashboardRoutes);
  app.use(userRoutes);
  app.use(devRoutes);
  app.use(customerRoutes);
  app.use(vehicleRoutes);
  app.use(searchRoutes);
  app.use(checkinRoutes);
  app.use(movementRoutes);
  app.use(visitorRoutes);
  app.use(enquiryRoutes);
  app.use(proformaRoutes);
  app.use(jobRoutes);
  app.use(invoiceRoutes);
  app.use(employeeRoutes);
  app.use(attendanceRoutes);
  app.use(payrollRoutes);
  app.use(jobTypeRoutes);
  app.use(itemRoutes);
  app.use(supplierRoutes);
  app.use(purchasingRoutes);
  app.use(stockRoutes);
  app.use(issueRoutes);
  app.use(siteRoutes);
  app.use(reportRoutes);
  app.use(privacyRoutes);

  // ---- 404 and errors ----
  app.use((req, res) => {
    res.status(404).render('error', { title: 'Page not found', status: 404, message: "We couldn't find that page. Check the address, or go back to the dashboard." });
  });

  // Express 5 sends errors thrown in async handlers here automatically.
  app.use((err, req, res, next) => {
    let status = err.status ?? err.statusCode ?? 500;
    let message = err.expose ? err.message : (config.isProd ? 'The error has been logged. Try again, and tell the administrator if it keeps happening.' : err.message);
    if (err.code === 'EBADCSRFTOKEN') {
      status = 403;
      message = 'This form has expired. Go back, reload the page and try again.';
    }
    if (status >= 500) req.log.error(err);
    else req.log.warn(err.message);

    res.status(status).render('error', {
      layout: res.locals.user ? 'layout' : 'layout-auth',
      title: status === 403 ? 'No access' : 'Something went wrong',
      status,
      message,
    });
  });

  return app;
}
