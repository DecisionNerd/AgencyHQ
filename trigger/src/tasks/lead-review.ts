// The `lead.review` Trigger task (Packet 3.D, ADR-0006).
//
// Runs an adversarial Lead session seeded with the diff, approved criteria,
// and verification results — never the worker's session or conversation.
// Outputs are proposals; the coordinator validates them deterministically.
//
// v2 path (payloadVersion: 2): source is materialized from a coordinator bundle
// (SourceRef) and the diff is computed from the clone rather than a host path.
// The clone is deleted in a finally block.

import { execFile as execFileCb } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LeadReviewPayload, LeadReviewPayloadV2 } from "@agencyhq/contracts";
import { isV2LeadReviewPayload, LeadReviewPayloadAnySchema } from "@agencyhq/contracts";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import { createBroker } from "../lib/broker.ts";
import { classifyCapacity, providerFromModel } from "../lib/capacity.ts";
import { worktreeAdd, worktreeRemove } from "../lib/git.ts";
import { materializeSource } from "../lib/source.ts";
import { leadPrompt } from "../opencode/sdk.ts";
import type { ReviewTaskOutput } from "../types.ts";
import { runReview } from "./lead-review-core.ts";

const DEFAULT_LEAD_VARIANT = "low";
const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// gitDiff adapter: runs `git diff <base> <attempt>` in any repo dir.
// ---------------------------------------------------------------------------

async function gitDiff(repoPath: string, base: string, attempt: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["diff", base, attempt], {
    cwd: repoPath,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const leadReview = task({
  id: "lead.review",
  // small-2x: adversarial review runs one OpenCode serve session with a
  // patch and diff in context. MachinePresetName verified from
  // schemas/common.d.ts (read 2026-09-09):
  //   node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
  //   node_modules/@trigger.dev/core/dist/commonjs/v3/schemas/common.d.ts
  // machine field on task verified from types/tasks.d.ts (read 2026-09-09).
  machine: "small-2x",
  maxDuration: 600,
  queue: { name: "lead", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  run: async (rawPayload: unknown): Promise<ReviewTaskOutput & { reviewerModel: string }> => {
    // Validate with the union schema (accepts v1 and v2).
    const parseResult = LeadReviewPayloadAnySchema.safeParse(rawPayload);
    if (!parseResult.success) {
      throw new AbortTaskRunError(
        `Invalid lead.review payload: ${JSON.stringify(parseResult.error.flatten())}`,
      );
    }
    const payload = parseResult.data;

    metadata.set("phase", "payload_valid");
    metadata.set("attemptId", payload.attemptId);
    metadata.set("generation", payload.generation);
    metadata.set("model", payload.model);

    const variant = process.env.AGENCYHQ_LEAD_VARIANT ?? DEFAULT_LEAD_VARIANT;
    metadata.set("variant", variant);
    metadata.set("phase", "session_starting");

    // v2 path: materialize source from coordinator bundle, compute diff in clone.
    if (isV2LeadReviewPayload(payload)) {
      return runReviewV2(payload, variant);
    }

    // v1 path: host filesystem repo and patchPath.
    const v1Payload = payload as LeadReviewPayload;
    const result = await runReview(v1Payload, {
      worktreeAdd,
      worktreeRemove,
      gitDiff,
      leadSession: (input) =>
        leadPrompt({
          ...input,
          variant: input.variant ?? variant,
        }),
      now: () => new Date(),
    });

    if ("kind" in result && result.kind === "invalid_output") {
      metadata.set("phase", "invalid_output");
      // Classify capacity from the failure reason (no NDJSON events in SDK mode).
      const syntheticEvent = { type: "error", error: { message: result.reason } };
      const capacity = classifyCapacity([syntheticEvent], {
        provider: providerFromModel(v1Payload.model),
        model: v1Payload.model,
        now: new Date(),
      });
      if (capacity !== null) {
        metadata.set("capacity", capacity);
      }
    } else {
      metadata.set("phase", "done");
    }

    return result;
  },
});

// ---------------------------------------------------------------------------
// runReviewV2: materialize source from coordinator bundle, run review in clone.
// ---------------------------------------------------------------------------

async function runReviewV2(
  payload: LeadReviewPayloadV2,
  variant: string,
): Promise<ReviewTaskOutput & { reviewerModel: string }> {
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
  // Upload token used for source bundle download (read-only access).
  const uploadToken = process.env.AGENCYHQ_UPLOAD_TOKEN ?? "";

  const broker = createBroker(coordinatorUrl);
  // Temp parent: holds the cloned src subdir and the review runDir subdir.
  const tempParent = join(runRoot, "runs", `review-${payload.attemptId}-${payload.generation}`);
  const cloneDir = join(tempParent, "src");

  // Materialize source. For review, source.revision is the attemptRevision so
  // the clone has full history through the attempt (diff base..attempt works).
  const sourceResult = await materializeSource({
    source: payload.source,
    dir: cloneDir,
    broker,
    token: uploadToken,
  });

  if (!sourceResult.ok) {
    throw new AbortTaskRunError(
      `review source materialization failed: ${sourceResult.failureKind}`,
    );
  }

  const clonedDir = sourceResult.clonedDir;

  try {
    metadata.set("phase", "source_materialized");

    // Synthesize a v1-compatible payload. repoPath and worktreeBase reference
    // the clone dir; patchPath is a placeholder (not read by the core — the core
    // computes the diff via gitDiff then writes it to runDir/attempt.patch).
    const v1Payload: LeadReviewPayload = {
      ...payload,
      payloadVersion: 1 as const,
      repoPath: clonedDir,
      worktreeBase: tempParent,
      patchPath: join(tempParent, "attempt.patch"),
    };

    const result = await runReview(v1Payload, {
      // v2: clone is already at the right revision; no worktree needed.
      worktreeAdd: async () => {},
      worktreeRemove: async () => {},
      // gitDiff uses the clone dir (not the synthetic payload.repoPath which
      // equals clonedDir anyway, but passed explicitly for clarity).
      gitDiff: (_repoPath, base, attempt) => gitDiff(clonedDir, base, attempt),
      leadSession: (input) =>
        leadPrompt({
          ...input,
          variant: input.variant ?? variant,
        }),
      now: () => new Date(),
      // Override worktree path: the lead session runs in the clone dir.
      worktreePath: clonedDir,
    });

    if ("kind" in result && result.kind === "invalid_output") {
      metadata.set("phase", "invalid_output");
      const syntheticEvent = { type: "error", error: { message: result.reason } };
      const capacity = classifyCapacity([syntheticEvent], {
        provider: providerFromModel(payload.model),
        model: payload.model,
        now: new Date(),
      });
      if (capacity !== null) {
        metadata.set("capacity", capacity);
      }
    } else {
      metadata.set("phase", "done");
    }

    return result;
  } finally {
    await rm(tempParent, { recursive: true, force: true }).catch(() => undefined);
  }
}
