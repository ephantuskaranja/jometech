// The starting quality checklist (agreed with the user 2026-11-13; Jome-Tech had no paper one).
// Each section suggests the production step that redoes its work when an item fails.
//
// Written once, while there is no checklist. Deploys run the seeds every time,
// so anything an admin later changes under System stays that way.

export const CHECKLIST = [
  { name: 'Dimensions and fit', rework_step: 'Assembly', items: [
    'Overall length, width and height as ordered or drawn',
    'Body square and level (diagonals match)',
    'Mounted firmly on the chassis (U-bolts, brackets, bolts tight)',
    'Clear of wheels, cab, exhaust and fuel tank',
  ] },
  { name: 'Welding', rework_step: 'Welding', items: [
    'All joints fully welded as specified',
    'No cracks, holes (porosity) or undercut',
    'Slag and spatter removed; welds ground where they show',
  ] },
  { name: 'Structure and moving parts', rework_step: 'Assembly', items: [
    'Floor, sides and cross-members straight, no dents',
    'Doors, tailgate and drop-sides open, close and lock properly',
    'Hinges and pins greased and moving freely',
  ] },
  { name: 'Hydraulics (tippers only, else N/A)', rework_step: 'Assembly', items: [
    'Tips fully up and down smoothly',
    'No oil leaks (pump, hoses, ram)',
    'Safety prop / stay works',
  ] },
  { name: 'Paint and finish', rework_step: 'Painting', items: [
    'Primer and top coat cover everything, including the underside and inside',
    'Colour as ordered; no runs, bare patches or overspray on the chassis or cab',
    'No sharp edges or burrs',
  ] },
  { name: 'Electrical and accessories', rework_step: 'Electrical / Accessories', items: [
    'All lights work: tail, brake, indicators, side markers',
    'Wiring clipped and protected',
    'Reflectors and reflective tape fitted',
    'Mudguards, rear under-run bumper, toolbox, spare wheel carrier and ladder, as ordered',
  ] },
  { name: 'Handover', rework_step: 'Finishing', items: [
    'Vehicle cleaned; tools and scrap removed',
    'Items on the receiving note are all still with the vehicle',
  ] },
];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  const [{ n }] = await knex('qc_checklist_sections').count({ n: '*' });
  if (Number(n) > 0) return;
  for (const [i, { items, ...section }] of CHECKLIST.entries()) {
    const [id] = await knex('qc_checklist_sections').insert({ ...section, sort_order: i + 1 });
    await knex('qc_checklist_items').insert(items.map((text, j) => ({ section_id: id, sort_order: j + 1, text })));
  }
}
