-- =====================================================================
-- SealedPaper beyond exams: any confidential document
--
-- Research results, earnings before announcement, board and M&A decks,
-- court judgments before pronouncement, tenders, policy drafts, exam papers.
-- Every released document is handed out as a TRACED COPY: each download
-- is stamped with the reader's name and a unique copy code, so a leaked
-- copy names the person it was issued to.
-- =====================================================================

CREATE TYPE document_category AS ENUM ('research', 'financial', 'board', 'legal', 'government', 'exam', 'other');

ALTER TABLE documents
    ADD COLUMN category       document_category NOT NULL DEFAULT 'other',
    ADD COLUMN description    text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
    -- how many traced copies one reader may download (each copy has its own code)
    ADD COLUMN copies_per_reader smallint NOT NULL DEFAULT 2 CHECK (copies_per_reader BETWEEN 1 AND 20);

-- exam papers sealed earlier are exams
UPDATE documents SET category = 'exam' WHERE paper_id IS NOT NULL;

-- the frozen-settings trigger must also freeze the new columns once sealed
CREATE OR REPLACE FUNCTION documents_settings_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.category <> OLD.category OR NEW.copies_per_reader <> OLD.copies_per_reader THEN
        RAISE EXCEPTION 'document % settings are frozen after upload', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER documents_settings_frozen_upd BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION documents_settings_frozen();

-- ---------- traced copies ----------
CREATE TABLE document_copies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    reader_id    uuid NOT NULL REFERENCES users(id),
    copy_no      integer NOT NULL CHECK (copy_no >= 1),
    copy_code    text NOT NULL,
    stamped      boolean NOT NULL,               -- true = PDF stamped with name + code; false = other file type, logged only
    ip           inet,
    issued_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT document_copies_number_unique UNIQUE (document_id, copy_no),
    CONSTRAINT document_copies_code_unique   UNIQUE (copy_code)
);
CREATE INDEX document_copies_reader_idx ON document_copies (document_id, reader_id);

-- T12. Copies only after release, and at most copies_per_reader per reader.
CREATE FUNCTION document_copy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    d documents%ROWTYPE;
    v_count int;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.document_id::text || NEW.reader_id::text));
    SELECT * INTO d FROM documents WHERE id = NEW.document_id;
    IF d.status <> 'released' THEN
        RAISE EXCEPTION 'document % is not released', d.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO v_count FROM document_copies WHERE document_id = NEW.document_id AND reader_id = NEW.reader_id;
    IF v_count >= d.copies_per_reader THEN
        RAISE EXCEPTION 'copy limit reached: % of % copies already issued to this reader', v_count, d.copies_per_reader
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER document_copies_guard BEFORE INSERT ON document_copies
    FOR EACH ROW EXECUTE FUNCTION document_copy_guard();
CREATE TRIGGER document_copies_no_edit BEFORE UPDATE OR DELETE ON document_copies
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------- leaks can now be about a paper OR a document ----------
ALTER TABLE leak_reports ALTER COLUMN paper_id DROP NOT NULL;
ALTER TABLE leak_reports
    ADD COLUMN document_id uuid REFERENCES documents(id),
    ADD COLUMN matched_document_copy_id uuid REFERENCES document_copies(id),
    ADD CONSTRAINT leak_reports_one_target CHECK ((paper_id IS NULL) <> (document_id IS NULL));
CREATE INDEX leak_reports_document_idx ON leak_reports (document_id, created_at);

-- V8. reader_copy_report — GROUP BY / HAVING: readers holding copies of several confidential documents
CREATE VIEW reader_copy_report AS
SELECT u.id AS reader_id, u.name, u.email,
       count(DISTINCT c.document_id) AS documents,
       count(*)                      AS copies,
       count(*) FILTER (WHERE lr.id IS NOT NULL) AS leaked_copies,
       max(c.issued_at)              AS last_copy
FROM document_copies c
JOIN users u ON u.id = c.reader_id
LEFT JOIN leak_reports lr ON lr.matched_document_copy_id = c.id
GROUP BY u.id
HAVING count(*) FILTER (WHERE lr.id IS NOT NULL) > 0 OR count(DISTINCT c.document_id) > 1;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sealedpaper_app') THEN
        EXECUTE 'GRANT SELECT, INSERT ON document_copies TO sealedpaper_app';
        EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON document_copies FROM sealedpaper_app';
        EXECUTE 'GRANT SELECT ON reader_copy_report TO sealedpaper_app';
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'DCL skipped: %', SQLERRM;
END $$;
