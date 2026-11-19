import { Router } from 'express';
import multer from 'multer';
import { sysadminOnly } from '../../core/auth.js';
import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import { loadBook, readSheet } from './sheet.js';
import * as customers from './customers.js';
import * as items from './items.js';
import * as employees from './employees.js';

// System → Import data (System Administrator only): download a template, fill it in Excel, upload it, check the
// preview (what will be added, skipped or is wrong), then import. Nothing is added before that.

export const router = Router();
router.use('/admin/import', sysadminOnly);

export const KINDS = { [customers.KIND]: customers, [items.KIND]: items, [employees.KIND]: employees };
const kindOf = (name) => KINDS[name] ?? (() => { throw httpError(404, 'That kind of import doesn’t exist.'); })();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');
const receive = (req, res) => new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve(req.file))));

const parse = (row) => ({ ...row, rows: typeof row.rows === 'string' ? JSON.parse(row.rows) : row.rows });
const countOf = (sheets) => {
  const all = Object.values(sheets).flat();
  return { add: all.filter((r) => r.status === 'add').length, skip: all.filter((r) => r.status === 'skip').length, error: all.filter((r) => r.status === 'error').length };
};

router.get('/admin/import', async (req, res) => {
  const recent = (await db('imports as i').leftJoin('users as u', 'u.id', 'i.created_by').orderBy('i.id', 'desc').limit(20)
    .select('i.id', 'i.kind', 'i.file_name', 'i.status', 'i.summary', 'i.created_at', 'u.name as by')).map((r) => ({ ...r, title: KINDS[r.kind]?.TITLE ?? r.kind }));
  res.render('imports/views/index', { title: 'Import data', kinds: Object.values(KINDS), recent });
});

router.get('/admin/import/:kind/template.xlsx', async (req, res) => {
  const kind = kindOf(req.params.kind);
  res.attachment(`jome-tech-import-${kind.KIND}.xlsx`);
  await kind.template().xlsx.write(res);
  res.end();
});

router.post('/admin/import/:kind', async (req, res) => {
  const kind = kindOf(req.params.kind);
  // Sent by uploadForm (public/js/app.js), which follows { go } in the answer.
  const back = (text) => { req.session.flash = { type: 'warning', text }; res.json({ go: '/admin/import' }); };
  let file;
  try {
    file = await receive(req, res);
  } catch (err) {
    return back(err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (over 5 MB).' : 'The file didn’t arrive. Try again.');
  }
  if (!file) return back('Choose the filled-in Excel file first.');
  let book;
  try {
    book = await loadBook(file.buffer);
  } catch {
    return back('That isn’t an Excel file (.xlsx) the app can read. Save it as .xlsx and try again.');
  }
  const sheets = {};
  for (const s of kind.SHEETS) {
    const read = readSheet(book, s.name, s.fields);
    sheets[s.name] = read?.rows ?? [];
  }
  if (!Object.values(sheets).some((rows) => rows.length)) return back(`Nothing to import: the ${kind.SHEETS.map((s) => `“${s.name}”`).join(' and ')} sheet${kind.SHEETS.length > 1 ? 's are' : ' is'} empty or missing. Use the template.`);
  const checked = await kind.check(sheets);
  const [id] = await db('imports').insert({ kind: kind.KIND, file_name: String(file.originalname).slice(0, 200), rows: JSON.stringify(checked), created_by: req.user.id });
  res.json({ go: `/admin/import/${id}` });
});

async function loadImport(req) {
  const row = await db('imports as i').leftJoin('users as u', 'u.id', 'i.created_by').where('i.id', Number(req.params.id)).first('i.*', 'u.name as by');
  if (!row || !KINDS[row.kind]) throw httpError(404, 'That import doesn’t exist.');
  return parse(row);
}

router.get('/admin/import/:id', async (req, res) => {
  const imp = await loadImport(req);
  const kind = KINDS[imp.kind];
  res.render('imports/views/preview', { title: `Import: ${kind.TITLE}`, imp, kind, counts: countOf(imp.rows) });
});

router.post('/admin/import/:id/run', async (req, res) => {
  const imp = await loadImport(req);
  if (imp.status !== 'preview') throw httpError(409, 'This import has already been done or discarded.');
  // Claim it first, so a double click can't import twice.
  const claimed = await db('imports').where({ id: imp.id, status: 'preview' }).update({ status: 'done', finished_at: db.fn.now() });
  if (!claimed) throw httpError(409, 'This import has already been done or discarded.');
  const { summary, failed } = await KINDS[imp.kind].run(imp.rows, req);
  const text = `${summary}${failed.length ? `; ${failed.length} failed` : ''}`;
  await db('imports').where({ id: imp.id }).update({ summary: text.slice(0, 500) });
  await audit(db, req, { entity: 'import', id: imp.id, action: 'import_done', summary: `${KINDS[imp.kind].TITLE} from ${imp.file_name}: ${text}`.slice(0, 1000) });
  req.session.flash = { type: failed.length ? 'warning' : 'success', text: `${text}.${failed.length ? ` ${failed.slice(0, 3).join(' · ')}` : ''}` };
  res.redirect(`/admin/import/${imp.id}`);
});

router.post('/admin/import/:id/discard', async (req, res) => {
  const imp = await loadImport(req);
  await db('imports').where({ id: imp.id, status: 'preview' }).update({ status: 'discarded', finished_at: db.fn.now() });
  req.session.flash = { type: 'success', text: 'Import discarded. Nothing was added.' };
  res.redirect('/admin/import');
});
