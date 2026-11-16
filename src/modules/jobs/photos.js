import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import { saveFile, removeFile } from '../../core/storage.js';
import { processPhoto } from '../checkins/service.js';

// Job progress photos, filed under the step the job was at when taken. Added and deleted while the
// job is open or in progress; kept (read-only) once it is completed.

export const MAX_JOB_PHOTOS = 60;

async function openJob(trx, jobId) {
  const job = await trx('jobs').where({ id: jobId }).forUpdate().first('id', 'number', 'status');
  if (!job) throw httpError(404, 'That job doesn’t exist.');
  if (!['open', 'in_progress'].includes(job.status)) throw httpError(409, `${job.number} is ${job.status}, so its photos can’t change.`);
  return job;
}
const photoCount = async (q, jobId) => Number((await q('job_photos').where({ job_id: jobId }).count({ n: '*' }))[0].n);
const tooMany = () => httpError(409, `A job can have up to ${MAX_JOB_PHOTOS} photos. Delete one to add another.`);

/** Saves one photo under the job's current step; returns its id. */
export async function addPhoto(jobId, buffer, actor) {
  if ((await photoCount(db, jobId)) >= MAX_JOB_PHOTOS) throw tooMany(); // before the slow part
  const { full, thumb } = await processPhoto(buffer);
  const files = [];
  try {
    files.push(await saveFile('photos', full, 'webp'), await saveFile('photos', thumb, 'webp'));
    return await db.transaction(async (trx) => {
      const job = await openJob(trx, jobId);
      if ((await photoCount(trx, jobId)) >= MAX_JOB_PHOTOS) throw tooMany();
      const step = await trx('job_steps').where({ job_id: jobId, status: 'pending' }).orderBy('sort_order').first('id', 'name');
      const [id] = await trx('job_photos').insert({ job_id: jobId, step_id: step?.id ?? null, step_name: step?.name ?? null, path: files[0], thumb_path: files[1], bytes: full.length + thumb.length, uploaded_by: actor.user.id });
      await audit(trx, actor, { entity: 'job', id: jobId, action: 'photo_added', summary: step ? `At ${step.name}` : `To ${job.number}` });
      return id;
    });
  } catch (err) {
    for (const rel of files) await removeFile(rel); // not saved: don't leave the images behind
    throw err;
  }
}

export async function deletePhoto(jobId, photoId, actor) {
  const photo = await db.transaction(async (trx) => {
    await openJob(trx, jobId);
    const row = await trx('job_photos').where({ id: photoId, job_id: jobId }).first();
    if (!row) throw httpError(404, 'That photo has already been deleted.');
    await trx('job_photos').where({ id: photoId }).delete();
    await audit(trx, actor, { entity: 'job', id: jobId, action: 'photo_deleted', summary: row.step_name ? `At ${row.step_name}` : null });
    return row;
  });
  await removeFile(photo.path);
  await removeFile(photo.thumb_path);
}

export const getPhoto = (jobId, photoId) => db('job_photos').where({ id: photoId, job_id: jobId }).first('path', 'thumb_path');

/**
 * A job's photos grouped by step, in the order of the steps (photos with no step last).
 * @returns {Promise<{ total: number, groups: { stepId: number|null, name: string, photos: number[] }[] }>}
 */
export async function forJob(jobId, steps) {
  const rows = await db('job_photos').where({ job_id: jobId }).orderBy('id').select('id', 'step_id', 'step_name');
  const groups = [];
  for (const s of steps) {
    const photos = rows.filter((r) => r.step_id === s.id).map((r) => r.id);
    groups.push({ stepId: s.id, name: s.name, photos });
  }
  const loose = rows.filter((r) => !steps.some((s) => s.id === r.step_id));
  if (loose.length) groups.push({ stepId: null, name: 'Other photos', photos: loose.map((r) => r.id) });
  return { total: rows.length, groups };
}

/** Every stored file of these jobs' photos (tests clean them up). */
export async function filesOf(jobIds) {
  const rows = await db('job_photos').whereIn('job_id', jobIds).select('path', 'thumb_path');
  return rows.flatMap((r) => [r.path, r.thumb_path]);
}
