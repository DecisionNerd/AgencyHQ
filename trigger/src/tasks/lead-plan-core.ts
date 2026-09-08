// Pure/injectable pieces of the `lead.plan` task, factored out for unit
// testing without importing `@trigger.dev/sdk`. No Trigger SDK usage.
// No direct child_process or filesystem calls — all effects are injected.
//
// The Lead is read-only: it inspects the repository and produces a PROPOSAL
// that the coordinator validates. The task never calls the authority subset
// check and never records a Decision — that is the coordinator's job.
// (ADR-0006: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md)

import type { LeadPlanOutput, LeadPlanPayload, PermissionRuleset } from "@agencyhq/contracts";
import type { LeadPromptResult } from "../opencode/sdk.ts";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Where a lead session's worktree lives:
 *   `<worktreeBase>/lead/<workItemId>-<runId>`
 */
export function resolveLeadWorktreePath(args: {
  worktreeBase: string;
  workItemId: string;
  runId: string;
}): string {
  return `${args.worktreeBase}/lead/${args.workItemId}-${args.runId}`;
}

/**
 * Where a lead session's run directory lives (config/logs/events),
 * deliberately outside the worktree:
 *   `<worktreeBase>/lead-runs/<workItemId>-<runId>`
 */
export function resolveLeadRunDir(args: {
  worktreeBase: string;
  workItemId: string;
  runId: string;
}): string {
  return `${args.worktreeBase}/lead-runs/${args.workItemId}-${args.runId}`;
}

// ---------------------------------------------------------------------------
// Injected types
// ---------------------------------------------------------------------------

/** Minimal git-ls-files dependency for testing. */
export type GitLsFilesFn = (args: { worktreePath: string; limit: number }) => Promise<string[]>;

/** Read a file from the worktree, returning undefined if absent. */
export type ReadFileFn = (path: string) => Promise<string | undefined>;

/** Signature matching leadPrompt in sdk.ts (injected for tests). */
export type LeadPromptFn = <T>(input: {
  dir: string;
  runDir: string;
  model: string;
  variant?: string | undefined;
  agentName: "agencyhq-lead";
  ruleset: PermissionRuleset;
  env: Record<string, string>;
  systemContext: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  parse: (raw: unknown) => T;
  timeoutMs: number;
}) => Promise<LeadPromptResult<T>>;

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

/**
 * Execute the lead.plan logic with injected dependencies.
 *
 * INVARIANTS (enforced here):
 *  - The Lead worktree is created at baseRevision (read-only role).
 *  - Only ONE prompt is sent to the model.
 *  - The raw output is validated with LeadPlanOutputSchema.
 *  - On parse failure → { kind: "invalid_output", reason }.
 *  - The task NEVER calls the authority subset check.
 *  - The Lead worktree is removed in the finally block.
 */
export async function runLeadPlanCore(args: {
  payload: LeadPlanPayload;
  runId: string;
  env: Record<string, string>;
  ruleset: PermissionRuleset;
  schema: Record<string, unknown>;
  leadPromptFn: LeadPromptFn;
  worktreeAdd: (args: { repoPath: string; worktreePath: string; rev: string }) => Promise<void>;
  worktreeRemove: (args: {
    repoPath: string;
    worktreePath: string;
    force?: boolean;
  }) => Promise<void>;
  gitLsFiles: GitLsFilesFn;
  readFile: ReadFileFn;
  buildPrompt: (
    payload: LeadPlanPayload,
    repoContext: { agentsMd?: string; readmeHead?: string; fileList: string[] },
  ) => { systemContext: string; userPrompt: string };
  parseOutput: (raw: unknown) => LeadPlanOutput;
  onPhase?: (phase: string) => void;
  timeoutMs: number;
}): Promise<LeadPlanOutput> {
  const { payload, runId } = args;
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

  // Get model and variant
  const modelEnvVariant = args.env.AGENCYHQ_LEAD_VARIANT;
  const variant =
    (payload as LeadPlanPayload & { variant?: string }).variant ?? modelEnvVariant ?? "low";

  args.onPhase?.("worktree_ready");

  try {
    // Create worktree at base revision (read-only for Lead)
    await args.worktreeAdd({
      repoPath: payload.repoPath,
      worktreePath,
      rev: payload.baseRevision,
    });

    // Read repo context
    const [agentsMd, readmeRaw, fileList] = await Promise.all([
      args.readFile(`${worktreePath}/AGENTS.md`),
      args.readFile(`${worktreePath}/README.md`),
      args.gitLsFiles({ worktreePath, limit: 500 }),
    ]);

    const readmeHead =
      readmeRaw !== undefined ? readmeRaw.split("\n").slice(0, 100).join("\n") : undefined;

    // Build prompts
    // exactOptionalPropertyTypes: pass only the defined properties
    const repoContext: { agentsMd?: string; readmeHead?: string; fileList: string[] } = {
      fileList,
    };
    if (agentsMd !== undefined) repoContext.agentsMd = agentsMd;
    if (readmeHead !== undefined) repoContext.readmeHead = readmeHead;
    const { systemContext, userPrompt } = args.buildPrompt(payload, repoContext);

    args.onPhase?.("lead_running");

    // Run the Lead session
    let result: LeadPromptResult<LeadPlanOutput>;
    try {
      result = await args.leadPromptFn({
        dir: worktreePath,
        runDir,
        model: payload.model,
        variant: typeof variant === "string" ? variant : undefined,
        agentName: "agencyhq-lead",
        ruleset: args.ruleset,
        env: args.env,
        systemContext,
        userPrompt,
        schema: args.schema,
        parse: args.parseOutput,
        timeoutMs: args.timeoutMs,
      });
    } catch (err: unknown) {
      // Parse failure or SDK error → invalid_output
      const reason = err instanceof Error ? err.message : String(err);
      return { kind: "invalid_output", reason };
    }

    args.onPhase?.("done");
    return result.value;
  } finally {
    // Lead worktrees are read-only and disposable — always remove
    await args
      .worktreeRemove({ repoPath: payload.repoPath, worktreePath, force: true })
      .catch(() => {
        /* non-fatal; worktree may not exist if create failed */
      });
  }
}
