/**
 * updateAuthority command — update a project's delegated authority.
 *
 * Sequence:
 *  1. Claim the command slot (idempotency).
 *  2. BEGIN a transaction.
 *  3. SELECT ... FOR UPDATE the project row (prevents lost updates — T-9).
 *  4. Validate authority with proposeAuthorityUpdate (domain).
 *  5. UPDATE projects ... WHERE authority_version = $current (CAS).
 *     A concurrent update from the same base gets stale_version.
 *  6. If authority_versions is empty, write the initial (pre-update) version
 *     as history before appending the new version (T-13 backfill).
 *  7. Append to authority_versions via insertAuthorityVersion (db).
 *  8. Insert a decision row of kind "authority_update".
 *  9. COMMIT.
 * 10. completeCommand.
 *
 * INVARIANTS:
 *  - AuthoritySchema validation required (contracts package).
 *  - Version must strictly increase (numerical comparison of version strings).
 *  - Frozen contract rows (step_contracts) are NEVER modified (R-017/R-018).
 *    This command only touches: projects, authority_versions, decisions, commands.
 *    It never SELECT-s, UPDATE-s, INSERT-s, or DELETE-s step_contracts rows.
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
import { proposeAuthorityUpdate } from "@agencyhq/domain";
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
      reason:
        | "validation_failed"
        | "version_not_increasing"
        | "project_not_found"
        | "stale_version";
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

    // 2-9. All inside one transaction with FOR UPDATE row lock.
    await client.query("BEGIN");
    try {
      // 3. SELECT FOR UPDATE — acquires row lock to prevent lost updates (T-9).
      const { rows: projectRows } = await client.query<{
        id: string;
        authority_version: string;
        authority: unknown;
      }>(`SELECT id, authority_version, authority FROM projects WHERE id = $1 FOR UPDATE`, [
        projectId,
      ]);

      if (projectRows.length === 0) {
        await client.query("ROLLBACK");
        const result: UpdateAuthorityResult = { ok: false, reason: "project_not_found" };
        await completeCommand(client, commandId, result);
        return result;
      }

      const currentVersionStr = projectRows[0]?.authority_version ?? "0";
      // proposeAuthorityUpdate uses current.version; current.authority satisfies the type.
      const currentAuthority = (projectRows[0]?.authority ?? {}) as Authority;

      // 4. Validate and check version via domain function
      const proposal = proposeAuthorityUpdate(
        { version: currentVersionStr, authority: currentAuthority },
        rawAuthority,
      );

      if (!proposal.ok) {
        await client.query("ROLLBACK");
        const reason =
          proposal.error.kind === "parse_error" ? "validation_failed" : "version_not_increasing";
        const result: UpdateAuthorityResult = { ok: false, reason };
        await completeCommand(client, commandId, result);
        return result;
      }

      const { version: newVersionStr, authority } = proposal.value;
      const now = new Date();
      const decisionId = randomUUID();

      // 5. CAS update: only succeeds when the version we read is still current.
      const { rowCount } = await client.query(
        `UPDATE projects SET authority = $1::jsonb, authority_version = $2, updated_at = now()
         WHERE id = $3 AND authority_version = $4`,
        [JSON.stringify(authority), newVersionStr, projectId, currentVersionStr],
      );

      if ((rowCount ?? 0) === 0) {
        // Concurrent update won — report stale_version.
        await client.query("ROLLBACK");
        const result: UpdateAuthorityResult = { ok: false, reason: "stale_version" };
        await completeCommand(client, commandId, result);
        return result;
      }

      // 6. Backfill: if authority_versions is empty for this project, write the
      //    pre-update (initial) version as history first (T-13).
      const { rows: existingVersionRows } = await client.query<{ version: string }>(
        `SELECT version FROM authority_versions WHERE project_id = $1 LIMIT 1`,
        [projectId],
      );
      if (existingVersionRows.length === 0) {
        await insertAuthorityVersion(client, {
          project_id: projectId,
          version: currentVersionStr,
          authority: currentAuthority,
          actor,
          at: new Date(now.getTime() - 1), // just before the new version
        });
      }

      // 7. Append to authority_versions via db repo (idempotent on conflict)
      await insertAuthorityVersion(client, {
        project_id: projectId,
        version: newVersionStr,
        authority,
        actor,
        at: now,
      });

      // 8. Insert a decision row for the audit trail
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

      const result: UpdateAuthorityResult = { ok: true, version: newVersionStr };
      await completeCommand(client, commandId, result);
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}
