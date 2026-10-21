// Admin + investigator: read the audit log, verify its hash chain, see suspicious activity.
import { Router } from 'express';
import { query } from '../db.js';
import { parse, z } from '../validate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const canAudit = requireAuth('admin', 'investigator');

const listSchema = z.object({
  action: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

router.get('/', canAudit, async (req, res, next) => {
  try {
    const q = parse(listSchema, req.query);
    const { rows } = await query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.payload, a.ip, a.created_at, a.prev_hash, a.row_hash,
              u.name AS actor_name, u.email AS actor_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::text IS NULL OR a.action LIKE $1 || '%')
        ORDER BY a.id DESC LIMIT $2`,
      [q.action ?? null, q.limit],
    );
    res.json({ entries: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/verify', canAudit, async (_req, res, next) => {
  try {
    const { rows: problems } = await query('SELECT * FROM verify_audit_chain()');
    const { rows: [{ count }] } = await query('SELECT count(*) FROM audit_log');
    res.json({ ok: problems.length === 0, checkedRows: count, problems });
  } catch (err) {
    next(err);
  }
});

router.get('/suspicious', canAudit, async (_req, res, next) => {
  try {
    const { rows: keyAttempts } = await query(
      `SELECT s.*, u.email, d.title FROM suspicious_key_attempts s
         JOIN users u ON u.id = s.custodian_id JOIN documents d ON d.id = s.document_id
        ORDER BY s.submitted_at DESC LIMIT 100`,
    );
    const { rows: faceFailures } = await query('SELECT * FROM face_failure_report ORDER BY failed_scans DESC');
    res.json({ keyAttempts, faceFailures });
  } catch (err) {
    next(err);
  }
});

export default router;
