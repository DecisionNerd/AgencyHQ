/**
 * Repository for the reviews table.
 */

import type pg from "pg";
import type { ReviewRow } from "../rows.ts";
import { ReviewRowSchema } from "../rows.ts";

export interface ReviewInsert {
  id: string;
  attempt_id: string;
  attempt_revision?: string | null;
  diff_digest?: string | null;
  criteria_digest?: string | null;
  profile_digest?: string | null;
  reviewer_model: string;
  profile: string;
  findings: unknown;
}

/** Insert a review row. Returns the parsed row. */
export async function insertReview(client: pg.PoolClient, row: ReviewInsert): Promise<ReviewRow> {
  const { rows } = await client.query<ReviewRow>(
    `INSERT INTO reviews
       (id, attempt_id, attempt_revision, diff_digest, criteria_digest,
        profile_digest, reviewer_model, profile, findings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING *`,
    [
      row.id,
      row.attempt_id,
      row.attempt_revision ?? null,
      row.diff_digest ?? null,
      row.criteria_digest ?? null,
      row.profile_digest ?? null,
      row.reviewer_model,
      row.profile,
      JSON.stringify(row.findings),
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertReview: no row returned");
  return ReviewRowSchema.parse(first);
}

/** Get a review by id. Returns null if not found. */
export async function getReview(client: pg.PoolClient, id: string): Promise<ReviewRow | null> {
  const { rows } = await client.query<ReviewRow>("SELECT * FROM reviews WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return ReviewRowSchema.parse(first);
}

/** List reviews for an attempt. */
export async function listReviewsByAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<ReviewRow[]> {
  const { rows } = await client.query<ReviewRow>(
    "SELECT * FROM reviews WHERE attempt_id = $1 ORDER BY created_at",
    [attemptId],
  );
  return rows.map((r) => ReviewRowSchema.parse(r));
}
