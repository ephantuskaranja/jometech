import { db } from './db.js';
import { saveFile, removeFile } from './storage.js';

// A member of staff's own signature, saved once (Account → My signature) and printed on the
// documents they are responsible for. Documents show it as an image from /staff-signatures/:id.png;
// the ?v= part changes when they save a new one, so a printed page never shows an old copy.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** "data:image/png;base64,…" from the signature pad → PNG bytes, or null. */
export function pngFromDataUrl(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  return buf && buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC) ? buf : null;
}

export async function saveSignature(userId, png) {
  const rel = await saveFile('signatures', png, 'png');
  const before = await db('users').where({ id: userId }).first('signature_path');
  await db('users').where({ id: userId }).update({ signature_path: rel, signature_saved_at: db.fn.now() });
  if (before?.signature_path) await removeFile(before.signature_path).catch(() => {});
}

export async function deleteSignature(userId) {
  const before = await db('users').where({ id: userId }).first('signature_path');
  await db('users').where({ id: userId }).update({ signature_path: null, signature_saved_at: null });
  if (before?.signature_path) await removeFile(before.signature_path).catch(() => {});
}

export const signaturePathOf = async (userId) => (userId ? (await db('users').where({ id: userId }).first('signature_path'))?.signature_path ?? null : null);

/**
 * For printed documents: who signs, keyed by role on the document.
 *   await staffSignatures({ prepared: invoice.created_by, supervisor: job.supervisor_id })
 *   → { prepared: { name, url } | null, supervisor: { name, url } | null }
 * url is null when the person hasn't saved a signature (the line stays blank to sign by hand).
 */
export async function staffSignatures(byRole) {
  const ids = [...new Set(Object.values(byRole).filter(Boolean))];
  const rows = ids.length ? await db('users').whereIn('id', ids).select('id', 'name', 'signature_path', 'signature_saved_at') : [];
  return Object.fromEntries(Object.entries(byRole).map(([role, id]) => {
    const u = rows.find((r) => r.id === id);
    if (!u) return [role, null];
    const v = u.signature_saved_at ? new Date(u.signature_saved_at).getTime() : 0;
    return [role, { name: u.name, url: u.signature_path ? `/staff-signatures/${u.id}.png?v=${v}` : null }];
  }));
}
