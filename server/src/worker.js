// Background worker: every 30 seconds, seal papers whose seal deadline passed, and release any sealed document whose unlock time
// has passed and which already holds k accepted key files. Uses the partial index
// documents_due_idx (unlock_at) WHERE status = 'sealed'.
import cron from 'node-cron';
import { query } from './db.js';
import { tryRelease } from './services/release.js';
import { sealPaper } from './services/papers.js';
import { audit } from './services/audit.js';

const sealFailuresLogged = new Set();

/** Papers past their seal deadline are sealed automatically (if the pool covers the blueprint). */
export async function sealDuePapers() {
  const { rows } = await query(`SELECT id FROM papers WHERE status = 'draft' AND seal_deadline <= now() ORDER BY seal_deadline LIMIT 20`);
  const sealed = [];
  for (const { id } of rows) {
    try {
      await sealPaper(id);
      sealed.push(id);
    } catch (err) {
      if (!sealFailuresLogged.has(id)) {
        sealFailuresLogged.add(id);
        await audit(null, { action: 'paper.seal_failed', entity: 'paper', entityId: id, payload: { reason: err.message } });
      }
    }
  }
  return sealed;
}

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
      const sealed = await sealDuePapers();
      if (sealed.length) console.log(`[worker] sealed papers ${sealed.join(', ')}`);
      const released = await releaseDueDocuments();
      if (released.length) console.log(`[worker] released ${released.join(', ')}`);
    } catch (err) {
      console.error('[worker]', err.message);
    }
  });
  return task;
}
