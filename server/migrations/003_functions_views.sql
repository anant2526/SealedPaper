-- =====================================================================
-- Stored functions, views and window-function queries
-- =====================================================================

-- ---------------------------------------------------------------------
-- F1. verify_audit_chain()
--   LAG() finds rows whose link to the previous row is broken (deleted / inserted rows);
--   recomputing row_hash finds rows whose contents were edited.
-- ---------------------------------------------------------------------
CREATE FUNCTION verify_audit_chain()
RETURNS TABLE (id bigint, problem text)
LANGUAGE sql STABLE AS $$
    WITH chain AS (
        SELECT a.*,
               LAG(a.row_hash) OVER (ORDER BY a.id) AS expected_prev
        FROM audit_log a
    )
    SELECT c.id, 'broken link: prev_hash does not match the row before it'
    FROM chain c
    WHERE c.prev_hash IS DISTINCT FROM c.expected_prev
    UNION ALL
    SELECT c.id, 'contents edited: row_hash does not match the row'
    FROM chain c
    WHERE c.row_hash <> audit_row_hash(c.prev_hash, c.actor_id, c.action, c.entity,
                                       c.entity_id, c.payload, c.created_at)
    ORDER BY 1;
$$;

-- ---------------------------------------------------------------------
-- F2. finalize_release()
--   The database half of the release ceremony. The caller must already hold
--   SELECT ... FOR UPDATE on the document row inside the same transaction.
--   The documents_guard trigger re-checks the time lock and the quorum.
-- ---------------------------------------------------------------------
CREATE FUNCTION finalize_release(
    p_document_id  uuid,
    p_wrapped_key  bytea,
    p_custodians   uuid[],
    p_triggered_by text,
    p_actor        uuid
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    v_release_id uuid;
BEGIN
    UPDATE documents SET status = 'released' WHERE id = p_document_id;   -- trigger: time lock + quorum

    INSERT INTO releases (document_id, wrapped_key, custodian_ids, triggered_by)
    VALUES (p_document_id, p_wrapped_key, p_custodians, p_triggered_by)
    RETURNING id INTO v_release_id;

    DELETE FROM pending_shares WHERE document_id = p_document_id;           -- shares leave the server

    INSERT INTO audit_log (actor_id, action, entity, entity_id, payload)
    VALUES (p_actor, 'document.released', 'document', p_document_id::text,
            jsonb_build_object('release_id', v_release_id,
                               'custodians', to_jsonb(p_custodians),
                               'triggered_by', p_triggered_by));
    RETURN v_release_id;
END $$;

-- ---------------------------------------------------------------------
-- F3. custodian_locked_out(): 5 failed key uploads in 10 minutes => locked
-- ---------------------------------------------------------------------
CREATE FUNCTION custodian_locked_out(p_document_id uuid, p_custodian_id uuid,
                                     p_max_failures int DEFAULT 5)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT count(*) >= p_max_failures
    FROM share_submissions
    WHERE document_id = p_document_id
      AND custodian_id = p_custodian_id
      AND NOT accepted
      AND submitted_at > now() - interval '10 minutes';
$$;

-- ---------------------------------------------------------------------
-- V1. unlock_status: key files picked up / submitted vs threshold_k
-- ---------------------------------------------------------------------
CREATE VIEW unlock_status AS
SELECT d.id                                                        AS document_id,
       d.title,
       d.status,
       d.threshold_k,
       d.total_shares_n,
       d.unlock_at,
       d.unlock_at - make_interval(mins => d.submit_window_minutes) AS submit_opens_at,
       count(k.id) FILTER (WHERE k.picked_up_at IS NOT NULL)       AS keys_picked_up,
       coalesce(cardinality(r.custodian_ids), count(p.custodian_id)) AS keys_submitted,
       (d.status = 'sealed'
        AND now() >= d.unlock_at
        AND count(p.custodian_id) >= d.threshold_k)                AS ready_to_release,
       r.released_at
FROM documents d
LEFT JOIN key_shares     k ON k.document_id = d.id
LEFT JOIN pending_shares p ON p.document_id = k.document_id AND p.custodian_id = k.custodian_id
LEFT JOIN releases       r ON r.document_id = d.id
GROUP BY d.id, r.custodian_ids, r.released_at;

-- ---------------------------------------------------------------------
-- V2. suspicious_key_attempts — window function over a sliding 10-minute range
-- ---------------------------------------------------------------------
CREATE VIEW suspicious_key_attempts AS
SELECT *
FROM (
    SELECT s.id, s.document_id, s.custodian_id, s.ip, s.submitted_at, s.accepted, s.reason,
           count(*) FILTER (WHERE NOT s.accepted) OVER (
               PARTITION BY s.document_id, s.custodian_id
               ORDER BY s.submitted_at
               RANGE BETWEEN INTERVAL '10 minutes' PRECEDING AND CURRENT ROW
           ) AS failures_last_10_min
    FROM share_submissions s
) t
WHERE failures_last_10_min >= 3;

-- ---------------------------------------------------------------------
-- V3. face_failure_report — GROUP BY / HAVING: users with repeated failed face scans
-- ---------------------------------------------------------------------
CREATE VIEW face_failure_report AS
SELECT u.id AS user_id, u.name, u.email,
       count(*) FILTER (WHERE NOT f.passed) AS failed_scans,
       count(*)                             AS total_scans,
       max(f.created_at)                    AS last_scan
FROM users u
JOIN face_checks f ON f.user_id = u.id
GROUP BY u.id
HAVING count(*) FILTER (WHERE NOT f.passed) >= 3;
