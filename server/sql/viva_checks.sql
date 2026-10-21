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
