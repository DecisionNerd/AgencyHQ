-- Migration 0001: Ledger schema
-- All tables use id text primary key unless noted otherwise.

-- Projects: linked Git repositories with authority schema
CREATE TABLE IF NOT EXISTS projects (
  id              text primary key,
  remote          text,
  clone_path      text,
  worktree_base   text,
  allowed_refs    jsonb,
  profile_catalog jsonb,
  authority       jsonb not null,
  authority_version text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- WorkItems: ranked, scoped units of intended change
CREATE TABLE IF NOT EXISTS work_items (
  id           text primary key,
  project_id   text not null references projects(id),
  rank         int not null,
  intent       text not null,
  defect       text,
  boundary     text not null check (boundary in ('artifact', 'merge', 'deploy')),
  lifecycle    text not null,
  condition    text not null,
  main_effort  boolean not null default false,
  version      int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS work_items_project_id_rank_idx ON work_items (project_id, rank);

-- StepContracts: immutable versioned execution contracts
CREATE TABLE IF NOT EXISTS step_contracts (
  id                  text primary key,
  work_item_id        text not null references work_items(id),
  project_id          text not null references projects(id),
  version             int not null,
  base_revision       text not null,
  inputs              jsonb not null,
  criteria            jsonb not null,
  criteria_digest     text not null,
  profile_id          text not null,
  profile_digest      text not null,
  bounds              jsonb not null,
  required_boundaries jsonb not null,
  human_required      boolean not null,
  status              text not null,
  superseded_by       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (work_item_id, version)
);

CREATE INDEX IF NOT EXISTS step_contracts_work_item_id_idx ON step_contracts (work_item_id);
CREATE INDEX IF NOT EXISTS step_contracts_project_id_idx ON step_contracts (project_id);

-- Attempts: one execution of a StepContract
CREATE TABLE IF NOT EXISTS attempts (
  id                text primary key,
  contract_id       text not null references step_contracts(id),
  contract_version  int not null,
  generation        int not null default 1,
  status            text not null,
  run_id            text,
  worktree_path     text,
  session_id        text,
  commit_sha        text,
  diff_digest       text,
  checkpoint_commit text,
  failure_id        text,
  budget_remaining  int not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS attempts_contract_id_idx ON attempts (contract_id);
CREATE INDEX IF NOT EXISTS attempts_run_id_idx ON attempts (run_id);

-- DispatchIntents: coordinator-recorded intent to trigger a task
CREATE TABLE IF NOT EXISTS dispatch_intents (
  id              text primary key,
  task            text not null,
  payload_digest  text not null,
  attempt_id      text references attempts(id),
  status          text not null,
  run_id          text,
  idempotency_key text not null unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS dispatch_intents_attempt_id_idx ON dispatch_intents (attempt_id);

-- Artifacts: content-addressed outputs
CREATE TABLE IF NOT EXISTS artifacts (
  id            text primary key,
  attempt_id    text not null references attempts(id),
  revision      text not null,
  diff_digest   text not null,
  changed_paths jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS artifacts_attempt_id_idx ON artifacts (attempt_id);

-- VerificationResults: results of approved checks
CREATE TABLE IF NOT EXISTS verification_results (
  id               text primary key,
  attempt_id       text not null references attempts(id),
  step_contract_id text not null references step_contracts(id),
  record           jsonb not null,
  result           text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS verification_results_attempt_id_idx ON verification_results (attempt_id);
CREATE INDEX IF NOT EXISTS verification_results_step_contract_id_idx ON verification_results (step_contract_id);

-- Reviews: adversarial review evidence
CREATE TABLE IF NOT EXISTS reviews (
  id              text primary key,
  attempt_id      text not null references attempts(id),
  attempt_revision text,
  diff_digest     text,
  criteria_digest text,
  profile_digest  text,
  reviewer_model  text,
  profile         text,
  findings        jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS reviews_attempt_id_idx ON reviews (attempt_id);

-- Decisions: immutable, versioned Lead or human decisions
CREATE TABLE IF NOT EXISTS decisions (
  id                text primary key,
  kind              text,
  actor             text,
  proposal_digest   text,
  authority_version text,
  work_item_id      text references work_items(id),
  contract_id       text,
  contract_version  int,
  attempt_id        text,
  causation_id      text,
  command_id        text,
  outcome           text,
  at                timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS decisions_work_item_id_idx ON decisions (work_item_id);
CREATE INDEX IF NOT EXISTS decisions_attempt_id_idx ON decisions (attempt_id);

-- Approvals: human decisions over exact subject versions
CREATE TABLE IF NOT EXISTS approvals (
  id               text primary key,
  decision_id      text not null references decisions(id),
  contract_id      text references step_contracts(id),
  contract_version int,
  attempt_revision text,
  human_actor      text,
  at               timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS approvals_decision_id_idx ON approvals (decision_id);
CREATE INDEX IF NOT EXISTS approvals_contract_id_idx ON approvals (contract_id);

-- Findings: evidence-backed observations from any task
CREATE TABLE IF NOT EXISTS findings (
  id          text primary key,
  attempt_id  text,
  severity    text,
  kind        text,
  description text,
  evidence    text,
  disposition text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS findings_attempt_id_idx ON findings (attempt_id);

-- Failures: failure records
CREATE TABLE IF NOT EXISTS failures (
  id         text primary key,
  class      text,
  phase      text,
  attempt_id text,
  run_id     text,
  cause      text,
  evidence   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS failures_attempt_id_idx ON failures (attempt_id);

-- Transitions: append-only audit log of state transitions
CREATE TABLE IF NOT EXISTS transitions (
  id           bigserial primary key,
  aggregate    text,
  aggregate_id text,
  from_state   text,
  to_state     text,
  actor        text,
  causation_id text,
  command_id   text,
  at           timestamptz default now()
);

CREATE INDEX IF NOT EXISTS transitions_aggregate_idx ON transitions (aggregate, aggregate_id);

-- Commands: idempotency table for operator commands
CREATE TABLE IF NOT EXISTS commands (
  command_id text primary key,
  kind       text,
  result     jsonb,
  at         timestamptz,
  created_at timestamptz not null default now()
);

-- RunObservations: Trigger run observations with dedupe identity (run_id + generation)
CREATE TABLE IF NOT EXISTS run_observations (
  run_id      text not null,
  generation  int not null,
  stale       boolean not null,
  payload     jsonb not null,
  observed_at timestamptz,
  primary key (run_id, generation)
);
