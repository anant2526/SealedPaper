// Question crypto: every question is encrypted with its paper's own data key,
// plus an HMAC of its normalised text so a leak can be matched WITHOUT decrypting.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { encrypt, decrypt, unwrap } from './crypto.js';

// A separate key for question HMACs, derived from the master key (never stored).
const HMAC_KEY = Buffer.from(crypto.hkdfSync('sha256', config.masterKey, Buffer.alloc(0), 'sealedpaper-question-hmac-v1', 32));

/** Lower-case, Unicode-normalised, punctuation and spacing collapsed: "Q1. What's  AVL?" -> "q1 what s avl" */
export function normalise(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function questionHmac(text) {
  return crypto.createHmac('sha256', HMAC_KEY).update(normalise(text)).digest();
}

/** Body = { text, options: [..], answer: index }. Stored as iv(12) | tag(16) | ciphertext. */
export function encryptQuestion(key, body) {
  const { iv, authTag, ciphertext } = encrypt(key, Buffer.from(JSON.stringify(body), 'utf8'));
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptQuestion(key, blob) {
  const b = Buffer.from(blob);
  const plain = decrypt(key, { iv: b.subarray(0, 12), authTag: b.subarray(12, 28), ciphertext: b.subarray(28) });
  return JSON.parse(plain.toString('utf8'));
}

/** The paper key while it is still a draft (wrapped with the master key). */
export function draftKey(paper) {
  if (!paper.data_key_wrapped) {
    const err = new Error('This paper is sealed. Its questions can no longer be read or changed.');
    err.status = 409;
    throw err;
  }
  return unwrap(paper.data_key_wrapped);
}
