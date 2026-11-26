import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The company stamp on printed documents (views/partials/stamp.ejs). Kept out of public/ so it is
// served only to someone logged in: anyone could otherwise download it and stamp a fake document.

export const router = Router();
const here = path.dirname(fileURLToPath(import.meta.url));

router.get('/company-stamp.png', (req, res, next) => {
  res.set('Cache-Control', 'private, max-age=86400'); // the browser keeps it a day; shared caches never do
  res.sendFile('company-stamp.png', { root: here }, (err) => err && next(err));
});
