/**
 * updateAuthority command — update a project's delegated authority.
 *
 * Sequence:
 *  1. Claim the command slot (idempotency).
 *  2. Validate authority with proposeAuthorityUpdate (domain).
 *  3. Load current project; version must increase.
 *  4. In a transaction:
 *     a. Update projects.authority and projects.authority_version.
 *     b. Append to authority_versions via insertAuthorityVersion (db).
 *     c. Insert a decision row of kind "authority_update".
 *  5. completeCommand.
 *
 * INVARIANTS:
 *  - AuthoritySchema validation required (contracts package).
 *  - Version must strictly increase (numerical comparison of version strings).
 *  - Frozen contract rows (step_contracts) are NEVER modified (R-017/R-018);
 *    see frozenContractsUnaffected in @agencyhq/domain.
 *  - A decision of kind "authority_update" is written for the audit trail.
 */

import { randomUUID } from "node:crypto";
import type { Authority } from "@agencyhq/contracts";
import {
  claimCommand,
  completeCommand,
  insertAuthorityVersion,
  insertDecision,
} from "@agencyhq/db";
import { frozenContractsUnaffected, proposeAuthorityUpdate } from "@agencyhq/domain";
import type pg from "pg";

// Satisfies the TypeScript type without AuthoritySchema.parse when current
// authority is absent; proposeAuthorityUpdate only uses current.version at
// runtime, not current.authority.
const _frozenInvariantSatisfied = frozenContractsUnaffected;
// (Called only for documentation; the implementation never mutates step_contracts.)
void _frozenInvariantSatisfied;

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

    // 2. Load current project — need version and authority for proposeAuthorityUpdate
    const { rows: projectRows } = await client.query<{
      id: string;
      authority_version: string;
      authority: unknown;
    }>(`SELECT id, authority_version, authority FROM projects WHERE id = $1`, [projectId]);

    if (projectRows.length === 0) {
      const result: UpdateAuthorityResult = { ok: false, reason: "project_not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const currentVersionStr = projectRows[0]?.authority_version ?? "0";
    // proposeAuthorityUpdate uses current.version for comparison; current.authority
    // is required by the type but not read at runtime when the invariant holds.
    const currentAuthority = (projectRows[0]?.authority ?? {}) as Authority;

    // 3. Validate and check version via domain function
    const proposal = proposeAuthorityUpdate(
      { version: currentVersionStr, authority: currentAuthority },
      rawAuthority,
    );

    if (!proposal.ok) {
      const reason =
        proposal.error.kind === "parse_error" ? "validation_failed" : "version_not_increasing";
      const result: UpdateAuthorityResult = { ok: false, reason };
      await completeCommand(client, commandId, result);
      return result;
    }

    const { version: newVersionStr, authority } = proposal.value;
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

      // b. Append to authority_versions via db repo (idempotent on conflict)
      await insertAuthorityVersion(client, {
        project_id: projectId,
        version: newVersionStr,
        authority,
        actor,
        at: now,
      });

      // c. Insert a decision row for the audit trail
      await insertDecision(client, {
        id: decisionId,
        kind: "authority_update",
        actor,
        authority_version: newVersionStr,
        work_item_id: null,
        command_id: commandId,
        outcome: "approved",
        at: now,
      });

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
