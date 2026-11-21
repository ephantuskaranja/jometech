// Fewer production steps: Cutting, Frame Fabrication, Welding, Grinding and Assembly are one step,
// "Fabrication", in every job type that has two or more of them. It takes the place of the first
// one; the order of the other steps doesn't change. Jobs already opened keep their own copy of the
// steps (System → Job types & steps only affects jobs opened afterwards).
//
// Not undone on rollback: an admin may have changed the lists since.

const FABRICATION = 'Fabrication (cutting, frame, welding, assembly, grinding)';
const PARTS = ['cutting', 'frame fabrication', 'welding', 'grinding', 'assembly'];

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const types = await knex('job_types').select('id');
  for (const { id } of types) {
    const steps = await knex('job_type_steps').where({ job_type_id: id }).orderBy('sort_order').select('id', 'name');
    const isPart = (s) => PARTS.includes(s.name.trim().toLowerCase());
    if (steps.filter(isPart).length < 2) continue;
    const names = [];
    for (const s of steps) {
      if (!isPart(s)) names.push(s.name);
      else if (!names.includes(FABRICATION)) names.push(FABRICATION);
    }
    await knex('job_type_steps').where({ job_type_id: id }).delete();
    await knex('job_type_steps').insert(names.map((name, i) => ({ job_type_id: id, sort_order: i + 1, name })));
  }
}

/** @param {import('knex').Knex} knex */
export async function down() {}
