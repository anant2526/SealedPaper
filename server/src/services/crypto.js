// All cryptography uses Node's built-in `crypto` module.
import crypto from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';

/** A fresh random 256-bit key. A new one is made for every document, never reused. */
export function newDocumentKey() {
  return crypto.randomBytes(32);
}

/** AES-256-GCM encrypt. The auth tag later proves the key and the data are both correct. */
export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

/** AES-256-GCM decrypt. Throws if the key is wrong or a single byte was changed. */
export function decrypt(key, { iv, authTag, ciphertext }) {
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Wrap a small secret with the server master key. Output = iv(12) | tag(16) | ciphertext. */
export function wrap(secret) {
  const { iv, authTag, ciphertext } = encrypt(config.masterKey, Buffer.from(secret));
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function unwrap(blob) {
  const buf = Buffer.from(blob);
  return decrypt(config.masterKey, {
    iv: buf.subarray(0, 12),
    authTag: buf.subarray(12, 28),
    ciphertext: buf.subarray(28),
  });
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/** Constant-time comparison, so response timing never leaks how many bytes matched. */
export function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Cryptographically secure shuffle (Fisher–Yates with crypto.randomInt). */
export function secureShuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
