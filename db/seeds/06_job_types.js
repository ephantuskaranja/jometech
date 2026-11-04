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

const TYPES = [
  { name: 'New fabrication', is_default: true, steps: [RECEIVED, INSPECT, DESIGN, PLAN, 'Cutting', 'Frame Fabrication', 'Welding', 'Assembly', 'Body Installation', 'Grinding', 'Finishing', 'Painting', 'Electrical / Accessories', QC, CUSTOMER] },
  { name: 'Repair', steps: [RECEIVED, INSPECT, PLAN, 'Cutting', 'Welding', 'Grinding', 'Finishing', 'Painting', QC, CUSTOMER] },
  { name: 'Modification', steps: [RECEIVED, INSPECT, DESIGN, PLAN, 'Cutting', 'Welding', 'Assembly', 'Grinding', 'Finishing', 'Painting', QC, CUSTOMER] },
  { name: 'Maintenance / other', steps: [RECEIVED, INSPECT, 'Work Carried Out', QC, CUSTOMER] },
];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  const [{ n }] = await knex('job_types').count({ n: '*' });
  if (Number(n) > 0) return;
  for (const { steps, ...type } of TYPES) {
    const [id] = await knex('job_types').insert(type);
    await knex('job_type_steps').insert(steps.map((name, i) => ({ job_type_id: id, sort_order: i + 1, name })));
  }
}
