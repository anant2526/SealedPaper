// Confidential documents beyond exams: a financial report opens k-of-N, every reader
// gets a stamped copy with its own code, the copy limit holds, and a leak names the reader.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { resetDatabase, registerUser, framesFor, codeFor, allowNewCode } from './helpers.js';

await resetDatabase();
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { releaseDueDocuments } = await import('../src/worker.js');
const app = createApp();

const ppl = {};
let docId;
let copyCode;

async function makePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`Q3 FY27 results, page ${i}: revenue up 18 percent. Not for release before 4 pm.`, { x: 50, y: 780, size: 12, font });
  }
  return Buffer.from(await pdf.save());
}

const binary = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

before(async () => {
  ppl.admin = await registerUser(app, { name: 'Company Secretary', email: 'cs@corp.dev', person: 'cs' });
  for (const k of ['cfo', 'ceo', 'auditor']) ppl[k] = await registerUser(app, { name: k.toUpperCase(), email: `${k}@corp.dev`, person: k });
  ppl.analyst = await registerUser(app, { name: 'Analyst Riya', email: 'riya@corp.dev', person: 'riya' });
  ppl.inv = await registerUser(app, { name: 'Compliance Officer', email: 'compliance@corp.dev', person: 'inv' });
  await ppl.admin.agent.patch(`/api/users/${ppl.analyst.user.id}`).send({ role: 'superintendent' });
  await ppl.admin.agent.patch(`/api/users/${ppl.inv.user.id}`).send({ role: 'investigator' });
});
after(() => pool.end());

test('a financial report is sealed with a category and a copy limit', async () => {
  const r = await ppl.admin.agent.post('/api/documents')
    .field('title', 'Q3 FY27 results before announcement')
    .field('category', 'financial')
    .field('description', 'Board-approved results. Embargoed until the stock exchange filing.')
    .field('copiesPerReader', '1')
    .field('unlockAt', new Date(Date.now() + 2500).toISOString())
    .field('thresholdK', '2')
    .field('custodianIds', JSON.stringify([ppl.cfo.user.id, ppl.ceo.user.id, ppl.auditor.user.id]))
    .field('recipientIds', JSON.stringify([ppl.analyst.user.id]))
    .attach('file', await makePdf(), { filename: 'q3-results.pdf', contentType: 'application/pdf' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  docId = r.body.document.document_id;
  const d = await ppl.admin.agent.get(`/api/documents/${docId}`);
  assert.equal(d.body.document.category, 'financial');
  assert.equal(d.body.document.copies_per_reader, 1);
});

test('nothing can be copied before the quorum opens it', async () => {
  assert.equal((await ppl.analyst.agent.get(`/api/documents/${docId}/download`)).status, 423);
  await assert.rejects(pool.query(
    `INSERT INTO document_copies (document_id, reader_id, copy_no, copy_code, stamped) VALUES ($1, $2, 1, 'FIN-0001-AAAA', true)`,
    [docId, ppl.analyst.user.id]), /not released/);
});

test('two of three executives open it after the unlock time', async () => {
  for (const k of ['cfo', 'ceo']) {
    await allowNewCode(pool, ppl[k].user.id);
    const kf = await ppl[k].agent.post(`/api/documents/${docId}/key-file`).send({ code: codeFor(ppl[k].secret) });
    await allowNewCode(pool, ppl[k].user.id);
    const ch = await ppl[k].agent.post(`/api/documents/${docId}/face-challenge`).send({});
    const r = await ppl[k].agent.post(`/api/documents/${docId}/unlock`).send({
      challengeId: ch.body.challengeId, frames: framesFor(ch.body.poses, k), code: codeFor(ppl[k].secret), keyFile: kf.body.keyFile,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  await new Promise((r) => setTimeout(r, 2600));
  assert.deepEqual(await releaseDueDocuments(), [docId]);
});

test('each download is a stamped copy with its own code, and the copy limit holds', async () => {
  const r = await ppl.analyst.agent.get(`/api/documents/${docId}/download`).buffer(true).parse(binary);
  assert.equal(r.status, 200);
  copyCode = r.headers['x-copy-code'];
  assert.match(copyCode, /^FIN-0001-[A-Z2-7]{4}$/);
  assert.match(r.headers['content-disposition'], new RegExp(copyCode));
  const pdf = await PDFDocument.load(r.body);
  assert.equal(pdf.getPageCount(), 2);
  assert.match(pdf.getKeywords(), new RegExp(copyCode));
  assert.match(pdf.getSubject(), /riya@corp\.dev/);

  const again = await ppl.analyst.agent.get(`/api/documents/${docId}/download`);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /copy limit/);

  // another reader gets a different code
  const cfo = await ppl.cfo.agent.get(`/api/documents/${docId}/download`);
  assert.match(cfo.headers['x-copy-code'], /^FIN-0002-/);

  const list = await ppl.admin.agent.get(`/api/documents/${docId}/copies`);
  assert.equal(list.body.copies.length, 2);
  const mine = await ppl.analyst.agent.get(`/api/documents/${docId}/copies`);
  assert.equal(mine.body.copies.length, 1, 'a reader sees only their own copies');
  await assert.rejects(pool.query('DELETE FROM document_copies'), /append-only/);
});

test('a leak carrying the copy code names the reader', async () => {
  const leak = `Forwarded on WhatsApp: "revenue up 18 percent" ... Confidential. Issued to Analyst Riya (riya@corp.dev). Copy ${copyCode}.`;
  const r = await ppl.inv.agent.post('/api/leaks').send({ documentId: docId, text: leak, source: 'WhatsApp forward' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rep = await ppl.inv.agent.get(`/api/leaks/${r.body.id}`);
  assert.equal(rep.body.report.reader_name, 'Analyst Riya');
  assert.equal(rep.body.report.doc_copy_code, copyCode);
  assert.equal(rep.body.report.confidence, 1);

  const none = await ppl.inv.agent.post('/api/leaks').send({ documentId: docId, text: 'revenue up 18 percent, heard from someone' });
  const rep2 = await ppl.inv.agent.get(`/api/leaks/${none.body.id}`);
  assert.equal(rep2.body.report.matched_document_copy_id, null);

  const a = await ppl.inv.agent.get('/api/leaks/analytics');
  assert.ok(a.body.readers.some((x) => x.name === 'Analyst Riya' && Number(x.leaked_copies) === 1));
  const list = await ppl.inv.agent.get('/api/leaks');
  assert.ok(list.body.reports.some((x) => x.reader_name === 'Analyst Riya'));
});
