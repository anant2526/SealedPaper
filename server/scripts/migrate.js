// Applies every migrations/*.sql file once, in order, each inside its own transaction.
// Applied files are recorded in schema_migrations, so re-running is safe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL first (see .env.example)');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  file text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const { rows } = await client.query('SELECT file FROM schema_migrations');
const done = new Set(rows.map((r) => r.file));

for (const file of files) {
  if (done.has(file)) continue;
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (file) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`applied ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`FAILED ${file}: ${err.message}`);
    process.exit(1);
  }
}
console.log('database is up to date');
await client.end();
