import { Router } from 'express';
import { can } from '../../core/auth.js';
import { history } from '../../core/audit.js';
import { httpError } from '../../core/validate.js';
import * as roles from './roles.js';

// System → Roles: what each role may do. Admins only: whoever can change roles can give
// themselves anything, so users.manage alone isn't enough.
export const router = Router();
router.use('/admin/roles', can('users.manage'), (req, res, next) => (req.user.isAdmin ? next() : next(httpError(403, 'Only admins can change what roles can do.'))));

async function loadRole(req) {
  const id = Number(req.params.id);
  const role = Number.isInteger(id) ? await roles.getRole(id) : null;
  if (!role) throw httpError(404, 'That role doesn’t exist.');
  return role;
}

router.get('/admin/roles', async (req, res) => {
  res.render('users/views/roles', { title: 'Roles', list: await roles.listRoles(), total: roles.permissionGroups().reduce((n, g) => n + g.items.length, 0) });
});

router.get('/admin/roles/:id', async (req, res) => {
  const role = await loadRole(req);
  res.render('users/views/role', { title: role.name, role, groups: roles.permissionGroups(), entries: await history('role', role.id, { limit: 30 }) });
});

router.post('/admin/roles/:id', async (req, res) => {
  const role = await loadRole(req);
  const keys = [].concat(req.body.permissions ?? []).map(String);
  const { added, removed } = await roles.setPermissions(role.id, keys, req);
  const n = added.length + removed.length;
  req.session.flash = n
    ? { type: 'success', text: `${role.name}: ${n} change${n === 1 ? '' : 's'} saved. Everyone with this role has them from their next page.` }
    : { type: 'info', text: `${role.name}: nothing changed.` };
  res.redirect(`/admin/roles/${role.id}`);
});
