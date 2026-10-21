// Every important action is written to the hash-chained audit_log.
// Pass the transaction's client so the audit row commits (or rolls back) with the change itself.
import { query } from '../db.js';

export async function audit(db, { actorId = null, action, entity = null, entityId = null, payload = {}, ip = null }) {
  const client = db || { query };
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, payload, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorId, action, entity, entityId === null ? null : String(entityId), JSON.stringify(payload), ip],
  );
}
