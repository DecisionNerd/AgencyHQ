// The `verify.run` Trigger task: runs approved verification checks in an
// isolated worktree at the attempt revision (ADR-0007 item 5,
// docs/engineering/adrs/0007-worker-effect-model.md lines 39-41) and returns
// structured VerificationResults.
//
// Evidence integrity invariants enforced by verify-run-core.ts:
//   - The verify worktree is created at attemptRevision, not baseRevision.
//   - diffDigest is reproduced before any check runs; mismatch → all results error.
//   - Frozen profileDigest/criteriaDigest are copied from the payload; never recomputed.
//   - This task reads nothing from the worker's report.
//   - The verify worktree is removed in a finally block; the attempt worktree is retained.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { VerifyRunOutput } from "@agencyhq/contracts";
import { isV2VerifyRunPayload, VerifyRunPayloadAnySchema } from "@agencyhq/contracts";
import { buildVerificationResult, environmentFingerprint, runCheck } from "@agencyhq/verification";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import { createBroker } from "../lib/broker.ts";
import { scrubbedChildEnv } from "../lib/env.ts";
import { changedPaths, diffDigest, worktreeAdd, worktreeRemove } from "../lib/git.ts";
import { materializeSource } from "../lib/source.ts";
import type { RunProfileInput, VerificationRunner } from "./verify-run-core.ts";
import { runVerification } from "./verify-run-core.ts";

// ---------------------------------------------------------------------------
// Real VerificationRunner backed by @agencyhq/verification
// ---------------------------------------------------------------------------

function createRealRunner(scrubEnv: Record<string, string>): VerificationRunner {
  return {
    async runProfile(input: RunProfileInput) {
      const fingerprint = await environmentFingerprint(input.cwd);
      const results = [];

      // Merge the scrubbed base env with any manifest env vars injected by the core.
      // input.env contains AGENCYHQ_MANIFEST_* and AGENCYHQ_MANIFEST_DIGEST when
      // combined verification is active; it is empty ({}) for single-repo runs.
      const env = { ...scrubEnv, ...input.env };

      for (const check of input.checks) {
        // check objects from the payload already match CheckDef shape
        const run = await runCheck(check, { cwd: input.cwd, env });

        const vr = buildVerificationResult({
          verifier: { name: "agencyhq-verification", version: "1" },
          stepContractId: input.contractId,
          attemptId: input.attemptId,
          criteriaDigest: input.criteriaDigest as `sha256:${string}`,
          profileDigest: input.profileDigest as `sha256:${string}`,
          repository: input.repoPath,
          baseRevision: input.baseRevision,
          attemptRevision: input.attemptRevision,
          diffDigest: input.diffDigest as `sha256:${string}`,
          check,
          run,
          environmentFingerprint: fingerprint,
        });

        results.push(vr);
      }

      return results;
    },
  };
}

/** Build an environment fingerprint from host toolchain versions. */
async function buildFingerprint(): Promise<Record<string, string>> {
  try {
    return await environmentFingerprint(".");
  } catch {
    return {};
  }
}

export const verifyRun = task({
  id: "verify.run",
  // medium-1x: verification materialises worktrees and runs check scripts;
  // 2 GB guards against memory-hungry check toolchains. MachinePresetName
  // verified from schemas/common.d.ts (read 2026-09-09):
  //   node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
  //   node_modules/@trigger.dev/core/dist/commonjs/v3/schemas/common.d.ts
  // machine field on task verified from types/tasks.d.ts (read 2026-09-09).
  machine: "medium-1x",
  maxDuration: 1200,
  queue: { name: "verify", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  run: async (rawPayload: unknown, { signal }): Promise<VerifyRunOutput> => {
    // Validate payload with the contracts schema (accepts v1 and v2).
    const parseResult = VerifyRunPayloadAnySchema.safeParse(rawPayload);
    if (!parseResult.success) {
      throw new AbortTaskRunError(
        `invalid payload: ${JSON.stringify(parseResult.error.flatten())}`,
      );
    }
    const payload = parseResult.data;

    // v2: materialize the artifact bundle at attemptRevision, run checks in the
    // clone dir, then delete the clone in a finally block.
    if (isV2VerifyRunPayload(payload)) {
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
      const broker = createBroker(coordinatorUrl);
      const cloneDir = join(runRoot, "runs", `verify-${payload.attemptId}`, "src");

      // D1 / W-6: get upload token from payload nonce (request a lease) or fall back to env.
      let uploadToken = process.env.AGENCYHQ_UPLOAD_TOKEN ?? "";
      if (payload.leaseNonce) {
        const runId = process.env.TRIGGER_RUN_ID ?? `verify-${payload.attemptId}`;
        const leaseResult = await broker.requestLease({
          runId,
          attemptId: payload.attemptId,
          generation: payload.generation,
          purpose: "upload",
          nonce: payload.leaseNonce,
        });
        if (leaseResult.ok && leaseResult.grant.material.purpose === "upload") {
          uploadToken = leaseResult.grant.material.token;
        }
      }

      const sourceResult = await materializeSource({
        source: { ...payload.source, revision: payload.attemptRevision },
        dir: cloneDir,
        broker,
        token: uploadToken,
      });

      if (!sourceResult.ok) {
        throw new AbortTaskRunError(
          `verify source materialization failed: ${sourceResult.failureKind}`,
        );
      }

      const clonedDir = sourceResult.clonedDir;

      try {
        const env = scrubbedChildEnv({ attemptId: payload.attemptId });
        const runner = createRealRunner(env);
        signal.addEventListener("abort", () => runner.abort?.(), { once: true });
        metadata.set("phase", "integrity_checked");

        // Synthesize a v1-compatible payload for runVerification (which expects
        // repoPath and worktreeBase). The actual worktree path is overridden via
        // deps.worktreePath so these placeholder values are unused for git ops.
        const v1Payload = {
          ...payload,
          repoPath: clonedDir,
          worktreeBase: clonedDir,
          payloadVersion: 1 as const,
        };

        const output = await runVerification(v1Payload, {
          worktreeAdd: async () => {
            // v2: clone is already materialized; no worktree needed.
          },
          worktreeRemove: async () => {
            // v2: cleanup handled in finally.
          },
          diffDigest: async (args) => {
            const hex = await diffDigest({
              worktreePath: clonedDir,
              baseRev: args.baseRev,
            });
            return hex;
          },
          changedPaths: (args) => changedPaths({ worktreePath: clonedDir, baseRev: args.baseRev }),
          runner,
          fingerprint: buildFingerprint,
          now: () => new Date().toISOString(),
          // Override worktree path with the clone dir.
          worktreePath: clonedDir,
        });

        metadata.set("phase", "done");
        metadata.set("integrity", output.integrity);
        const { diffDigestMatches: _dm, ...contractIntegrity } = output.integrity;
        return { results: output.results, integrity: contractIntegrity };
      } finally {
        await rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    // Extract coordinator-supplied manifest extension fields from the raw payload.
    // These are not in the contracts schema and must be pulled directly from the raw object.
    const rawObj = rawPayload as Record<string, unknown>;
    const manifestProjectId =
      typeof rawObj.manifestProjectId === "string" ? rawObj.manifestProjectId : undefined;
    const manifestRepoPaths =
      rawObj.manifestRepoPaths !== null &&
      typeof rawObj.manifestRepoPaths === "object" &&
      !Array.isArray(rawObj.manifestRepoPaths)
        ? (rawObj.manifestRepoPaths as Record<string, string>)
        : undefined;

    metadata.set("phase", "worktree_ready");

    // Build the scrubbed environment.  The verifier must not be able to push.
    const env = scrubbedChildEnv({ attemptId: payload.attemptId });

    // Wire up the real verification runner.
    const runner = createRealRunner(env);

    // Register abort hook so running checks are killed on task abort.
    signal.addEventListener(
      "abort",
      () => {
        runner.abort?.();
      },
      { once: true },
    );

    metadata.set("phase", "integrity_checked");

    const output = await runVerification(payload, {
      worktreeAdd,
      worktreeRemove,
      diffDigest: async (args) => {
        const hex = await diffDigest({ worktreePath: args.worktreePath, baseRev: args.baseRev });
        return hex;
      },
      changedPaths: (args) =>
        changedPaths({ worktreePath: args.worktreePath, baseRev: args.baseRev }),
      runner,
      fingerprint: buildFingerprint,
      now: () => new Date().toISOString(),
      ...(manifestProjectId !== undefined ? { manifestProjectId } : {}),
      ...(manifestRepoPaths !== undefined ? { manifestRepoPaths } : {}),
    });

    metadata.set("phase", "checks_running");
    metadata.set("integrity", output.integrity);

    metadata.set("phase", "done");

    // Return the VerifyRunOutput shape: include integrity but strip the
    // adapter-internal diffDigestMatches field so the coordinator's safeParse
    // validates against VerifyRunOutputSchema exactly.
    const { diffDigestMatches: _dm, ...contractIntegrity } = output.integrity;
    return { results: output.results, integrity: contractIntegrity };
  },
});
