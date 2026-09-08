/**
 * updateAuthority command — update a project's delegated authority.
 *
 * Sequence:
 *  1. Claim the command slot (idempotency).
 *  2. Validate authority with AuthoritySchema.
 *  3. Load current project; version must increase.
 *  4. In a transaction:
 *     a. Update projects.authority and projects.authority_version.
 *     b. Append to authority_versions (project_id, version, authority, actor, at).
 *     c. Insert a decision row of kind "authority_update".
 *  5. completeCommand.
 *
 * INVARIANTS:
 *  - AuthoritySchema validation required (contracts package).
 *  - Version must strictly increase (numerical comparison of version strings).
 *  - Frozen contract rows (step_contracts) are NEVER modified (R-017/R-018).
 *  - A decision of kind "authority_update" is written for the audit trail.
 *
 * NOTE: This module writes directly to authority_versions because the
 * packages/db repos for this table are being added in a parallel packet.
 * Swap to @agencyhq/db insertAuthorityVersion when the merge packet lands.
 */

import { randomUUID } from "node:crypto";
import type { Authority } from "@agencyhq/contracts";
import { AuthoritySchema } from "@agencyhq/contracts";
import { claimCommand, completeCommand } from "@agencyhq/db";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateAuthorityDeps = {
  pool: pg.Pool;
};

export type UpdateAuthorityInput = {
  commandId: string;
  projectId: string;
  authority: unknown;
  actor: string;
};

export type UpdateAuthorityResult =
  | { ok: true; version: string; replayed?: boolean }
  | {
      ok: false;
      reason: "validation_failed" | "version_not_increasing" | "project_not_found";
      replayed?: boolean;
    };

// ---------------------------------------------------------------------------
// updateAuthority
// ---------------------------------------------------------------------------

export async function updateAuthority(
  deps: UpdateAuthorityDeps,
  input: UpdateAuthorityInput,
): Promise<UpdateAuthorityResult> {
  const { commandId, projectId, authority: rawAuthority, actor } = input;
  const client = await deps.pool.connect();

  try {
    // 1. Claim command slot (idempotency)
    const claim = await claimCommand(client, commandId, "update_authority");
    if (!claim.claimed) {
      const stored = claim.result as UpdateAuthorityResult;
      return { ...stored, replayed: true };
    }

    // 2. Validate authority with AuthoritySchema
    const parsed = AuthoritySchema.safeParse(rawAuthority);
    if (!parsed.success) {
      const result: UpdateAuthorityResult = { ok: false, reason: "validation_failed" };
      await completeCommand(client, commandId, result);
      return result;
    }
    const authority: Authority = parsed.data;

    // 3. Load current project — check version must increase
    const { rows: projectRows } = await client.query<{
      id: string;
      authority_version: string;
    }>(`SELECT id, authority_version FROM projects WHERE id = $1`, [projectId]);

    if (projectRows.length === 0) {
      const result: UpdateAuthorityResult = { ok: false, reason: "project_not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const currentVersionStr = projectRows[0]?.authority_version ?? "0";
    const currentVersionNum = Number(currentVersionStr);
    const newVersionStr = authority.version;
    const newVersionNum = Number(newVersionStr);

    if (Number.isNaN(newVersionNum) || newVersionNum <= currentVersionNum) {
      const result: UpdateAuthorityResult = { ok: false, reason: "version_not_increasing" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const now = new Date();
    const decisionId = randomUUID();

    // 4. Transaction: update project + insert authority_versions + insert decision
    await client.query("BEGIN");
    try {
      // a. Update project authority
      await client.query(
        `UPDATE projects SET authority = $1::jsonb, authority_version = $2, updated_at = now()
         WHERE id = $3`,
        [JSON.stringify(authority), newVersionStr, projectId],
      );

      // b. Append to authority_versions table (added in migration 0004)
      //    Swap to insertAuthorityVersion from @agencyhq/db when merge packet lands.
      await client.query(
        `INSERT INTO authority_versions (project_id, version, authority, actor, at)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (project_id, version) DO UPDATE
           SET authority = excluded.authority, actor = excluded.actor, at = excluded.at`,
        [projectId, newVersionStr, JSON.stringify(authority), actor, now],
      );

      // c. Insert a decision row for the audit trail
      await client.query(
        `INSERT INTO decisions
           (id, kind, actor, authority_version, work_item_id, command_id, outcome, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          decisionId,
          "authority_update",
          actor,
          newVersionStr,
          null, // no specific work item
          commandId,
          "approved",
          now,
        ],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const result: UpdateAuthorityResult = { ok: true, version: newVersionStr };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
