-- =====================================================================
-- DCL: a least-privilege role for the API.
-- In production, connect the API as a login user that is a member of
-- sealedpaper_app (see README), NOT as the table owner — the owner skips GRANTs.
-- Skipped quietly if the current user may not create roles.
-- =====================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sealedpaper_app') THEN
        CREATE ROLE sealedpaper_app NOLOGIN;
    END IF;

    EXECUTE 'GRANT USAGE ON SCHEMA public TO sealedpaper_app';

    -- normal tables: full DML
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON
                 users, sessions, face_templates, face_challenges, documents, document_blobs,
                 key_shares, document_recipients, pending_shares
             TO sealedpaper_app';

    -- evidence tables: may only grow
    EXECUTE 'GRANT SELECT, INSERT ON audit_log, share_submissions, face_checks, releases, downloads
             TO sealedpaper_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, share_submissions, face_checks, releases, downloads
             FROM sealedpaper_app';

    EXECUTE 'GRANT SELECT ON unlock_status, suspicious_key_attempts, face_failure_report TO sealedpaper_app';
    EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO sealedpaper_app';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO sealedpaper_app';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'DCL skipped (no permission to manage roles here): %', SQLERRM;
END $$;
