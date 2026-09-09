// The `lead.review` Trigger task (Packet 3.D, ADR-0006).
//
// Runs an adversarial Lead session seeded with the diff, approved criteria,
// and verification results — never the worker's session or conversation.
// Outputs are proposals; the coordinator validates them deterministically.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { LeadReviewPayload } from "@agencyhq/contracts";
import { LeadReviewPayloadSchema } from "@agencyhq/contracts";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";

import { classifyCapacity, providerFromModel } from "../lib/capacity.ts";
import { worktreeAdd, worktreeRemove } from "../lib/git.ts";
import { leadPrompt } from "../opencode/sdk.ts";
import type { ReviewTaskOutput } from "../types.ts";
import { runReview } from "./lead-review-core.ts";

const DEFAULT_LEAD_VARIANT = "low";
const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// gitDiff adapter: runs `git diff <base> <attempt>` in the main repo.
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
  maxDuration: 600,
  queue: { name: "lead", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  run: async (rawPayload: unknown): Promise<ReviewTaskOutput & { reviewerModel: string }> => {
    // Validate the payload against the contract schema.
    let payload: LeadReviewPayload;
    try {
      payload = LeadReviewPayloadSchema.parse(rawPayload);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AbortTaskRunError(`Invalid lead.review payload: ${reason}`);
    }

    metadata.set("phase", "payload_valid");
    metadata.set("attemptId", payload.attemptId);
    metadata.set("generation", payload.generation);
    metadata.set("model", payload.model);

    const variant = process.env.AGENCYHQ_LEAD_VARIANT ?? DEFAULT_LEAD_VARIANT;
    metadata.set("variant", variant);
    metadata.set("phase", "session_starting");

    const result = await runReview(payload, {
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
  },
});
