import pg from 'pg';
import { config } from './config.js';

// Return bigint counts as numbers (safe for our sizes) instead of strings.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export function query(text, params) {
  return pool.query(text, params);
}

// Run fn(client) inside BEGIN ... COMMIT. Any error rolls the whole thing back.
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
