import { Router } from 'express';
import { can, verifyPassword } from '../../core/auth.js';
import { audit } from '../../core/audit.js';
import { db } from '../../core/db.js';
import { httpError } from '../../core/validate.js';
import * as backups from './service.js';

// System → Backups: back up now (optionally with photos and files), check, download, delete.
// Download and delete ask for the admin's password again. Restoring is done on the server (docs/DEPLOY.md).
export const router = Router();
router.use(['/admin/backups', '/api/admin/backups'], can('system.backup.manage'));

async function loadBackup(req) {
  const id = Number(req.params.id);
  const backup = Number.isInteger(id) ? await backups.getBackup(id) : null;
  if (!backup) throw httpError(404, 'That backup doesn’t exist.');
  return backup;
}

/** The admin's own password, typed again. */
async function passwordOk(req) {
  const { password_hash: hash } = await db('users').where({ id: req.user.id }).first('password_hash');
  return verifyPassword(hash, String(req.body.password ?? ''));
}

const back = (req, res, type, text) => {
  req.session.flash = { type, text };
  res.redirect('/admin/backups');
};

router.get('/admin/backups', async (req, res) => {
  res.render('backups/views/index', {
    title: 'Backups',
    list: await backups.listBackups(),
    disk: await backups.diskSpace(),
  });
});

router.post('/admin/backups', async (req, res) => {
  try {
    const { number } = await backups.startBackup({ kind: 'manual', withFiles: req.body.with_files === '1', actor: req });
    back(req, res, 'info', `${number} started. People can keep working; this page updates when it’s done.`);
  } catch (err) {
    if (err.status !== 409) throw err;
    back(req, res, 'warning', err.message);
  }
});

// The list page asks every few seconds while a backup runs.
router.get('/api/admin/backups/running', async (req, res) => {
  res.json({ running: await backups.isRunning() });
});

router.post('/admin/backups/:id/check', async (req, res) => {
  const backup = await loadBackup(req);
  const { ok, problems } = await backups.checkBackup(backup.id, req);
  const name = backup.number ?? backup.file_name;
  if (ok) back(req, res, 'success', `${name} checked: the file is good.`);
  else back(req, res, 'warning', `${name} has a problem: ${problems.join('; ')}. Make a new backup.`);
});

router.post('/admin/backups/:id/download', async (req, res) => {
  const backup = await loadBackup(req);
  if (!(await passwordOk(req))) return back(req, res, 'warning', 'Wrong password. Nothing was downloaded.');
  const which = req.body.which === 'files' ? 'files' : 'db';
  const file = backups.filePath(backup, which);
  if (!file) throw httpError(404, 'That file isn’t there.');
  await audit(db, req, { entity: 'backup', id: backup.id, action: 'downloaded', summary: which === 'files' ? 'Photos and files' : 'Database' });
  res.download(file, (err) => {
    if (err && !res.headersSent) back(req, res, 'warning', 'The file couldn’t be sent. Check the backup.');
  });
});

router.post('/admin/backups/:id/delete', async (req, res) => {
  const backup = await loadBackup(req);
  if (!(await passwordOk(req))) return back(req, res, 'warning', 'Wrong password. Nothing was deleted.');
  try {
    await backups.deleteBackup(backup.id, req);
  } catch (err) {
    if (err.status !== 409) throw err;
    return back(req, res, 'warning', err.message);
  }
  back(req, res, 'success', `${backup.number ?? backup.file_name} deleted.`);
});
