-- 0006_capacity_metrics.sql
-- Adds provider_capacity table and lead_metrics view (Slice 6).
-- Idempotent: CREATE TABLE IF NOT EXISTS; CREATE OR REPLACE VIEW.

-- ---------------------------------------------------------------------------
-- provider_capacity
-- Records adapter- or operator-reported capacity observations per
-- (provider, model, observed_at). Each observation is immutable; stale
-- handling is computed by the domain from valid_until.
--
-- status:  ok | limited | down
-- source:  adapter (machine-reported) | operator (human override)
-- run_id:  trigger run that produced the observation (null for operator)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_capacity (
  provider    text        not null,
  model       text        not null,
  status      text        not null check (status in ('ok', 'limited', 'down')),
  observed_at timestamptz not null,
  valid_until timestamptz not null,
  source      text        not null check (source in ('adapter', 'operator')),
  run_id      text,
  primary key (provider, model, observed_at)
);

-- Supports latestCapacity and listCurrentCapacity queries efficiently.
CREATE INDEX IF NOT EXISTS provider_capacity_provider_model_valid_until_idx
  ON provider_capacity (provider, model, valid_until desc);

-- ---------------------------------------------------------------------------
-- lead_metrics view
-- Per-project quality metrics aggregated over the full ledger.
-- Parameterised queries (with a `since` cut-off) are implemented in
-- repos/metrics.ts using CTEs; this view covers the unfiltered case and
-- serves as the canonical SQL definition for documentation purposes.
--
-- Metric definitions
--   plans_total        : decisions with kind='plan' linked to the project
--   plans_escalated    : plan decisions with outcome='pending_human'
--   escalation_rate    : plans_escalated / plans_total   (null when 0 plans)
--   acceptances        : decisions kind='accept', outcome IN ('accepted','approved')
--   invalidations      : decisions kind='invalidate' linked to the project
--   reversal_rate      : invalidations / acceptances     (null when 0 acceptances)
--   reviews_total      : review rows linked via attempt→step_contract→project
--   reviews_with_findings : reviews where findings JSONB array is non-empty
--   review_yield       : reviews_with_findings / reviews_total  (null when 0 reviews)
--   findings_by_disposition : JSONB {disposition → count} for all findings
--   integrations_by_outcome : JSONB {outcome → count}    for all integrations
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW lead_metrics AS
WITH decision_metrics AS (
  SELECT
    wi.project_id,
    COUNT(*) FILTER (WHERE d.kind = 'plan')                                             AS plans_total,
    COUNT(*) FILTER (WHERE d.kind = 'plan'   AND d.outcome = 'pending_human')           AS plans_escalated,
    COUNT(*) FILTER (WHERE d.kind = 'accept' AND d.outcome IN ('accepted', 'approved')) AS acceptances,
    COUNT(*) FILTER (WHERE d.kind = 'invalidate')                                       AS invalidations
  FROM decisions d
  JOIN work_items wi ON wi.id = d.work_item_id
  GROUP BY wi.project_id
),
review_metrics AS (
  SELECT
    sc.project_id,
    COUNT(*)                                                          AS reviews_total,
    COUNT(*) FILTER (WHERE jsonb_array_length(r.findings) > 0)       AS reviews_with_findings
  FROM reviews r
  JOIN attempts     a  ON a.id  = r.attempt_id
  JOIN step_contracts sc ON sc.id = a.contract_id
  GROUP BY sc.project_id
),
finding_disp AS (
  SELECT
    sc.project_id,
    COALESCE(f.disposition, 'unset') AS disposition,
    COUNT(*)                         AS cnt
  FROM findings f
  JOIN attempts     a  ON a.id  = f.attempt_id
  JOIN step_contracts sc ON sc.id = a.contract_id
  GROUP BY sc.project_id, COALESCE(f.disposition, 'unset')
),
finding_metrics AS (
  SELECT project_id, jsonb_object_agg(disposition, cnt) AS findings_by_disposition
  FROM finding_disp
  GROUP BY project_id
),
integration_outcome AS (
  SELECT
    sc.project_id,
    COALESCE(i.outcome, 'unknown') AS outcome,
    COUNT(*)                       AS cnt
  FROM integrations i
  JOIN attempts     a  ON a.id  = i.attempt_id
  JOIN step_contracts sc ON sc.id = a.contract_id
  GROUP BY sc.project_id, COALESCE(i.outcome, 'unknown')
),
integration_metrics AS (
  SELECT project_id, jsonb_object_agg(outcome, cnt) AS integrations_by_outcome
  FROM integration_outcome
  GROUP BY project_id
)
SELECT
  p.id                                               AS project_id,
  COALESCE(dm.plans_total,    0)                     AS plans_total,
  COALESCE(dm.plans_escalated, 0)                    AS plans_escalated,
  CASE WHEN COALESCE(dm.plans_total, 0) = 0 THEN NULL
       ELSE dm.plans_escalated::float / dm.plans_total
  END                                                AS escalation_rate,
  COALESCE(dm.acceptances,   0)                      AS acceptances,
  COALESCE(dm.invalidations, 0)                      AS invalidations,
  CASE WHEN COALESCE(dm.acceptances, 0) = 0 THEN NULL
       ELSE dm.invalidations::float / dm.acceptances
  END                                                AS reversal_rate,
  COALESCE(rm.reviews_total, 0)                      AS reviews_total,
  COALESCE(rm.reviews_with_findings, 0)              AS reviews_with_findings,
  CASE WHEN COALESCE(rm.reviews_total, 0) = 0 THEN NULL
       ELSE rm.reviews_with_findings::float / rm.reviews_total
  END                                                AS review_yield,
  COALESCE(fm.findings_by_disposition, '{}'::jsonb)  AS findings_by_disposition,
  COALESCE(im.integrations_by_outcome, '{}'::jsonb)  AS integrations_by_outcome
FROM projects p
LEFT JOIN decision_metrics    dm ON dm.project_id = p.id
LEFT JOIN review_metrics      rm ON rm.project_id = p.id
LEFT JOIN finding_metrics     fm ON fm.project_id = p.id
LEFT JOIN integration_metrics im ON im.project_id = p.id
ORDER BY p.id;
