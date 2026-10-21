// Shamir's Secret Sharing via the independently audited `shamir-secret-sharing` library.
// The 32-byte document key becomes N shares; any k of them rebuild it, k-1 reveal nothing.
import { split, combine } from 'shamir-secret-sharing';

export async function splitKey(key, totalShares, threshold) {
  const shares = await split(new Uint8Array(key), totalShares, threshold);
  return shares.map((s) => Buffer.from(s));
}

export async function combineShares(shares) {
  const key = await combine(shares.map((s) => new Uint8Array(s)));
  return Buffer.from(key);
}

// ---- Key file: what a custodian downloads and later uploads ----

export const KEY_FILE_FORMAT = 'sealedpaper-key';

export function buildKeyFile({ documentId, documentTitle, custodianEmail, shareIndex, share, threshold, total }) {
  return {
    format: KEY_FILE_FORMAT,
    version: 1,
    documentId,
    documentTitle,
    custodian: custodianEmail,
    shareIndex,
    threshold,
    totalShares: total,
    share: Buffer.from(share).toString('base64'),
    issuedAt: new Date().toISOString(),
    warning: 'Keep this file private. It works only for this document, only for you, and only together with your face scan and authenticator code.',
  };
}

/** Returns the raw share bytes, or throws a readable error. */
export function parseKeyFile(keyFile, expectedDocumentId) {
  if (!keyFile || typeof keyFile !== 'object' || keyFile.format !== KEY_FILE_FORMAT) {
    throw new Error('This is not a SealedPaper key file');
  }
  if (keyFile.documentId !== expectedDocumentId) {
    throw new Error('This key file belongs to a different document');
  }
  if (typeof keyFile.share !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(keyFile.share)) {
    throw new Error('Key file is damaged');
  }
  const share = Buffer.from(keyFile.share, 'base64');
  if (share.length !== 33) throw new Error('Key file is damaged');
  return share;
}
