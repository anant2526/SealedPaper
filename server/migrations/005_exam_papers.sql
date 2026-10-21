-- =====================================================================
-- SealedPaper — exam papers built from a question pool
--
--   setters add questions (encrypted) -> sealing splits the paper key among
--   custodians and DELETES it -> k custodians unlock after unlock_at ->
--   the server draws the final questions to the blueprint -> every centre gets
--   its own shuffled variant -> superintendents print numbered copies ->
--   a leaked copy traces back to its setter (before release) or centre/copy (after).
-- =====================================================================

CREATE TYPE paper_status    AS ENUM ('draft', 'sealed', 'released');
CREATE TYPE difficulty      AS ENUM ('easy', 'medium', 'hard');
CREATE TYPE question_status AS ENUM ('active', 'burned');
CREATE TYPE reprint_status  AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE leak_phase      AS ENUM ('pre_release', 'post_release');

-- ---------- exams ----------
CREATE TABLE exams (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 120),
    created_by  uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT exams_name_unique UNIQUE (name)
);

-- ---------- centres ----------
CREATE TABLE centres (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL,
    name        text NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 160),
    city        text NOT NULL CHECK (length(trim(city)) BETWEEN 2 AND 80),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT centres_code_unique UNIQUE (code),
    CONSTRAINT centres_code_format CHECK (code ~ '^[A-Z0-9]{2,8}$')
);

-- ---------- papers ----------
CREATE TABLE papers (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id                uuid NOT NULL REFERENCES exams(id),
    subject                text NOT NULL CHECK (length(trim(subject)) BETWEEN 2 AND 120),
    title                  text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
    instructions           text NOT NULL DEFAULT '' CHECK (length(instructions) <= 2000),
    duration_minutes       integer NOT NULL CHECK (duration_minutes BETWEEN 10 AND 600),
    status                 paper_status NOT NULL DEFAULT 'draft',
    seal_deadline          timestamptz NOT NULL,
    unlock_at              timestamptz NOT NULL,
    exam_start             timestamptz NOT NULL,
    submit_window_minutes  integer NOT NULL DEFAULT 60 CHECK (submit_window_minutes BETWEEN 0 AND 10080),
    threshold_k            smallint NOT NULL,
    total_shares_n         smallint NOT NULL,
    -- the paper's data key, wrapped with the server master key; deleted at sealing
    data_key_wrapped       bytea,
    created_by             uuid NOT NULL REFERENCES users(id),
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT papers_threshold CHECK (2 <= threshold_k AND threshold_k <= total_shares_n AND total_shares_n <= 20),
    CONSTRAINT papers_timeline  CHECK (seal_deadline < unlock_at AND unlock_at < exam_start),
    -- after sealing not even the server holds the key
    CONSTRAINT papers_key_only_in_draft CHECK ((status = 'draft') = (data_key_wrapped IS NOT NULL)),
    CONSTRAINT papers_title_unique UNIQUE (exam_id, subject, title)
);
CREATE INDEX papers_seal_due_idx ON papers (seal_deadline) WHERE status = 'draft';

-- link a sealed paper to the vault document that holds its key quorum
ALTER TABLE documents ADD COLUMN paper_id uuid UNIQUE REFERENCES papers(id);

-- ---------- who works on a paper ----------
CREATE TABLE paper_setters (
    paper_id   uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    setter_id  uuid NOT NULL REFERENCES users(id),
    PRIMARY KEY (paper_id, setter_id)
);

CREATE TABLE paper_custodians (
    paper_id      uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    custodian_id  uuid NOT NULL REFERENCES users(id),
    PRIMARY KEY (paper_id, custodian_id)
);

-- ---------- blueprint: topic x difficulty counts ----------
CREATE TABLE blueprint_items (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id      uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    position      smallint NOT NULL CHECK (position >= 1),
    topic         text NOT NULL CHECK (length(trim(topic)) BETWEEN 2 AND 80),
    difficulty    difficulty NOT NULL,
    count_needed  smallint NOT NULL CHECK (count_needed > 0 AND count_needed <= 100),
    marks_each    smallint NOT NULL CHECK (marks_each > 0 AND marks_each <= 100),
    CONSTRAINT blueprint_cell_unique UNIQUE (paper_id, topic, difficulty),
    CONSTRAINT blueprint_position_unique UNIQUE (paper_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- ---------- the question pool ----------
CREATE TABLE questions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id        uuid NOT NULL,
    setter_id       uuid NOT NULL,
    topic           text NOT NULL,
    difficulty      difficulty NOT NULL,
    body_enc        bytea NOT NULL,                       -- AES-GCM(paper key, {text, options, answer})
    body_hmac       bytea NOT NULL CHECK (length(body_hmac) = 32),   -- HMAC of the normalised question text
    option_count    smallint NOT NULL CHECK (option_count BETWEEN 2 AND 6),
    status          question_status NOT NULL DEFAULT 'active',
    burned_at       timestamptz,
    burned_by_leak  uuid,                                 -- FK added below (leak_reports)
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT questions_no_duplicates UNIQUE (paper_id, body_hmac),
    CONSTRAINT questions_burn_state CHECK ((status = 'burned') = (burned_at IS NOT NULL)),
    -- only an assigned setter can own a question of this paper
    FOREIGN KEY (paper_id, setter_id) REFERENCES paper_setters (paper_id, setter_id) ON DELETE CASCADE,
    -- the question must fit a cell of the blueprint
    FOREIGN KEY (paper_id, topic, difficulty) REFERENCES blueprint_items (paper_id, topic, difficulty) ON UPDATE CASCADE
);
CREATE INDEX questions_paper_cell_idx ON questions (paper_id, topic, difficulty) WHERE status = 'active';
CREATE INDEX questions_hmac_idx ON questions (body_hmac);

-- ---------- centres per paper ----------
CREATE TABLE paper_centres (
    paper_id           uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    centre_id          uuid NOT NULL REFERENCES centres(id),
    superintendent_id  uuid NOT NULL REFERENCES users(id),
    candidate_count    integer NOT NULL CHECK (candidate_count BETWEEN 1 AND 100000),
    print_buffer       integer NOT NULL DEFAULT 2 CHECK (print_buffer BETWEEN 0 AND 100),
    PRIMARY KEY (paper_id, centre_id)
);
CREATE INDEX paper_centres_super_idx ON paper_centres (superintendent_id);

-- ---------- the final paper (drawn at release) ----------
CREATE TABLE final_questions (
    paper_id     uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    question_id  uuid NOT NULL REFERENCES questions(id),
    position     smallint NOT NULL CHECK (position >= 1),
    section      smallint NOT NULL CHECK (section >= 1),
    marks        smallint NOT NULL CHECK (marks > 0),
    PRIMARY KEY (paper_id, question_id),
    CONSTRAINT final_questions_position_unique UNIQUE (paper_id, position)
);

-- ---------- one shuffled variant per centre ----------
CREATE TABLE variants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id        uuid NOT NULL,
    centre_id       uuid NOT NULL,
    question_order  uuid[] NOT NULL,                  -- question ids in the order this centre prints them
    option_orders   jsonb NOT NULL,                   -- { question_id: [original option indexes in printed order] }
    signature       text NOT NULL,                    -- SHA-256 of the order, used by the leak tracer
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT variants_one_per_centre UNIQUE (paper_id, centre_id),
    CONSTRAINT variants_signature_unique UNIQUE (paper_id, signature),
    FOREIGN KEY (paper_id, centre_id) REFERENCES paper_centres (paper_id, centre_id)
);
CREATE INDEX variants_signature_idx ON variants (signature);

-- ---------- reprints ----------
CREATE TABLE printed_copies (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id          uuid NOT NULL REFERENCES variants(id),
    copy_no             integer NOT NULL CHECK (copy_no >= 1),
    copy_code           text NOT NULL,
    printed_by          uuid NOT NULL REFERENCES users(id),
    printed_at          timestamptz NOT NULL DEFAULT now(),
    reprint_request_id  uuid UNIQUE,                  -- set when this copy replaces a spoiled one
    voided_at           timestamptz,                  -- set when this copy was replaced
    CONSTRAINT printed_copies_number_unique UNIQUE (variant_id, copy_no),
    CONSTRAINT printed_copies_code_unique UNIQUE (copy_code)
);

CREATE TABLE reprint_requests (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    copy_id       uuid NOT NULL REFERENCES printed_copies(id),
    requested_by  uuid NOT NULL REFERENCES users(id),
    reason        text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 300),
    status        reprint_status NOT NULL DEFAULT 'pending',
    decided_by    uuid REFERENCES users(id),
    decided_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- the person who asked can never approve their own reprint
    CONSTRAINT reprint_four_eyes CHECK (decided_by <> requested_by),
    CONSTRAINT reprint_decision_state CHECK ((status = 'pending') = (decided_by IS NULL AND decided_at IS NULL)),
    CONSTRAINT reprint_one_open_per_copy EXCLUDE USING btree (copy_id WITH =) WHERE (status = 'pending')
);
ALTER TABLE printed_copies
    ADD CONSTRAINT printed_copies_reprint_fk FOREIGN KEY (reprint_request_id) REFERENCES reprint_requests(id);

-- ---------- leaks ----------
CREATE TABLE leak_reports (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id            uuid NOT NULL REFERENCES papers(id),
    reported_by         uuid NOT NULL REFERENCES users(id),
    source              text NOT NULL DEFAULT '' CHECK (length(source) <= 300),
    leaked_text         text NOT NULL CHECK (length(leaked_text) BETWEEN 10 AND 200000),
    phase               leak_phase NOT NULL,
    matched_variant_id  uuid REFERENCES variants(id),   -- nullable: unknown or before release
    matched_copy_id     uuid REFERENCES printed_copies(id),
    confidence          real CHECK (confidence BETWEEN 0 AND 1),
    summary             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leak_reports_paper_idx ON leak_reports (paper_id, created_at);

CREATE TABLE leak_matches (
    leak_report_id  uuid NOT NULL REFERENCES leak_reports(id) ON DELETE CASCADE,
    question_id     uuid NOT NULL REFERENCES questions(id),
    setter_id       uuid NOT NULL REFERENCES users(id),
    PRIMARY KEY (leak_report_id, question_id)
);
CREATE INDEX leak_matches_setter_idx ON leak_matches (setter_id);

ALTER TABLE questions
    ADD CONSTRAINT questions_burned_by_leak_fk FOREIGN KEY (burned_by_leak) REFERENCES leak_reports(id);

-- =====================================================================
-- Triggers
-- =====================================================================

-- T8. Paper guard: settings frozen after sealing, legal status moves only,
--     release only after its vault document was released by the key quorum.
CREATE FUNCTION papers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'draft' AND (
           NEW.seal_deadline <> OLD.seal_deadline OR NEW.unlock_at <> OLD.unlock_at
        OR NEW.exam_start <> OLD.exam_start OR NEW.threshold_k <> OLD.threshold_k
        OR NEW.total_shares_n <> OLD.total_shares_n OR NEW.duration_minutes <> OLD.duration_minutes
        OR NEW.subject <> OLD.subject OR NEW.title <> OLD.title OR NEW.instructions <> OLD.instructions) THEN
        RAISE EXCEPTION 'paper % is % and its settings are frozen', OLD.id, OLD.status USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT ((OLD.status = 'draft' AND NEW.status = 'sealed') OR (OLD.status = 'sealed' AND NEW.status = 'released')) THEN
            RAISE EXCEPTION 'paper % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status = 'sealed' AND NOT EXISTS (SELECT 1 FROM documents WHERE paper_id = OLD.id) THEN
            RAISE EXCEPTION 'paper % has no key quorum yet', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status = 'released' AND NOT EXISTS (
            SELECT 1 FROM documents WHERE paper_id = OLD.id AND status = 'released') THEN
            RAISE EXCEPTION 'paper % is still locked: its key quorum has not opened it', OLD.id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER papers_guard_upd BEFORE UPDATE ON papers
    FOR EACH ROW EXECUTE FUNCTION papers_guard();

-- T9. Questions are frozen after sealing (or after the seal deadline).
--     The only change allowed later: burning an active question before release.
CREATE FUNCTION questions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    p papers%ROWTYPE;
BEGIN
    SELECT * INTO p FROM papers WHERE id = coalesce(NEW.paper_id, OLD.paper_id);

    IF TG_OP = 'UPDATE'
       AND OLD.status = 'active' AND NEW.status = 'burned'
       AND NEW.body_enc = OLD.body_enc AND NEW.body_hmac = OLD.body_hmac
       AND NEW.topic = OLD.topic AND NEW.difficulty = OLD.difficulty THEN
        IF p.status = 'released' THEN
            RAISE EXCEPTION 'paper % is already released; burning a question is too late', p.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF p.status <> 'draft' THEN
        RAISE EXCEPTION 'questions of paper % are frozen: it is %', p.id, p.status USING ERRCODE = 'check_violation';
    END IF;
    IF now() >= p.seal_deadline THEN
        RAISE EXCEPTION 'the seal deadline of paper % has passed', p.id USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER questions_guard_all BEFORE INSERT OR UPDATE OR DELETE ON questions
    FOR EACH ROW EXECUTE FUNCTION questions_guard();

-- T10. Blueprint, setters, custodians and centres of a paper are frozen after sealing.
CREATE FUNCTION paper_setup_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_status paper_status;
BEGIN
    SELECT status INTO v_status FROM papers WHERE id = coalesce(NEW.paper_id, OLD.paper_id);
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
        RAISE EXCEPTION '% cannot change: paper % is %', TG_TABLE_NAME, coalesce(NEW.paper_id, OLD.paper_id), v_status
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER blueprint_frozen   BEFORE INSERT OR UPDATE OR DELETE ON blueprint_items  FOR EACH ROW EXECUTE FUNCTION paper_setup_frozen();
CREATE TRIGGER setters_frozen     BEFORE INSERT OR UPDATE OR DELETE ON paper_setters    FOR EACH ROW EXECUTE FUNCTION paper_setup_frozen();
CREATE TRIGGER custodians_frozen  BEFORE INSERT OR UPDATE OR DELETE ON paper_custodians FOR EACH ROW EXECUTE FUNCTION paper_setup_frozen();
CREATE TRIGGER centres_frozen     BEFORE INSERT OR UPDATE OR DELETE ON paper_centres    FOR EACH ROW EXECUTE FUNCTION paper_setup_frozen();

-- T11. Print cap: a centre can print at most candidates + buffer + approved reprints.
CREATE FUNCTION print_cap_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_cap      int;
    v_printed  int;
    v_status   paper_status;
BEGIN
    -- serialise printers of the same variant so two clicks cannot both squeeze under the cap
    PERFORM pg_advisory_xact_lock(hashtext(NEW.variant_id::text));

    SELECT pc.candidate_count + pc.print_buffer
           + (SELECT count(*) FROM reprint_requests r JOIN printed_copies c ON c.id = r.copy_id
               WHERE c.variant_id = v.id AND r.status = 'approved'),
           p.status
      INTO v_cap, v_status
      FROM variants v
      JOIN paper_centres pc ON pc.paper_id = v.paper_id AND pc.centre_id = v.centre_id
      JOIN papers p ON p.id = v.paper_id
     WHERE v.id = NEW.variant_id;

    IF v_status <> 'released' THEN
        RAISE EXCEPTION 'paper is not released; nothing can be printed' USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*) INTO v_printed FROM printed_copies WHERE variant_id = NEW.variant_id;
    IF v_printed >= v_cap THEN
        RAISE EXCEPTION 'print cap reached: % of % copies already printed for this centre', v_printed, v_cap
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.reprint_request_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM reprint_requests WHERE id = NEW.reprint_request_id AND status = 'approved') THEN
        RAISE EXCEPTION 'reprint % is not approved', NEW.reprint_request_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER printed_copies_cap BEFORE INSERT ON printed_copies
    FOR EACH ROW EXECUTE FUNCTION print_cap_guard();

-- Printed copies are evidence: only voided_at may be set, once.
CREATE FUNCTION printed_copies_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'printed copies cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.copy_code <> OLD.copy_code OR NEW.variant_id <> OLD.variant_id OR NEW.copy_no <> OLD.copy_no
       OR NEW.printed_by <> OLD.printed_by OR NEW.printed_at <> OLD.printed_at
       OR (OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at) THEN
        RAISE EXCEPTION 'printed copy % is evidence and cannot be changed', OLD.copy_code USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER printed_copies_no_edit BEFORE UPDATE OR DELETE ON printed_copies
    FOR EACH ROW EXECUTE FUNCTION printed_copies_guard();

CREATE TRIGGER leak_reports_no_edit BEFORE UPDATE OR DELETE ON leak_reports
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- =====================================================================
-- Stored functions
-- =====================================================================

-- F4. draw_final_questions(): the late assembly. For each blueprint cell, picks
--     count_needed ACTIVE (never burned) questions using pgcrypto's
--     cryptographically secure gen_random_bytes() as the shuffle key.
--     Returns what was needed vs drawn per cell.
CREATE FUNCTION draw_final_questions(p_paper_id uuid)
RETURNS TABLE (topic text, difficulty difficulty, needed smallint, drawn integer)
LANGUAGE plpgsql AS $$
DECLARE
    b      record;
    v_pos  int := 0;
    v_n    int;
BEGIN
    IF EXISTS (SELECT 1 FROM final_questions f WHERE f.paper_id = p_paper_id) THEN
        RAISE EXCEPTION 'paper % was already drawn', p_paper_id USING ERRCODE = 'unique_violation';
    END IF;

    FOR b IN SELECT * FROM blueprint_items bi WHERE bi.paper_id = p_paper_id ORDER BY bi.position LOOP
        WITH picked AS (
            SELECT q.id
              FROM questions q
             WHERE q.paper_id = p_paper_id AND q.topic = b.topic AND q.difficulty = b.difficulty
               AND q.status = 'active'
             ORDER BY gen_random_bytes(16)
             LIMIT b.count_needed
        ), numbered AS (
            SELECT id, v_pos + row_number() OVER () AS pos FROM picked
        )
        INSERT INTO final_questions (paper_id, question_id, position, section, marks)
        SELECT p_paper_id, id, pos, b.position, b.marks_each FROM numbered;

        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_pos := v_pos + v_n;
        topic := b.topic; difficulty := b.difficulty; needed := b.count_needed; drawn := v_n;
        RETURN NEXT;
    END LOOP;
END $$;

-- =====================================================================
-- Views
-- =====================================================================

-- V4. pool_coverage: is every blueprint cell covered? (counts only, never content)
CREATE VIEW pool_coverage AS
SELECT b.paper_id, b.position, b.topic, b.difficulty, b.count_needed, b.marks_each,
       count(q.id) FILTER (WHERE q.status = 'active') AS active_count,
       count(q.id) FILTER (WHERE q.status = 'burned') AS burned_count,
       count(q.id) FILTER (WHERE q.status = 'active') >= b.count_needed AS covered
FROM blueprint_items b
LEFT JOIN questions q ON q.paper_id = b.paper_id AND q.topic = b.topic AND q.difficulty = b.difficulty
GROUP BY b.id;

-- V5. centre_readiness: is each centre fully set up, and how much has it printed?
CREATE VIEW centre_readiness AS
SELECT pc.paper_id, pc.centre_id, c.code AS centre_code, c.name AS centre_name, c.city,
       pc.superintendent_id, u.name AS superintendent_name, u.email AS superintendent_email,
       (u.status = 'active' AND u.role = 'superintendent') AS superintendent_ready,
       pc.candidate_count, pc.print_buffer,
       v.id AS variant_id,
       coalesce(pr.printed, 0) AS copies_printed,
       coalesce(pr.voided, 0) AS copies_voided,
       pc.candidate_count + pc.print_buffer + coalesce(rr.approved, 0) AS print_cap,
       coalesce(rr.pending, 0) AS reprints_pending
FROM paper_centres pc
JOIN centres c ON c.id = pc.centre_id
JOIN users u ON u.id = pc.superintendent_id
LEFT JOIN variants v ON v.paper_id = pc.paper_id AND v.centre_id = pc.centre_id
LEFT JOIN LATERAL (
    SELECT count(*) AS printed, count(*) FILTER (WHERE voided_at IS NOT NULL) AS voided
    FROM printed_copies WHERE variant_id = v.id) pr ON true
LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE r.status = 'approved') AS approved,
           count(*) FILTER (WHERE r.status = 'pending')  AS pending
    FROM reprint_requests r JOIN printed_copies pcp ON pcp.id = r.copy_id
    WHERE pcp.variant_id = v.id) rr ON true;

-- V6. setter_leak_report — GROUP BY / HAVING: setters with more than one leaked question
CREATE VIEW setter_leak_report AS
SELECT u.id AS setter_id, u.name, u.email,
       count(DISTINCT m.question_id)    AS leaked_questions,
       count(DISTINCT m.leak_report_id) AS reports,
       count(DISTINCT lr.paper_id)      AS papers,
       max(lr.created_at)               AS last_seen
FROM leak_matches m
JOIN leak_reports lr ON lr.id = m.leak_report_id
JOIN users u ON u.id = m.setter_id
GROUP BY u.id
HAVING count(DISTINCT m.question_id) > 1;

-- V7. centre_reprint_rates — subquery: centres whose reprint rate is above the average
CREATE VIEW centre_reprint_rates AS
WITH per_centre AS (
    SELECT c.id AS centre_id, c.code, c.name,
           count(pcp.id) AS copies,
           count(pcp.id) FILTER (WHERE pcp.reprint_request_id IS NOT NULL) AS reprints,
           round(count(pcp.id) FILTER (WHERE pcp.reprint_request_id IS NOT NULL)::numeric
                 / NULLIF(count(pcp.id), 0), 4) AS reprint_rate
    FROM centres c
    JOIN variants v ON v.centre_id = c.id
    JOIN printed_copies pcp ON pcp.variant_id = v.id
    GROUP BY c.id
)
SELECT pc.*, (SELECT round(avg(reprint_rate), 4) FROM per_centre) AS average_rate,
       pc.reprint_rate > (SELECT avg(reprint_rate) FROM per_centre) AS above_average
FROM per_centre pc;

-- V1 again: unlock_status gains the paper link (columns appended at the end)
CREATE OR REPLACE VIEW unlock_status AS
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
       r.released_at,
       d.paper_id
FROM documents d
LEFT JOIN key_shares     k ON k.document_id = d.id
LEFT JOIN pending_shares p ON p.document_id = k.document_id AND p.custodian_id = k.custodian_id
LEFT JOIN releases       r ON r.document_id = d.id
GROUP BY d.id, r.custodian_ids, r.released_at;

-- =====================================================================
-- DCL for the new tables
-- =====================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sealedpaper_app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON exams, centres, papers, paper_setters, paper_custodians,
                 blueprint_items, questions, paper_centres, final_questions, variants, reprint_requests
                 TO sealedpaper_app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON printed_copies TO sealedpaper_app';
        EXECUTE 'GRANT SELECT, INSERT ON leak_reports, leak_matches TO sealedpaper_app';
        EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON leak_reports FROM sealedpaper_app';
        EXECUTE 'GRANT SELECT ON pool_coverage, centre_readiness, setter_leak_report, centre_reprint_rates, unlock_status
                 TO sealedpaper_app';
        EXECUTE 'GRANT EXECUTE ON FUNCTION draw_final_questions(uuid) TO sealedpaper_app';
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'DCL skipped: %', SQLERRM;
END $$;
