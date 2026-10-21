// End-to-end: register with face + authenticator, log in with a face scan, upload a document,
// collect key files, reject bad keys / faces / codes, release at k-of-N, download.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, registerUser, framesFor, codeFor, allowNewCode, request } from './helpers.js';

await resetDatabase();
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { releaseDueDocuments } = await import('../src/worker.js');
const app = createApp();

const PAPER = Buffer.from('%PDF-1.4\nMid-sem 2026 — Data Structures — Q1. Explain AVL rotations.\n');
let admin, c1, c2, c3, sup;
let docId;
const keyFiles = {};

before(async () => {
  admin = await registerUser(app, { name: 'Exam Controller', email: 'admin@test.dev', person: 'anant' });
  c1 = await registerUser(app, { name: 'Custodian One', email: 'c1@test.dev', person: 'priya' });
  c2 = await registerUser(app, { name: 'Custodian Two', email: 'c2@test.dev', person: 'rahul' });
  c3 = await registerUser(app, { name: 'Custodian Three', email: 'c3@test.dev', person: 'meera' });
  sup = await registerUser(app, { name: 'Centre Superintendent', email: 'sup@test.dev', person: 'kabir' });
});
after(() => pool.end());

test('first account is admin, later accounts are custodians', () => {
  assert.equal(admin.user.role, 'admin');
  assert.equal(c1.user.role, 'custodian');
  assert.equal(c1.user.status, 'active');
});

test('login needs password AND a matching face', async () => {
  const agent = request.agent(app);
  const bad = await agent.post('/api/auth/login').send({ email: 'c1@test.dev', password: 'wrong password!!' });
  assert.equal(bad.status, 401);

  const step1 = await agent.post('/api/auth/login').send({ email: 'c1@test.dev', password: 'correct horse battery' });
  assert.equal(step1.body.next, 'face-login');
  // Before the face scan there is no session.
  assert.equal((await agent.get('/api/auth/me')).status, 401);

  // Someone else's face -> rejected.
  let ch = await agent.post('/api/auth/face-challenge').send({});
  let r = await agent.post('/api/auth/login/face').send({ challengeId: ch.body.challengeId, frames: framesFor(ch.body.poses, 'impostor') });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /does not match/);

  // Right face but frames in the wrong order -> rejected (liveness).
  ch = await agent.post('/api/auth/face-challenge').send({});
  const wrongOrder = framesFor([...ch.body.poses].reverse(), 'priya');
  r = await agent.post('/api/auth/login/face').send({ challengeId: ch.body.challengeId, frames: wrongOrder });
  assert.equal(r.status, 401);

  // Did not actually turn the head -> rejected.
  ch = await agent.post('/api/auth/face-challenge').send({});
  r = await agent.post('/api/auth/login/face').send({
    challengeId: ch.body.challengeId,
    frames: framesFor(ch.body.poses, 'priya', { left: 'mock:priya:0.01', right: 'mock:priya:0.0' }),
  });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /head position/);

  // A used challenge cannot be replayed.
  r = await agent.post('/api/auth/login/face').send({ challengeId: ch.body.challengeId, frames: framesFor(ch.body.poses, 'priya') });
  assert.match(r.body.error, /expired or already used/);

  // Correct face, fresh challenge -> logged in.
  ch = await agent.post('/api/auth/face-challenge').send({});
  r = await agent.post('/api/auth/login/face').send({ challengeId: ch.body.challengeId, frames: framesFor(ch.body.poses, 'priya') });
  assert.equal(r.status, 200);
  assert.equal((await agent.get('/api/auth/me')).body.user.email, 'c1@test.dev');
});

test('only an admin can upload, and k must be <= N', async () => {
  const notAdmin = await c1.agent.post('/api/documents').field('title', 'x').attach('file', PAPER, 'p.pdf');
  assert.equal(notAdmin.status, 403);

  const badK = await admin.agent.post('/api/documents')
    .field('title', 'Too strict')
    .field('unlockAt', new Date(Date.now() + 60_000).toISOString())
    .field('thresholdK', '4')
    .field('custodianIds', JSON.stringify([c1.user.id, c2.user.id, c3.user.id]))
    .attach('file', PAPER, 'paper.pdf');
  assert.equal(badK.status, 400);
});

test('admin uploads a paper split 2-of-3 with a fresh key', async () => {
  const res = await admin.agent.post('/api/documents')
    .field('title', 'Mid-sem 2026 — Data Structures')
    .field('unlockAt', new Date(Date.now() + 4000).toISOString())
    .field('thresholdK', '2')
    .field('submitWindowMinutes', '60')
    .field('custodianIds', JSON.stringify([c1.user.id, c2.user.id, c3.user.id]))
    .field('recipientIds', JSON.stringify([sup.user.id]))
    .attach('file', PAPER, 'ds-midsem.pdf');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  docId = res.body.document.document_id;
  assert.equal(res.body.document.status, 'sealed');

  // Only ciphertext in the database.
  const { rows: [blob] } = await pool.query('SELECT ciphertext FROM document_blobs WHERE document_id = $1', [docId]);
  assert.equal(blob.ciphertext.includes(Buffer.from('AVL rotations')), false);
});

test('each custodian downloads their key file exactly once (needs the rotating code)', async () => {
  const noCode = await c1.agent.post(`/api/documents/${docId}/key-file`).send({ code: '000000' });
  assert.equal(noCode.status, 401);

  for (const c of [c1, c2, c3]) {
    await allowNewCode(pool, c.user.id);
    const r = await c.agent.post(`/api/documents/${docId}/key-file`).send({ code: codeFor(c.secret) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    keyFiles[c.user.email] = r.body.keyFile;
  }
  // Every custodian got a different share.
  assert.equal(new Set(Object.values(keyFiles).map((k) => k.share)).size, 3);

  await allowNewCode(pool, c1.user.id);
  const again = await c1.agent.post(`/api/documents/${docId}/key-file`).send({ code: codeFor(c1.secret) });
  assert.equal(again.status, 410);

  // The server no longer holds any pickup copy.
  const { rows } = await pool.query('SELECT count(*) FROM key_shares WHERE document_id = $1 AND pickup_enc IS NOT NULL', [docId]);
  assert.equal(rows[0].count, 0);
});

test('nobody can download a sealed paper, not even the admin', async () => {
  assert.equal((await admin.agent.get(`/api/documents/${docId}/download`)).status, 423);
  assert.equal((await sup.agent.get(`/api/documents/${docId}/download`)).status, 423);
});

async function submit(c, { keyFile, person, code } = {}) {
  await allowNewCode(pool, c.user.id);
  const ch = await c.agent.post(`/api/documents/${docId}/face-challenge`).send({});
  return c.agent.post(`/api/documents/${docId}/unlock`).send({
    challengeId: ch.body.challengeId,
    frames: framesFor(ch.body.poses, person ?? c.person),
    code: code ?? codeFor(c.secret),
    keyFile: keyFile ?? keyFiles[c.user.email],
  });
}

test('key upload is rejected with someone else\'s key, a wrong code or a wrong face', async () => {
  let r = await submit(c1, { keyFile: keyFiles['c2@test.dev'] });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /not yours/);

  const forged = { ...keyFiles['c1@test.dev'], share: Buffer.alloc(33, 7).toString('base64') };
  r = await submit(c1, { keyFile: forged });
  assert.equal(r.status, 401);

  r = await submit(c1, { code: '123456' });
  assert.equal(r.status, 401);

  r = await submit(c1, { person: 'impostor' });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /Face check failed/);

  const { rows } = await pool.query('SELECT count(*) FROM share_submissions WHERE document_id = $1 AND NOT accepted', [docId]);
  assert.equal(rows[0].count, 4);
});

test('two valid keys before the unlock time: accepted, but the time lock holds', async () => {
  let r = await submit(c1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.released, false);

  r = await submit(c1);
  assert.equal(r.status, 409);   // already submitted

  r = await submit(c2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.released, false);
  assert.equal(r.body.status.keys_submitted, 2);

  // Even forcing it in SQL fails: the trigger enforces the time lock.
  await assert.rejects(pool.query(`UPDATE documents SET status = 'released' WHERE id = $1`, [docId]), /time lock/);
});

test('after the unlock time the worker releases it, and recipients can download', async () => {
  await new Promise((r) => setTimeout(r, 4500));
  const released = await releaseDueDocuments();
  assert.deepEqual(released, [docId]);

  const dl = await sup.agent.get(`/api/documents/${docId}/download`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(dl.status, 200);
  assert.ok(dl.body.equals(PAPER), 'downloaded file equals the original');

  // c3 never needed to submit; the release used c1 + c2.
  const { rows: [rel] } = await pool.query('SELECT custodian_ids FROM releases WHERE document_id = $1', [docId]);
  assert.deepEqual(new Set(rel.custodian_ids), new Set([c1.user.id, c2.user.id]));
  const { rows: [p] } = await pool.query('SELECT count(*) FROM pending_shares WHERE document_id = $1', [docId]);
  assert.equal(p.count, 0);
});

test('outsiders cannot see the document; the audit chain verifies', async () => {
  const stranger = await registerUser(app, { name: 'Stranger', email: 'x@test.dev', person: 'nobody' });
  assert.equal((await stranger.agent.get(`/api/documents/${docId}`)).status, 404);
  assert.equal((await stranger.agent.get('/api/audit/verify')).status, 403);

  const v = await admin.agent.get('/api/audit/verify');
  assert.equal(v.body.ok, true);
  assert.ok(v.body.checkedRows > 20);
});

test('a TOTP code cannot be used twice', async () => {
  const doc2 = await admin.agent.post('/api/documents')
    .field('title', 'Replay test')
    .field('unlockAt', new Date(Date.now() + 3_600_000).toISOString())
    .field('thresholdK', '2')
    .field('custodianIds', JSON.stringify([c1.user.id, c2.user.id]))
    .attach('file', PAPER, 'p.pdf');
  const doc3 = await admin.agent.post('/api/documents')
    .field('title', 'Replay test 2')
    .field('unlockAt', new Date(Date.now() + 3_600_000).toISOString())
    .field('thresholdK', '2')
    .field('custodianIds', JSON.stringify([c1.user.id, c2.user.id]))
    .attach('file', PAPER, 'p.pdf');
  await allowNewCode(pool, c1.user.id);
  const code = codeFor(c1.secret);
  const first = await c1.agent.post(`/api/documents/${doc2.body.document.document_id}/key-file`).send({ code });
  const second = await c1.agent.post(`/api/documents/${doc3.body.document.document_id}/key-file`).send({ code });
  assert.equal(first.status, 200);
  assert.equal(second.status, 401);
  assert.match(second.body.error, /already used/);
});
