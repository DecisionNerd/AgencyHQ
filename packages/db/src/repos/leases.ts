/**
 * Repository for the leases table (0008_container_runtime).
 *
 * Leases are time-bounded credential grants issued to worker containers.
 * Each lease is scoped to a specific (attempt_id, generation, purpose, nonce_hash).
 */

import type pg from "pg";
import type { LeaseRow } from "../rows.ts";
import { LeaseRowSchema } from "../rows.ts";

export interface LeaseInsert {
  id: string;
  attempt_id: string;
  generation: number;
  run_id: string;
  purpose: "provider" | "git-read" | "integrate" | "upload";
  /** SHA-256 hex hash of the raw nonce — the nonce value itself is not stored. */
  nonce_hash: string;
  expires_at: Date;
}

/** Issue (insert) a new lease. Returns the parsed row. */
export async function issueLease(client: pg.PoolClient, row: LeaseInsert): Promise<LeaseRow> {
  const { rows } = await client.query<LeaseRow>(
    `INSERT INTO leases
       (id, attempt_id, generation, run_id, purpose, nonce_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      row.id,
      row.attempt_id,
      row.generation,
      row.run_id,
      row.purpose,
      row.nonce_hash,
      row.expires_at,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("issueLease: no row returned");
  return LeaseRowSchema.parse(first);
}

/** Find leases for an attempt + generation. Returns all matching rows. */
export async function findLeasesByAttemptGeneration(
  client: pg.PoolClient,
  attemptId: string,
  generation: number,
): Promise<LeaseRow[]> {
  const { rows } = await client.query<LeaseRow>(
    `SELECT * FROM leases WHERE attempt_id = $1 AND generation = $2 ORDER BY issued_at`,
    [attemptId, generation],
  );
  return rows.map((r) => LeaseRowSchema.parse(r));
}

/** Mark a lease as used (set used_at = now). Returns updated row or null if not found. */
export async function markLeaseUsed(
  client: pg.PoolClient,
  leaseId: string,
): Promise<LeaseRow | null> {
  const { rows } = await client.query<LeaseRow>(
    `UPDATE leases SET used_at = now() WHERE id = $1 RETURNING *`,
    [leaseId],
  );
  const first = rows[0];
  if (!first) return null;
  return LeaseRowSchema.parse(first);
}

/**
 * Revoke all leases for an attempt with generation < the given generation.
 * Called when a new generation starts; older leases should no longer be usable.
 * Returns the count of revoked rows.
 */
export async function revokeLeasesBelowGeneration(
  client: pg.PoolClient,
  attemptId: string,
  generation: number,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE leases
     SET revoked_at = now()
     WHERE attempt_id = $1
       AND generation < $2
       AND revoked_at IS NULL`,
    [attemptId, generation],
  );
  return rowCount ?? 0;
}

/**
 * Revoke expired leases (expires_at < now). Returns the count of revoked rows.
 * @param before - Timestamp to compare against; defaults to now() if not provided.
 */
export async function revokeExpiredLeases(client: pg.PoolClient, before?: Date): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE leases
     SET revoked_at = now()
     WHERE expires_at < $1
       AND revoked_at IS NULL`,
    [before ?? new Date()],
  );
  return rowCount ?? 0;
}
