// Registration (password -> face enrolment -> authenticator app) and login (password -> face scan).
import { Router } from 'express';
import argon2 from 'argon2';
import { rateLimit } from 'express-rate-limit';
import { query, withTx } from '../db.js';
import { parse, z, scanSchema, codeSchema } from '../validate.js';
import {
  HttpError, clientIp, setPreAuth, startSession, endSession, requireAuth, requirePre, rotateRefresh,
} from '../middleware/auth.js';
import { createChallenge, runFaceCheck, encryptTemplate } from '../services/faceCheck.js';
import { newTotpSecret, totpSetupPayload, encryptSecret, decryptSecret, codeStep } from '../services/totp.js';
import { audit } from '../services/audit.js';

const router = Router();

const limiter = (limit) => rateLimit({
  windowMs: 15 * 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many attempts — wait 15 minutes' },
});

// A real hash of a random password, so a login for an unknown email takes as long as a real one.
const DUMMY_HASH = await argon2.hash('not-a-real-password-' + Math.random());

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status });

// ---------- register ----------

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(10, 'at least 10 characters').max(200),
});

router.post('/register', limiter(20), async (req, res, next) => {
  try {
    const body = parse(registerSchema, req.body);
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    const user = await withTx(async (db) => {
      // The very first account becomes the admin (exam controller).
      await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const { rows: [{ count }] } = await db.query('SELECT count(*) FROM users');
      const role = count === 0 ? 'admin' : 'custodian';
      const { rows } = await db.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, role, status`,
        [body.name, body.email, passwordHash, role],
      );
      await audit(db, { actorId: rows[0].id, action: 'user.registered', entity: 'user', entityId: rows[0].id, payload: { role }, ip: clientIp(req) });
      return rows[0];
    });
    setPreAuth(res, user, 'enroll');
    res.status(201).json({ user: publicUser(user), next: 'face' });
  } catch (err) {
    if (err.code === '23505') return next(new HttpError(409, 'An account with this email already exists'));
    next(err);
  }
});

// ---------- login: step 1, password ----------

const loginSchema = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string().min(1).max(200),
});

router.post('/login', limiter(30), async (req, res, next) => {
  try {
    const body = parse(loginSchema, req.body);
    const { rows } = await query(
      `SELECT u.*, (f.user_id IS NOT NULL) AS has_face
         FROM users u LEFT JOIN face_templates f ON f.user_id = u.id
        WHERE u.email = $1`,
      [body.email],
    );
    const user = rows[0];
    const ok = await argon2.verify(user ? user.password_hash : DUMMY_HASH, body.password);
    if (!user || !ok) {
      await audit(null, { actorId: user?.id ?? null, action: 'login.failed', payload: { email: body.email, reason: 'password' }, ip: clientIp(req) });
      throw new HttpError(401, 'Wrong email or password');
    }
    if (user.status === 'disabled') throw new HttpError(403, 'This account is disabled');

    if (user.status === 'pending') {
      // Registration was not finished: continue where it stopped.
      setPreAuth(res, user, 'enroll');
      return res.json({ user: publicUser(user), next: user.has_face ? 'totp' : 'face' });
    }
    setPreAuth(res, user, 'login');
    res.json({ user: publicUser(user), next: 'face-login' });
  } catch (err) {
    next(err);
  }
});

// ---------- face challenge for enrolment or login ----------

router.post('/face-challenge', limiter(60), requirePre('enroll', 'login'), async (req, res, next) => {
  try {
    const purpose = req.stage === 'enroll' ? 'enroll' : 'login';
    res.json(await createChallenge(req.user.id, purpose));
  } catch (err) {
    next(err);
  }
});

// ---------- login: step 2, face scan ----------

router.post('/login/face', limiter(30), requirePre('login'), async (req, res, next) => {
  try {
    const scan = parse(scanSchema, req.body);
    const result = await runFaceCheck({ userId: req.user.id, purpose: 'login', ...scan, ip: clientIp(req) });
    if (!result.passed) {
      await audit(null, { actorId: req.user.id, action: 'login.face_failed', payload: { reason: result.reason }, ip: clientIp(req) });
      throw new HttpError(401, `Face check failed: ${result.reason}`);
    }
    await audit(null, { actorId: req.user.id, action: 'login.success', payload: { matchDistance: result.matchDistance }, ip: clientIp(req) });
    await startSession(req, res, req.user);
    res.json({ user: publicUser({ ...req.user, status: 'active' }) });
  } catch (err) {
    next(err);
  }
});

// ---------- registration: face enrolment ----------

router.post('/enroll/face', limiter(30), requirePre('enroll'), async (req, res, next) => {
  try {
    if (req.user.status !== 'pending') throw new HttpError(409, 'Face is already enrolled for this account');
    const scan = parse(scanSchema, req.body);
    const result = await runFaceCheck({ userId: req.user.id, purpose: 'enroll', ...scan, ip: clientIp(req) });
    if (!result.passed) throw new HttpError(422, `Face scan failed: ${result.reason}`);
    await withTx(async (db) => {
      await db.query(
        `INSERT INTO face_templates (user_id, descriptor_enc) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET descriptor_enc = EXCLUDED.descriptor_enc, enrolled_at = now()`,
        [req.user.id, encryptTemplate(result.descriptor)],
      );
      await audit(db, { actorId: req.user.id, action: 'face.enrolled', entity: 'user', entityId: req.user.id, ip: clientIp(req) });
    });
    res.json({ next: 'totp' });
  } catch (err) {
    next(err);
  }
});

// ---------- registration: authenticator app ----------

router.post('/enroll/totp', requirePre('enroll'), async (req, res, next) => {
  try {
    if (req.user.status !== 'pending') throw new HttpError(409, 'Authenticator is already set up');
    const face = await query('SELECT 1 FROM face_templates WHERE user_id = $1', [req.user.id]);
    if (!face.rows[0]) throw new HttpError(409, 'Do the face scan first');
    const secret = newTotpSecret();
    await query('UPDATE users SET totp_secret_enc = $2, totp_enabled = false WHERE id = $1', [req.user.id, encryptSecret(secret)]);
    res.json(await totpSetupPayload(req.user.email, secret));
  } catch (err) {
    next(err);
  }
});

router.post('/enroll/totp/confirm', limiter(30), requirePre('enroll'), async (req, res, next) => {
  try {
    const { code } = parse(z.object({ code: codeSchema }), req.body);
    const { rows } = await query('SELECT totp_secret_enc FROM users WHERE id = $1 AND status = $2', [req.user.id, 'pending']);
    if (!rows[0]?.totp_secret_enc) throw new HttpError(409, 'Start the authenticator setup first');
    const step = codeStep(decryptSecret(rows[0].totp_secret_enc), code);
    if (step === null) throw new HttpError(401, 'That code is wrong or expired — try the current one');
    const user = await withTx(async (db) => {
      // The users_activation_guard trigger double-checks that a face template exists.
      const { rows: [u] } = await db.query(
        `UPDATE users SET totp_enabled = true, totp_last_step = $2, status = 'active'
          WHERE id = $1 RETURNING id, name, email, role, status`,
        [req.user.id, step],
      );
      await audit(db, { actorId: u.id, action: 'user.activated', entity: 'user', entityId: u.id, ip: clientIp(req) });
      return u;
    });
    await startSession(req, res, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// ---------- session ----------

router.post('/refresh', async (req, res, next) => {
  try {
    const user = await rotateRefresh(req, res);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await endSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth(), (req, res) => res.json({ user: publicUser(req.user) }));

export default router;
