-- Migration 0003: Revision manifests and integrations.
-- Adds work_item_projects (revision manifest per project in a WorkItem),
-- integrations (compare-and-set integration ledger), and nullable target_ref /
-- manifest_digest columns on step_contracts.
--
-- All CREATE TABLE / ALTER TABLE statements are idempotent (IF NOT EXISTS /
-- DO $$ … IF EXISTS checks).

-- ---------------------------------------------------------------------------
-- work_item_projects
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS work_item_projects (
  work_item_id           text    not null references work_items(id),
  project_id             text    not null references projects(id),
  position               int     not null,
  target_ref             text    not null,
  expected_base_revision text    not null,
  result_revision        text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (work_item_id, position),
  unique (work_item_id, project_id)
);

CREATE INDEX IF NOT EXISTS work_item_projects_work_item_id_idx
  ON work_item_projects (work_item_id);

-- ---------------------------------------------------------------------------
-- integrations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integrations (
  id                     text primary key,
  attempt_id             text not null references attempts(id),
  contract_id            text not null references step_contracts(id),
  contract_version       int  not null,
  target_ref             text not null,
  expected_base_revision text not null,
  resulting_revision     text,
  outcome                text,
  run_id                 text,
  at                     timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (attempt_id, target_ref, expected_base_revision)
);

CREATE INDEX IF NOT EXISTS integrations_attempt_id_idx
  ON integrations (attempt_id);

-- ---------------------------------------------------------------------------
-- step_contracts: add nullable target_ref and manifest_digest columns
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'step_contracts'
      AND column_name  = 'target_ref'
  ) THEN
    ALTER TABLE step_contracts ADD COLUMN target_ref text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'step_contracts'
      AND column_name  = 'manifest_digest'
  ) THEN
    ALTER TABLE step_contracts ADD COLUMN manifest_digest text;
  END IF;
END $$;
