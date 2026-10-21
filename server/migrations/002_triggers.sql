-- =====================================================================
-- Triggers: the database enforces the security rules on its own.
-- Try any of these from psql — they fail even without the API.
-- =====================================================================

-- ---------------------------------------------------------------------
-- T1 + T2. Audit log: hash chain on insert, no UPDATE / DELETE / TRUNCATE
-- ---------------------------------------------------------------------

-- One function computes a row's hash, so the trigger and the verifier agree exactly.
CREATE FUNCTION audit_row_hash(
    p_prev text, p_actor uuid, p_action text, p_entity text, p_entity_id text,
    p_payload jsonb, p_created timestamptz
) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT encode(digest(
        coalesce(p_prev, '')                          || '|' ||
        coalesce(p_actor::text, 'system')             || '|' ||
        p_action                                      || '|' ||
        coalesce(p_entity, '')                        || '|' ||
        coalesce(p_entity_id, '')                     || '|' ||
        p_payload::text                               || '|' ||
        to_char(p_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
        'sha256'), 'hex');
$$;

CREATE FUNCTION audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(4242);              -- one writer at a time, so the chain never forks
    NEW.created_at := clock_timestamp();
    SELECT row_hash INTO NEW.prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
    NEW.row_hash := audit_row_hash(NEW.prev_hash, NEW.actor_id, NEW.action, NEW.entity,
                                   NEW.entity_id, NEW.payload, NEW.created_at);
    RETURN NEW;
END $$;

CREATE TRIGGER audit_chain_ins BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_chain();

CREATE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_no_edit BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- The evidence tables are append-only too.
CREATE TRIGGER share_submissions_no_edit BEFORE UPDATE OR DELETE ON share_submissions
    FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER face_checks_no_edit BEFORE UPDATE OR DELETE ON face_checks
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------
-- T3. Documents: settings are frozen, and RELEASE needs time + quorum
-- ---------------------------------------------------------------------
CREATE FUNCTION documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_pending int;
BEGIN
    IF NEW.threshold_k    <> OLD.threshold_k
    OR NEW.total_shares_n <> OLD.total_shares_n
    OR NEW.unlock_at      <> OLD.unlock_at
    OR NEW.submit_window_minutes <> OLD.submit_window_minutes
    OR NEW.created_by     <> OLD.created_by
    OR NEW.created_at     <> OLD.created_at THEN
        RAISE EXCEPTION 'document % settings are frozen after upload', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'sealed' THEN
            RAISE EXCEPTION 'document % is % and can no longer change status', OLD.id, OLD.status
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.status = 'released' THEN
            -- the time lock
            IF now() < OLD.unlock_at THEN
                RAISE EXCEPTION 'time lock: document % cannot be released before %', OLD.id, OLD.unlock_at
                    USING ERRCODE = 'check_violation';
            END IF;
            -- the quorum
            SELECT count(*) INTO v_pending FROM pending_shares WHERE document_id = OLD.id;
            IF v_pending < OLD.threshold_k THEN
                RAISE EXCEPTION 'quorum: document % has % of % key shares', OLD.id, v_pending, OLD.threshold_k
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER documents_guard_upd BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION documents_guard();

-- ---------------------------------------------------------------------
-- T4. Key shares: the hash never changes, and the pickup copy only ever disappears
-- ---------------------------------------------------------------------
CREATE FUNCTION key_shares_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.share_hash   <> OLD.share_hash
    OR NEW.share_index  <> OLD.share_index
    OR NEW.custodian_id <> OLD.custodian_id
    OR NEW.document_id  <> OLD.document_id THEN
        RAISE EXCEPTION 'key share % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.pickup_enc IS NULL AND NEW.pickup_enc IS NOT NULL THEN
        RAISE EXCEPTION 'key share % was already picked up; it cannot be re-issued', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER key_shares_guard_upd BEFORE UPDATE ON key_shares
    FOR EACH ROW EXECUTE FUNCTION key_shares_guard();

-- ---------------------------------------------------------------------
-- T5. Pending shares only inside the submission window of a sealed document
-- ---------------------------------------------------------------------
CREATE FUNCTION pending_shares_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    d documents%ROWTYPE;
BEGIN
    SELECT * INTO d FROM documents WHERE id = NEW.document_id;
    IF d.status <> 'sealed' THEN
        RAISE EXCEPTION 'document % is %, not accepting keys', d.id, d.status USING ERRCODE = 'check_violation';
    END IF;
    IF now() < d.unlock_at - make_interval(mins => d.submit_window_minutes) THEN
        RAISE EXCEPTION 'submission window for document % opens at %', d.id,
            d.unlock_at - make_interval(mins => d.submit_window_minutes) USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER pending_shares_guard_ins BEFORE INSERT ON pending_shares
    FOR EACH ROW EXECUTE FUNCTION pending_shares_guard();

-- ---------------------------------------------------------------------
-- T6. Releases and downloads only for a released document
-- ---------------------------------------------------------------------
CREATE FUNCTION require_released() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND status = 'released') THEN
        RAISE EXCEPTION 'document % is not released', NEW.document_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER releases_require_released BEFORE INSERT ON releases
    FOR EACH ROW EXECUTE FUNCTION require_released();
CREATE TRIGGER downloads_require_released BEFORE INSERT ON downloads
    FOR EACH ROW EXECUTE FUNCTION require_released();

-- ---------------------------------------------------------------------
-- T7. A user becomes 'active' only with a face template AND an authenticator app
-- ---------------------------------------------------------------------
CREATE FUNCTION users_activation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active' THEN
        IF NOT NEW.totp_enabled THEN
            RAISE EXCEPTION 'user % has no authenticator app set up', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM face_templates WHERE user_id = NEW.id) THEN
            RAISE EXCEPTION 'user % has no face scan enrolled', NEW.id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER users_activation_guard_upd BEFORE UPDATE OF status ON users
    FOR EACH ROW EXECUTE FUNCTION users_activation_guard();
