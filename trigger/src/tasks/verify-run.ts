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

import type { VerifyRunOutput } from "@agencyhq/contracts";
import { VerifyRunPayloadSchema } from "@agencyhq/contracts";
import { buildVerificationResult, environmentFingerprint, runCheck } from "@agencyhq/verification";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import { scrubbedChildEnv } from "../lib/env.ts";
import { changedPaths, diffDigest, worktreeAdd, worktreeRemove } from "../lib/git.ts";
import type { RunProfileInput, VerificationRunner } from "./verify-run-core.ts";
import { runVerification } from "./verify-run-core.ts";

// ---------------------------------------------------------------------------
// Real VerificationRunner backed by @agencyhq/verification
// ---------------------------------------------------------------------------

function createRealRunner(env: Record<string, string>): VerificationRunner {
  return {
    async runProfile(input: RunProfileInput) {
      const fingerprint = await environmentFingerprint(input.cwd);
      const results = [];

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
  maxDuration: 1200,
  queue: { name: "verify", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  run: async (rawPayload: unknown, { signal }): Promise<VerifyRunOutput> => {
    // Validate payload with the contracts schema.
    const parseResult = VerifyRunPayloadSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      throw new AbortTaskRunError(
        `invalid payload: ${JSON.stringify(parseResult.error.flatten())}`,
      );
    }
    const payload = parseResult.data;

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
    });

    metadata.set("phase", "checks_running");
    metadata.set("integrity", output.integrity);

    metadata.set("phase", "done");

    // Return only the VerifyRunOutput shape (strip the internal integrity field).
    return { results: output.results };
  },
});
