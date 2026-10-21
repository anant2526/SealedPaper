// Exam centres (admin manages; investigators can read).
import { Router } from 'express';
import { query, withTx } from '../db.js';
import { parse, z } from '../validate.js';
import { HttpError, clientIp, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';

const router = Router();

router.get('/', requireAuth('admin', 'investigator'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, count(pc.paper_id) AS papers, coalesce(sum(pc.candidate_count), 0) AS candidates
         FROM centres c LEFT JOIN paper_centres pc ON pc.centre_id = c.id
        GROUP BY c.id ORDER BY c.code`,
    );
    res.json({ centres: rows });
  } catch (err) {
    next(err);
  }
});

const centreSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, '2 to 8 letters or digits, e.g. DEL01'),
  name: z.string().trim().min(3).max(160),
  city: z.string().trim().min(2).max(80),
});

router.post('/', requireAuth('admin'), async (req, res, next) => {
  try {
    const body = parse(centreSchema, req.body);
    const centre = await withTx(async (db) => {
      const { rows: [c] } = await db.query('INSERT INTO centres (code, name, city) VALUES ($1, $2, $3) RETURNING *', [body.code, body.name, body.city]);
      await audit(db, { actorId: req.user.id, action: 'centre.created', entity: 'centre', entityId: c.id, payload: body, ip: clientIp(req) });
      return c;
    });
    res.status(201).json({ centre });
  } catch (err) {
    if (err.code === '23505') return next(new HttpError(409, 'A centre with this code already exists'));
    next(err);
  }
});

router.patch('/:id', requireAuth('admin'), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const body = parse(centreSchema.pick({ name: true, city: true }), req.body);
    const { rows: [c] } = await query('UPDATE centres SET name = $2, city = $3 WHERE id = $1 RETURNING *', [id, body.name, body.city]);
    if (!c) throw new HttpError(404, 'Centre not found');
    await audit(null, { actorId: req.user.id, action: 'centre.updated', entity: 'centre', entityId: id, payload: body, ip: clientIp(req) });
    res.json({ centre: c });
  } catch (err) {
    next(err);
  }
});

export default router;
