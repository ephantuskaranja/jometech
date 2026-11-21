import { db } from './db.js';

// Shortcut buttons to the next screen in the workshop flow, shown in the message after each step
// (partials/flash: flash.actions). The flow:
//
//   check-in ─▶ driver signs ─▶ job opened ─▶ started ─▶ steps … ─▶ quality check ─▶ customer sign-off
//            ─▶ completed ─▶ invoice ─▶ payment ─▶ release ─▶ gate clears it out
//
// Each helper only offers what the person is allowed to do, and only what makes sense now.

/**
 * After something changed on a job: where to go next.
 * @param {{ can: (p: string) => boolean }} user
 * @param {number} jobId
 * @returns {Promise<{ label: string, href?: string, post?: string, fields?: object, icon?: string, primary?: boolean }[]>}
 */
export async function afterJobChange(user, jobId) {
  const job = await db('jobs').where({ id: jobId }).first('id', 'number', 'status', 'checkin_id', 'started_at');
  if (!job) return [];
  const actions = [];
  if (job.status === 'open' && user.can('jobs.manage')) {
    actions.push({ label: 'Print the job card', href: `/jobs/${job.id}/print`, icon: 'printer' });
    actions.push({ label: 'Start the job', post: `/jobs/${job.id}/start`, icon: 'play-fill', primary: true });
  }
  if (job.status === 'in_progress') {
    const step = await db('job_steps').where({ job_id: job.id, status: 'pending' }).orderBy('sort_order').first('id', 'name', 'is_qc', 'is_signoff');
    if (step?.is_qc && user.can('qc.manage')) actions.push({ label: 'Start the quality check', post: `/jobs/${job.id}/qc`, icon: 'shield-check', primary: true });
    else if (step?.is_signoff && user.can('jobs.manage')) actions.push({ label: 'Customer sign-off', href: `/jobs/${job.id}/signoff`, icon: 'pen', primary: true });
  }
  if (job.status === 'completed') {
    if (user.can('invoices.manage')) {
      const inv = await db('invoices').where({ job_id: job.id }).whereIn('status', ['draft', 'issued']).orderBy('id', 'desc').first('id', 'status', 'number');
      if (!inv) actions.push({ label: 'Make the invoice', href: `/jobs/${job.id}/invoice`, icon: 'receipt', primary: true });
      else if (inv.status === 'draft') actions.push({ label: 'Check and issue the invoice', href: `/invoices/${inv.id}`, icon: 'receipt', primary: true });
      else actions.push({ label: 'Record a payment', href: `/jobs/${job.id}#payments`, icon: 'cash-coin', primary: true });
    }
    if (job.checkin_id && user.can('checkin.manage')) {
      const checkin = await db('checkins').where({ id: job.checkin_id }).first('id', 'status');
      if (checkin?.status === 'in_workshop') actions.push({ label: 'Release checklist', href: `/check-in/${checkin.id}#release-checklist`, icon: 'list-check' });
    }
  }
  return actions;
}

/**
 * After the check-in is confirmed (signed, or saved without a signature): photos, then the job.
 * @param {{ can: (p: string) => boolean }} user
 * @param {{ id: number, vehicle_id: number }} checkin
 */
export async function afterCheckin(user, checkin) {
  const actions = [{ label: 'Add photos', href: `/check-in/${checkin.id}#photos`, icon: 'camera' }];
  actions.push({ label: 'Print receiving note', href: `/check-in/${checkin.id}/print`, icon: 'printer' });
  if (user.can('jobs.manage')) {
    const job = await db('jobs').where({ checkin_id: checkin.id }).whereIn('status', ['open', 'in_progress']).orderBy('id', 'desc').first('id', 'number');
    actions.unshift(job
      ? { label: `Open ${job.number}`, href: `/jobs/${job.id}`, icon: 'wrench', primary: true }
      : { label: 'Open a job', href: `/jobs/new?vehicle_id=${checkin.vehicle_id}`, icon: 'plus-lg', primary: true });
  }
  return actions;
}
