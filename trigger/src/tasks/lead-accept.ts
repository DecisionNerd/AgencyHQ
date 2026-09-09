// The `lead.accept` Trigger task (Packet 3.D, ADR-0006).
//
// Runs a Lead session to produce an acceptance proposal for a completed attempt.
// The proposal names every criterion, cites passing results by ref, and lists
// dispositions for all non-blocking findings.
// Outputs are proposals; the coordinator validates them deterministically.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { LeadAcceptPayload } from "@agencyhq/contracts";
import { LeadAcceptPayloadSchema } from "@agencyhq/contracts";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";

import { classifyCapacity, providerFromModel } from "../lib/capacity.ts";
import { leadPrompt } from "../opencode/sdk.ts";
import type { AcceptTaskOutput } from "../types.ts";
import { runAccept } from "./lead-accept-core.ts";

const DEFAULT_LEAD_VARIANT = "low";

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const leadAccept = task({
  id: "lead.accept",
  maxDuration: 300,
  queue: { name: "lead", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  run: async (rawPayload: unknown): Promise<AcceptTaskOutput> => {
    // Validate the payload against the contract schema.
    let payload: LeadAcceptPayload;
    try {
      payload = LeadAcceptPayloadSchema.parse(rawPayload);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AbortTaskRunError(`Invalid lead.accept payload: ${reason}`);
    }

    metadata.set("phase", "payload_valid");
    metadata.set("attemptId", payload.attemptId);
    metadata.set("generation", payload.generation);
    metadata.set("model", payload.model);

    const variant = process.env.AGENCYHQ_LEAD_VARIANT ?? DEFAULT_LEAD_VARIANT;
    metadata.set("variant", variant);
    metadata.set("phase", "session_starting");

    const result = await runAccept(payload, {
      leadSession: (input) =>
        leadPrompt({
          ...input,
          variant: input.variant ?? variant,
        }),
      mkdtemp: (prefix: string) => mkdtemp(`${tmpdir()}/${prefix}`),
      rmdir: (path: string) => rm(path, { recursive: true, force: true }),
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
