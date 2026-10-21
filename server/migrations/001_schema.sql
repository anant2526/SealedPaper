-- =====================================================================
-- SealedPaper — Phase 1 (document vault) schema
-- 14 tables in 3NF. Security rules live in the database itself
-- (see 002_triggers.sql), so even a buggy or hacked API cannot break them.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()

-- ---------- enum types ----------
CREATE TYPE user_role       AS ENUM ('admin', 'setter', 'custodian', 'superintendent', 'investigator');
CREATE TYPE user_status     AS ENUM ('pending', 'active', 'disabled');
CREATE TYPE face_purpose    AS ENUM ('enroll', 'login', 'unlock');
CREATE TYPE document_status AS ENUM ('sealed', 'released', 'revoked');

-- ---------- 1. users ----------
-- An account is 'pending' until the face scan AND the authenticator app are set up.
CREATE TABLE users (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
    email            text NOT NULL,
    password_hash    text NOT NULL,                 -- Argon2id
    role             user_role   NOT NULL DEFAULT 'custodian',
    status           user_status NOT NULL DEFAULT 'pending',
    totp_secret_enc  bytea,                         -- AES-GCM encrypted with the server master key
    totp_enabled     boolean NOT NULL DEFAULT false,
    totp_last_step   bigint,                        -- last accepted 30-second step: stops code replay
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_unique   UNIQUE (email),
    CONSTRAINT users_email_lower    CHECK (email = lower(email) AND email LIKE '%_@_%'),
    CONSTRAINT users_totp_has_secret CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL)
);

-- ---------- 2. sessions (refresh tokens) ----------
CREATE TABLE sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_hash  bytea NOT NULL UNIQUE,            -- SHA-256 of the token; the token itself is never stored
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    ip            inet,
    user_agent    text,
    CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------- 3. face_templates ----------
CREATE TABLE face_templates (
    user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    descriptor_enc  bytea NOT NULL,                 -- 128 floats, AES-GCM encrypted
    model           text  NOT NULL DEFAULT 'face-api faceRecognitionNet',
    enrolled_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- 4. face_challenges (one-time liveness challenges) ----------
CREATE TABLE face_challenges (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     face_purpose NOT NULL,
    poses       text[] NOT NULL,                    -- e.g. {right,straight,left}: random order every time
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    CONSTRAINT face_challenges_poses CHECK (
        cardinality(poses) = 3 AND poses @> ARRAY['straight', 'left', 'right']),
    CHECK (expires_at > created_at)
);

-- ---------- 5. face_checks (every scan, pass or fail) ----------
CREATE TABLE face_checks (
    id              bigserial PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    challenge_id    uuid REFERENCES face_challenges(id),
    purpose         face_purpose NOT NULL,
    passed          boolean NOT NULL,
    reason          text NOT NULL,
    match_distance  real,                           -- Euclidean distance to the stored template
    yaw_values      real[],                         -- head-turn value per frame
    ip              inet,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX face_checks_user_idx ON face_checks (user_id, created_at);

-- ---------- 6. documents ----------
CREATE TABLE documents (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title                  text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
    original_name          text NOT NULL,
    mime_type              text NOT NULL,
    size_bytes             integer NOT NULL CHECK (size_bytes > 0),
    threshold_k            smallint NOT NULL,
    total_shares_n         smallint NOT NULL,
    unlock_at              timestamptz NOT NULL,
    submit_window_minutes  integer NOT NULL DEFAULT 60 CHECK (submit_window_minutes BETWEEN 0 AND 10080),
    status                 document_status NOT NULL DEFAULT 'sealed',
    created_by             uuid NOT NULL REFERENCES users(id),
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT documents_threshold    CHECK (2 <= threshold_k AND threshold_k <= total_shares_n AND total_shares_n <= 20),
    CONSTRAINT documents_unlock_after CHECK (unlock_at > created_at)
);
-- Partial index: the release worker only ever scans sealed documents.
CREATE INDEX documents_due_idx ON documents (unlock_at) WHERE status = 'sealed';

-- ---------- 7. document_blobs (ciphertext only) ----------
CREATE TABLE document_blobs (
    document_id        uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    iv                 bytea NOT NULL CHECK (length(iv) = 12),
    auth_tag           bytea NOT NULL CHECK (length(auth_tag) = 16),
    ciphertext         bytea NOT NULL,
    ciphertext_sha256  bytea NOT NULL CHECK (length(ciphertext_sha256) = 32)
);

-- ---------- 8. key_shares ----------
-- One row per custodian. The share itself is NEVER kept after pickup — only its SHA-256.
CREATE TABLE key_shares (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    custodian_id  uuid NOT NULL REFERENCES users(id),
    share_index   smallint NOT NULL CHECK (share_index >= 1),
    share_hash    bytea NOT NULL CHECK (length(share_hash) = 32),
    pickup_enc    bytea,                            -- one-time copy for download; NULL once picked up
    picked_up_at  timestamptz,
    CONSTRAINT key_shares_one_per_custodian UNIQUE (document_id, custodian_id),
    CONSTRAINT key_shares_unique_index      UNIQUE (document_id, share_index),
    CONSTRAINT key_shares_pickup_state      CHECK ((pickup_enc IS NULL) = (picked_up_at IS NOT NULL))
);

-- ---------- 9. document_recipients ----------
CREATE TABLE document_recipients (
    document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id),
    PRIMARY KEY (document_id, user_id)
);

-- ---------- 10. share_submissions (every key upload attempt) ----------
CREATE TABLE share_submissions (
    id            bigserial PRIMARY KEY,
    document_id   uuid NOT NULL,
    custodian_id  uuid NOT NULL,
    accepted      boolean NOT NULL,
    reason        text NOT NULL,
    ip            inet,
    submitted_at  timestamptz NOT NULL DEFAULT now(),
    -- composite FK: only a custodian who holds a share for THIS document can appear here
    FOREIGN KEY (document_id, custodian_id) REFERENCES key_shares (document_id, custodian_id) ON DELETE CASCADE
);
CREATE INDEX share_submissions_doc_time_idx ON share_submissions (document_id, submitted_at);
CREATE INDEX share_submissions_cust_time_idx ON share_submissions (custodian_id, submitted_at);

-- ---------- 11. pending_shares (accepted, waiting for quorum) ----------
CREATE TABLE pending_shares (
    document_id   uuid NOT NULL,
    custodian_id  uuid NOT NULL,
    share_enc     bytea NOT NULL,                   -- wrapped with the master key, deleted at release
    accepted_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, custodian_id),
    FOREIGN KEY (document_id, custodian_id) REFERENCES key_shares (document_id, custodian_id) ON DELETE CASCADE
);

-- ---------- 12. releases ----------
CREATE TABLE releases (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    released_at    timestamptz NOT NULL DEFAULT now(),
    wrapped_key    bytea NOT NULL,                  -- rebuilt key, wrapped for authorised downloads
    custodian_ids  uuid[] NOT NULL,                 -- whose key files opened it
    triggered_by   text NOT NULL CHECK (triggered_by IN ('submission', 'worker')),
    CONSTRAINT releases_once UNIQUE (document_id)   -- a document can be released exactly once
);

-- ---------- 13. downloads ----------
CREATE TABLE downloads (
    id             bigserial PRIMARY KEY,
    document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id),
    ip             inet,
    downloaded_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- 14. audit_log (hash-chained, append-only) ----------
CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    actor_id    uuid REFERENCES users(id),          -- NULL = system / worker
    action      text NOT NULL,
    entity      text,
    entity_id   text,
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip          inet,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    prev_hash   text,
    row_hash    text NOT NULL
);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);
