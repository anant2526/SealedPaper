// Exam paper lifecycle: setup -> seal -> (key quorum opens it) -> assemble -> variants.
import crypto from 'node:crypto';
import { query, withTx } from '../db.js';
import { HttpError } from '../middleware/auth.js';
import { newDocumentKey, encrypt, wrap, unwrap, sha256, secureShuffle } from './crypto.js';
import { splitKey } from './shamir.js';
import { decryptQuestion } from './questions.js';
import { audit } from './audit.js';
import { config } from '../config.js';

// ---------- setup (create / edit while draft) ----------

/**
 * setup = { examName, subject, title, instructions, durationMinutes, sealDeadline, unlockAt, examStart,
 *           submitWindowMinutes, thresholdK, custodianIds[], setterIds[], blueprint[{topic, difficulty, count, marks}],
 *           centres[{centreId, superintendentId, candidateCount, printBuffer}] }
 */
async function validatePeople(db, ids, role, label) {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'active' AND role = $2`, [ids, role],
  );
  if (rows.length !== new Set(ids).size) throw new HttpError(400, `Every ${label} must be an active user with the ${label} role`);
}

function checkSetup(s) {
  const custodians = [...new Set(s.custodianIds)];
  if (custodians.length < 2) throw new HttpError(400, 'Choose at least 2 key custodians');
  if (s.thresholdK > custodians.length) {
    throw new HttpError(400, `Keys needed (${s.thresholdK}) cannot be more than the custodians (${custodians.length})`);
  }
  if (!(s.sealDeadline < s.unlockAt && s.unlockAt < s.examStart)) {
    throw new HttpError(400, 'Times must run: seal deadline, then unlock time, then exam start');
  }
  const cells = new Set(s.blueprint.map((b) => `${b.topic.trim().toLowerCase()}|${b.difficulty}`));
  if (cells.size !== s.blueprint.length) throw new HttpError(400, 'Each topic and difficulty pair may appear only once in the blueprint');
  const centres = new Set(s.centres.map((c) => c.centreId));
  if (centres.size !== s.centres.length) throw new HttpError(400, 'Each centre may appear only once');
  return custodians;
}

export async function createPaper(setup, actor, ip) {
  if (setup.sealDeadline.getTime() <= Date.now()) throw new HttpError(400, 'The seal deadline must be in the future');
  const custodians = checkSetup(setup);
  return withTx(async (db) => {
    await validatePeople(db, custodians, 'custodian', 'key custodian');
    await validatePeople(db, setup.setterIds, 'setter', 'setter');
    await validatePeople(db, setup.centres.map((c) => c.superintendentId), 'superintendent', 'superintendent');

    const { rows: [exam] } = await db.query(
      `INSERT INTO exams (name, created_by) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [setup.examName.trim(), actor.id],
    );
    const key = newDocumentKey();
    const { rows: [paper] } = await db.query(
      `INSERT INTO papers (exam_id, subject, title, instructions, duration_minutes, seal_deadline, unlock_at, exam_start,
                           submit_window_minutes, threshold_k, total_shares_n, data_key_wrapped, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [exam.id, setup.subject.trim(), setup.title.trim(), setup.instructions, setup.durationMinutes, setup.sealDeadline,
        setup.unlockAt, setup.examStart, setup.submitWindowMinutes, setup.thresholdK, custodians.length, wrap(key), actor.id],
    );
    key.fill(0);
    await writeChildren(db, paper.id, setup, custodians, true);
    await audit(db, { actorId: actor.id, action: 'paper.created', entity: 'paper', entityId: paper.id, ip,
      payload: { title: setup.title, subject: setup.subject, k: setup.thresholdK, n: custodians.length } });
    return paper.id;
  });
}

export async function updatePaper(paperId, setup, actor, ip) {
  const custodians = checkSetup(setup);
  return withTx(async (db) => {
    const { rows: [p] } = await db.query('SELECT status FROM papers WHERE id = $1 FOR UPDATE', [paperId]);
    if (!p) throw new HttpError(404, 'Paper not found');
    if (p.status !== 'draft') throw new HttpError(409, 'This paper is sealed and can no longer be edited');
    await validatePeople(db, custodians, 'custodian', 'key custodian');
    await validatePeople(db, setup.setterIds, 'setter', 'setter');
    await validatePeople(db, setup.centres.map((c) => c.superintendentId), 'superintendent', 'superintendent');
    const { rows: [exam] } = await db.query(
      `INSERT INTO exams (name, created_by) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [setup.examName.trim(), actor.id],
    );
    await db.query(
      `UPDATE papers SET exam_id=$2, subject=$3, title=$4, instructions=$5, duration_minutes=$6, seal_deadline=$7,
              unlock_at=$8, exam_start=$9, submit_window_minutes=$10, threshold_k=$11, total_shares_n=$12
        WHERE id = $1`,
      [paperId, exam.id, setup.subject.trim(), setup.title.trim(), setup.instructions, setup.durationMinutes,
        setup.sealDeadline, setup.unlockAt, setup.examStart, setup.submitWindowMinutes, setup.thresholdK, custodians.length],
    );
    await writeChildren(db, paperId, setup, custodians, false);
    await audit(db, { actorId: actor.id, action: 'paper.updated', entity: 'paper', entityId: paperId, ip,
      payload: { title: setup.title } });
    return paperId;
  });
}

async function writeChildren(db, paperId, setup, custodians, isNew) {
  // custodians + centres: replace
  await db.query('DELETE FROM paper_custodians WHERE paper_id = $1', [paperId]);
  for (const id of custodians) {
    await db.query('INSERT INTO paper_custodians (paper_id, custodian_id) VALUES ($1, $2)', [paperId, id]);
  }
  await db.query('DELETE FROM paper_centres WHERE paper_id = $1', [paperId]);
  for (const c of setup.centres) {
    await db.query(
      `INSERT INTO paper_centres (paper_id, centre_id, superintendent_id, candidate_count, print_buffer)
       VALUES ($1, $2, $3, $4, $5)`,
      [paperId, c.centreId, c.superintendentId, c.candidateCount, c.printBuffer],
    );
  }

  // setters: removing a setter who already wrote questions would delete their work -> refuse
  const newSetters = [...new Set(setup.setterIds)];
  if (!isNew) {
    const { rows } = await db.query(
      `SELECT u.name FROM paper_setters ps JOIN users u ON u.id = ps.setter_id
        WHERE ps.paper_id = $1 AND NOT (ps.setter_id = ANY($2::uuid[]))
          AND EXISTS (SELECT 1 FROM questions q WHERE q.paper_id = ps.paper_id AND q.setter_id = ps.setter_id)`,
      [paperId, newSetters],
    );
    if (rows.length) throw new HttpError(409, `${rows.map((r) => r.name).join(', ')} already added questions and cannot be removed`);
    await db.query('DELETE FROM paper_setters WHERE paper_id = $1 AND NOT (setter_id = ANY($2::uuid[]))', [paperId, newSetters]);
  }
  for (const id of newSetters) {
    await db.query('INSERT INTO paper_setters (paper_id, setter_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [paperId, id]);
  }

  // blueprint: upsert by (topic, difficulty); a cell that already has questions cannot be removed
  const keep = setup.blueprint.map((b) => [b.topic.trim(), b.difficulty]);
  const { rows: existing } = await db.query(
    `SELECT b.id, b.topic, b.difficulty, (SELECT count(*) FROM questions q WHERE q.paper_id = b.paper_id
            AND q.topic = b.topic AND q.difficulty = b.difficulty) AS used
       FROM blueprint_items b WHERE b.paper_id = $1`,
    [paperId],
  );
  for (const e of existing) {
    const still = keep.some(([t, d]) => t.toLowerCase() === e.topic.toLowerCase() && d === e.difficulty);
    if (!still) {
      if (e.used > 0) throw new HttpError(409, `"${e.topic}" (${e.difficulty}) already has questions and cannot be removed from the blueprint`);
      await db.query('DELETE FROM blueprint_items WHERE id = $1', [e.id]);
    }
  }
  for (let i = 0; i < setup.blueprint.length; i++) {
    const b = setup.blueprint[i];
    const match = existing.find((e) => e.topic.toLowerCase() === b.topic.trim().toLowerCase() && e.difficulty === b.difficulty);
    if (match) {
      await db.query('UPDATE blueprint_items SET position=$2, count_needed=$3, marks_each=$4, topic=$5 WHERE id=$1',
        [match.id, i + 1, b.count, b.marks, b.topic.trim()]);
    } else {
      await db.query(
        `INSERT INTO blueprint_items (paper_id, position, topic, difficulty, count_needed, marks_each)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [paperId, i + 1, b.topic.trim(), b.difficulty, b.count, b.marks],
      );
    }
  }
}

// ---------- sealing ----------

/** Problems that block sealing; empty array = ready. */
export async function sealProblems(db, paperId) {
  const problems = [];
  const { rows: [p] } = await db.query(
    `SELECT p.*, (SELECT count(*) FROM paper_custodians pc JOIN users u ON u.id = pc.custodian_id
                   WHERE pc.paper_id = p.id AND u.status = 'active' AND u.role = 'custodian') AS active_custodians,
            (SELECT count(*) FROM paper_custodians WHERE paper_id = p.id) AS custodians
       FROM papers p WHERE p.id = $1`,
    [paperId],
  );
  if (!p) return ['Paper not found'];
  if (p.status !== 'draft') return [`Paper is already ${p.status}`];
  if (p.custodians !== p.total_shares_n || p.active_custodians !== p.custodians) problems.push('Every key custodian must be an active account');
  if (new Date(p.unlock_at).getTime() <= Date.now() + config.minSealLeadSeconds * 1000) {
    problems.push(`The unlock time must be at least ${config.minSealLeadSeconds} seconds away`);
  }
  const { rows: cov } = await db.query('SELECT * FROM pool_coverage WHERE paper_id = $1 ORDER BY position', [paperId]);
  if (cov.length === 0) problems.push('The blueprint is empty');
  for (const c of cov) {
    if (!c.covered) problems.push(`${c.topic} (${c.difficulty}) has ${c.active_count} of ${c.count_needed} questions`);
  }
  const { rows: centres } = await db.query('SELECT * FROM centre_readiness WHERE paper_id = $1', [paperId]);
  if (centres.length === 0) problems.push('Add at least one exam centre');
  for (const c of centres) if (!c.superintendent_ready) problems.push(`Centre ${c.centre_code} has no active superintendent`);
  return problems;
}

/**
 * Seal: split the paper key among the custodians and DELETE the wrapped copy.
 * Creates the vault document that the custodians unlock with key file + code + face.
 */
export async function sealPaper(paperId, { actorId = null, ip = null } = {}) {
  return withTx(async (db) => {
    const { rows: [p] } = await db.query('SELECT * FROM papers WHERE id = $1 FOR UPDATE', [paperId]);
    if (!p) throw new HttpError(404, 'Paper not found');
    const problems = await sealProblems(db, paperId);
    if (problems.length) throw new HttpError(409, `Cannot seal yet: ${problems.join('; ')}`, { problems });

    const key = unwrap(p.data_key_wrapped);
    // A known plaintext encrypted with the paper key: at release, the AES-GCM tag proves
    // the rebuilt key is the right one before anything is drawn.
    const check = encrypt(key, Buffer.from(`SEALEDPAPER-KEYCHECK:${paperId}`));
    const { rows: custodians } = await db.query(
      `SELECT pc.custodian_id FROM paper_custodians pc JOIN users u ON u.id = pc.custodian_id
        WHERE pc.paper_id = $1 ORDER BY u.name`,
      [paperId],
    );
    const shares = await splitKey(key, custodians.length, p.threshold_k);
    key.fill(0);

    const { rows: [doc] } = await db.query(
      `INSERT INTO documents (title, original_name, mime_type, size_bytes, threshold_k, total_shares_n,
                              unlock_at, submit_window_minutes, created_by, paper_id)
       VALUES ($1, $2, 'application/x-sealedpaper-paper', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [`Exam paper: ${p.subject}, ${p.title}`.slice(0, 200), `${p.title}.pdf`, check.ciphertext.length,
        p.threshold_k, custodians.length, p.unlock_at, p.submit_window_minutes, p.created_by, paperId],
    );
    await db.query(
      `INSERT INTO document_blobs (document_id, iv, auth_tag, ciphertext, ciphertext_sha256) VALUES ($1, $2, $3, $4, $5)`,
      [doc.id, check.iv, check.authTag, check.ciphertext, sha256(check.ciphertext)],
    );
    for (let i = 0; i < custodians.length; i++) {
      await db.query(
        `INSERT INTO key_shares (document_id, custodian_id, share_index, share_hash, pickup_enc) VALUES ($1, $2, $3, $4, $5)`,
        [doc.id, custodians[i].custodian_id, i + 1, sha256(shares[i]), wrap(shares[i])],
      );
    }
    shares.forEach((s) => s.fill(0));

    // The CHECK constraint papers_key_only_in_draft forces the key to be deleted here.
    await db.query(`UPDATE papers SET status = 'sealed', data_key_wrapped = NULL WHERE id = $1`, [paperId]);
    const { rows: [{ count }] } = await db.query(`SELECT count(*) FROM questions WHERE paper_id = $1 AND status = 'active'`, [paperId]);
    await audit(db, { actorId, action: 'paper.sealed', entity: 'paper', entityId: paperId, ip,
      payload: { documentId: doc.id, poolSize: count, k: p.threshold_k, n: custodians.length, by: actorId ? 'admin' : 'worker' } });
    return doc.id;
  });
}

// ---------- assembly at release ----------

const sig = (order, options) => crypto.createHash('sha256').update(JSON.stringify({ order, options })).digest('hex');

/**
 * Runs inside the release transaction, right after the key quorum opened the vault document.
 * Draws the final questions (stored function), then gives every centre its own shuffled variant.
 */
export async function assemblePaper(db, paperId, actorId = null) {
  const { rows: drawn } = await db.query('SELECT * FROM draw_final_questions($1)', [paperId]);
  const shortfalls = drawn.filter((d) => d.drawn < d.needed);

  const { rows: finals } = await db.query(
    `SELECT f.question_id, f.position, f.section, q.option_count
       FROM final_questions f JOIN questions q ON q.id = f.question_id
      WHERE f.paper_id = $1 ORDER BY f.position`,
    [paperId],
  );
  const sections = new Map();
  for (const f of finals) {
    if (!sections.has(f.section)) sections.set(f.section, []);
    sections.get(f.section).push(f);
  }

  const { rows: centres } = await db.query('SELECT centre_id FROM paper_centres WHERE paper_id = $1', [paperId]);
  const usedOrders = new Set();
  const usedSigs = new Set();
  for (const c of centres) {
    let order;
    let options;
    // Prefer a question order no other centre has, so order alone can name the centre.
    for (let attempt = 0; attempt < 40; attempt++) {
      order = [...sections.keys()].sort((a, b) => a - b).flatMap((s) => secureShuffle(sections.get(s)).map((f) => f.question_id));
      options = Object.fromEntries(finals.map((f) => [f.question_id, secureShuffle([...Array(f.option_count).keys()])]));
      if (!usedOrders.has(order.join()) && !usedSigs.has(sig(order, options))) break;
    }
    const signature = sig(order, options);
    if (usedSigs.has(signature)) throw new Error('could not build distinct variants');
    usedOrders.add(order.join());
    usedSigs.add(signature);
    await db.query(
      `INSERT INTO variants (paper_id, centre_id, question_order, option_orders, signature) VALUES ($1, $2, $3, $4, $5)`,
      [paperId, c.centre_id, order, JSON.stringify(options), signature],
    );
  }

  await db.query(`UPDATE papers SET status = 'released' WHERE id = $1`, [paperId]);
  await audit(db, { actorId, action: 'paper.assembled', entity: 'paper', entityId: paperId,
    payload: { questions: finals.length, centres: centres.length, shortfalls } });
}

// ---------- reading a released paper ----------

/** Decrypts the final questions of a released paper with the key the quorum rebuilt. */
export async function openReleasedPaper(paperId) {
  const { rows: [r] } = await query(
    `SELECT r.wrapped_key FROM releases r JOIN documents d ON d.id = r.document_id
      WHERE d.paper_id = $1`,
    [paperId],
  );
  if (!r) throw new HttpError(423, 'This paper is still sealed');
  const key = unwrap(r.wrapped_key);
  try {
    const { rows } = await query(
      `SELECT f.question_id, f.position, f.section, f.marks, q.topic, q.difficulty, q.setter_id, q.body_enc
         FROM final_questions f JOIN questions q ON q.id = f.question_id
        WHERE f.paper_id = $1 ORDER BY f.position`,
      [paperId],
    );
    return rows.map((row) => {
      const body = decryptQuestion(key, row.body_enc);
      return {
        id: row.question_id, position: row.position, section: row.section, marks: row.marks,
        topic: row.topic, difficulty: row.difficulty, setterId: row.setter_id,
        text: body.text, options: body.options, answer: body.answer,
      };
    });
  } finally {
    key.fill(0);
  }
}

/** Questions in the order and option order of one centre's variant. */
export function applyVariant(finals, variant) {
  const byId = new Map(finals.map((q) => [q.id, q]));
  return variant.question_order.map((id, i) => {
    const q = byId.get(id);
    const order = variant.option_orders[id];
    return {
      ...q,
      number: i + 1,
      options: order.map((o) => q.options[o]),
      answer: order.indexOf(q.answer),
    };
  });
}
