/**
 * import_host_project command — converts a host_clone project to a git-mirror
 * project and optionally reverts it.
 *
 * import_host_project (projectId):
 *   1. Claim the command (idempotent by commandId).
 *   2. Ensure the bare mirror at <gitRoot>/mirrors/<projectId>.git exists
 *      and is populated from projects.remote.
 *   3. Re-read allowed_refs from the mirror.
 *   4. Set projects.source_mode = 'mirror'.
 *   5. CompleteCommand.
 *
 * revert_import (projectId):
 *   1. Set projects.source_mode = 'host_clone' (mirror kept on disk for re-use).
 *
 * Invariant: unresolved work items are never re-dispatched by the import.
 * The import/revert only changes the source_mode; it never touches work item
 * or attempt state.
 *
 * Both operations are idempotent (commandId-deduplicated via claimCommand).
 */

import {
  claimCommand,
  completeCommand,
  decryptSecret,
  getProject,
  getProjectCredential,
  setProjectSourceMode,
} from "@agencyhq/db";
import { ensureMirror } from "../git/mirror.ts";
import type { CommandDeps } from "./stop.ts";

// ---------------------------------------------------------------------------
// ImportDeps — extends CommandDeps with git mirror configuration
// ---------------------------------------------------------------------------

export interface ImportDeps extends CommandDeps {
  gitRoot: string;
  /** 64-hex AES-256 key for decrypting project_credentials; optional for public remotes. */
  secretsKey?: string | undefined;
}

// ---------------------------------------------------------------------------
// importHostProject
// ---------------------------------------------------------------------------

export type ImportHostProjectInput = {
  commandId: string;
  projectId: string;
};

export type ImportHostProjectResult =
  | { ok: true; sourceMode: "mirror"; replayed?: boolean }
  | {
      ok: false;
      reason: "project_not_found" | "no_remote" | "mirror_failed";
      detail?: string;
      replayed?: boolean;
    };

export async function importHostProject(
  deps: ImportDeps,
  input: ImportHostProjectInput,
): Promise<ImportHostProjectResult> {
  const { commandId, projectId } = input;
  const client = await deps.pool.connect();

  try {
    // 1. Claim the command (idempotent)
    const claim = await claimCommand(client, commandId, "import_host_project");
    if (!claim.claimed) {
      return {
        ok: true,
        sourceMode: "mirror",
        replayed: true,
        ...(claim.result as object),
      };
    }

    // 2. Load the project
    const project = await getProject(client, projectId);
    if (!project) {
      const result = { ok: false as const, reason: "project_not_found" as const };
      await completeCommand(client, commandId, result);
      return result;
    }

    if (!project.remote) {
      const result = { ok: false as const, reason: "no_remote" as const };
      await completeCommand(client, commandId, result);
      return result;
    }

    // 3. Resolve credentials for private remotes
    let askpassToken: string | undefined;
    if (deps.secretsKey) {
      const credRow = await getProjectCredential(client, projectId, "git-read");
      if (credRow) {
        try {
          askpassToken = decryptSecret(
            {
              ciphertext: credRow.ciphertext,
              iv: credRow.iv,
              tag: credRow.tag,
              key_version: credRow.key_version,
            },
            deps.secretsKey,
          );
        } catch {
          // Credential decryption failed; proceed without (public remote or misconfigured)
        }
      }
    }

    // 4. Ensure mirror
    let mirrorRef: Awaited<ReturnType<typeof ensureMirror>>;
    try {
      mirrorRef = await ensureMirror(
        { id: projectId, remote: project.remote },
        { gitRoot: deps.gitRoot, askpassToken },
      );
    } catch (err) {
      const detail = (err as Error).message;
      const result = {
        ok: false as const,
        reason: "mirror_failed" as const,
        // Do not include the detail if it might contain credential info
        detail:
          detail.includes("password") || detail.includes("token")
            ? "mirror operation failed"
            : detail,
      };
      await completeCommand(client, commandId, result);
      return result;
    }

    // Silence unused variable warning - mirrorRef is used for side effect (mirror created)
    void mirrorRef;

    // 5. Set source_mode = 'mirror'
    await setProjectSourceMode(client, projectId, "mirror");

    const result = { ok: true as const, sourceMode: "mirror" as const };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// revertImport
// ---------------------------------------------------------------------------

export type RevertImportInput = {
  commandId: string;
  projectId: string;
};

export type RevertImportResult =
  | { ok: true; sourceMode: "host_clone"; replayed?: boolean }
  | { ok: false; reason: "project_not_found"; replayed?: boolean };

export async function revertImport(
  deps: CommandDeps,
  input: RevertImportInput,
): Promise<RevertImportResult> {
  const { commandId, projectId } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "revert_import");
    if (!claim.claimed) {
      return {
        ok: true,
        sourceMode: "host_clone",
        replayed: true,
        ...(claim.result as object),
      };
    }

    const project = await getProject(client, projectId);
    if (!project) {
      const result = { ok: false as const, reason: "project_not_found" as const };
      await completeCommand(client, commandId, result);
      return result;
    }

    await setProjectSourceMode(client, projectId, "host_clone");

    const result = { ok: true as const, sourceMode: "host_clone" as const };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
