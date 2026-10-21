// Exam papers: setup (admin), question pool (setters), sealing, released content,
// printing (superintendents) and reprints.
import crypto from 'node:crypto';
import { Router } from 'express';
import { query, withTx } from '../db.js';
import { parse, z } from '../validate.js';
import { HttpError, clientIp, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { createPaper, updatePaper, sealPaper, sealProblems, openReleasedPaper, applyVariant } from '../services/papers.js';
import { draftKey, encryptQuestion, decryptQuestion, questionHmac, normalise } from '../services/questions.js';
import { renderCopies } from '../services/pdf.js';

const router = Router();
const LETTERS = 'ABCDEF';

// ---------- who may see what ----------

async function paperAccess(paperId, user) {
  const { rows: [paper] } = await query(
    `SELECT p.*, e.name AS exam_name, d.id AS document_id
       FROM papers p JOIN exams e ON e.id = p.exam_id LEFT JOIN documents d ON d.paper_id = p.id
      WHERE p.id = $1`,
    [paperId],
  );
  if (!paper) throw new HttpError(404, 'Paper not found');
  const { rows: [m] } = await query(
    `SELECT EXISTS (SELECT 1 FROM paper_setters WHERE paper_id = $1 AND setter_id = $2) AS setter,
            EXISTS (SELECT 1 FROM paper_custodians WHERE paper_id = $1 AND custodian_id = $2) AS custodian,
            coalesce((SELECT array_agg(centre_id) FROM paper_centres WHERE paper_id = $1 AND superintendent_id = $2), '{}') AS my_centres`,
    [paperId, user.id],
  );
  const roles = {
    admin: user.role === 'admin',
    investigator: user.role === 'investigator',
    setter: m.setter,
    custodian: m.custodian,
    superintendent: m.my_centres.length > 0,
    myCentres: m.my_centres,
  };
  if (!roles.admin && !roles.investigator && !roles.setter && !roles.custodian && !roles.superintendent) {
    throw new HttpError(404, 'Paper not found');
  }
  return { paper, roles };
}

const iso = z.coerce.date();
const setupSchema = z.object({
  examName: z.string().trim().min(3).max(120),
  subject: z.string().trim().min(2).max(120),
  title: z.string().trim().min(3).max(200),
  instructions: z.string().max(2000).default(''),
  durationMinutes: z.coerce.number().int().min(10).max(600),
  sealDeadline: iso,
  unlockAt: iso,
  examStart: iso,
  submitWindowMinutes: z.coerce.number().int().min(0).max(10080).default(60),
  thresholdK: z.coerce.number().int().min(2).max(20),
  custodianIds: z.array(z.uuid()).min(2).max(20),
  setterIds: z.array(z.uuid()).min(1).max(50),
  blueprint: z.array(z.object({
    topic: z.string().trim().min(2).max(80),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    count: z.coerce.number().int().min(1).max(100),
    marks: z.coerce.number().int().min(1).max(100),
  })).min(1).max(30),
  centres: z.array(z.object({
    centreId: z.uuid(),
    superintendentId: z.uuid(),
    candidateCount: z.coerce.number().int().min(1).max(100000),
    printBuffer: z.coerce.number().int().min(0).max(100).default(2),
  })).min(1).max(100),
});

// ---------- list + create ----------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const seeAll = ['admin', 'investigator'].includes(req.user.role);
    const { rows } = await query(
      `SELECT p.id, p.title, p.subject, e.name AS exam_name, p.status, p.seal_deadline, p.unlock_at, p.exam_start,
              p.threshold_k, p.total_shares_n, d.id AS document_id, s.keys_submitted,
              (ps.setter_id IS NOT NULL) AS i_am_setter,
              (pcu.custodian_id IS NOT NULL) AS i_am_custodian,
              EXISTS (SELECT 1 FROM paper_centres c WHERE c.paper_id = p.id AND c.superintendent_id = $1) AS i_am_superintendent,
              CASE WHEN $2 THEN (SELECT count(*) FROM questions q WHERE q.paper_id = p.id AND q.status = 'active') END AS pool_size,
              (SELECT sum(count_needed) FROM blueprint_items b WHERE b.paper_id = p.id) AS questions_needed,
              (SELECT count(*) FROM questions q WHERE q.paper_id = p.id AND q.setter_id = $1) AS my_questions,
              (SELECT count(*) FROM paper_centres c WHERE c.paper_id = p.id) AS centre_count
         FROM papers p
         JOIN exams e ON e.id = p.exam_id
         LEFT JOIN documents d ON d.paper_id = p.id
         LEFT JOIN unlock_status s ON s.document_id = d.id
         LEFT JOIN paper_setters ps ON ps.paper_id = p.id AND ps.setter_id = $1
         LEFT JOIN paper_custodians pcu ON pcu.paper_id = p.id AND pcu.custodian_id = $1
        WHERE $2 OR ps.setter_id IS NOT NULL OR pcu.custodian_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM paper_centres c WHERE c.paper_id = p.id AND c.superintendent_id = $1)
        ORDER BY p.exam_start DESC`,
      [req.user.id, seeAll],
    );
    res.json({ papers: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth('admin'), async (req, res, next) => {
  try {
    const setup = parse(setupSchema, req.body);
    const id = await createPaper(setup, req.user, clientIp(req));
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/setup', requireAuth('admin'), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const { paper } = await paperAccess(id, req.user);
    const [b, s, c, ce] = await Promise.all([
      query('SELECT topic, difficulty, count_needed AS count, marks_each AS marks FROM blueprint_items WHERE paper_id = $1 ORDER BY position', [id]),
      query('SELECT setter_id FROM paper_setters WHERE paper_id = $1', [id]),
      query('SELECT custodian_id FROM paper_custodians WHERE paper_id = $1', [id]),
      query(`SELECT centre_id AS "centreId", superintendent_id AS "superintendentId", candidate_count AS "candidateCount",
                    print_buffer AS "printBuffer" FROM paper_centres WHERE paper_id = $1`, [id]),
    ]);
    res.json({
      status: paper.status,
      setup: {
        examName: paper.exam_name, subject: paper.subject, title: paper.title, instructions: paper.instructions,
        durationMinutes: paper.duration_minutes, sealDeadline: paper.seal_deadline, unlockAt: paper.unlock_at,
        examStart: paper.exam_start, submitWindowMinutes: paper.submit_window_minutes, thresholdK: paper.threshold_k,
        blueprint: b.rows, setterIds: s.rows.map((r) => r.setter_id), custodianIds: c.rows.map((r) => r.custodian_id),
        centres: ce.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAuth('admin'), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const setup = parse(setupSchema, req.body);
    await updatePaper(id, setup, req.user, clientIp(req));
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

// ---------- detail (shape depends on the viewer's roles) ----------

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const { paper, roles } = await paperAccess(id, req.user);
    const overseer = roles.admin || roles.investigator;

    const { rows: blueprint } = await query(
      `SELECT position, topic, difficulty, count_needed, marks_each,
              CASE WHEN $2 THEN active_count END AS active_count,
              CASE WHEN $2 THEN burned_count END AS burned_count,
              CASE WHEN $2 THEN covered END AS covered
         FROM pool_coverage WHERE paper_id = $1 ORDER BY position`,
      [id, overseer],
    );
    const { rows: centres } = await query(
      `SELECT * FROM centre_readiness WHERE paper_id = $1 AND ($2 OR superintendent_id = $3) ORDER BY centre_code`,
      [id, overseer, req.user.id],
    );
    const out = {
      paper: {
        id: paper.id, examName: paper.exam_name, subject: paper.subject, title: paper.title, instructions: paper.instructions,
        durationMinutes: paper.duration_minutes, status: paper.status, sealDeadline: paper.seal_deadline,
        unlockAt: paper.unlock_at, examStart: paper.exam_start, thresholdK: paper.threshold_k, totalSharesN: paper.total_shares_n,
        submitWindowMinutes: paper.submit_window_minutes, documentId: paper.document_id,
        totalMarks: blueprint.reduce((s, b) => s + b.count_needed * b.marks_each, 0),
      },
      me: { ...roles, myCentres: undefined },
      blueprint,
      centres,
      serverTime: new Date().toISOString(),
    };

    if (paper.document_id) {
      const { rows: [s] } = await query('SELECT * FROM unlock_status WHERE document_id = $1', [paper.document_id]);
      out.keys = s;
    }
    if (overseer) {
      const { rows: setters } = await query(
        `SELECT u.id, u.name, u.email,
                count(q.id) AS questions, count(q.id) FILTER (WHERE q.status = 'burned') AS burned
           FROM paper_setters ps JOIN users u ON u.id = ps.setter_id
           LEFT JOIN questions q ON q.paper_id = ps.paper_id AND q.setter_id = ps.setter_id
          WHERE ps.paper_id = $1 GROUP BY u.id ORDER BY u.name`,
        [id],
      );
      const { rows: custodians } = await query(
        `SELECT u.id, u.name, u.email, u.status FROM paper_custodians pc JOIN users u ON u.id = pc.custodian_id
          WHERE pc.paper_id = $1 ORDER BY u.name`,
        [id],
      );
      out.setters = setters;
      out.custodians = custodians;
      if (paper.status === 'draft' && roles.admin) out.sealProblems = await sealProblems({ query }, id);
      const { rows: leaks } = await query(
        `SELECT lr.id, lr.phase, lr.created_at, lr.confidence, c.code AS centre_code,
                (SELECT count(*) FROM leak_matches m WHERE m.leak_report_id = lr.id) AS matches
           FROM leak_reports lr LEFT JOIN variants v ON v.id = lr.matched_variant_id LEFT JOIN centres c ON c.id = v.centre_id
          WHERE lr.paper_id = $1 ORDER BY lr.created_at DESC`,
        [id],
      );
      out.leaks = leaks;
    }
    if (roles.setter) {
      const { rows: [mine] } = await query(
        `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'burned') AS burned
           FROM questions WHERE paper_id = $1 AND setter_id = $2`,
        [id, req.user.id],
      );
      out.myQuestions = mine;
    }
    if (roles.admin) {
      const { rows: reprints } = await query(
        `SELECT r.id, r.reason, r.status, r.created_at, pcp.copy_code, c.code AS centre_code, u.name AS requested_by_name
           FROM reprint_requests r JOIN printed_copies pcp ON pcp.id = r.copy_id JOIN variants v ON v.id = pcp.variant_id
           JOIN centres c ON c.id = v.centre_id JOIN users u ON u.id = r.requested_by
          WHERE v.paper_id = $1 ORDER BY (r.status = 'pending') DESC, r.created_at DESC`,
        [id],
      );
      out.reprints = reprints;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/seal', requireAuth('admin'), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const documentId = await sealPaper(id, { actorId: req.user.id, ip: clientIp(req) });
    res.json({ sealed: true, documentId });
  } catch (err) {
    next(err);
  }
});

// ---------- the question pool (setters) ----------

const questionSchema = z.object({
  topic: z.string().trim().min(2).max(80),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  text: z.string().trim().min(10, 'Question text needs at least 10 characters').max(2000),
  options: z.array(z.string().trim().min(1).max(300)).min(2).max(6),
  answer: z.coerce.number().int().min(0),
}).refine((q) => q.answer < q.options.length, { message: 'The correct answer must be one of the options', path: ['answer'] })
  .refine((q) => new Set(q.options.map(normalise)).size === q.options.length, { message: 'Options must all be different', path: ['options'] });

async function setterPaper(paperId, user) {
  const { paper, roles } = await paperAccess(paperId, user);
  if (!roles.setter) throw new HttpError(403, 'You are not a setter for this paper');
  return paper;
}

function poolError(err) {
  if (err.code === '23505') return new HttpError(409, 'This question is already in the pool');
  if (err.code === '23503') return new HttpError(400, 'That topic and difficulty are not in this paper\'s blueprint');
  return err;
}

router.get('/:id/questions/mine', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const paper = await setterPaper(id, req.user);
    const { rows } = await query(
      `SELECT id, topic, difficulty, body_enc, status, created_at, updated_at FROM questions
        WHERE paper_id = $1 AND setter_id = $2 ORDER BY created_at`,
      [id, req.user.id],
    );
    if (paper.status !== 'draft') {
      return res.json({
        locked: true,
        questions: rows.map(({ body_enc, ...r }) => r),   // eslint-disable-line no-unused-vars
      });
    }
    const key = draftKey(paper);
    const questions = rows.map(({ body_enc, ...r }) => ({ ...r, ...decryptQuestion(key, body_enc) }));
    key.fill(0);
    res.json({ locked: false, questions });
  } catch (err) {
    next(err);
  }
});

async function insertQuestion(db, paper, setterId, q) {
  const key = draftKey(paper);
  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO questions (paper_id, setter_id, topic, difficulty, body_enc, body_hmac, option_count)
       VALUES ($1, $2, (SELECT topic FROM blueprint_items WHERE paper_id = $1 AND lower(topic) = lower($3) AND difficulty = $4 LIMIT 1),
               $4, $5, $6, $7)
       RETURNING id`,
      [paper.id, setterId, q.topic, q.difficulty,
        encryptQuestion(key, { text: q.text, options: q.options, answer: q.answer }), questionHmac(q.text), q.options.length],
    );
    return row.id;
  } finally {
    key.fill(0);
  }
}

router.post('/:id/questions', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const paper = await setterPaper(id, req.user);
    const q = parse(questionSchema, req.body);
    const qid = await withTx(async (db) => {
      const newId = await insertQuestion(db, paper, req.user.id, q).catch((e) => {
        throw e.code === '23502' ? new HttpError(400, 'That topic and difficulty are not in this paper\'s blueprint') : e;
      });
      await audit(db, { actorId: req.user.id, action: 'question.added', entity: 'paper', entityId: id, ip: clientIp(req),
        payload: { questionId: newId, topic: q.topic, difficulty: q.difficulty } });
      return newId;
    });
    res.status(201).json({ id: qid });
  } catch (err) {
    next(poolError(err));
  }
});

router.post('/:id/questions/import', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const paper = await setterPaper(id, req.user);
    const { questions } = parse(z.object({ questions: z.array(z.unknown()).min(1).max(300) }), req.body);
    const added = [];
    const skipped = [];
    for (let i = 0; i < questions.length; i++) {
      const r = questionSchema.safeParse(questions[i]);
      if (!r.success) {
        skipped.push({ index: i + 1, reason: r.error.issues.map((x) => `${x.path.join('.') || 'question'}: ${x.message}`).join('; ') });
        continue;
      }
      try {
        // each question in its own transaction, so one bad row does not undo the rest
        added.push(await withTx((db) => insertQuestion(db, paper, req.user.id, r.data)));
      } catch (e) {
        const reason = e.code === '23505' ? 'duplicate of a question already in the pool'
          : e.code === '23502' || e.code === '23503' ? `"${r.data.topic}" (${r.data.difficulty}) is not in the blueprint`
          : e.status ? e.message : 'could not be saved';
        if (!e.code && !e.status) throw e;
        skipped.push({ index: i + 1, reason });
      }
    }
    await audit(null, { actorId: req.user.id, action: 'question.imported', entity: 'paper', entityId: id, ip: clientIp(req),
      payload: { added: added.length, skipped: skipped.length } });
    res.json({ added: added.length, skipped });
  } catch (err) {
    next(err);
  }
});

async function ownQuestion(questionId, user) {
  const { rows: [q] } = await query('SELECT * FROM questions WHERE id = $1', [questionId]);
  if (!q || q.setter_id !== user.id) throw new HttpError(404, 'Question not found');
  const { rows: [paper] } = await query('SELECT * FROM papers WHERE id = $1', [q.paper_id]);
  return { q, paper };
}

router.patch('/questions/:qid', requireAuth(), async (req, res, next) => {
  try {
    const qid = parse(z.uuid(), req.params.qid);
    const { paper } = await ownQuestion(qid, req.user);
    const q = parse(questionSchema, req.body);
    const key = draftKey(paper);
    await withTx(async (db) => {
      await db.query(
        `UPDATE questions SET topic = (SELECT topic FROM blueprint_items WHERE paper_id = $2 AND lower(topic) = lower($3)
                                        AND difficulty = $4 LIMIT 1),
                difficulty = $4, body_enc = $5, body_hmac = $6, option_count = $7
          WHERE id = $1`,
        [qid, paper.id, q.topic, q.difficulty, encryptQuestion(key, { text: q.text, options: q.options, answer: q.answer }),
          questionHmac(q.text), q.options.length],
      );
      await audit(db, { actorId: req.user.id, action: 'question.edited', entity: 'paper', entityId: paper.id, ip: clientIp(req), payload: { questionId: qid } });
    }).catch((e) => {
      throw e.code === '23502' ? new HttpError(400, 'That topic and difficulty are not in this paper\'s blueprint') : e;
    });
    key.fill(0);
    res.json({ ok: true });
  } catch (err) {
    next(poolError(err));
  }
});

router.delete('/questions/:qid', requireAuth(), async (req, res, next) => {
  try {
    const qid = parse(z.uuid(), req.params.qid);
    const { paper } = await ownQuestion(qid, req.user);
    if (paper.status !== 'draft') throw new HttpError(409, 'This paper is sealed; its questions are frozen');
    await withTx(async (db) => {
      await db.query('DELETE FROM questions WHERE id = $1', [qid]);
      await audit(db, { actorId: req.user.id, action: 'question.deleted', entity: 'paper', entityId: paper.id, ip: clientIp(req), payload: { questionId: qid } });
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- the released paper (admin, investigator) ----------

router.get('/:id/content', requireAuth('admin', 'investigator'), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const { paper } = await paperAccess(id, req.user);
    if (paper.status !== 'released') throw new HttpError(423, 'This paper is still sealed');
    const finals = await openReleasedPaper(id);
    const { rows: setters } = await query('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [[...new Set(finals.map((f) => f.setterId))]]);
    const nameOf = Object.fromEntries(setters.map((s) => [s.id, s.name]));
    const { rows: variants } = await query(
      `SELECT v.id, v.question_order, v.option_orders, v.signature, c.code, c.name
         FROM variants v JOIN centres c ON c.id = v.centre_id WHERE v.paper_id = $1 ORDER BY c.code`,
      [id],
    );
    const { rows: draws } = await query(
      `SELECT payload FROM audit_log WHERE action = 'paper.assembled' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [id],
    );
    res.json({
      questions: finals.map((f) => ({ ...f, setterName: nameOf[f.setterId] })),
      shortfalls: draws[0]?.payload?.shortfalls ?? [],
      centres: variants.map((v) => {
        const qs = applyVariant(finals, v);
        return {
          code: v.code, name: v.name, signature: v.signature.slice(0, 12),
          // printed number at this centre -> base position, plus the answer letter for marking
          key: qs.map((q) => ({ number: q.number, basePosition: q.position, answer: LETTERS[q.answer] })),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- printing (superintendents) ----------

async function centreAccess(paperId, centreId, user, { print = false } = {}) {
  const { paper, roles } = await paperAccess(paperId, user);
  const mine = roles.myCentres.includes(centreId);
  if (print ? !mine : !(mine || roles.admin || roles.investigator)) throw new HttpError(403, 'This is not your centre');
  const { rows: [c] } = await query('SELECT * FROM centre_readiness WHERE paper_id = $1 AND centre_id = $2', [paperId, centreId]);
  if (!c) throw new HttpError(404, 'Centre not found for this paper');
  const { rows: [centre] } = await query('SELECT code, name, city FROM centres WHERE id = $1', [centreId]);
  return { paper, readiness: c, centre };
}

router.get('/:id/centres/:centreId/copies', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const centreId = parse(z.uuid(), req.params.centreId);
    const { paper, readiness } = await centreAccess(id, centreId, req.user);
    const { rows: copies } = await query(
      `SELECT pc.id, pc.copy_no, pc.copy_code, pc.printed_at, pc.voided_at, u.name AS printed_by_name,
              (SELECT r.copy_code FROM reprint_requests rr JOIN printed_copies r ON r.id = rr.copy_id WHERE rr.id = pc.reprint_request_id) AS replaces,
              (SELECT json_build_object('id', rr.id, 'status', rr.status, 'reason', rr.reason)
                 FROM reprint_requests rr WHERE rr.copy_id = pc.id ORDER BY rr.created_at DESC LIMIT 1) AS reprint
         FROM printed_copies pc JOIN users u ON u.id = pc.printed_by
        WHERE pc.variant_id = $1 ORDER BY pc.copy_no`,
      [readiness.variant_id],
    );
    const printUntil = new Date(new Date(paper.exam_start).getTime() + paper.duration_minutes * 60_000);
    res.json({ readiness, copies, printUntil });
  } catch (err) {
    next(err);
  }
});

function copyCode(centreCode, copyNo) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const tail = Array.from({ length: 4 }, () => A[crypto.randomInt(32)]).join('');
  return `${centreCode}-${String(copyNo).padStart(4, '0')}-${tail}`;
}

async function printCopies(req, res, { paperId, centreId, count, reprintRequestId = null }) {
  const { paper, readiness, centre } = await centreAccess(paperId, centreId, req.user, { print: true });
  if (paper.status !== 'released') throw new HttpError(423, 'The paper is still sealed. Printing opens when it is released.');
  const printUntil = new Date(paper.exam_start).getTime() + paper.duration_minutes * 60_000;
  if (Date.now() > printUntil) throw new HttpError(409, 'The exam is over; printing is closed');

  const finals = await openReleasedPaper(paperId);
  const { rows: [variant] } = await query('SELECT * FROM variants WHERE id = $1', [readiness.variant_id]);
  const { rows: items } = await query('SELECT position, topic, difficulty FROM blueprint_items WHERE paper_id = $1', [paperId]);
  const sectionTitle = Object.fromEntries(items.map((b) => [b.position, `${b.topic} (${b.difficulty})`]));
  const questions = applyVariant(finals, variant).map((q) => ({ ...q, sectionTitle: sectionTitle[q.section] }));

  const copies = await withTx(async (db) => {
    let replaced = null;
    if (reprintRequestId) {
      const { rows: [r] } = await db.query(
        `SELECT rr.*, pc.copy_code, pc.variant_id FROM reprint_requests rr JOIN printed_copies pc ON pc.id = rr.copy_id
          WHERE rr.id = $1 FOR UPDATE OF rr`,
        [reprintRequestId],
      );
      if (!r || r.variant_id !== variant.id) throw new HttpError(404, 'Reprint request not found');
      if (r.status !== 'approved') throw new HttpError(409, `This reprint is ${r.status}`);
      const used = await db.query('SELECT 1 FROM printed_copies WHERE reprint_request_id = $1', [reprintRequestId]);
      if (used.rows[0]) throw new HttpError(409, 'The replacement for this copy was already printed');
      await db.query('UPDATE printed_copies SET voided_at = now() WHERE id = $1 AND voided_at IS NULL', [r.copy_id]);
      replaced = r.copy_code;
    }
    const out = [];
    const { rows: [{ max }] } = await db.query('SELECT coalesce(max(copy_no), 0) AS max FROM printed_copies WHERE variant_id = $1', [variant.id]);
    for (let i = 1; i <= count; i++) {
      const no = max + i;
      const code = copyCode(centre.code, no);
      // the print_cap_guard trigger refuses anything over candidates + buffer + approved reprints
      await db.query(
        `INSERT INTO printed_copies (variant_id, copy_no, copy_code, printed_by, reprint_request_id) VALUES ($1, $2, $3, $4, $5)`,
        [variant.id, no, code, req.user.id, reprintRequestId],
      );
      out.push({ copyNo: no, copyCode: code, reprintOf: replaced });
    }
    await audit(db, { actorId: req.user.id, action: reprintRequestId ? 'copy.reprinted' : 'copy.printed', entity: 'paper',
      entityId: paperId, ip: clientIp(req), payload: { centre: centre.code, copies: out.map((c) => c.copyCode), replaces: replaced } });
    return out;
  });

  const pdf = await renderCopies({
    paper: { examName: paper.exam_name, subject: paper.subject, title: paper.title, instructions: paper.instructions,
      durationMinutes: paper.duration_minutes, examStart: paper.exam_start },
    centre, questions, copies,
  });
  const name = `${centre.code}-${paper.subject}-${copies[0].copyNo}${copies.length > 1 ? `-${copies.at(-1).copyNo}` : ''}.pdf`
    .replace(/[^A-Za-z0-9._-]+/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Copy-Codes', copies.map((c) => c.copyCode).join(','));
  res.send(pdf);
}

router.post('/:id/centres/:centreId/print', requireAuth('superintendent'), async (req, res, next) => {
  try {
    const paperId = parse(z.uuid(), req.params.id);
    const centreId = parse(z.uuid(), req.params.centreId);
    const { count } = parse(z.object({ count: z.coerce.number().int().min(1).max(500) }), req.body);
    await printCopies(req, res, { paperId, centreId, count });
  } catch (err) {
    next(err);
  }
});

// ---------- reprints ----------

router.post('/copies/:copyId/reprint-requests', requireAuth('superintendent'), async (req, res, next) => {
  try {
    const copyId = parse(z.uuid(), req.params.copyId);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    const { rows: [c] } = await query(
      `SELECT pc.*, v.paper_id, v.centre_id FROM printed_copies pc JOIN variants v ON v.id = pc.variant_id WHERE pc.id = $1`, [copyId],
    );
    if (!c) throw new HttpError(404, 'Copy not found');
    await centreAccess(c.paper_id, c.centre_id, req.user, { print: true });
    if (c.voided_at) throw new HttpError(409, 'This copy was already replaced');
    const { rows: [r] } = await withTx(async (db) => {
      const ins = await db.query(
        `INSERT INTO reprint_requests (copy_id, requested_by, reason) VALUES ($1, $2, $3) RETURNING id`, [copyId, req.user.id, reason],
      );
      await audit(db, { actorId: req.user.id, action: 'reprint.requested', entity: 'paper', entityId: c.paper_id, ip: clientIp(req),
        payload: { copy: c.copy_code, reason } });
      return ins;
    }).catch((e) => {
      throw e.code === '23P01' ? new HttpError(409, 'A reprint request for this copy is already waiting') : e;
    });
    res.status(201).json({ id: r.id });
  } catch (err) {
    next(err);
  }
});

router.patch('/reprint-requests/:rid', requireAuth('admin'), async (req, res, next) => {
  try {
    const rid = parse(z.uuid(), req.params.rid);
    const { decision } = parse(z.object({ decision: z.enum(['approved', 'rejected']) }), req.body);
    const out = await withTx(async (db) => {
      const { rows: [r] } = await db.query(
        `UPDATE reprint_requests SET status = $2, decided_by = $3, decided_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING *`,
        [rid, decision, req.user.id],
      );
      if (!r) throw new HttpError(409, 'This request was already decided');
      const { rows: [c] } = await db.query(
        'SELECT pc.copy_code, v.paper_id FROM printed_copies pc JOIN variants v ON v.id = pc.variant_id WHERE pc.id = $1', [r.copy_id],
      );
      await audit(db, { actorId: req.user.id, action: `reprint.${decision}`, entity: 'paper', entityId: c.paper_id, ip: clientIp(req),
        payload: { copy: c.copy_code } });
      return r;
    });
    res.json({ request: out });
  } catch (err) {
    next(err);
  }
});

router.post('/reprint-requests/:rid/print', requireAuth('superintendent'), async (req, res, next) => {
  try {
    const rid = parse(z.uuid(), req.params.rid);
    const { rows: [r] } = await query(
      `SELECT v.paper_id, v.centre_id FROM reprint_requests rr JOIN printed_copies pc ON pc.id = rr.copy_id
         JOIN variants v ON v.id = pc.variant_id WHERE rr.id = $1`,
      [rid],
    );
    if (!r) throw new HttpError(404, 'Reprint request not found');
    await printCopies(req, res, { paperId: r.paper_id, centreId: r.centre_id, count: 1, reprintRequestId: rid });
  } catch (err) {
    next(err);
  }
});

export default router;
