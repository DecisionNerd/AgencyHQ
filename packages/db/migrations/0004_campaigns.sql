-- Migration 0004: Campaigns, authority versions, and work-item rank/campaign fields.
--
-- Adds:
--   campaigns      — grouping of WorkItems with a declared main effort
--   authority_versions — append-only log of delegated-authority schema versions per project
--   work_items.campaign_id — nullable FK to campaigns
--
-- All CREATE TABLE / ALTER TABLE statements are idempotent (IF NOT EXISTS /
-- DO $$ … IF NOT EXISTS checks). No data is backfilled; existing rows keep
-- campaign_id null.
--
-- decisions.kind is free text (no CHECK constraint exists or is added here).
-- The values authority_update, reject, and invalidate are now produced by the
-- coordinator; they insert successfully because the column has no enumerated
-- constraint.

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campaigns (
  id                      text primary key,
  name                    text not null,
  main_effort_work_item_id text null references work_items(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- work_items: add campaign_id
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'work_items'
      AND column_name  = 'campaign_id'
  ) THEN
    ALTER TABLE work_items ADD COLUMN campaign_id text references campaigns(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS work_items_campaign_id_idx ON work_items (campaign_id);

-- ---------------------------------------------------------------------------
-- authority_versions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS authority_versions (
  project_id text        not null references projects(id),
  version    text        not null,
  authority  jsonb       not null,
  actor      text        not null,
  at         timestamptz not null default now(),
  primary key (project_id, version)
);

CREATE INDEX IF NOT EXISTS authority_versions_project_id_idx ON authority_versions (project_id);
