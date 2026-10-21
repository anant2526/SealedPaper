// The whole exam pipeline: setup -> question pool -> early leak + burn -> seal ->
// key quorum (key file + code + face) -> late draw + per-centre variants -> printing
// with copy codes and a print cap -> reprint with four-eyes approval -> leak tracing
// to the setter (before release) and to the centre and copy (after release).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, registerUser, framesFor, codeFor, allowNewCode } from './helpers.js';

await resetDatabase();
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { releaseDueDocuments } = await import('../src/worker.js');
const app = createApp();

const ppl = {};
let paperId;
let documentId;
let centres = {};
const T0 = Date.now();

const Q = (text, opts, answer = 0, topic = 'Arrays', difficulty = 'easy') => ({ topic, difficulty, text, options: opts, answer });
const S1_QUESTIONS = [
  Q('What is the time complexity of accessing an array element by index?', ['O(1)', 'O(n)', 'O(log n)', 'O(n log n)']),
  Q('Which operation on a dynamic array is amortised constant time?', ['Append at the end', 'Insert at the front', 'Delete from the middle', 'Linear search']),
  Q('An array of 10 integers of 4 bytes each occupies how many bytes?', ['40 bytes', '10 bytes', '14 bytes', '400 bytes']),
  Q('In an AVL tree, what is the maximum allowed balance factor of any node?', ['1', '2', '0', '3'], 0, 'Trees', 'medium'),
];
const S2_QUESTIONS = [
  Q('Which technique finds a pair with a given sum in a sorted array in linear time?', ['Two pointers', 'Binary search per element', 'Hashing every pair', 'Bubble sort']),
  Q('What does a prefix sum array let you compute in constant time?', ['Sum of any subarray', 'Maximum element', 'Sorted order', 'Median']),
  Q('Which traversal of a binary search tree visits keys in sorted order?', ['Inorder', 'Preorder', 'Postorder', 'Level order'], 0, 'Trees', 'medium'),
  Q('How many children can a node of a binary tree have at most?', ['Two', 'One', 'Three', 'Unlimited'], 0, 'Trees', 'medium'),
  Q('This topic is not in the blueprint at all, so it must be skipped', ['A', 'B'], 0, 'Graphs', 'hard'),
  Q('What is the time complexity of accessing an array element by index?', ['O(1)', 'O(n)']),   // duplicate of setter 1
];

before(async () => {
  ppl.admin = await registerUser(app, { name: 'Exam Controller', email: 'admin@x.dev', person: 'admin' });
  const roles = {
    s1: ['setter', 'Setter Asha'], s2: ['setter', 'Setter Bilal'],
    c1: ['custodian', 'Cust One'], c2: ['custodian', 'Cust Two'], c3: ['custodian', 'Cust Three'],
    sup1: ['superintendent', 'Supt Delhi'], sup2: ['superintendent', 'Supt Pune'], inv: ['investigator', 'Investigator Ira'],
  };
  for (const [k, [role, name]] of Object.entries(roles)) {
    ppl[k] = await registerUser(app, { name, email: `${k}@x.dev`, person: k });
    if (role !== 'custodian') {
      const r = await ppl.admin.agent.patch(`/api/users/${ppl[k].user.id}`).send({ role });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  }
});
after(() => pool.end());

test('admin creates centres and a paper with blueprint, setters, custodians and centres', async () => {
  for (const [code, name, city] of [['DEL01', 'Delhi Public School', 'Delhi'], ['PUN02', 'Pune Model College', 'Pune']]) {
    const r = await ppl.admin.agent.post('/api/centres').send({ code, name, city });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    centres[code] = r.body.centre.id;
  }
  const dup = await ppl.admin.agent.post('/api/centres').send({ code: 'del01', name: 'Again', city: 'Delhi' });
  assert.equal(dup.status, 409);

  const res = await ppl.admin.agent.post('/api/papers').send({
    examName: 'Mid-semester 2026', subject: 'Data Structures', title: 'Paper A',
    instructions: 'Answer all questions. Each question has one correct option.',
    durationMinutes: 90,
    sealDeadline: new Date(T0 + 30_000), unlockAt: new Date(T0 + 34_000), examStart: new Date(T0 + 3_600_000),
    thresholdK: 2, custodianIds: [ppl.c1.user.id, ppl.c2.user.id, ppl.c3.user.id],
    setterIds: [ppl.s1.user.id, ppl.s2.user.id],
    blueprint: [{ topic: 'Arrays', difficulty: 'easy', count: 3, marks: 2 }, { topic: 'Trees', difficulty: 'medium', count: 2, marks: 4 }],
    centres: [
      { centreId: centres.DEL01, superintendentId: ppl.sup1.user.id, candidateCount: 2, printBuffer: 1 },
      { centreId: centres.PUN02, superintendentId: ppl.sup2.user.id, candidateCount: 5, printBuffer: 1 },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  paperId = res.body.id;

  const d = await ppl.admin.agent.get(`/api/papers/${paperId}`);
  assert.equal(d.body.paper.status, 'draft');
  assert.equal(d.body.paper.totalMarks, 3 * 2 + 2 * 4);
  assert.ok(d.body.sealProblems.some((p) => p.includes('Arrays')), 'pool is empty, so sealing is blocked');
});

test('a custodian given the setter role cannot be put in the custodian list', async () => {
  const r = await ppl.admin.agent.post('/api/papers').send({
    examName: 'Mid-semester 2026', subject: 'Data Structures', title: 'Paper B', durationMinutes: 60,
    sealDeadline: new Date(T0 + 600_000), unlockAt: new Date(T0 + 700_000), examStart: new Date(T0 + 800_000),
    thresholdK: 2, custodianIds: [ppl.c1.user.id, ppl.s1.user.id], setterIds: [ppl.s1.user.id],
    blueprint: [{ topic: 'Arrays', difficulty: 'easy', count: 1, marks: 1 }],
    centres: [{ centreId: centres.DEL01, superintendentId: ppl.sup1.user.id, candidateCount: 2, printBuffer: 0 }],
  });
  assert.equal(r.status, 400);
});

test('setters add questions (one by one and by import); each sees only their own', async () => {
  for (const q of S1_QUESTIONS) {
    const r = await ppl.s1.agent.post(`/api/papers/${paperId}/questions`).send(q);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const imp = await ppl.s2.agent.post(`/api/papers/${paperId}/questions/import`).send({ questions: S2_QUESTIONS });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.added, 4);
  assert.equal(imp.body.skipped.length, 2);

  const mine = await ppl.s1.agent.get(`/api/papers/${paperId}/questions/mine`);
  assert.equal(mine.body.questions.length, 4);
  assert.ok(mine.body.questions.every((q) => S1_QUESTIONS.some((s) => s.text === q.text)));

  // a custodian on this paper is not a setter
  assert.equal((await ppl.c1.agent.get(`/api/papers/${paperId}/questions/mine`)).status, 403);

  // the database holds ciphertext only
  const { rows } = await pool.query('SELECT body_enc FROM questions WHERE paper_id = $1', [paperId]);
  assert.ok(rows.every((r) => !r.body_enc.includes(Buffer.from('complexity'))));
});

let earlyLeakId;
test('a leak before release names the setter, and burning keeps the question out of the draw', async () => {
  const leak = `Got this from a senior, paper A for tomorrow!!\n\nQ1. ${S1_QUESTIONS[1].text} [2 marks]\n(a) Append at the end\n(b) Insert at the front\n`;
  const r = await ppl.inv.agent.post('/api/leaks').send({ paperId, text: leak, source: 'Telegram group' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  earlyLeakId = r.body.id;
  const rep = await ppl.inv.agent.get(`/api/leaks/${earlyLeakId}`);
  assert.equal(rep.body.report.phase, 'pre_release');
  assert.equal(rep.body.matches.length, 1);
  assert.equal(rep.body.matches[0].setter_name, 'Setter Asha');

  // investigators can report but never change records
  assert.equal((await ppl.inv.agent.post(`/api/leaks/${earlyLeakId}/burn`)).status, 403);
  const burn = await ppl.admin.agent.post(`/api/leaks/${earlyLeakId}/burn`);
  assert.equal(burn.body.burned, 1);
  const d = await ppl.admin.agent.get(`/api/papers/${paperId}`);
  const arrays = d.body.blueprint.find((b) => b.topic === 'Arrays');
  assert.equal(arrays.active_count, 4);
  assert.equal(arrays.burned_count, 1);
});

test('sealing deletes the paper key; questions are frozen even in raw SQL', async () => {
  const r = await ppl.admin.agent.post(`/api/papers/${paperId}/seal`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  documentId = r.body.documentId;
  const { rows: [p] } = await pool.query('SELECT status, data_key_wrapped FROM papers WHERE id = $1', [paperId]);
  assert.equal(p.status, 'sealed');
  assert.equal(p.data_key_wrapped, null);

  const edit = await ppl.s1.agent.post(`/api/papers/${paperId}/questions`).send(Q('A brand new question after sealing?', ['Yes', 'No']));
  assert.equal(edit.status, 409);
  const mine = await ppl.s1.agent.get(`/api/papers/${paperId}/questions/mine`);
  assert.equal(mine.body.locked, true);
  assert.equal(mine.body.questions[0].text, undefined, 'even the setter can no longer read it');

  await assert.rejects(pool.query(`DELETE FROM questions WHERE paper_id = $1`, [paperId]), /frozen/);
  await assert.rejects(pool.query(`UPDATE papers SET exam_start = exam_start + interval '1 day' WHERE id = $1`, [paperId]), /frozen/);
  await assert.rejects(pool.query(`UPDATE papers SET status = 'released' WHERE id = $1`, [paperId]), /still locked/);
  await assert.rejects(pool.query(`DELETE FROM blueprint_items WHERE paper_id = $1`, [paperId]), /cannot change/);
});

test('custodians open it with key file + code + face; the draw skips the burned question', async () => {
  const keyFiles = {};
  for (const c of ['c1', 'c2', 'c3']) {
    await allowNewCode(pool, ppl[c].user.id);
    const r = await ppl[c].agent.post(`/api/documents/${documentId}/key-file`).send({ code: codeFor(ppl[c].secret) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    keyFiles[c] = r.body.keyFile;
  }
  for (const c of ['c1', 'c3']) {
    await allowNewCode(pool, ppl[c].user.id);
    const ch = await ppl[c].agent.post(`/api/documents/${documentId}/face-challenge`).send({});
    const r = await ppl[c].agent.post(`/api/documents/${documentId}/unlock`).send({
      challengeId: ch.body.challengeId, frames: framesFor(ch.body.poses, c), code: codeFor(ppl[c].secret), keyFile: keyFiles[c],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.released, false, 'unlock time not reached yet');
  }
  // the documents endpoint never hands out an exam paper as a file
  await new Promise((r) => setTimeout(r, Math.max(0, T0 + 34_500 - Date.now())));
  const released = await releaseDueDocuments();
  assert.deepEqual(released, [documentId]);

  const { rows: [p] } = await pool.query('SELECT status FROM papers WHERE id = $1', [paperId]);
  assert.equal(p.status, 'released');
  const { rows: finals } = await pool.query(
    'SELECT q.status, q.topic FROM final_questions f JOIN questions q ON q.id = f.question_id WHERE f.paper_id = $1', [paperId],
  );
  assert.equal(finals.length, 5);
  assert.ok(finals.every((f) => f.status === 'active'), 'burned question never drawn');
  const { rows: v } = await pool.query('SELECT question_order FROM variants WHERE paper_id = $1', [paperId]);
  assert.equal(v.length, 2);
  assert.notEqual(v[0].question_order.join(), v[1].question_order.join(), 'each centre has its own order');
});

const copyCodes = [];
let copyIds;
test('superintendents print numbered copies of their own centre, up to the cap', async () => {
  const other = await ppl.sup2.agent.post(`/api/papers/${paperId}/centres/${centres.DEL01}/print`).send({ count: 1 });
  assert.equal(other.status, 403);

  const r = await ppl.sup1.agent.post(`/api/papers/${paperId}/centres/${centres.DEL01}/print`).send({ count: 3 })
    .buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.body.subarray(0, 4).toString(), '%PDF');
  copyCodes.push(...r.headers['x-copy-codes'].split(','));
  if (process.env.PDF_OUT) (await import('node:fs')).writeFileSync(process.env.PDF_OUT, r.body);
  assert.equal(copyCodes.length, 3);
  assert.ok(copyCodes.every((c) => /^DEL01-000\d-[A-Z2-7]{4}$/.test(c)));

  const over = await ppl.sup1.agent.post(`/api/papers/${paperId}/centres/${centres.DEL01}/print`).send({ count: 1 });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /print cap/);

  const list = await ppl.sup1.agent.get(`/api/papers/${paperId}/centres/${centres.DEL01}/copies`);
  copyIds = list.body.copies.map((c) => c.id);
  assert.equal(list.body.readiness.copies_printed, 3);
});

test('a spoiled copy is replaced only after an admin approves; the old copy is voided', async () => {
  const req1 = await ppl.sup1.agent.post(`/api/papers/copies/${copyIds[0]}/reprint-requests`).send({ reason: 'Printer jammed, page 2 torn' });
  assert.equal(req1.status, 201, JSON.stringify(req1.body));
  const again = await ppl.sup1.agent.post(`/api/papers/copies/${copyIds[0]}/reprint-requests`).send({ reason: 'twice' });
  assert.equal(again.status, 409);

  const early = await ppl.sup1.agent.post(`/api/papers/reprint-requests/${req1.body.id}/print`);
  assert.equal(early.status, 409, 'cannot print before approval');

  const ok = await ppl.admin.agent.patch(`/api/papers/reprint-requests/${req1.body.id}`).send({ decision: 'approved' });
  assert.equal(ok.status, 200);
  const pr = await ppl.sup1.agent.post(`/api/papers/reprint-requests/${req1.body.id}/print`);
  assert.equal(pr.status, 200);
  copyCodes.push(pr.headers['x-copy-codes']);
  const list = await ppl.sup1.agent.get(`/api/papers/${paperId}/centres/${centres.DEL01}/copies`);
  assert.ok(list.body.copies[0].voided_at);
  assert.equal(list.body.copies[3].replaces, copyCodes[0]);

  // four eyes, enforced by the database too
  await assert.rejects(pool.query(
    `INSERT INTO reprint_requests (copy_id, requested_by, reason, status, decided_by, decided_at)
     VALUES ($1, $2, 'self approved', 'approved', $2, now())`, [copyIds[1], ppl.sup1.user.id]), /reprint_four_eyes/);
  await assert.rejects(pool.query('DELETE FROM printed_copies WHERE id = $1', [copyIds[1]]), /cannot be deleted/);
});

test('after release a leak names the centre by question order, and the copy by its code', async () => {
  const content = await ppl.admin.agent.get(`/api/papers/${paperId}/content`);
  assert.equal(content.status, 200, JSON.stringify(content.body));
  const byPos = Object.fromEntries(content.body.questions.map((q) => [q.position, q]));
  const pune = content.body.centres.find((c) => c.code === 'PUN02');
  const leakText = pune.key.map((k) => `${k.number}. ${byPos[k.basePosition].text}`).join('\n');

  const r = await ppl.inv.agent.post('/api/leaks').send({ paperId, text: leakText, source: 'WhatsApp screenshot' });
  const rep = await ppl.inv.agent.get(`/api/leaks/${r.body.id}`);
  assert.equal(rep.body.report.phase, 'post_release');
  assert.equal(rep.body.report.centre_code, 'PUN02');
  assert.ok(rep.body.report.confidence > 0);

  const withCode = `${leakText.split('\n')[0]}\nSealedPaper | Centre DEL01 | Copy ${copyCodes[1]}`;
  const r2 = await ppl.inv.agent.post('/api/leaks').send({ paperId, text: withCode });
  const rep2 = await ppl.inv.agent.get(`/api/leaks/${r2.body.id}`);
  assert.equal(rep2.body.report.copy_code, copyCodes[1]);
  assert.equal(rep2.body.report.centre_code, 'DEL01');
  assert.equal(rep2.body.report.confidence, 1);

  // the report table itself is append-only
  await assert.rejects(pool.query('DELETE FROM leak_reports'), /append-only/);
});

test('analytics views and the audit chain', async () => {
  const a = await ppl.inv.agent.get('/api/leaks/analytics');
  assert.equal(a.status, 200);
  assert.ok(Array.isArray(a.body.setters) && Array.isArray(a.body.centres));
  assert.ok(a.body.centres.some((c) => c.code === 'DEL01' && Number(c.reprints) === 1));
  const v = await ppl.admin.agent.get('/api/audit/verify');
  assert.equal(v.body.ok, true);
});
