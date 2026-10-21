// The concurrency test from the proposal: 5 unlock requests hit the server at the same instant
// for a document that needs only one more key. Exactly ONE release must happen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, registerUser, framesFor, codeFor, allowNewCode } from './helpers.js';

await resetDatabase();
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const app = createApp();

let admin;
const cs = [];
let docId;
const keyFiles = new Map();

before(async () => {
  admin = await registerUser(app, { name: 'Admin', email: 'admin@race.dev', person: 'admin' });
  for (let i = 1; i <= 5; i++) {
    cs.push(await registerUser(app, { name: `Custodian ${i}`, email: `c${i}@race.dev`, person: `p${i}` }));
  }
  const res = await admin.agent.post('/api/documents')
    .field('title', 'Race paper')
    .field('unlockAt', new Date(Date.now() + 1500).toISOString())
    .field('thresholdK', '2')
    .field('custodianIds', JSON.stringify(cs.map((c) => c.user.id)))
    .attach('file', Buffer.from('race paper body'), 'race.txt');
  docId = res.body.document.document_id;
  for (const c of cs) {
    await allowNewCode(pool, c.user.id);
    const r = await c.agent.post(`/api/documents/${docId}/key-file`).send({ code: codeFor(c.secret) });
    keyFiles.set(c.user.id, r.body.keyFile);
  }
  await new Promise((r) => setTimeout(r, 1600));   // past the unlock time
});
after(() => pool.end());

async function prepare(c) {
  await allowNewCode(pool, c.user.id);
  const ch = await c.agent.post(`/api/documents/${docId}/face-challenge`).send({});
  return {
    c,
    body: { challengeId: ch.body.challengeId, frames: framesFor(ch.body.poses, c.person), code: codeFor(c.secret), keyFile: keyFiles.get(c.user.id) },
  };
}

test('one key alone does not open a 2-of-5 paper', async () => {
  const p = await prepare(cs[0]);
  const r = await p.c.agent.post(`/api/documents/${docId}/unlock`).send(p.body);
  assert.equal(r.status, 200);
  assert.equal(r.body.released, false);
});

test('5 parallel unlock requests produce exactly one release', async () => {
  // Custodians 2-5 plus a duplicate from custodian 2 (its own fresh challenge).
  const prepared = [await prepare(cs[1]), await prepare(cs[2]), await prepare(cs[3]), await prepare(cs[4])];
  const dupChallenge = await cs[1].agent.post(`/api/documents/${docId}/face-challenge`).send({});
  prepared.push({
    c: cs[1],
    body: { ...prepared[0].body, challengeId: dupChallenge.body.challengeId, frames: framesFor(dupChallenge.body.poses, cs[1].person) },
  });

  const results = await Promise.all(
    prepared.map((p) => p.c.agent.post(`/api/documents/${docId}/unlock`).send(p.body)),
  );
  assert.ok(results.every((r) => r.status < 500), 'no server errors under the race');
  const releasedBy = results.filter((r) => r.body.released === true);
  assert.equal(releasedBy.length, 1, `exactly one request performs the release: ${results.map((r) => r.status + ' ' + JSON.stringify(r.body.error ?? r.body.released)).join(' | ')}`);

  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM releases WHERE document_id = $1', [docId]);
  assert.equal(count, 1);
  const { rows: [doc] } = await pool.query('SELECT status FROM documents WHERE id = $1', [docId]);
  assert.equal(doc.status, 'released');
  const { rows: [{ count: left }] } = await pool.query('SELECT count(*) FROM pending_shares WHERE document_id = $1', [docId]);
  assert.equal(left, 0, 'no key shares stay on the server after release');
});
