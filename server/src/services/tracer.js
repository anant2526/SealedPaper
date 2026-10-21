// Leak tracer.
//
// Before release: questions are still encrypted, so the leaked text is split into lines
//   (and windows of up to 4 lines), each normalised and HMAC'd, and matched against
//   questions.body_hmac. A match names the SETTER and lets the admin burn the question.
//
// After release: the final paper is decrypted. Each final question found in the leak
//   gives its position; the order of the found questions and of their options is
//   compared with every centre's variant. A printed copy code, if present, names the
//   exact COPY.
import { query } from '../db.js';
import { normalise, questionHmac } from './questions.js';
import { openReleasedPaper } from './papers.js';

const NUMBERING = /^\s*(?:q(?:uestion)?\s*)?[([]?\d{1,3}\s*[.):\]]\s*/i;
const OPTION_MARK = /^\s*[([]?[a-fA-F]\s*[.)\]]\s+/;
const MARKS_TAIL = /\s*[[(]\s*\d+\s*marks?\s*[\])]\s*$/i;
const COPY_CODE = /\b([A-Z0-9]{2,8})-(\d{4})-([A-Z2-7]{4})\b/g;

function cleanLine(line) {
  return line.replace(NUMBERING, '').replace(MARKS_TAIL, '').trim();
}

/** HMAC candidates from the leak: every line and every run of 2–4 consecutive lines. */
function hmacCandidates(text) {
  const lines = String(text).split(/\r?\n/).map(cleanLine).filter((l) => l && !OPTION_MARK.test(l));
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    let joined = '';
    for (let w = 0; w < 4 && i + w < lines.length; w++) {
      joined = w === 0 ? lines[i] : `${joined} ${lines[i + w]}`;
      const n = normalise(joined);
      if (n.length >= 12) out.set(questionHmac(n).toString('hex'), joined);
    }
  }
  return out;
}

async function matchByHmac(paperId, text) {
  const cands = hmacCandidates(text);
  if (cands.size === 0) return [];
  const { rows } = await query(
    `SELECT q.id, q.setter_id, q.topic, q.difficulty, q.status, encode(q.body_hmac, 'hex') AS h, u.name AS setter_name
       FROM questions q JOIN users u ON u.id = q.setter_id
      WHERE q.paper_id = $1 AND encode(q.body_hmac, 'hex') = ANY($2::text[])`,
    [paperId, [...cands.keys()]],
  );
  return rows.map((r) => ({
    questionId: r.id, setterId: r.setter_id, setterName: r.setter_name, topic: r.topic,
    difficulty: r.difficulty, status: r.status, excerpt: cands.get(r.h).slice(0, 160),
  }));
}

function kendall(leakedIds, variantOrder) {
  const pos = new Map(variantOrder.map((id, i) => [id, i]));
  let agree = 0;
  let total = 0;
  for (let i = 0; i < leakedIds.length; i++) {
    for (let j = i + 1; j < leakedIds.length; j++) {
      total += 1;
      if (pos.get(leakedIds[i]) < pos.get(leakedIds[j])) agree += 1;
    }
  }
  return { agree, total };
}

async function traceReleased(paperId, text) {
  const finals = await openReleasedPaper(paperId);
  const leak = normalise(text);

  // where does each final question appear in the leak?
  const found = [];
  for (const q of finals) {
    const needle = normalise(q.text);
    if (needle.length < 8) continue;
    const at = leak.indexOf(needle);
    if (at >= 0) found.push({ q, at, end: at + needle.length });
  }
  found.sort((a, b) => a.at - b.at);

  // which options appear after each question, and in what order?
  const optionEvidence = new Map();
  found.forEach((f, i) => {
    const region = leak.slice(f.end, i + 1 < found.length ? found[i + 1].at : f.end + 1500);
    const seen = [];
    f.q.options.forEach((opt, idx) => {
      const n = normalise(opt);
      if (n.length < 3) return;
      const at = region.indexOf(n);
      if (at >= 0) seen.push({ idx, at });
    });
    if (seen.length >= 2) optionEvidence.set(f.q.id, seen.sort((a, b) => a.at - b.at).map((s) => s.idx));
  });

  const leakedIds = found.map((f) => f.q.id);
  const { rows: variants } = await query(
    `SELECT v.id, v.question_order, v.option_orders, c.code, c.name, c.id AS centre_id
       FROM variants v JOIN centres c ON c.id = v.centre_id WHERE v.paper_id = $1`,
    [paperId],
  );
  const ranking = variants.map((v) => {
    const order = kendall(leakedIds, v.question_order);
    let optAgree = 0;
    let optTotal = 0;
    for (const [qid, seq] of optionEvidence) {
      const printed = v.option_orders[qid].filter((o) => seq.includes(o));
      optTotal += 1;
      if (printed.join() === seq.join()) optAgree += 1;
    }
    const evidence = order.total + optTotal;
    return {
      variantId: v.id, centreId: v.centre_id, centreCode: v.code, centreName: v.name,
      orderAgree: order.agree, orderPairs: order.total, optionAgree: optAgree, optionChecks: optTotal,
      score: evidence ? (order.agree + optAgree) / evidence : 0,
    };
  }).sort((a, b) => b.score - a.score);

  // an exact copy code beats everything else
  const codes = [...String(text).toUpperCase().matchAll(COPY_CODE)].map((m) => m[0]);
  let copy = null;
  if (codes.length) {
    const { rows } = await query(
      `SELECT pc.id, pc.copy_code, pc.copy_no, pc.printed_at, pc.voided_at, v.id AS variant_id, c.code AS centre_code,
              c.name AS centre_name, u.name AS printed_by_name
         FROM printed_copies pc JOIN variants v ON v.id = pc.variant_id JOIN centres c ON c.id = v.centre_id
         JOIN users u ON u.id = pc.printed_by
        WHERE v.paper_id = $1 AND pc.copy_code = ANY($2::text[])`,
      [paperId, codes],
    );
    copy = rows[0] || null;
  }

  const best = ranking[0];
  const second = ranking[1];
  const evidence = best ? best.orderPairs + best.optionChecks : 0;
  let matchedVariantId = null;
  let confidence = 0;
  if (copy) {
    matchedVariantId = copy.variant_id;
    confidence = 1;
  } else if (best && evidence > 0 && best.score > (second?.score ?? 0)) {
    matchedVariantId = best.variantId;
    // high when the best variant agrees fully and clearly beats the runner-up
    const margin = best.score - (second?.score ?? 0);
    confidence = Math.min(1, Number((best.score * Math.min(1, margin * 2 + evidence / 20)).toFixed(3)));
  }

  return {
    matchedQuestions: found.map((f) => ({
      questionId: f.q.id, setterId: f.q.setterId, topic: f.q.topic, difficulty: f.q.difficulty, position: f.q.position,
      excerpt: f.q.text.slice(0, 160),
    })),
    ranking,
    copy,
    matchedVariantId,
    confidence,
    evidence,
  };
}

/** Runs the right tracer for the paper's current state. */
export async function trace(paperId, text) {
  const { rows: [p] } = await query('SELECT status FROM papers WHERE id = $1', [paperId]);
  if (!p) return null;
  const hmacMatches = await matchByHmac(paperId, text);
  if (p.status !== 'released') {
    return { phase: 'pre_release', hmacMatches, matchedVariantId: null, copy: null, confidence: null };
  }
  const post = await traceReleased(paperId, text);
  return { phase: 'post_release', hmacMatches, ...post };
}
