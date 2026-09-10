-- 0008_container_runtime.sql
-- Adds tables and columns for portable container execution (P18.1, epic #14).
-- Idempotent: ADD COLUMN IF NOT EXISTS; CREATE TABLE IF NOT EXISTS.

-- source_mode indicates whether this project's source is served via the
-- coordinator bundle API ('mirror') or the legacy host-clone path ('host_clone').
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_mode text NOT NULL DEFAULT 'host_clone';

-- Enforce the two-value set. The CHECK constraint is not IF NOT EXISTS in standard SQL;
-- we use a DO block to add it idempotently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'projects' AND constraint_name = 'projects_source_mode_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_source_mode_check
      CHECK (source_mode IN ('host_clone', 'mirror'));
  END IF;
END$$;

-- leases: time-bounded credential grants issued to worker containers.
-- Each lease is scoped to a specific attempt + generation + purpose + nonce.
-- nonce_hash stores a hash of the worker nonce (the raw nonce is never persisted).
CREATE TABLE IF NOT EXISTS leases (
  id           text primary key,
  attempt_id   text not null,
  generation   int not null,
  run_id       text not null,
  -- purpose in ('provider','git-read','integrate','upload')
  purpose      text not null check (purpose in ('provider', 'git-read', 'integrate', 'upload')),
  -- hashed worker nonce; unique per (attempt, generation, purpose, nonce) tuple
  nonce_hash   text not null,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  -- used_at is set when the worker materializes the credential
  used_at      timestamptz,
  -- revoked_at is set by the coordinator on generation advance or stop
  revoked_at   timestamptz,
  unique (attempt_id, generation, purpose, nonce_hash)
);

CREATE INDEX IF NOT EXISTS leases_attempt_id_idx ON leases (attempt_id);
CREATE INDEX IF NOT EXISTS leases_expires_at_idx ON leases (expires_at);

-- attempt_artifacts: bundle metadata uploaded by worker containers.
-- ON CONFLICT DO NOTHING is the contract; callers detect duplicate by rowcount.
CREATE TABLE IF NOT EXISTS attempt_artifacts (
  id               text primary key,
  attempt_id       text not null references attempts(id),
  generation       int not null,
  -- kind in ('attempt','checkpoint')
  kind             text not null check (kind in ('attempt', 'checkpoint')),
  commit_id        text not null,
  diff_digest      text not null,
  changed_paths    jsonb not null,
  quarantine_patch text,
  bundle_sha256    text not null,
  bundle_bytes     bigint not null,
  verified         boolean not null default false,
  received_at      timestamptz not null default now(),
  unique (attempt_id, generation, kind, commit_id)
);

CREATE INDEX IF NOT EXISTS attempt_artifacts_attempt_id_idx ON attempt_artifacts (attempt_id);

-- attempt_stop_evidence: stop-sequence evidence uploaded on graceful worker shutdown.
-- Upserted idempotently by (attempt_id, generation); later uploads overwrite steps.
CREATE TABLE IF NOT EXISTS attempt_stop_evidence (
  id          text primary key,
  attempt_id  text not null references attempts(id),
  generation  int not null,
  -- JSON array of step objects: { at, step, detail? }
  steps       jsonb not null,
  received_at timestamptz not null default now(),
  unique (attempt_id, generation)
);

CREATE INDEX IF NOT EXISTS attempt_stop_evidence_attempt_id_idx ON attempt_stop_evidence (attempt_id);

-- project_credentials: AES-256-GCM encrypted credentials for git operations.
-- purpose in ('git-read','integrate'); ciphertext/iv/tag are raw bytes.
CREATE TABLE IF NOT EXISTS project_credentials (
  project_id   text not null references projects(id),
  purpose      text not null check (purpose in ('git-read', 'integrate')),
  ciphertext   bytea not null,
  iv           bytea not null,
  tag          bytea not null,
  key_version  int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (project_id, purpose)
);
