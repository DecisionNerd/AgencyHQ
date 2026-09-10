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

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VerifyRunOutput, VerifyRunPayloadV2 } from "@agencyhq/contracts";
import { isV2VerifyRunPayload, VerifyRunPayloadAnySchema } from "@agencyhq/contracts";
import { buildVerificationResult, environmentFingerprint, runCheck } from "@agencyhq/verification";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import type { Broker } from "../lib/broker.ts";
import { createBroker } from "../lib/broker.ts";
import { scrubbedChildEnv } from "../lib/env.ts";
import { changedPaths, diffDigest, worktreeAdd, worktreeRemove } from "../lib/git.ts";
import { materializeSource } from "../lib/source.ts";
import type {
  RunProfileInput,
  RunVerificationOutput,
  VerificationRunner,
} from "./verify-run-core.ts";
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

  // biome-ignore lint/suspicious/noExplicitAny: ctx shape is opaque from Trigger SDK
  run: async (rawPayload: unknown, { signal, ctx }: any): Promise<VerifyRunOutput> => {
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
      const env = scrubbedChildEnv({ attemptId: payload.attemptId });
      const runner = createRealRunner(env);
      signal.addEventListener("abort", () => runner.abort?.(), { once: true });
      const output = await runVerifyV2WithBroker(
        payload,
        ctx.run.id as string,
        broker,
        runRoot,
        runner,
      );
      metadata.set("phase", "done");
      metadata.set("integrity", output.integrity);
      return { results: output.results, integrity: output.integrity };
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

// ---------------------------------------------------------------------------
// runVerifyV2WithBroker — broker-injectable entry point (W-16).
//
// Materializes the main source and any manifest sibling sources using the
// broker (W-15: no manifestRepoPaths read on v2), then runs verification.
// No Trigger SDK metadata calls — testable in isolation with FakeBroker.
// ---------------------------------------------------------------------------

export type RunVerifyV2Output = Pick<RunVerificationOutput, "results" | "integrity">;

export async function runVerifyV2WithBroker(
  payload: VerifyRunPayloadV2,
  runId: string,
  broker: Broker,
  runRoot: string,
  runner: VerificationRunner,
): Promise<RunVerifyV2Output> {
  const runDir = join(runRoot, "runs", `verify-${payload.attemptId}`);
  const cloneDir = join(runDir, "src");

  // Request upload lease for authenticated source downloads.
  let uploadToken = "";
  if (payload.leaseNonce) {
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

  // Materialize main source at attemptRevision.
  const sourceResult = await materializeSource({
    source: { ...payload.source, revision: payload.attemptRevision },
    dir: cloneDir,
    broker,
    token: uploadToken,
  });

  if (!sourceResult.ok) {
    throw new Error(`verify source materialization failed: ${sourceResult.failureKind}`);
  }

  const clonedDir = sourceResult.clonedDir;

  // W-15: Materialize manifest sibling sources using the broker (no manifestRepoPaths).
  // Each sibling is cloned into ${runDir}/siblings/${position} then used as the
  // repoPath for worktreeAdd to create the actual sibling worktree.
  let manifestRepoPaths: Record<string, string> | undefined;
  const siblingCloneDirs: string[] = [];

  if (payload.manifest && payload.manifest.entries.length > 0) {
    const siblingBaseDir = join(runDir, "siblings");
    await mkdir(siblingBaseDir, { recursive: true });
    manifestRepoPaths = {};

    for (const entry of payload.manifest.entries) {
      // Skip the main project (already materialized above).
      if (entry.projectId === payload.source.projectId) continue;

      const rev = entry.resultRevision ?? entry.expectedBaseRevision;
      const siblingCloneDir = join(siblingBaseDir, String(entry.position));

      const sibResult = await materializeSource({
        source: {
          projectId: entry.projectId,
          revision: rev,
          bundlePath: "source.bundle",
        },
        dir: siblingCloneDir,
        broker,
        token: uploadToken,
      });

      if (!sibResult.ok) {
        throw new Error(
          `verify manifest sibling ${entry.projectId} materialization failed: ${sibResult.failureKind}`,
        );
      }

      manifestRepoPaths[entry.projectId] = sibResult.clonedDir;
      siblingCloneDirs.push(sibResult.clonedDir);
    }
  }

  try {
    // Synthesize a v1-compatible payload. worktreeBase set to runDir so
    // the core's manifestDir is ${runDir}/manifest-... (outside clone).
    const v1Payload = {
      ...payload,
      repoPath: clonedDir,
      worktreeBase: runDir,
      payloadVersion: 1 as const,
    };

    const output = await runVerification(v1Payload, {
      // Main worktreeAdd: no-op when repoPath === worktreePath (clone IS the worktree).
      // Sibling worktreeAdd: real add from sibling clone into manifestDir/${position}.
      // Ensure parent of worktreePath exists (git worktree add does not create grandparents).
      worktreeAdd: async (args) => {
        if (args.repoPath === args.worktreePath) {
          return; // no-op: main clone is already at worktreePath
        }
        await mkdir(dirname(args.worktreePath), { recursive: true });
        await worktreeAdd(args);
      },
      worktreeRemove: async () => {
        // v2: sibling worktrees are inside runDir; cleaned up in finally.
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
      // Override worktree path with the clone dir (repoPath === worktreePath → no-op above).
      worktreePath: clonedDir,
      ...(manifestRepoPaths !== undefined
        ? {
            manifestProjectId: payload.source.projectId,
            manifestRepoPaths,
          }
        : {}),
    });

    return { results: output.results, integrity: output.integrity };
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
