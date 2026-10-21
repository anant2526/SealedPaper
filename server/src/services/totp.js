// Rotating 6-digit codes (TOTP, RFC 6238) — the same codes Google Authenticator shows.
import otplib from 'otplib';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { wrap, unwrap } from './crypto.js';

const { authenticator } = otplib;
authenticator.options = { step: 30, window: 1, digits: 6 };   // accept one 30-s step either side for clock drift

export function newTotpSecret() {
  return authenticator.generateSecret(20);
}

export async function totpSetupPayload(email, secret) {
  const otpauthUrl = authenticator.keyuri(email, config.appName, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  return { otpauthUrl, qrDataUrl, secret };
}

export const encryptSecret = (secret) => wrap(Buffer.from(secret, 'utf8'));
export const decryptSecret = (blob) => unwrap(blob).toString('utf8');

/** Returns the 30-second step the code belongs to, or null if the code is wrong. */
export function codeStep(secret, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const delta = authenticator.checkDelta(String(code), secret);
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / 30) + delta;
}

/**
 * Checks a code AND consumes it, so the same code can never be used twice.
 * The UPDATE ... WHERE last_step < step is atomic: two parallel requests with one code -> one wins.
 */
export async function verifyAndConsumeCode(db, userId, code) {
  const { rows } = await db.query('SELECT totp_secret_enc FROM users WHERE id = $1 AND totp_enabled', [userId]);
  if (!rows[0]) return { ok: false, reason: 'authenticator not set up' };
  const step = codeStep(decryptSecret(rows[0].totp_secret_enc), code);
  if (step === null) return { ok: false, reason: 'wrong or expired authenticator code' };
  const res = await db.query(
    `UPDATE users SET totp_last_step = $2
      WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
    [userId, step],
  );
  if (res.rowCount === 0) return { ok: false, reason: 'authenticator code already used — wait for the next one' };
  return { ok: true };
}

// Exposed for tests: produce the current code for a secret.
export const currentCode = (secret) => authenticator.generate(secret);
