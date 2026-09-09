// The `integrate.merge` Trigger task: integrates an attempt commit into the
// coordinator-owned clone and pushes to the remote (R-015, R-010,
// ARCHITECTURE.md lines 85-110).  This is the ONLY task that may push;
// worker tasks commit locally only (ADR-0007).
//
// Design invariants:
//   - Runs with the task's own host environment so the git credential helper
//     works (NOT the scrubbed worker env from env.ts).
//   - AbortTaskRunError is thrown only for setup failures (bad payload,
//     missing repo).  All other outcomes are returned as structured output.
//   - concurrencyLimit: 1 on the "integrate" queue serialises pushes per
//     Trigger project; callers are responsible for per-repository serialisation
//     via concurrencyKey when triggering.
//   - retries: 0 — the task is idempotent via already_integrated but
//     retry-on-failure would mask coordinator bugs.
//
// v2 path (payloadVersion: 2): source is materialized from a coordinator bundle
// (SourceRef), an integrate lease is requested for the GIT_ASKPASS token, and
// an askpass script is written to a per-run tmp path (mode 0700, deleted in
// finally). The token never appears in logs, metadata, or thrown errors.

import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrateMergePayload, IntegrateMergePayloadV2 } from "@agencyhq/contracts";
import { IntegrateMergePayloadAnySchema, isV2IntegrateMergePayload } from "@agencyhq/contracts";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import { createBroker } from "../lib/broker.ts";
import {
  fetchRef,
  isAncestor,
  lsRemote,
  mergeInWorktree,
  pushForceWithLease,
  worktreeAdd,
  worktreeRemove,
} from "../lib/git.ts";
import { materializeSource } from "../lib/source.ts";
import type { IntegrateMergeOutput } from "../types.ts";
import type { IntegrateMergeDeps } from "./integrate-merge-core.ts";
import { runIntegrateMerge } from "./integrate-merge-core.ts";

// ---------------------------------------------------------------------------
// Task definition
// ---------------------------------------------------------------------------

export const integrateMerge = task({
  id: "integrate.merge",
  // medium-1x: integration clones and pushes repositories; 2 GB provides
  // headroom for large Git histories. MachinePresetName verified from
  // schemas/common.d.ts (read 2026-09-09):
  //   node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
  //   node_modules/@trigger.dev/core/dist/commonjs/v3/schemas/common.d.ts
  // machine field on task verified from types/tasks.d.ts (read 2026-09-09).
  machine: "medium-1x",
  maxDuration: 300,
  queue: { name: "integrate", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  // biome-ignore lint/suspicious/noExplicitAny: ctx shape is opaque from Trigger SDK
  run: async (rawPayload: unknown, { ctx }: any): Promise<IntegrateMergeOutput> => {
    metadata.set("phase", "validating");

    // Validate payload with the union schema; AbortTaskRunError on failure.
    const parseResult = IntegrateMergePayloadAnySchema.safeParse(rawPayload);
    if (!parseResult.success) {
      throw new AbortTaskRunError(
        `integrate.merge: invalid payload: ${JSON.stringify(parseResult.error.flatten())}`,
      );
    }
    const payload = parseResult.data;

    // v2 path: materialize source from coordinator bundle and push with GIT_ASKPASS.
    if (isV2IntegrateMergePayload(payload)) {
      return runIntegrateMergeV2(payload, ctx.run.id as string);
    }

    // v1 path: coordinator-owned local clone.
    const v1Payload: IntegrateMergePayload = payload;

    // Ensure the coordinator repo exists before doing any git work.
    await stat(v1Payload.repoPath).catch(() => {
      throw new AbortTaskRunError(
        `integrate.merge: coordinator repo not found: ${v1Payload.repoPath}`,
      );
    });

    metadata.set("phase", "setup");

    // Use the task's own host environment so the credential helper for pushes
    // is available.  GIT_TERMINAL_PROMPT=0 prevents any interactive prompt.
    const hostEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

    // Create a run-local temp directory for the merge worktree.
    const runDir = await mkdir(join(tmpdir(), `agencyhq-integrate-${v1Payload.attemptId}-`), {
      recursive: true,
    })
      .then(() => join(tmpdir(), `agencyhq-integrate-${v1Payload.attemptId}-`))
      .catch(async () => {
        // If the fixed-name dir already exists, fall back to mkdtemp.
        const { mkdtemp } = await import("node:fs/promises");
        return mkdtemp(join(tmpdir(), `agencyhq-integrate-${v1Payload.attemptId}-`));
      });

    // Wire up the real git deps with the host environment.
    const deps: IntegrateMergeDeps = {
      fetchRef: (args) => fetchRef({ ...args, env: hostEnv }),
      lsRemote: (args) => lsRemote({ ...args, env: hostEnv }),
      isAncestor: (args) => isAncestor({ ...args, env: hostEnv }),
      worktreeAdd,
      worktreeRemove,
      mergeInWorktree: (args) => mergeInWorktree({ ...args, env: hostEnv }),
      pushForceWithLease: (args) => pushForceWithLease({ ...args, env: hostEnv }),
    };

    metadata.set("phase", "integrating");
    metadata.set("attemptId", v1Payload.attemptId);
    metadata.set("strategy", v1Payload.strategy);

    let output: IntegrateMergeOutput;
    try {
      output = await runIntegrateMerge(v1Payload, deps, runDir);
    } finally {
      // Clean up the run dir (best-effort; merge worktree is removed inside core).
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    }

    metadata.set("phase", "done");
    metadata.set("outcome", output.outcome);

    return output;
  },
});

// ---------------------------------------------------------------------------
// runIntegrateMergeV2: materialize source, obtain integrate lease, push via
// GIT_ASKPASS. This is the ONLY path that issues an integrate lease.
//
// SECURITY: askpassToken never appears in logs, metadata, errors, or call
// records. The askpass script is written mode 0700 and deleted in finally.
// ---------------------------------------------------------------------------

async function runIntegrateMergeV2(
  payload: IntegrateMergePayloadV2,
  runId: string,
): Promise<IntegrateMergeOutput> {
  const coordinatorUrl =
    process.env.AGENCYHQ_COORDINATOR_INTERNAL_URL ??
    (() => {
      throw new AbortTaskRunError("missing AGENCYHQ_COORDINATOR_INTERNAL_URL");
    })();
  const runRoot =
    process.env.AGENCYHQ_RUN_ROOT ??
    (() => {
      throw new AbortTaskRunError("missing AGENCYHQ_RUN_ROOT");
    })();
  const nonce =
    process.env.AGENCYHQ_LEASE_NONCE ??
    (() => {
      throw new AbortTaskRunError("missing AGENCYHQ_LEASE_NONCE");
    })();

  metadata.set("phase", "requesting_integrate_lease");
  metadata.set("attemptId", payload.attemptId);
  metadata.set("strategy", payload.strategy);

  const broker = createBroker(coordinatorUrl);

  // Request integrate lease — provides GIT_ASKPASS token for push.
  const leaseResult = await broker.requestLease({
    runId,
    attemptId: payload.attemptId,
    generation: payload.generation,
    purpose: "integrate",
    nonce,
  });

  if (!leaseResult.ok) {
    throw new AbortTaskRunError(
      `integrate.merge: integrate lease refused: ${leaseResult.refusal.reason}`,
    );
  }

  const grant = leaseResult.grant;
  if (grant.material.purpose !== "integrate") {
    throw new AbortTaskRunError("integrate.merge: lease material purpose mismatch");
  }

  // askpassToken is a secret — never log or record it.
  const { askpassToken } = grant.material;

  // Temp directory for clone + merge worktree + askpass script.
  const tempDir = join(runRoot, "runs", `integrate-${payload.attemptId}-${runId}`);
  const cloneDir = join(tempDir, "src");
  const askpassPath = join(tempDir, "git-askpass.sh");

  // Write the askpass script (mode 0700). Outputs the token for "Password:"
  // prompts so git credential helper gets the right value for HTTPS auth.
  // Single-quote the token; escape embedded single quotes.
  const safeToken = askpassToken.replace(/'/g, "'\\''");
  const askpassScript = `#!/bin/sh\ncase "$1" in\n  Password*) printf '%s\\n' '${safeToken}' ;;\n  *) printf '\\n' ;;\nesac\n`;

  try {
    await mkdir(tempDir, { recursive: true });
    await writeFile(askpassPath, askpassScript, { mode: 0o700, encoding: "utf8" });
    // Ensure mode 0700 even if umask restricted writeFile.
    await chmod(askpassPath, 0o700);

    // Materialize source. For integrate v2, source.revision is the attemptRevision
    // so the clone has the attempt commit ready for the merge step.
    const sourceResult = await materializeSource({
      source: payload.source,
      dir: cloneDir,
      broker,
      // Use the upload token from env for source bundle download.
      token: process.env.AGENCYHQ_UPLOAD_TOKEN ?? "",
    });

    if (!sourceResult.ok) {
      throw new AbortTaskRunError(
        `integrate.merge source materialization failed: ${sourceResult.failureKind}`,
      );
    }

    const clonedDir = sourceResult.clonedDir;
    metadata.set("phase", "integrating");

    // Git env: GIT_ASKPASS provides the credential, GIT_TERMINAL_PROMPT=0
    // prevents interactive prompts.
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpassPath,
    };

    // Synthesize a v1-compatible payload for runIntegrateMerge.
    const v1Payload: IntegrateMergePayload = {
      payloadVersion: 1 as const,
      attemptId: payload.attemptId,
      generation: payload.generation,
      contractId: payload.contractId,
      contractVersion: payload.contractVersion,
      projectId: payload.projectId,
      repoPath: clonedDir,
      remote: payload.remote,
      targetRef: payload.targetRef,
      expectedBaseRevision: payload.expectedBaseRevision,
      attemptRevision: payload.attemptRevision,
      strategy: payload.strategy,
    };

    // Run dir for the merge worktree (inside tempDir so cleanup covers it).
    const runDir = join(tempDir, "run");
    await mkdir(runDir, { recursive: true });

    // Wire up git deps with the GIT_ASKPASS-equipped env for network ops.
    const deps: IntegrateMergeDeps = {
      fetchRef: (args) => fetchRef({ ...args, env: gitEnv }),
      lsRemote: (args) => lsRemote({ ...args, env: gitEnv }),
      isAncestor: (args) => isAncestor({ ...args, env: gitEnv }),
      worktreeAdd,
      worktreeRemove,
      mergeInWorktree: (args) => mergeInWorktree({ ...args, env: gitEnv }),
      pushForceWithLease: (args) => pushForceWithLease({ ...args, env: gitEnv }),
    };

    const output = await runIntegrateMerge(v1Payload, deps, runDir);

    metadata.set("phase", "done");
    metadata.set("outcome", output.outcome);

    return output;
  } finally {
    // Delete tempDir (askpass script + clone + run dir). askpassToken is gone
    // from the filesystem after this; it never appears in any output field.
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
