// Cookie-based JWT auth.
//   sp_access  (15 min)  full session, issued only after password + face scan
//   sp_pre     (10 min)  half-way token: password OK, face scan / enrolment still to do
//   sp_refresh (7 days)  random token, its SHA-256 lives in `sessions`, rotated on every use
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { randomToken, sha256 } from '../services/crypto.js';

const ACCESS_MIN = 15;
const PRE_MIN = 10;
const REFRESH_DAYS = 7;

const baseCookie = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function clientIp(req) {
  const ip = req.ip || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip || null;
}

// ---------- issuing ----------

export function setPreAuth(res, user, stage) {
  const token = jwt.sign({ sub: user.id, stage }, config.jwtSecret, { expiresIn: `${PRE_MIN}m` });
  res.cookie('sp_pre', token, { ...baseCookie(), maxAge: PRE_MIN * 60_000 });
}

export async function startSession(req, res, user) {
  const refresh = randomToken();
  await query(
    `INSERT INTO sessions (user_id, refresh_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + interval '${REFRESH_DAYS} days', $3, $4)`,
    [user.id, sha256(refresh), clientIp(req), (req.get('user-agent') || '').slice(0, 300)],
  );
  setAccess(res, user);
  res.cookie('sp_refresh', refresh, { ...baseCookie(), path: '/api/auth', maxAge: REFRESH_DAYS * 86_400_000 });
  res.clearCookie('sp_pre', baseCookie());
}

export function setAccess(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role, stage: 'full' }, config.jwtSecret, { expiresIn: `${ACCESS_MIN}m` });
  res.cookie('sp_access', token, { ...baseCookie(), maxAge: ACCESS_MIN * 60_000 });
}

export async function endSession(req, res) {
  const refresh = req.cookies?.sp_refresh;
  if (refresh) await query('UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1', [sha256(refresh)]);
  res.clearCookie('sp_access', baseCookie());
  res.clearCookie('sp_pre', baseCookie());
  res.clearCookie('sp_refresh', { ...baseCookie(), path: '/api/auth' });
}

// ---------- checking ----------

function verify(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** Full session required. Re-reads the user so a disabled account or changed role applies at once. */
export function requireAuth(...roles) {
  return async (req, _res, next) => {
    try {
      const claims = verify(req.cookies?.sp_access);
      if (!claims || claims.stage !== 'full') throw new HttpError(401, 'Please log in');
      const { rows } = await query('SELECT id, name, email, role, status FROM users WHERE id = $1', [claims.sub]);
      const user = rows[0];
      if (!user || user.status !== 'active') throw new HttpError(401, 'Account is not active');
      if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'Your role cannot do this');
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Half-way token required, for the face scan at login or the enrolment steps. */
export function requirePre(...stages) {
  return async (req, _res, next) => {
    try {
      const claims = verify(req.cookies?.sp_pre);
      if (!claims || !stages.includes(claims.stage)) throw new HttpError(401, 'Session step expired — log in again');
      const { rows } = await query('SELECT id, name, email, role, status, totp_enabled FROM users WHERE id = $1', [claims.sub]);
      if (!rows[0] || rows[0].status === 'disabled') throw new HttpError(401, 'Account is disabled');
      req.user = rows[0];
      req.stage = claims.stage;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function rotateRefresh(req, res) {
  const refresh = req.cookies?.sp_refresh;
  if (!refresh) throw new HttpError(401, 'Please log in');
  const { rows } = await query(
    `UPDATE sessions SET revoked_at = now()
      WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(refresh)],
  );
  if (!rows[0]) throw new HttpError(401, 'Session expired — log in again');
  const u = await query('SELECT id, name, email, role, status FROM users WHERE id = $1', [rows[0].user_id]);
  if (!u.rows[0] || u.rows[0].status !== 'active') throw new HttpError(401, 'Account is not active');
  await startSession(req, res, u.rows[0]);
  return u.rows[0];
}
