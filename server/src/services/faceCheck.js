// Liveness challenges + logging around the face model.
import { query } from '../db.js';
import { config } from '../config.js';
import { secureShuffle, wrap, unwrap } from './crypto.js';
import { evaluateScan, bufferToDescriptor, descriptorToBuffer, FaceError } from './face.js';

/** A one-time challenge: random pose order, expires in 2 minutes. */
export async function createChallenge(userId, purpose) {
  const poses = secureShuffle(['straight', 'left', 'right']);
  const { rows } = await query(
    `INSERT INTO face_challenges (user_id, purpose, poses, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     RETURNING id, poses, expires_at`,
    [userId, purpose, poses, config.face.challengeSeconds],
  );
  return { challengeId: rows[0].id, poses: rows[0].poses, expiresAt: rows[0].expires_at };
}

/**
 * Claims the challenge (single use), runs the scan, logs the result in face_checks.
 * For purpose 'enroll' there is no template yet; the result carries the new descriptor.
 */
export async function runFaceCheck({ userId, purpose, challengeId, frames, ip }) {
  let result;
  let poses = null;
  try {
    const claimed = await query(
      `UPDATE face_challenges SET used_at = now()
        WHERE id = $1 AND user_id = $2 AND purpose = $3 AND used_at IS NULL AND expires_at > now()
        RETURNING poses`,
      [challengeId, userId, purpose],
    );
    if (!claimed.rows[0]) {
      result = { passed: false, reason: 'face challenge expired or already used — start the scan again' };
    } else {
      poses = claimed.rows[0].poses;
      let template = null;
      if (purpose !== 'enroll') {
        const t = await query('SELECT descriptor_enc FROM face_templates WHERE user_id = $1', [userId]);
        if (!t.rows[0]) result = { passed: false, reason: 'no face enrolled for this account' };
        else template = bufferToDescriptor(unwrap(t.rows[0].descriptor_enc));
      }
      if (!result) result = await evaluateScan({ poses, frames, template });
    }
  } catch (err) {
    if (!(err instanceof FaceError)) throw err;
    result = { passed: false, reason: err.message };
  }

  await query(
    `INSERT INTO face_checks (user_id, challenge_id, purpose, passed, reason, match_distance, yaw_values, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, poses ? challengeId : null, purpose, result.passed, result.reason,
      result.matchDistance ?? null, result.yaws ?? null, ip],
  );
  return result;
}

export const encryptTemplate = (descriptor) => wrap(descriptorToBuffer(descriptor));
