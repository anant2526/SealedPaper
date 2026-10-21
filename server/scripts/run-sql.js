// Runs a .sql file with psql-free Node (handy when psql is not installed).
// Usage: npm run viva:sql   (runs sql/viva_checks.sql and prints the PASS/FAIL table)
// Note: psql meta-commands (lines starting with \) are skipped.
import fs from 'node:fs';
import pg from 'pg';

const file = process.argv[2];
const sql = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('\\')).join('\n');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
const results = await client.query(sql);
for (const r of [].concat(results)) {
  if (r.command === 'SELECT' && r.rows.length && r.fields.some((f) => f.name === 'outcome')) console.table(r.rows);
}
await client.end();
