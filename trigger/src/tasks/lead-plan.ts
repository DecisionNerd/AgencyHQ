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
import { execFile as execFileCb } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  LEAD_OUTPUT_JSON_SCHEMAS,
  LeadPlanOutputSchema,
  LeadPlanPayloadSchema,
  leadAgentPermissions,
} from "@agencyhq/contracts";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import { classifyCapacity, providerFromModel } from "../lib/capacity.ts";
import { scrubbedChildEnv } from "../lib/env.ts";
import { worktreeAdd, worktreeRemove } from "../lib/git.ts";
import { buildLeadPlanPrompt } from "../opencode/lead-prompt.ts";
import { leadPrompt } from "../opencode/sdk.ts";
import { parseWithSchema } from "../opencode/structured.ts";
import { resolveLeadRunDir, resolveLeadWorktreePath, runLeadPlanCore } from "./lead-plan-core.ts";

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

  run: async (rawPayload: unknown, { ctx }) => {
    // --- Payload validation ---
    const parsed = LeadPlanPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new AbortTaskRunError(`lead.plan: invalid payload: ${parsed.error.message}`);
    }
    const payload = parsed.data;

    const runId = ctx.run.id;

    // Worktree and run dir paths (for logging)
    const worktreePath = resolveLeadWorktreePath({
      worktreeBase: payload.worktreeBase,
      workItemId: payload.workItemId,
      runId,
    });
    const runDir = resolveLeadRunDir({
      worktreeBase: payload.worktreeBase,
      workItemId: payload.workItemId,
      runId,
    });

    metadata.set("worktreePath", worktreePath);
    metadata.set("runDir", runDir);

    const env = scrubbedChildEnv({ attemptId: `lead-${payload.workItemId}` });
    const ruleset = leadAgentPermissions();
    const schema = LEAD_OUTPUT_JSON_SCHEMAS.leadPlanOutput;

    const variant =
      (payload as typeof payload & { variant?: string }).variant ??
      process.env.AGENCYHQ_LEAD_VARIANT ??
      "low";

    // Core run with injected dependencies
    const output = await runLeadPlanCore({
      payload,
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
        const execFileAsync = promisify(execFileCb);
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
        provider: providerFromModel(payload.model),
        model: payload.model,
        now: new Date(),
      });
      if (capacity !== null) {
        metadata.set("capacity", capacity);
      }
    }

    return output;
  },
});
