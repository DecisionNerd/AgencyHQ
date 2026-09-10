// The `lead.plan` Trigger task: read-only Lead session → structured proposal.
//
// ADR-0006: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md
// EXECUTION_MODEL.md lines 7-14 (Plan step)
// R-005: all model calls go through OpenCode.
// R-020: repository content is untrusted; proposals can only narrow authority.
//
// INVARIANTS enforced here:
//  - Payload validated at entry with LeadPlanPayloadSchema (→ AbortTaskRunError).
//  - Lead worktree created at baseRevision and NEVER reused.
//  - Only ONE prompt is sent to the model.
//  - Output validated with LeadPlanOutputSchema.
//  - Malformed output → { kind: "invalid_output", reason } — retriable.
//  - Task NEVER calls the authority subset check and NEVER writes a Decision.
//  - Lead worktree removed in finally (read-only and disposable).
//  - Run dir is KEPT after the run for evidence/debugging.
//
// v2 path (payloadVersion: 2): source is materialized from a coordinator bundle
// (SourceRef); the clone is the lead worktree and is deleted in a finally block.
import { execFile as execFileCb } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LeadPlanPayload } from "@agencyhq/contracts";
import {
  isV2LeadPlanPayload,
  LEAD_OUTPUT_JSON_SCHEMAS,
  LeadPlanOutputSchema,
  LeadPlanPayloadAnySchema,
  leadAgentPermissions,
} from "@agencyhq/contracts";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import { createBroker } from "../lib/broker.ts";
import { classifyCapacity, providerFromModel } from "../lib/capacity.ts";
import { scrubbedChildEnv } from "../lib/env.ts";
import { worktreeAdd, worktreeRemove } from "../lib/git.ts";
import { materializeSource } from "../lib/source.ts";
import { buildLeadPlanPrompt } from "../opencode/lead-prompt.ts";
import { leadPrompt } from "../opencode/sdk.ts";
import { parseWithSchema } from "../opencode/structured.ts";
import { resolveLeadRunDir, resolveLeadWorktreePath, runLeadPlanCore } from "./lead-plan-core.ts";

const execFileAsync = promisify(execFileCb);

export const leadPlan = task({
  id: "lead.plan",
  // small-2x: lead tasks run one OpenCode serve session; 2 vCPUs / 1 GB is
  // sufficient for a single-prompt structured JSON call. MachinePresetName
  // verified from schemas/common.d.ts (read 2026-09-09):
  //   node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
  //   node_modules/@trigger.dev/core/dist/commonjs/v3/schemas/common.d.ts
  // machine field on task verified from types/tasks.d.ts (read 2026-09-09).
  machine: "small-2x",
  maxDuration: 300,
  queue: { name: "lead", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  // biome-ignore lint/suspicious/noExplicitAny: ctx shape is opaque from Trigger SDK
  run: async (rawPayload: unknown, { ctx }: any) => {
    // Validate with the union schema (accepts v1 and v2).
    const parsed = LeadPlanPayloadAnySchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new AbortTaskRunError(`lead.plan: invalid payload: ${parsed.error.message}`);
    }
    const payload = parsed.data;

    const runId = ctx.run.id as string;

    metadata.set("workItemId", payload.workItemId);
    metadata.set("model", payload.model);

    const env = scrubbedChildEnv({ attemptId: `lead-${payload.workItemId}` });
    const ruleset = leadAgentPermissions();
    const schema = LEAD_OUTPUT_JSON_SCHEMAS.leadPlanOutput;

    const variant =
      (payload as typeof payload & { variant?: string }).variant ??
      process.env.AGENCYHQ_LEAD_VARIANT ??
      "low";

    // v2 path: materialize source from coordinator bundle.
    if (isV2LeadPlanPayload(payload)) {
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
      // E2 / W-6: request an upload lease using the nonce from the payload.
      // ctx.run.id (captured as runId above) is the only correct run ID.
      const broker = createBroker(coordinatorUrl);
      let uploadToken = "";
      if (payload.leaseNonce) {
        const leaseResult = await broker.requestLease({
          runId,
          attemptId: payload.workItemId,
          generation: 0,
          purpose: "upload",
          nonce: payload.leaseNonce,
        });
        if (leaseResult.ok && leaseResult.grant.material.purpose === "upload") {
          uploadToken = leaseResult.grant.material.token;
        }
      }

      // tempParent holds src/ subdir and the lead-runs/ subdir for the session.
      const tempParent = join(runRoot, "runs", `lead-${payload.workItemId}-${runId}`);
      const cloneDir = join(tempParent, "src");

      const sourceResult = await materializeSource({
        source: payload.source,
        dir: cloneDir,
        broker,
        token: uploadToken,
      });

      if (!sourceResult.ok) {
        throw new AbortTaskRunError(
          `lead.plan source materialization failed: ${sourceResult.failureKind}`,
        );
      }

      const clonedDir = sourceResult.clonedDir;
      metadata.set("phase", "source_materialized");

      // Synthesize a v1-compatible payload for runLeadPlanCore.
      const v1Payload: LeadPlanPayload = {
        ...payload,
        payloadVersion: 1 as const,
        repoPath: clonedDir,
        worktreeBase: tempParent,
      };

      try {
        const output = await runLeadPlanCore({
          payload: v1Payload,
          runId,
          env,
          ruleset,
          schema,
          leadPromptFn: (input) =>
            leadPrompt({
              ...input,
              variant: typeof variant === "string" ? variant : undefined,
            }),
          // v2: clone is already at baseRevision; no worktree needed.
          worktreeAdd: async () => {},
          worktreeRemove: async () => {},
          gitLsFiles: async ({ limit }) => {
            const { stdout } = await execFileAsync("git", ["ls-files"], {
              cwd: clonedDir,
              maxBuffer: 16 * 1024 * 1024,
            });
            return stdout.trim().split("\n").filter(Boolean).slice(0, limit);
          },
          readFile: async (path) => {
            try {
              return await readFile(path, "utf8");
            } catch {
              return undefined;
            }
          },
          buildPrompt: (p, repoContext) => buildLeadPlanPrompt(p, repoContext),
          parseOutput: (raw) => {
            const result = parseWithSchema(LeadPlanOutputSchema, raw);
            if (result.ok) return result.value;
            throw new Error(`LeadPlanOutputSchema parse failed: ${result.reason}`);
          },
          onPhase: (phase) => metadata.set("phase", phase),
          timeoutMs: 270_000,
          // Override worktree path: lead session runs in the clone dir.
          worktreePath: clonedDir,
        });

        if (output.kind === "invalid_output") {
          const syntheticEvent = { type: "error", error: { message: output.reason } };
          const capacity = classifyCapacity([syntheticEvent], {
            provider: providerFromModel(payload.model),
            model: payload.model,
            now: new Date(),
          });
          if (capacity !== null) {
            metadata.set("capacity", capacity);
          }
        }

        return output;
      } finally {
        await rm(tempParent, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    // v1 path: host filesystem paths.
    const v1Payload = payload as LeadPlanPayload;

    // Worktree and run dir paths (for logging)
    const worktreePath = resolveLeadWorktreePath({
      worktreeBase: v1Payload.worktreeBase,
      workItemId: v1Payload.workItemId,
      runId,
    });
    const runDir = resolveLeadRunDir({
      worktreeBase: v1Payload.worktreeBase,
      workItemId: v1Payload.workItemId,
      runId,
    });

    metadata.set("worktreePath", worktreePath);
    metadata.set("runDir", runDir);

    // Core run with injected dependencies
    const output = await runLeadPlanCore({
      payload: v1Payload,
      runId,
      env,
      ruleset,
      schema,
      leadPromptFn: (input) =>
        leadPrompt({
          ...input,
          variant: typeof variant === "string" ? variant : undefined,
        }),
      worktreeAdd: (args) => worktreeAdd(args),
      worktreeRemove: (args) => worktreeRemove(args),
      gitLsFiles: async ({ worktreePath: wt, limit }) => {
        const { stdout } = await execFileAsync("git", ["ls-files"], {
          cwd: wt,
          maxBuffer: 16 * 1024 * 1024,
        });
        return stdout.trim().split("\n").filter(Boolean).slice(0, limit);
      },
      readFile: async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch {
          return undefined;
        }
      },
      buildPrompt: (p, repoContext) => buildLeadPlanPrompt(p, repoContext),
      parseOutput: (raw) => {
        const result = parseWithSchema(LeadPlanOutputSchema, raw);
        if (result.ok) return result.value;
        throw new Error(`LeadPlanOutputSchema parse failed: ${result.reason}`);
      },
      onPhase: (phase) => metadata.set("phase", phase),
      timeoutMs: 270_000, // 4.5 min soft limit inside 5 min maxDuration
    });

    // Classify provider capacity from invalid_output errors (the lead session
    // uses the OpenCode SDK server mode, so there is no NDJSON event stream;
    // we reconstruct a synthetic event from the failure reason instead).
    if (output.kind === "invalid_output") {
      const syntheticEvent = { type: "error", error: { message: output.reason } };
      const capacity = classifyCapacity([syntheticEvent], {
        provider: providerFromModel(v1Payload.model),
        model: v1Payload.model,
        now: new Date(),
      });
      if (capacity !== null) {
        metadata.set("capacity", capacity);
      }
    }

    return output;
  },
});
