// Admin: list users, change a role, disable or re-enable an account.
import { Router } from 'express';
import { query, withTx } from '../db.js';
import { parse, z } from '../validate.js';
import { HttpError, clientIp, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';

const router = Router();

router.get('/', requireAuth('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.totp_enabled, u.created_at,
              (f.user_id IS NOT NULL) AS face_enrolled,
              (SELECT count(*) FROM face_checks c WHERE c.user_id = u.id AND NOT c.passed
                 AND c.created_at > now() - interval '24 hours') AS failed_scans_24h
         FROM users u LEFT JOIN face_templates f ON f.user_id = u.id
        ORDER BY u.created_at`,
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  role: z.enum(['admin', 'setter', 'custodian', 'superintendent', 'investigator']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

router.patch('/:id', requireAuth('admin'), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const body = parse(patchSchema, req.body);
    if (id === req.user.id) throw new HttpError(400, 'You cannot change your own role or status');
    const user = await withTx(async (db) => {
      const { rows: [u] } = await db.query(
        `UPDATE users SET role = coalesce($2, role), status = coalesce($3, status)
          WHERE id = $1 RETURNING id, name, email, role, status`,
        [id, body.role ?? null, body.status ?? null],
      );
      if (!u) throw new HttpError(404, 'User not found');
      await audit(db, { actorId: req.user.id, action: 'user.updated', entity: 'user', entityId: id, payload: body, ip: clientIp(req) });
      return u;
    });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

export default router;
