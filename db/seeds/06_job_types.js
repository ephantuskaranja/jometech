// The starting job types and their production steps (requirements §12 and §27).
// "New fabrication" is the §27 list. The other three are shortened from it, for Jome-Tech to adjust.
// Left out on purpose: "Completed" is the job's own status, set when the last step is done;
// "Invoiced" and "Vehicle Released" belong to invoicing and check-out.
//
// Written once, while there are no job types. Deploys run the seeds every time,
// so anything an admin later changes or removes under System stays that way.

const RECEIVED = 'Vehicle Received';
const INSPECT = 'Inspection / Measurement';
const DESIGN = 'Design / Specification';
const PLAN = 'Material Planning';
const QC = 'Quality Inspection';
const CUSTOMER = 'Customer Inspection';
// Cutting, frame fabrication, welding, assembly and grinding are one step (Nov 2026: fewer steps to tick).
export const FAB = 'Fabrication (cutting, frame, welding, assembly, grinding)';

const TYPES = [
  { name: 'New fabrication', is_default: true, steps: [RECEIVED, INSPECT, DESIGN, PLAN, FAB, 'Body Installation', 'Finishing', 'Painting', 'Electrical / Accessories', QC, CUSTOMER] },
  { name: 'Repair', steps: [RECEIVED, INSPECT, PLAN, FAB, 'Finishing', 'Painting', QC, CUSTOMER] },
  { name: 'Modification', steps: [RECEIVED, INSPECT, DESIGN, PLAN, FAB, 'Finishing', 'Painting', QC, CUSTOMER] },
  { name: 'Maintenance / other', steps: [RECEIVED, INSPECT, 'Work Carried Out', QC, CUSTOMER] },
];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  const [{ n }] = await knex('job_types').count({ n: '*' });
  if (Number(n) > 0) return;
  for (const { steps, ...type } of TYPES) {
    // Every starting type: the vehicle's check-in ticks off Vehicle Received, a passed quality check Quality Inspection,
    // and the customer's sign-off Customer Inspection.
    const [id] = await knex('job_types').insert({ ...type, receive_step: RECEIVED, qc_step: QC, signoff_step: CUSTOMER });
    await knex('job_type_steps').insert(steps.map((name, i) => ({ job_type_id: id, sort_order: i + 1, name })));
  }
}
