import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError } from '../../core/validate.js';

// The guides, always at hand: the PDFs kept in docs/ (refreshed with the guides, deployed with the app).
// User guide for everyone logged in; the test guide for admins (it is for whoever tests the modules).

export const router = Router();
const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs');

const GUIDES = {
  'user-guide': { file: 'Jome-Tech User Guide.pdf', adminOnly: false },
  'test-guide': { file: 'Jome-Tech Test Guide for Modules.pdf', adminOnly: true },
};

router.get('/help/:guide', (req, res, next) => {
  const guide = GUIDES[req.params.guide];
  if (!guide) return next();
  if (guide.adminOnly && !req.user.isAdmin) throw httpError(403, 'The test guide is for admins.');
  // Opens in the browser's PDF viewer (read, print, download); always the copy just deployed.
  res.set('Cache-Control', 'no-cache');
  res.sendFile(guide.file, { root: docs, headers: { 'Content-Disposition': `inline; filename="${guide.file}"` } }, (err) => {
    if (err) next(err.status === 404 ? httpError(404, 'The guide isn’t on this server yet.') : err);
  });
});
