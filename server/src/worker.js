// Background worker: every 30 seconds, release any sealed document whose unlock time
// has passed and which already holds k accepted key files. Uses the partial index
// documents_due_idx (unlock_at) WHERE status = 'sealed'.
import cron from 'node-cron';
import { query } from './db.js';
import { tryRelease } from './services/release.js';

export async function releaseDueDocuments() {
  const { rows } = await query(
    `SELECT id FROM documents WHERE status = 'sealed' AND unlock_at <= now() ORDER BY unlock_at LIMIT 50`,
  );
  const released = [];
  for (const { id } of rows) {
    const r = await tryRelease(id, { triggeredBy: 'worker' });
    if (r.released) released.push(id);
  }
  // Housekeeping: old, unused face challenges are useless after expiry.
  await query(`DELETE FROM face_challenges WHERE expires_at < now() - interval '1 day' AND used_at IS NULL`);
  return released;
}

export function startWorker() {
  const task = cron.schedule('*/30 * * * * *', async () => {
    try {
      const released = await releaseDueDocuments();
      if (released.length) console.log(`[worker] released ${released.join(', ')}`);
    } catch (err) {
      console.error('[worker]', err.message);
    }
  });
  return task;
}
