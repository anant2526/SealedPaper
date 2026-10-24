// Leak reports: investigators (and admins) paste leaked text; the tracer names the
// setter before release and the centre / printed copy after release. Admins burn.
import { Router } from 'express';
import { query, withTx } from '../db.js';
import { parse, z } from '../validate.js';
import { HttpError, clientIp, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { trace, traceDocument } from '../services/tracer.js';

const router = Router();
const canTrace = requireAuth('admin', 'investigator');

// A leak of an uploaded confidential document: traced by the copy code stamped on every page.
async function reportDocumentLeak(req, res, body) {
  const result = await traceDocument(body.documentId, body.text);
  if (!result) throw new HttpError(404, 'Document not found');
  const summary = { codesFound: result.codesFound, copyCode: result.copy?.copy_code ?? null, readerName: result.copy?.reader_name ?? null };
  const id = await withTx(async (db) => {
    const { rows: [r] } = await db.query(
      `INSERT INTO leak_reports (document_id, reported_by, source, leaked_text, phase, matched_document_copy_id, confidence, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [body.documentId, req.user.id, body.source, body.text, result.phase, result.copy?.id ?? null, result.confidence, JSON.stringify(summary)],
    );
    await audit(db, { actorId: req.user.id, action: 'leak.reported', entity: 'document', entityId: body.documentId, ip: clientIp(req),
      payload: { reportId: r.id, copy: summary.copyCode, reader: summary.readerName } });
    return r.id;
  });
  res.status(201).json({ id });
}

router.post('/', canTrace, async (req, res, next) => {
  try {
    if (req.body?.documentId) {
      const body = parse(z.object({
        documentId: z.uuid(),
        text: z.string().min(10, 'Paste at least a line of the leaked text').max(200000),
        source: z.string().trim().max(300).default(''),
      }), req.body);
      return await reportDocumentLeak(req, res, body);
    }
    const body = parse(z.object({
      paperId: z.uuid(),
      text: z.string().min(10, 'Paste at least a full question').max(200000),
      source: z.string().trim().max(300).default(''),
    }), req.body);
    const result = await trace(body.paperId, body.text);
    if (!result) throw new HttpError(404, 'Paper not found');

    // setters: from HMAC matches (before release) plus decrypted matches (after release)
    const matches = new Map();
    for (const m of result.hmacMatches) matches.set(m.questionId, m.setterId);
    for (const m of result.matchedQuestions || []) matches.set(m.questionId, m.setterId);

    const summary = {
      hmacMatches: result.hmacMatches.map(({ setterId, ...m }) => m),   // eslint-disable-line no-unused-vars
      matchedQuestions: result.matchedQuestions?.map(({ setterId, ...m }) => m),   // eslint-disable-line no-unused-vars
      ranking: result.ranking,
      evidence: result.evidence,
      copyCode: result.copy?.copy_code ?? null,
    };
    const id = await withTx(async (db) => {
      const { rows: [r] } = await db.query(
        `INSERT INTO leak_reports (paper_id, reported_by, source, leaked_text, phase, matched_variant_id, matched_copy_id, confidence, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [body.paperId, req.user.id, body.source, body.text, result.phase, result.matchedVariantId, result.copy?.id ?? null,
          result.confidence, JSON.stringify(summary)],
      );
      for (const [questionId, setterId] of matches) {
        await db.query('INSERT INTO leak_matches (leak_report_id, question_id, setter_id) VALUES ($1, $2, $3)', [r.id, questionId, setterId]);
      }
      await audit(db, { actorId: req.user.id, action: 'leak.reported', entity: 'paper', entityId: body.paperId, ip: clientIp(req),
        payload: { reportId: r.id, phase: result.phase, matches: matches.size, copy: summary.copyCode, confidence: result.confidence } });
      return r.id;
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

router.get('/', canTrace, async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT lr.id, lr.phase, lr.source, lr.created_at, lr.confidence, p.id AS paper_id, lr.document_id,
              coalesce(p.subject || ': ' || p.title, doc.title) AS target_title, doc.category,
              c.code AS centre_code, coalesce(pcp.copy_code, dc.copy_code) AS copy_code, ru.name AS reader_name,
              u.name AS reported_by_name,
              (SELECT count(*) FROM leak_matches m WHERE m.leak_report_id = lr.id) AS matches
         FROM leak_reports lr JOIN users u ON u.id = lr.reported_by
         LEFT JOIN papers p ON p.id = lr.paper_id
         LEFT JOIN documents doc ON doc.id = lr.document_id
         LEFT JOIN document_copies dc ON dc.id = lr.matched_document_copy_id
         LEFT JOIN users ru ON ru.id = dc.reader_id
         LEFT JOIN variants v ON v.id = lr.matched_variant_id LEFT JOIN centres c ON c.id = v.centre_id
         LEFT JOIN printed_copies pcp ON pcp.id = lr.matched_copy_id
        ORDER BY lr.created_at DESC LIMIT 200`,
    );
    res.json({ reports: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/analytics', canTrace, async (_req, res, next) => {
  try {
    const { rows: setters } = await query('SELECT * FROM setter_leak_report ORDER BY leaked_questions DESC');
    const { rows: centres } = await query('SELECT * FROM centre_reprint_rates ORDER BY reprint_rate DESC NULLS LAST');
    const { rows: readers } = await query('SELECT * FROM reader_copy_report WHERE leaked_copies > 0 ORDER BY leaked_copies DESC');
    res.json({ setters, centres, readers });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', canTrace, async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const { rows: [r] } = await query(
      `SELECT lr.*, coalesce(p.title, doc.title) AS title, p.subject, p.status AS paper_status, doc.category, doc.status AS document_status,
              dc.copy_code AS doc_copy_code, dc.copy_no AS doc_copy_no, dc.issued_at AS doc_issued_at, dc.ip AS doc_copy_ip,
              ru.name AS reader_name, ru.email AS reader_email, u.name AS reported_by_name,
              c.code AS centre_code, c.name AS centre_name, c.city AS centre_city,
              pcp.copy_code, pcp.copy_no, pcp.printed_at, pcp.voided_at, pu.name AS printed_by_name
         FROM leak_reports lr JOIN users u ON u.id = lr.reported_by
         LEFT JOIN papers p ON p.id = lr.paper_id
         LEFT JOIN documents doc ON doc.id = lr.document_id
         LEFT JOIN document_copies dc ON dc.id = lr.matched_document_copy_id LEFT JOIN users ru ON ru.id = dc.reader_id
         LEFT JOIN variants v ON v.id = lr.matched_variant_id LEFT JOIN centres c ON c.id = v.centre_id
         LEFT JOIN printed_copies pcp ON pcp.id = lr.matched_copy_id LEFT JOIN users pu ON pu.id = pcp.printed_by
        WHERE lr.id = $1`,
      [id],
    );
    if (!r) throw new HttpError(404, 'Report not found');
    const { rows: matches } = await query(
      `SELECT m.question_id, q.topic, q.difficulty, q.status, q.burned_at, q.burned_by_leak = m.leak_report_id AS burned_by_this,
              u.name AS setter_name, u.email AS setter_email,
              EXISTS (SELECT 1 FROM final_questions f WHERE f.question_id = q.id) AS in_final_paper
         FROM leak_matches m JOIN questions q ON q.id = m.question_id JOIN users u ON u.id = m.setter_id
        WHERE m.leak_report_id = $1 ORDER BY u.name, q.topic`,
      [id],
    );
    res.json({ report: r, matches });
  } catch (err) {
    next(err);
  }
});

// Burn: matched questions leave the pool, so the release-time draw can never pick them.
router.post('/:id/burn', requireAuth('admin'), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const burned = await withTx(async (db) => {
      const { rows: [r] } = await db.query(
        'SELECT lr.paper_id, p.status FROM leak_reports lr JOIN papers p ON p.id = lr.paper_id WHERE lr.id = $1 FOR UPDATE OF p', [id],
      );
      if (!r) throw new HttpError(404, 'Only exam paper leaks have questions to withdraw');
      if (r.status === 'released') throw new HttpError(409, 'The paper is already released; burning is only possible before release');
      const { rows } = await db.query(
        `UPDATE questions SET status = 'burned', burned_at = now(), burned_by_leak = $1
          WHERE status = 'active' AND id IN (SELECT question_id FROM leak_matches WHERE leak_report_id = $1)
          RETURNING id, topic, difficulty`,
        [id],
      );
      await audit(db, { actorId: req.user.id, action: 'question.burned', entity: 'paper', entityId: r.paper_id, ip: clientIp(req),
        payload: { reportId: id, questions: rows.map((q) => q.id) } });
      return rows;
    });
    const { rows: [rp] } = await query('SELECT paper_id FROM leak_reports WHERE id = $1', [id]);
    const { rows: coverage } = await query('SELECT topic, difficulty, active_count, count_needed FROM pool_coverage WHERE paper_id = $1 AND NOT covered', [rp.paper_id]);
    res.json({ burned: burned.length, uncoveredCells: coverage });
  } catch (err) {
    next(err);
  }
});

export default router;
