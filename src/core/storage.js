// Files kept outside public/ (signatures, photos), so only logged-in users get them:
//
//   const rel = await saveFile('signatures', buffer, 'png');   // 'signatures/2026/11/k3f9….png'
//   res.sendFile(storagePath(rel));
//
// The database stores the relative path; the folder can move (STORAGE_DIR in .env).
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';

const root = path.resolve(config.storageDir);

/** Saves under <kind>/YYYY/MM/ with a random name. Returns the relative path. */
export async function saveFile(kind, buffer, ext) {
  const now = new Date();
  const dir = path.join(kind, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
  await mkdir(path.join(root, dir), { recursive: true });
  const rel = path.join(dir, `${randomBytes(12).toString('hex')}.${ext}`).split(path.sep).join('/');
  await writeFile(path.join(root, rel), buffer, { flag: 'wx' });
  return rel;
}

/** Absolute path of a stored file. Refuses anything that would leave the storage folder. */
export function storagePath(rel) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error(`Not a storage path: ${rel}`);
  return full;
}

export async function removeFile(rel) {
  if (rel) await rm(storagePath(rel), { force: true });
}
