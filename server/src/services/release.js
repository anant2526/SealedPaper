// The release ceremony. Called after every accepted key file and by the worker every 30 s.
//
// One transaction:
//   1. SELECT ... FOR UPDATE locks the document row, so two custodians submitting the
//      last key at the same instant are handled one after the other -> exactly one release.
//   2. Rebuild the key from the pending shares (Shamir combine).
//   3. Decrypt once to prove it: the AES-GCM auth tag fails on a wrong key.
//   4. finalize_release() flips the status (trigger re-checks time lock + quorum),
//      writes the release row, deletes the pending shares and writes the audit row.
//   5. For an exam paper: draw the final questions and build one variant per centre,
//      in the SAME transaction, so a paper is never released without its variants.
import { withTx } from '../db.js';
import { unwrap, wrap, decrypt } from './crypto.js';
import { combineShares } from './shamir.js';
import { audit } from './audit.js';
import { assemblePaper } from './papers.js';

/** Returns { released: true } if this call released the document, else { released: false, reason }. */
export async function tryRelease(documentId, { triggeredBy, actorId = null }) {
  return withTx(async (db) => {
    const { rows: [doc] } = await db.query(
      `SELECT id, status, threshold_k, unlock_at, paper_id, now() >= unlock_at AS time_ok
         FROM documents WHERE id = $1 FOR UPDATE`,
      [documentId],
    );
    if (!doc) return { released: false, reason: 'not found' };
    if (doc.status !== 'sealed') return { released: false, reason: `already ${doc.status}` };
    if (!doc.time_ok) return { released: false, reason: 'waiting for unlock time' };

    const { rows: pending } = await db.query(
      'SELECT custodian_id, share_enc FROM pending_shares WHERE document_id = $1 ORDER BY accepted_at',
      [documentId],
    );
    if (pending.length < doc.threshold_k) {
      return { released: false, reason: `waiting for keys (${pending.length} of ${doc.threshold_k})` };
    }

    const key = await combineShares(pending.map((p) => unwrap(p.share_enc)));
    const { rows: [blob] } = await db.query(
      'SELECT iv, auth_tag, ciphertext FROM document_blobs WHERE document_id = $1', [documentId],
    );
    try {
      decrypt(key, { iv: blob.iv, authTag: blob.auth_tag, ciphertext: blob.ciphertext });
    } catch {
      // Cannot happen with hash-checked shares; logged loudly if it ever does.
      await audit(db, { actorId, action: 'document.release_failed', entity: 'document', entityId: documentId, payload: { reason: 'GCM tag mismatch' } });
      return { released: false, reason: 'rebuilt key did not verify' };
    }

    await db.query('SELECT finalize_release($1, $2, $3, $4, $5)', [
      documentId, wrap(key), pending.map((p) => p.custodian_id), triggeredBy, actorId,
    ]);
    key.fill(0);
    if (doc.paper_id) await assemblePaper(db, doc.paper_id, actorId);
    return { released: true, paperId: doc.paper_id };
  });
}
