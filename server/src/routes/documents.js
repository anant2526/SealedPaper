import crypto from 'node:crypto';
// Documents: upload + split, one-time key-file pickup, key submission, download after release.
import { Router } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { query, withTx } from '../db.js';
import { config } from '../config.js';
import { parse, z, scanSchema, codeSchema } from '../validate.js';
import { HttpError, clientIp, requireAuth } from '../middleware/auth.js';
import { newDocumentKey, encrypt, decrypt, wrap, unwrap, sha256, safeEqual } from '../services/crypto.js';
import { splitKey, buildKeyFile, parseKeyFile } from '../services/shamir.js';
import { verifyAndConsumeCode } from '../services/totp.js';
import { createChallenge, runFaceCheck } from '../services/faceCheck.js';
import { tryRelease } from '../services/release.js';
import { stampPdf, isPdf } from '../services/stamp.js';
import { audit } from '../services/audit.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });
const unlockLimiter = rateLimit({
  windowMs: 10 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many key attempts — wait 10 minutes' },
});

// What this user may do with a document.
async function access(documentId, user) {
  const { rows: [doc] } = await query('SELECT * FROM documents WHERE id = $1', [documentId]);
  if (!doc) throw new HttpError(404, 'Document not found');
  const { rows: [share] } = await query(
    'SELECT id, share_index, picked_up_at FROM key_shares WHERE document_id = $1 AND custodian_id = $2',
    [documentId, user.id],
  );
  const { rows: [rec] } = await query(
    'SELECT 1 FROM document_recipients WHERE document_id = $1 AND user_id = $2', [documentId, user.id],
  );
  const isAdmin = user.role === 'admin';
  const isInvestigator = user.role === 'investigator';   // may look and trace, never download
  if (!isAdmin && !isInvestigator && !share && !rec) throw new HttpError(404, 'Document not found');
  return { doc, share, isAdmin, isInvestigator, isCustodian: !!share, isRecipient: !!rec };
}

async function statusOf(documentId) {
  const { rows: [s] } = await query('SELECT * FROM unlock_status WHERE document_id = $1', [documentId]);
  return s;
}

// ---------- upload (admin) ----------

const createSchema = z.object({
  title: z.string().trim().min(3).max(200),
  unlockAt: z.coerce.date(),
  thresholdK: z.coerce.number().int().min(2).max(20),
  submitWindowMinutes: z.coerce.number().int().min(0).max(10080).default(60),
  custodianIds: z.string().transform((s) => JSON.parse(s)).pipe(z.array(z.uuid()).min(2).max(20)),
  recipientIds: z.string().default('[]').transform((s) => JSON.parse(s)).pipe(z.array(z.uuid()).max(200)),
  category: z.enum(['research', 'financial', 'board', 'legal', 'government', 'exam', 'other']).default('other'),
  description: z.string().max(1000).default(''),
  copiesPerReader: z.coerce.number().int().min(1).max(20).default(2),
});

router.post('/', requireAuth('admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Attach a file');
    const body = parse(createSchema, req.body);
    const custodianIds = [...new Set(body.custodianIds)];
    const n = custodianIds.length;
    if (body.thresholdK > n) throw new HttpError(400, `k (${body.thresholdK}) cannot be more than the number of custodians (${n})`);
    if (body.unlockAt.getTime() <= Date.now()) throw new HttpError(400, 'Unlock time must be in the future');

    // Custodians must be active accounts (so they have a face template and an authenticator).
    const { rows: people } = await query(
      `SELECT id, email FROM users WHERE id = ANY($1::uuid[]) AND status = 'active'`, [custodianIds],
    );
    if (people.length !== n) throw new HttpError(400, 'Every custodian must be an active user');
    const emailOf = Object.fromEntries(people.map((p) => [p.id, p.email]));

    // 1. fresh key for THIS document only   2. encrypt   3. split into n shares   4. forget the key
    const key = newDocumentKey();
    const sealed = encrypt(key, req.file.buffer);
    const shares = await splitKey(key, n, body.thresholdK);
    key.fill(0);

    const doc = await withTx(async (db) => {
      const { rows: [d] } = await db.query(
        `INSERT INTO documents (title, original_name, mime_type, size_bytes, threshold_k, total_shares_n,
                                unlock_at, submit_window_minutes, created_by, category, description, copies_per_reader)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [body.title, req.file.originalname.slice(0, 255), req.file.mimetype || 'application/octet-stream',
          req.file.size, body.thresholdK, n, body.unlockAt, body.submitWindowMinutes, req.user.id,
          body.category, body.description.trim(), body.copiesPerReader],
      );
      await db.query(
        `INSERT INTO document_blobs (document_id, iv, auth_tag, ciphertext, ciphertext_sha256)
         VALUES ($1, $2, $3, $4, $5)`,
        [d.id, sealed.iv, sealed.authTag, sealed.ciphertext, sha256(sealed.ciphertext)],
      );
      for (let i = 0; i < n; i++) {
        await db.query(
          `INSERT INTO key_shares (document_id, custodian_id, share_index, share_hash, pickup_enc)
           VALUES ($1, $2, $3, $4, $5)`,
          [d.id, custodianIds[i], i + 1, sha256(shares[i]), wrap(shares[i])],
        );
      }
      for (const uid of new Set(body.recipientIds)) {
        await db.query('INSERT INTO document_recipients (document_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [d.id, uid]);
      }
      await audit(db, {
        actorId: req.user.id, action: 'document.sealed', entity: 'document', entityId: d.id, ip: clientIp(req),
        payload: { title: d.title, category: body.category, k: body.thresholdK, n, unlockAt: d.unlock_at,
          custodians: custodianIds.map((id) => emailOf[id]) },
      });
      return d;
    });
    shares.forEach((s) => s.fill(0));
    res.status(201).json({ document: await statusOf(doc.id) });
  } catch (err) {
    if (err instanceof SyntaxError) return next(new HttpError(400, 'custodianIds / recipientIds must be JSON arrays'));
    next(err);
  }
});

// ---------- list + detail ----------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.*, dd.category, dd.description, ks.share_index AS my_share_index, ks.picked_up_at AS my_key_picked_up_at,
              (ps.custodian_id IS NOT NULL) AS my_key_submitted,
              (ks.id IS NOT NULL) AS i_am_custodian, (dr.user_id IS NOT NULL) AS i_am_recipient
         FROM unlock_status s
         JOIN documents dd ON dd.id = s.document_id
         LEFT JOIN key_shares ks ON ks.document_id = s.document_id AND ks.custodian_id = $1
         LEFT JOIN pending_shares ps ON ps.document_id = s.document_id AND ps.custodian_id = $1
         LEFT JOIN document_recipients dr ON dr.document_id = s.document_id AND dr.user_id = $1
        WHERE $2 OR ks.id IS NOT NULL OR dr.user_id IS NOT NULL
        ORDER BY s.unlock_at DESC`,
      [req.user.id, ['admin', 'investigator'].includes(req.user.role)],
    );
    res.json({ documents: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const a = await access(id, req.user);
    const { rows: custodians } = await query(
      `SELECT u.name, u.email, k.share_index, k.picked_up_at,
              EXISTS (SELECT 1 FROM pending_shares p WHERE p.document_id = k.document_id AND p.custodian_id = k.custodian_id) AS submitted,
              (u.id = ANY (coalesce(r.custodian_ids, '{}'))) AS used_in_release
         FROM key_shares k JOIN users u ON u.id = k.custodian_id
         LEFT JOIN releases r ON r.document_id = k.document_id
        WHERE k.document_id = $1 ORDER BY k.share_index`,
      [id],
    );
    const { rows: recipients } = await query(
      'SELECT u.name, u.email FROM document_recipients d JOIN users u ON u.id = d.user_id WHERE d.document_id = $1', [id],
    );
    const { rows: [mine] } = await query(
      'SELECT 1 FROM pending_shares WHERE document_id = $1 AND custodian_id = $2', [id, req.user.id],
    );
    const { rows: [lock] } = await query('SELECT custodian_locked_out($1, $2, $3) AS locked', [id, req.user.id, config.lockout.maxFailures]);
    res.json({
      document: { ...(await statusOf(id)), paper_id: a.doc.paper_id, category: a.doc.category, description: a.doc.description,
        copies_per_reader: a.doc.copies_per_reader, original_name: a.doc.original_name, mime_type: a.doc.mime_type, size_bytes: a.doc.size_bytes, created_at: a.doc.created_at },
      custodians,
      recipients,
      me: {
        isAdmin: a.isAdmin, isCustodian: a.isCustodian, isRecipient: a.isRecipient, shareIndex: a.share?.share_index ?? null,
        keyPickedUp: !!a.share?.picked_up_at, keySubmitted: !!mine, lockedOut: lock.locked,
        isInvestigator: a.isInvestigator,
        canDownload: a.doc.status === 'released' && !a.doc.paper_id && (a.isAdmin || a.isCustodian || a.isRecipient),
      },
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- one-time key-file pickup (custodian, needs the rotating code) ----------

router.post('/:id/key-file', requireAuth(), unlockLimiter, async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const { code } = parse(z.object({ code: codeSchema }), req.body);
    const a = await access(id, req.user);
    if (!a.isCustodian) throw new HttpError(403, 'You are not a key custodian for this document');
    if (a.doc.status !== 'sealed') throw new HttpError(409, `Document is already ${a.doc.status}`);

    const totp = await verifyAndConsumeCode({ query }, req.user.id, code);
    if (!totp.ok) throw new HttpError(401, totp.reason);

    const keyFile = await withTx(async (db) => {
      const { rows: [ks] } = await db.query(
        `SELECT id, share_index, pickup_enc FROM key_shares
          WHERE document_id = $1 AND custodian_id = $2 FOR UPDATE`,
        [id, req.user.id],
      );
      if (!ks.pickup_enc) throw new HttpError(410, 'Your key file was already downloaded. It cannot be shown again.');
      const share = unwrap(ks.pickup_enc);
      await db.query('UPDATE key_shares SET pickup_enc = NULL, picked_up_at = now() WHERE id = $1', [ks.id]);
      await audit(db, { actorId: req.user.id, action: 'key.picked_up', entity: 'document', entityId: id, payload: { shareIndex: ks.share_index }, ip: clientIp(req) });
      return buildKeyFile({
        documentId: id, documentTitle: a.doc.title, custodianEmail: req.user.email, shareIndex: ks.share_index,
        share, threshold: a.doc.threshold_k, total: a.doc.total_shares_n,
      });
    });
    res.json({ keyFile, fileName: `sealedpaper-key-${id.slice(0, 8)}-${keyFile.shareIndex}.json` });
  } catch (err) {
    next(err);
  }
});

// ---------- key submission: key file + rotating code + live face scan ----------

router.post('/:id/face-challenge', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const a = await access(id, req.user);
    if (!a.isCustodian) throw new HttpError(403, 'You are not a key custodian for this document');
    res.json(await createChallenge(req.user.id, 'unlock'));
  } catch (err) {
    next(err);
  }
});

const unlockSchema = scanSchema.extend({
  code: codeSchema,
  keyFile: z.record(z.string(), z.unknown()),
});

router.post('/:id/unlock', requireAuth(), unlockLimiter, async (req, res, next) => {
  const ip = clientIp(req);
  try {
    const id = parse(z.uuid(), req.params.id);
    const body = parse(unlockSchema, req.body);
    const a = await access(id, req.user);
    if (!a.isCustodian) throw new HttpError(403, 'You are not a key custodian for this document');

    // Cheap checks first.
    const { rows: [w] } = await query(
      `SELECT status, now() >= unlock_at - make_interval(mins => submit_window_minutes) AS window_open,
              unlock_at - make_interval(mins => submit_window_minutes) AS opens_at,
              custodian_locked_out(id, $2, $3) AS locked,
              EXISTS (SELECT 1 FROM pending_shares WHERE document_id = $1 AND custodian_id = $2) AS already
         FROM documents WHERE id = $1`,
      [id, req.user.id, config.lockout.maxFailures],
    );
    if (w.status !== 'sealed') throw new HttpError(409, `Document is already ${w.status}`);
    if (!w.window_open) throw new HttpError(409, `Key submission opens at ${new Date(w.opens_at).toISOString()}`);
    if (w.locked) throw new HttpError(429, 'Too many failed attempts on this document. Wait 10 minutes.');
    if (w.already) throw new HttpError(409, 'You have already submitted your key for this document');

    const reject = async (reason, status = 401) => {
      await query(
        'INSERT INTO share_submissions (document_id, custodian_id, accepted, reason, ip) VALUES ($1, $2, false, $3, $4)',
        [id, req.user.id, reason, ip],
      );
      await audit(null, { actorId: req.user.id, action: 'key.rejected', entity: 'document', entityId: id, payload: { reason }, ip });
      throw new HttpError(status, reason);
    };

    // 1. Is the key file genuine and this custodian's own?
    let share;
    try {
      share = parseKeyFile(body.keyFile, id);
    } catch (e) {
      await reject(e.message);
    }
    const { rows: [ks] } = await query(
      'SELECT share_hash FROM key_shares WHERE document_id = $1 AND custodian_id = $2', [id, req.user.id],
    );
    if (!safeEqual(sha256(share), ks.share_hash)) await reject('This key file is not yours, or it was altered');

    // 2. Rotating code (consumed atomically, so it cannot be replayed).
    const totp = await verifyAndConsumeCode({ query }, req.user.id, body.code);
    if (!totp.ok) await reject(totp.reason);

    // 3. Live face scan against the enrolled template.
    const face = await runFaceCheck({ userId: req.user.id, purpose: 'unlock', challengeId: body.challengeId, frames: body.frames, ip });
    if (!face.passed) await reject(`Face check failed: ${face.reason}`);

    // All three passed: record the key (row lock serialises racing custodians).
    await withTx(async (db) => {
      const { rows: [d] } = await db.query('SELECT status FROM documents WHERE id = $1 FOR UPDATE', [id]);
      if (d.status !== 'sealed') throw new HttpError(409, `Document is already ${d.status}`);
      const ins = await db.query(
        `INSERT INTO pending_shares (document_id, custodian_id, share_enc) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [id, req.user.id, wrap(share)],
      );
      if (ins.rowCount === 0) throw new HttpError(409, 'You have already submitted your key for this document');
      await db.query(
        'INSERT INTO share_submissions (document_id, custodian_id, accepted, reason, ip) VALUES ($1, $2, true, $3, $4)',
        [id, req.user.id, 'key file + code + face verified', ip],
      );
      await audit(db, { actorId: req.user.id, action: 'key.submitted', entity: 'document', entityId: id, payload: { matchDistance: face.matchDistance }, ip });
    });
    share.fill(0);

    const release = await tryRelease(id, { triggeredBy: 'submission', actorId: req.user.id });
    res.json({ accepted: true, released: release.released, status: await statusOf(id) });
  } catch (err) {
    next(err);
  }
});

// ---------- traced copies after release ----------
// Every download is a numbered copy issued to one reader. PDFs are stamped with the reader's
// name and the copy code on every page; the database caps copies per reader.

const CODE_PREFIX = { research: 'RES', financial: 'FIN', board: 'BRD', legal: 'LEG', government: 'GOV', exam: 'EXM', other: 'DOC' };

function newCopyCode(category, copyNo) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const tail = Array.from({ length: 4 }, () => A[crypto.randomInt(32)]).join('');
  return `${CODE_PREFIX[category] || 'DOC'}-${String(copyNo).padStart(4, '0')}-${tail}`;
}

router.get('/:id/download', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const a = await access(id, req.user);
    if (a.doc.status !== 'released') throw new HttpError(423, 'This document is still sealed');
    if (a.doc.paper_id) throw new HttpError(409, 'This is an exam paper. Open it from the paper page; centres print their own copies.');
    if (!a.isAdmin && !a.isCustodian && !a.isRecipient) throw new HttpError(403, 'You are not a reader of this document');

    const out = await withTx(async (db) => {
      const { rows: [r] } = await db.query('SELECT wrapped_key FROM releases WHERE document_id = $1', [id]);
      const { rows: [b] } = await db.query('SELECT iv, auth_tag, ciphertext FROM document_blobs WHERE document_id = $1', [id]);
      const key = unwrap(r.wrapped_key);
      const plaintext = decrypt(key, { iv: b.iv, authTag: b.auth_tag, ciphertext: b.ciphertext });
      key.fill(0);

      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
      const { rows: [{ next_no }] } = await db.query(
        'SELECT coalesce(max(copy_no), 0) + 1 AS next_no FROM document_copies WHERE document_id = $1', [id],
      );
      const code = newCopyCode(a.doc.category, next_no);
      // PDFs are stamped; anything else (or a PDF that cannot be parsed) is still issued and logged as a numbered copy
      let body = plaintext;
      let stamped = false;
      if (isPdf(plaintext, a.doc.mime_type)) {
        try {
          body = await stampPdf(plaintext, { readerName: req.user.name, readerEmail: req.user.email, copyCode: code, title: a.doc.title });
          stamped = true;
        } catch {
          stamped = false;
        }
      }
      // document_copy_guard trigger: released only, and at most copies_per_reader for this reader
      await db.query(
        `INSERT INTO document_copies (document_id, reader_id, copy_no, copy_code, stamped, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, req.user.id, next_no, code, stamped, clientIp(req)],
      );
      await db.query('INSERT INTO downloads (document_id, user_id, ip) VALUES ($1, $2, $3)', [id, req.user.id, clientIp(req)]);
      await audit(db, { actorId: req.user.id, action: 'document.copy_issued', entity: 'document', entityId: id, ip: clientIp(req),
        payload: { copy: code, stamped } });
      return { body, code, stamped };
    });

    const dot = a.doc.original_name.lastIndexOf('.');
    const name = dot > 0
      ? `${a.doc.original_name.slice(0, dot)}-${out.code}${a.doc.original_name.slice(dot)}`
      : `${a.doc.original_name}-${out.code}`;
    res.setHeader('Content-Type', a.doc.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Copy-Code', out.code);
    res.send(out.body);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/copies', requireAuth(), async (req, res, next) => {
  try {
    const id = parse(z.uuid(), req.params.id);
    const a = await access(id, req.user);
    const all = a.isAdmin || a.isInvestigator;
    const { rows } = await query(
      `SELECT c.id, c.copy_no, c.copy_code, c.stamped, c.issued_at, c.ip, u.name AS reader_name, u.email AS reader_email,
              EXISTS (SELECT 1 FROM leak_reports lr WHERE lr.matched_document_copy_id = c.id) AS leaked
         FROM document_copies c JOIN users u ON u.id = c.reader_id
        WHERE c.document_id = $1 AND ($2 OR c.reader_id = $3) ORDER BY c.copy_no`,
      [id, all, req.user.id],
    );
    res.json({ copies: rows, copiesPerReader: a.doc.copies_per_reader });
  } catch (err) {
    next(err);
  }
});

export default router;
