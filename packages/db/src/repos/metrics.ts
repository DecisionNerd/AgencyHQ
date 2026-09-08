/**
 * Repository for Lead quality metrics.
 *
 * leadMetrics returns per-project quality metrics aggregated from the ledger.
 * An optional `since` date restricts all counts to rows created on or after
 * that timestamp; omitting it (or passing null) covers the full history.
 *
 * Metric definitions
 * ------------------
 * plans_total          : decisions with kind='plan' linked to the project
 * plans_escalated      : plan decisions with outcome='pending_human'
 * escalation_rate      : plans_escalated / plans_total   (null when plans_total = 0)
 * acceptances          : decisions kind='accept', outcome IN ('accepted','approved')
 * invalidations        : decisions kind='invalidate' linked to the project
 * reversal_rate        : invalidations / acceptances     (null when acceptances = 0)
 * reviews_total        : review rows linked via attempt→step_contract→project
 * reviews_with_findings: reviews where the findings JSONB array is non-empty
 * review_yield         : reviews_with_findings / reviews_total (null when reviews_total = 0)
 * findings_by_disposition: {disposition → count} for all findings rows
 * integrations_by_outcome: {outcome → count}    for all integration rows
 */

import type pg from "pg";
import { z } from "zod";

const ProjectMetricsRowSchema = z.object({
  project_id: z.string(),
  plans_total: z.coerce.number().int(),
  plans_escalated: z.coerce.number().int(),
  escalation_rate: z.number().nullable(),
  acceptances: z.coerce.number().int(),
  invalidations: z.coerce.number().int(),
  reversal_rate: z.number().nullable(),
  reviews_total: z.coerce.number().int(),
  reviews_with_findings: z.coerce.number().int(),
  review_yield: z.number().nullable(),
  findings_by_disposition: z.record(z.string(), z.number()),
  integrations_by_outcome: z.record(z.string(), z.number()),
});

export type ProjectMetricsRow = z.infer<typeof ProjectMetricsRowSchema>;

/**
 * Return per-project Lead quality metrics.
 *
 * @param client - Postgres pool client
 * @param opts.since - optional lower bound (inclusive) for created_at filtering
 */
export async function leadMetrics(
  client: pg.PoolClient,
  opts: { since?: Date | null } = {},
): Promise<ProjectMetricsRow[]> {
  const since = opts.since ?? null;

  // All counts are filtered by created_at >= since when since is not null.
  // The $1 parameter is passed as a timestamptz; IS NULL handles the "all time" case.
  const sql = `
    WITH decision_metrics AS (
      SELECT
        wi.project_id,
        COUNT(*) FILTER (WHERE d.kind = 'plan')                                             AS plans_total,
        COUNT(*) FILTER (WHERE d.kind = 'plan'   AND d.outcome = 'pending_human')           AS plans_escalated,
        COUNT(*) FILTER (WHERE d.kind = 'accept' AND d.outcome IN ('accepted', 'approved')) AS acceptances,
        COUNT(*) FILTER (WHERE d.kind = 'invalidate')                                       AS invalidations
      FROM decisions d
      JOIN work_items wi ON wi.id = d.work_item_id
      WHERE ($1::timestamptz IS NULL OR d.created_at >= $1)
      GROUP BY wi.project_id
    ),
    review_metrics AS (
      SELECT
        sc.project_id,
        COUNT(*)                                                    AS reviews_total,
        COUNT(*) FILTER (WHERE jsonb_array_length(r.findings) > 0) AS reviews_with_findings
      FROM reviews r
      JOIN attempts       a  ON a.id  = r.attempt_id
      JOIN step_contracts sc ON sc.id = a.contract_id
      WHERE ($1::timestamptz IS NULL OR r.created_at >= $1)
      GROUP BY sc.project_id
    ),
    finding_disp AS (
      SELECT
        sc.project_id,
        COALESCE(f.disposition, 'unset') AS disposition,
        COUNT(*)                         AS cnt
      FROM findings f
      JOIN attempts       a  ON a.id  = f.attempt_id
      JOIN step_contracts sc ON sc.id = a.contract_id
      WHERE ($1::timestamptz IS NULL OR f.created_at >= $1)
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
      JOIN attempts       a  ON a.id  = i.attempt_id
      JOIN step_contracts sc ON sc.id = a.contract_id
      WHERE ($1::timestamptz IS NULL OR i.created_at >= $1)
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
    ORDER BY p.id
  `;

  const { rows } = await client.query(sql, [since]);
  return rows.map((r) => ProjectMetricsRowSchema.parse(r));
}
