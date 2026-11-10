import { Router } from 'express';
import { db } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import { VIEW_CUSTOMERS } from '../../core/access.js';

// Personal details (ID numbers, KRA PINs, some phones) show masked, "****7996".
// "Show" asks here for the full value: only for someone allowed to see the record,
// and every look is written to the record's history, "viewed a hidden detail: ID number".

const any = (...perms) => (req) => perms.some((p) => req.user.can(p));
const atMySite = (req, row) => req.user.sites.some((s) => s.id === row.site_id);

/** what → where it lives (looked up by `key`, else id), which fields may be shown, who may see them, whose history records the look. */
const HIDDEN = {
  visitor: { table: 'visitors', fields: { id_no: 'ID number', phone: 'Phone' },
    allowed: (req, row) => any('visitors.view', 'visitors.gate', 'visitors.receive')(req) && atMySite(req, row), entity: 'visitor' },
  employee: { table: 'employees', fields: { id_no: 'ID number', mpesa_phone: 'M-Pesa number' },
    allowed: any('attendance.manage', 'payroll.manage', 'payroll.approve'), entity: 'employee' },
  checkin: { table: 'checkins', fields: { driver_id_no: 'driver’s ID number' },
    allowed: any(...VIEW_CUSTOMERS, 'checkin.gate'), entity: 'checkin' },
  release: { table: 'vehicle_releases', fields: { collector_id_no: 'collector’s ID number' },
    allowed: any(...VIEW_CUSTOMERS, 'checkin.gate'), entity: 'checkin', key: 'checkin_id' }, // by the check-in's id
  customer: { table: 'customers', fields: { kra_pin: 'KRA PIN' }, allowed: any(...VIEW_CUSTOMERS), entity: 'customer' },
  supplier: { table: 'suppliers', fields: { kra_pin: 'KRA PIN' }, allowed: any('purchasing.manage', 'purchasing.approve'), entity: 'supplier' },
};

/** The link a "Show" button posts to, e.g. revealUrl('visitor', 12, 'id_no'). */
export const revealUrl = (what, id, field) => `/api/reveal/${what}/${id}/${field}`;

export const router = Router();

router.post('/api/reveal/:what/:id/:field', async (req, res) => {
  if (!req.user) throw httpError(401, 'Log in again.');
  const spec = Object.hasOwn(HIDDEN, req.params.what) ? HIDDEN[req.params.what] : null;
  const label = spec && Object.hasOwn(spec.fields, req.params.field) ? spec.fields[req.params.field] : null;
  if (!label) throw httpError(404, 'Nothing to show.');
  const row = await db(spec.table).where({ [spec.key ?? 'id']: Number(req.params.id) }).first();
  if (!row || !spec.allowed(req, row)) throw httpError(404, 'Nothing to show.');

  const value = row[req.params.field];
  if (value) await audit(db, req, { entity: spec.entity, id: Number(req.params.id), action: 'revealed', summary: label });
  res.json({ value: value ?? null });
});
