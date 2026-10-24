-- =====================================================================
-- viva_checks.sql — prove the database enforces the rules on its own.
-- Run:  psql "$DATABASE_URL" -f server/sql/viva_checks.sql
-- Everything runs inside a transaction that is ROLLED BACK at the end,
-- so it never leaves test data behind. Each "expect_fail" block prints
-- PASS when the database correctly refused the action.
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE results (n serial, check_name text, outcome text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.expect_fail(p_name text, p_sql text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE p_sql;
        INSERT INTO results (check_name, outcome) VALUES (p_name, 'FAIL — the database allowed it');
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO results (check_name, outcome) VALUES (p_name, 'PASS — refused: ' || SQLERRM);
    END;
END $$;

-- ---------- test data ----------
INSERT INTO users (id, name, email, password_hash, role) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Admin',  'admin@test.dev', 'x', 'admin'),
  ('00000000-0000-0000-0000-0000000000c1', 'Cust 1', 'c1@test.dev',    'x', 'custodian'),
  ('00000000-0000-0000-0000-0000000000c2', 'Cust 2', 'c2@test.dev',    'x', 'custodian'),
  ('00000000-0000-0000-0000-0000000000c3', 'Cust 3', 'c3@test.dev',    'x', 'custodian');

-- created_at is set in the past so unlock_at can be "already passed" for the release test
INSERT INTO documents (id, title, original_name, mime_type, size_bytes, threshold_k, total_shares_n,
                       unlock_at, created_by, created_at) VALUES
  ('00000000-0000-0000-0000-00000000d001', 'Locked paper', 'p.pdf', 'application/pdf', 10, 2, 3,
   now() + interval '1 day', '00000000-0000-0000-0000-0000000000a1', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000d002', 'Due paper',    'p.pdf', 'application/pdf', 10, 2, 3,
   now() - interval '1 minute', '00000000-0000-0000-0000-0000000000a1', now() - interval '1 hour');

INSERT INTO key_shares (document_id, custodian_id, share_index, share_hash, pickup_enc)
SELECT d, c, i, digest(d::text || c::text, 'sha256'), '\x00'
FROM (VALUES ('00000000-0000-0000-0000-00000000d001'::uuid), ('00000000-0000-0000-0000-00000000d002'::uuid)) AS docs(d),
     (VALUES ('00000000-0000-0000-0000-0000000000c1'::uuid, 1), ('00000000-0000-0000-0000-0000000000c2'::uuid, 2),
             ('00000000-0000-0000-0000-0000000000c3'::uuid, 3)) AS cs(c, i);

INSERT INTO audit_log (actor_id, action, entity, entity_id) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'test.one', 'test', '1'),
  ('00000000-0000-0000-0000-0000000000a1', 'test.two', 'test', '2');

-- ---------- the checks ----------
\o /dev/null
SELECT pg_temp.expect_fail('threshold k must be >= 2',
  $q$INSERT INTO documents (title, original_name, mime_type, size_bytes, threshold_k, total_shares_n, unlock_at, created_by)
     VALUES ('Bad', 'b.pdf', 'application/pdf', 1, 1, 3, now() + interval '1 day', '00000000-0000-0000-0000-0000000000a1')$q$);

SELECT pg_temp.expect_fail('threshold k cannot exceed n',
  $q$INSERT INTO documents (title, original_name, mime_type, size_bytes, threshold_k, total_shares_n, unlock_at, created_by)
     VALUES ('Bad', 'b.pdf', 'application/pdf', 1, 4, 3, now() + interval '1 day', '00000000-0000-0000-0000-0000000000a1')$q$);

SELECT pg_temp.expect_fail('time lock: release before unlock_at',
  $q$UPDATE documents SET status = 'released' WHERE id = '00000000-0000-0000-0000-00000000d001'$q$);

SELECT pg_temp.expect_fail('quorum: release with 0 of 2 key shares',
  $q$UPDATE documents SET status = 'released' WHERE id = '00000000-0000-0000-0000-00000000d002'$q$);

INSERT INTO pending_shares (document_id, custodian_id, share_enc)
VALUES ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000c1', '\x01');

SELECT pg_temp.expect_fail('quorum: release with 1 of 2 key shares',
  $q$UPDATE documents SET status = 'released' WHERE id = '00000000-0000-0000-0000-00000000d002'$q$);

SELECT pg_temp.expect_fail('settings frozen: move unlock time earlier',
  $q$UPDATE documents SET unlock_at = now() WHERE id = '00000000-0000-0000-0000-00000000d001'$q$);

SELECT pg_temp.expect_fail('key share hash is immutable',
  $q$UPDATE key_shares SET share_hash = digest('forged', 'sha256')
     WHERE document_id = '00000000-0000-0000-0000-00000000d001' AND share_index = 1$q$);

SELECT pg_temp.expect_fail('stranger cannot submit a key (composite FK)',
  $q$INSERT INTO pending_shares (document_id, custodian_id, share_enc)
     VALUES ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000a1', '\x01')$q$);

SELECT pg_temp.expect_fail('cannot download a sealed document',
  $q$INSERT INTO downloads (document_id, user_id)
     VALUES ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000a1')$q$);

SELECT pg_temp.expect_fail('user cannot be activated without face + authenticator',
  $q$UPDATE users SET status = 'active' WHERE email = 'c1@test.dev'$q$);

SELECT pg_temp.expect_fail('audit log: UPDATE blocked',
  $q$UPDATE audit_log SET action = 'hidden' WHERE action = 'test.one'$q$);

SELECT pg_temp.expect_fail('audit log: DELETE blocked',
  $q$DELETE FROM audit_log WHERE action = 'test.one'$q$);

-- ---------- the happy path: 2 of 3 shares after unlock_at ----------
INSERT INTO pending_shares (document_id, custodian_id, share_enc)
VALUES ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000c3', '\x03');

SELECT finalize_release('00000000-0000-0000-0000-00000000d002', '\xff',
       ARRAY['00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3']::uuid[],
       'submission', NULL);
INSERT INTO results (check_name, outcome)
SELECT 'release with 2 of 2 shares after unlock_at',
       CASE WHEN status = 'released' THEN 'PASS — released' ELSE 'FAIL' END
FROM documents WHERE id = '00000000-0000-0000-0000-00000000d002';

SELECT pg_temp.expect_fail('a document releases only once',
  $q$INSERT INTO releases (document_id, wrapped_key, custodian_ids, triggered_by)
     VALUES ('00000000-0000-0000-0000-00000000d002', '\xff', '{}', 'worker')$q$);

INSERT INTO results (check_name, outcome)
SELECT 'audit chain verifies', CASE WHEN count(*) = 0 THEN 'PASS — no broken rows' ELSE 'FAIL' END
FROM verify_audit_chain();

-- =====================================================================
-- Exam papers: question pool, sealing, late draw, print cap, reprints
-- =====================================================================
INSERT INTO exams (id, name, created_by) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'Viva exam', '00000000-0000-0000-0000-0000000000a1');
INSERT INTO centres (id, code, name, city) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'TST01', 'Test centre', 'Delhi');
INSERT INTO papers (id, exam_id, subject, title, duration_minutes, seal_deadline, unlock_at, exam_start,
                    threshold_k, total_shares_n, data_key_wrapped, created_by) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'DSA', 'Viva paper', 60,
   now() + interval '1 day', now() + interval '2 days', now() + interval '3 days', 2, 2, '\x01',
   '00000000-0000-0000-0000-0000000000a1');
INSERT INTO paper_setters VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1');
INSERT INTO paper_centres VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1',
                                  '00000000-0000-0000-0000-0000000000a1', 2, 1);
INSERT INTO blueprint_items (paper_id, position, topic, difficulty, count_needed, marks_each)
VALUES ('00000000-0000-0000-0000-0000000000b1', 1, 'Arrays', 'easy', 2, 2);

SELECT pg_temp.expect_fail('paper timeline: unlock before the seal deadline',
  $q$INSERT INTO papers (exam_id, subject, title, duration_minutes, seal_deadline, unlock_at, exam_start, threshold_k, total_shares_n, data_key_wrapped, created_by)
     VALUES ('00000000-0000-0000-0000-0000000000e1', 'DSA', 'Bad timeline', 60, now() + interval '2 days', now() + interval '1 day',
             now() + interval '3 days', 2, 2, '\x01', '00000000-0000-0000-0000-0000000000a1')$q$);

SELECT pg_temp.expect_fail('only an assigned setter can add to the pool (composite FK)',
  $q$INSERT INTO questions (paper_id, setter_id, topic, difficulty, body_enc, body_hmac, option_count)
     VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'Arrays', 'easy', '\x00', digest('x', 'sha256'), 4)$q$);

SELECT pg_temp.expect_fail('a question must fit a blueprint cell (composite FK)',
  $q$INSERT INTO questions (paper_id, setter_id, topic, difficulty, body_enc, body_hmac, option_count)
     VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Graphs', 'hard', '\x00', digest('x', 'sha256'), 4)$q$);

INSERT INTO questions (id, paper_id, setter_id, topic, difficulty, body_enc, body_hmac, option_count)
SELECT ('00000000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid, '00000000-0000-0000-0000-0000000000b1',
       '00000000-0000-0000-0000-0000000000a1', 'Arrays', 'easy', '\x00', digest('question ' || g, 'sha256'), 4
FROM generate_series(1, 3) g;

SELECT pg_temp.expect_fail('duplicate question in the pool (same HMAC)',
  $q$INSERT INTO questions (paper_id, setter_id, topic, difficulty, body_enc, body_hmac, option_count)
     VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Arrays', 'easy', '\x00', digest('question 1', 'sha256'), 4)$q$);

SELECT pg_temp.expect_fail('cannot seal while the server still holds the paper key',
  $q$UPDATE papers SET status = 'sealed' WHERE id = '00000000-0000-0000-0000-0000000000b1'$q$);

-- move the timeline into the past (allowed while draft), create the key quorum, seal
UPDATE papers SET seal_deadline = now() - interval '3 hours', unlock_at = now() - interval '2 hours',
                  exam_start = now() + interval '1 hour'
 WHERE id = '00000000-0000-0000-0000-0000000000b1';
INSERT INTO documents (id, title, original_name, mime_type, size_bytes, threshold_k, total_shares_n, unlock_at,
                       created_by, created_at, paper_id)
VALUES ('00000000-0000-0000-0000-00000000d003', 'Exam paper: DSA', 'p.pdf', 'application/x-sealedpaper-paper', 1, 2, 2,
        now() - interval '2 hours', '00000000-0000-0000-0000-0000000000a1', now() - interval '4 hours',
        '00000000-0000-0000-0000-0000000000b1');
INSERT INTO key_shares (document_id, custodian_id, share_index, share_hash, pickup_enc)
VALUES ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000000c1', 1, digest('s1', 'sha256'), '\x00'),
       ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000000c2', 2, digest('s2', 'sha256'), '\x00');
UPDATE papers SET status = 'sealed', data_key_wrapped = NULL WHERE id = '00000000-0000-0000-0000-0000000000b1';

SELECT pg_temp.expect_fail('questions are frozen after sealing',
  $q$UPDATE questions SET topic = 'Arrays', body_enc = '\x01' WHERE id = '00000000-0000-0000-0000-000000000101'$q$);

SELECT pg_temp.expect_fail('blueprint is frozen after sealing',
  $q$UPDATE blueprint_items SET count_needed = 1 WHERE paper_id = '00000000-0000-0000-0000-0000000000b1'$q$);

UPDATE questions SET status = 'burned', burned_at = now() WHERE id = '00000000-0000-0000-0000-000000000101';
INSERT INTO results (check_name, outcome)
SELECT 'a leaked question can still be burned after sealing',
       CASE WHEN status = 'burned' THEN 'PASS — burned' ELSE 'FAIL' END
FROM questions WHERE id = '00000000-0000-0000-0000-000000000101';

SELECT pg_temp.expect_fail('a paper cannot be released before its key quorum opens it',
  $q$UPDATE papers SET status = 'released' WHERE id = '00000000-0000-0000-0000-0000000000b1'$q$);

INSERT INTO pending_shares (document_id, custodian_id, share_enc)
VALUES ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000000c1', '\x01'),
       ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000000c2', '\x02');
SELECT finalize_release('00000000-0000-0000-0000-00000000d003', '\xff',
       ARRAY['00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2']::uuid[], 'worker', NULL);
SELECT * FROM draw_final_questions('00000000-0000-0000-0000-0000000000b1');
INSERT INTO results (check_name, outcome)
SELECT 'draw_final_questions() fills the blueprint and never picks a burned question',
       CASE WHEN count(*) = 2 AND bool_and(q.status = 'active') THEN 'PASS — drew 2 active of 2 needed' ELSE 'FAIL' END
FROM final_questions f JOIN questions q ON q.id = f.question_id
WHERE f.paper_id = '00000000-0000-0000-0000-0000000000b1';
UPDATE papers SET status = 'released' WHERE id = '00000000-0000-0000-0000-0000000000b1';

INSERT INTO variants (id, paper_id, centre_id, question_order, option_orders, signature)
SELECT '00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1',
       array_agg(question_id ORDER BY position), '{}'::jsonb, 'sig-1'
FROM final_questions WHERE paper_id = '00000000-0000-0000-0000-0000000000b1';
-- cap = 2 candidates + 1 spare = 3
INSERT INTO printed_copies (variant_id, copy_no, copy_code, printed_by)
SELECT '00000000-0000-0000-0000-0000000000a9', g, 'TST01-000' || g || '-AAAA', '00000000-0000-0000-0000-0000000000a1'
FROM generate_series(1, 3) g;

SELECT pg_temp.expect_fail('print cap: a 4th copy for 2 candidates + 1 spare',
  $q$INSERT INTO printed_copies (variant_id, copy_no, copy_code, printed_by)
     VALUES ('00000000-0000-0000-0000-0000000000a9', 4, 'TST01-0004-AAAA', '00000000-0000-0000-0000-0000000000a1')$q$);

SELECT pg_temp.expect_fail('four eyes: nobody approves their own reprint',
  $q$INSERT INTO reprint_requests (copy_id, requested_by, reason, status, decided_by, decided_at)
     SELECT id, printed_by, 'self approved', 'approved', printed_by, now() FROM printed_copies WHERE copy_no = 1
       AND variant_id = '00000000-0000-0000-0000-0000000000a9'$q$);

SELECT pg_temp.expect_fail('printed copies are evidence: no deletes',
  $q$DELETE FROM printed_copies WHERE variant_id = '00000000-0000-0000-0000-0000000000a9'$q$);

-- =====================================================================
-- Confidential documents: traced copies and leak targets
-- =====================================================================
SELECT pg_temp.expect_fail('no traced copy of a sealed document',
  $q$INSERT INTO document_copies (document_id, reader_id, copy_no, copy_code, stamped)
     VALUES ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000c1', 1, 'DOC-0001-AAAA', true)$q$);

INSERT INTO document_copies (document_id, reader_id, copy_no, copy_code, stamped)
VALUES ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000c1', 1, 'DOC-0001-BBBB', true),
       ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000c1', 2, 'DOC-0002-CCCC', true);

SELECT pg_temp.expect_fail('copy limit: a 3rd copy for a reader allowed 2',
  $q$INSERT INTO document_copies (document_id, reader_id, copy_no, copy_code, stamped)
     VALUES ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000c1', 3, 'DOC-0003-DDDD', true)$q$);

SELECT pg_temp.expect_fail('issued copies cannot be deleted',
  $q$DELETE FROM document_copies WHERE copy_code = 'DOC-0001-BBBB'$q$);

SELECT pg_temp.expect_fail('a leak report targets exactly one paper or document',
  $q$INSERT INTO leak_reports (reported_by, leaked_text, phase)
     VALUES ('00000000-0000-0000-0000-0000000000a1', 'some leaked text here', 'post_release')$q$);

-- ---------- tamper test: an owner bypasses the trigger and edits one row ----------
ALTER TABLE audit_log DISABLE TRIGGER audit_no_edit;
UPDATE audit_log SET payload = '{"edited": true}' WHERE action = 'test.two';
ALTER TABLE audit_log ENABLE TRIGGER audit_no_edit;
INSERT INTO results (check_name, outcome)
SELECT 'verify_audit_chain() catches an edited row',
       CASE WHEN count(*) = 1 THEN 'PASS — flagged row ' || min(v.id) || ': ' || min(v.problem) ELSE 'FAIL' END
FROM verify_audit_chain() v JOIN audit_log a ON a.id = v.id AND a.action = 'test.two';

\o
SELECT n, check_name, outcome FROM results ORDER BY n;
SELECT * FROM unlock_status WHERE document_id::text LIKE '00000000-0000-0000-0000-00000000d00%' ORDER BY title;

ROLLBACK;
