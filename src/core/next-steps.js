import { db } from './db.js';

// The next screen in the workshop flow: the "Next step" bar on the check-in, job and invoice pages
// (partials/next-step), and buttons in messages that land somewhere without one. The flow:
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
    const step = await db('job_steps').where({ job_id: job.id, status: 'pending' }).orderBy('sort_order').first('id', 'name', 'is_receive', 'is_qc', 'is_signoff');
    const vehicle = step?.is_receive ? await db('jobs').where({ id: job.id }).first('vehicle_id') : null;
    if (vehicle?.vehicle_id && user.can('checkin.manage')) actions.push({ label: 'Check the vehicle in', href: `/check-in/new?vehicle_id=${vehicle.vehicle_id}`, icon: 'truck', primary: true });
    else if (step?.is_qc && user.can('qc.manage')) actions.push({ label: 'Start the quality check', post: `/jobs/${job.id}/qc`, icon: 'shield-check', primary: true });
    else if (step?.is_signoff && user.can('jobs.manage')) actions.push({ label: 'Customer sign-off', href: `/jobs/${job.id}/signoff`, icon: 'pen', primary: true });
  }
  if (job.status === 'completed') {
    const inv = await db('invoices').where({ job_id: job.id }).whereIn('status', ['draft', 'issued']).orderBy('id', 'desc').first('id', 'status', 'number', 'total');
    const owing = inv?.status === 'issued' ? await balanceOf(job.id, inv.total) : null;
    const paidUp = owing !== null && owing <= 0;
    if (user.can('invoices.manage')) {
      if (!inv) actions.push({ label: 'Make the invoice', href: `/jobs/${job.id}/invoice`, icon: 'receipt', primary: true });
      else if (inv.status === 'draft') actions.push({ label: 'Check and issue the invoice', href: `/invoices/${inv.id}`, icon: 'receipt', primary: true });
      else if (!paidUp) actions.push({ label: 'Record a payment', href: `/jobs/${job.id}#payments`, icon: 'cash-coin', primary: true });
    }
    if (job.checkin_id && user.can('checkin.manage')) {
      const checkin = await db('checkins').where({ id: job.checkin_id }).first('id', 'status');
      if (checkin?.status === 'in_workshop') {
        actions.push(paidUp
          ? { label: 'Release the vehicle', href: `/check-in/${checkin.id}/release`, icon: 'box-arrow-right', primary: !actions.some((a) => a.primary) }
          : { label: 'Release checklist', href: `/check-in/${checkin.id}#release-checklist`, icon: 'list-check' });
      }
    }
  }
  return actions;
}

/** What is still owed on a job's issued invoice (payments not voided). */
async function balanceOf(jobId, total) {
  const [{ paid }] = await db('payments').where({ job_id: jobId }).whereNull('voided_at').select(db.raw('COALESCE(SUM(amount), 0) as paid'));
  return Math.round((Number(total) - Number(paid)) * 100) / 100;
}

/**
 * The one thing to do next for a vehicle in the workshop, shown at the top of its check-in page:
 *   driver signs → open a job → the job's current step → invoice / payment → release → gate.
 * @param {{ can: (p: string) => boolean }} user
 * @param {object} checkin  the check-in (getCheckin), with .move when it is between sites
 * @param {{ jobs: { id: number, number: string, status: string }[], list: object|null, release: object|null }} state
 * @returns {Promise<{ text: string, tone: 'info'|'warning'|'success', actions: object[] } | null>}
 */
export async function forCheckin(user, checkin, { jobs, list, release }) {
  const id = checkin.id;
  if (checkin.status === 'checked_out') return { tone: 'success', text: 'Done: the vehicle has left.', actions: [] };
  if (checkin.status === 'released') {
    return {
      tone: 'info', text: 'Released to the customer. The gate checks it out as it leaves.',
      actions: release ? [{ label: `Print release note ${release.number}`, href: `/check-in/${id}/release-note`, icon: 'printer' }] : [],
    };
  }
  if (checkin.status !== 'in_workshop' || checkin.move) return null; // a move shows its own card
  if (!checkin.driver_signed_at && !checkin.not_signed_reason) {
    return {
      tone: 'warning', text: 'The person who brought the vehicle checks what was received and signs.',
      actions: user.can('checkin.manage') ? [{ label: 'Driver signs now', href: `/check-in/${id}/sign`, icon: 'pen', primary: true }] : [],
    };
  }
  const live = jobs.filter((j) => j.status !== 'cancelled');
  if (!live.length) {
    return {
      tone: 'info', text: 'No job yet. Open one for the work on this vehicle.',
      actions: user.can('jobs.manage') ? [{ label: 'Open a job', href: `/jobs/new?vehicle_id=${checkin.vehicle_id}`, icon: 'plus-lg', primary: true }] : [],
    };
  }
  const running = live.find((j) => ['open', 'in_progress'].includes(j.status));
  if (running) {
    const step = running.status === 'in_progress'
      ? await db('job_steps').where({ job_id: running.id, status: 'pending' }).orderBy('sort_order').first('name') : null;
    return {
      tone: 'info',
      text: running.status === 'open' ? `${running.number} is open: start it when work begins.` : `Work in progress on ${running.number}${step ? `: ${step.name}` : ''}.`,
      actions: [{ label: `Go to ${running.number}`, href: `/jobs/${running.id}`, icon: 'wrench', primary: true }],
    };
  }
  // All the work is done: the release checklist decides.
  if (list?.ok || checkin.release_allowed_at) {
    return {
      tone: 'success', text: 'Work done and paid. Release the vehicle to the customer.',
      actions: user.can('checkin.manage') ? [{ label: 'Release the vehicle', href: `/check-in/${id}/release`, icon: 'box-arrow-right', primary: true }] : [],
    };
  }
  const missing = list.items.find((i) => !i.ok);
  const actions = [];
  for (const j of list.jobs) {
    if (actions.length) break;
    if (!j.invoice && user.can('invoices.manage')) actions.push({ label: `Invoice ${j.number}`, href: `/jobs/${j.id}/invoice`, icon: 'receipt', primary: true });
    else if (j.invoice && j.invoice.balance > 0 && user.can('invoices.manage')) actions.push({ label: `Record payment for ${j.invoice.number}`, href: `/jobs/${j.id}#payments`, icon: 'cash-coin', primary: true });
  }
  actions.push({ label: 'See the checklist', href: `/check-in/${id}#release-checklist`, icon: 'list-check' });
  const why = { invoiced: 'Work done: it needs its invoice before it can go.', paid: 'Work done and invoiced: waiting for payment before it can go.', qc: 'Waiting for the quality check to pass.' };
  return { tone: 'warning', text: why[missing?.key] ?? `${missing?.label ?? 'Something'} still to do before it can go.`, actions };
}

/**
 * After the check-in is confirmed (signed, or saved without a signature): the extras. The check-in
 * page's Next step bar carries the main thing (open a job), so it isn't repeated here.
 * @param {{ id: number }} checkin
 */
export function afterCheckin(checkin) {
  return [
    { label: 'Add photos', href: `/check-in/${checkin.id}#photos`, icon: 'camera' },
    { label: 'Print receiving note', href: `/check-in/${checkin.id}/print`, icon: 'printer' },
  ];
}
