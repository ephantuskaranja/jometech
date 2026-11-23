// The kinds of work Jome-Tech does, shared by the check-in's "Purpose of visit" and the
// enquiry's "Enquiry type" so reports line up (issues sheet rows 47-48, 2026-11-23).
// Deliveries and visits are not here: those people sign in at the gate (Visitors).
// Stored values never change; only labels may.

export const WORK_KINDS = [
  { value: 'fabrication', label: 'Fabrication' },
  { value: 'repairs', label: 'Repair Works' },
  { value: 'modification', label: 'Modification' },
];

/** Check-in purposes: the work kinds, or anything else. */
export const PURPOSES = [...WORK_KINDS, { value: 'other', label: 'Others' }];

/** Enquiry types: the work kinds, or a general question. */
export const ENQUIRY_KINDS = [...WORK_KINDS, { value: 'general', label: 'General enquiry' }];

export const kindLabel = (list, value) => list.find((k) => k.value === value)?.label ?? null;
