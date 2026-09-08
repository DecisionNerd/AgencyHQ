// Tests for trigger/src/tasks/lead-plan-core.ts
// Uses injected fake leadPromptFn, worktreeAdd/Remove, gitLsFiles, readFile.
//
// Tests:
//  1. resolveLeadWorktreePath and resolveLeadRunDir path helpers.
//  2. Valid proposal returned as-is (task does NOT validate authority subset).
//  3. Garbage input from leadPromptFn → invalid_output result.
//  4. A proposal that widens (paths src/**) is STILL returned as a proposal
//     (the task does not judge; the coordinator does — no subset check here).
//  5. Worktree removed after a successful run.
//  6. Worktree removed even when leadPromptFn throws.
//  7. Source grep: lead-plan.ts must not import any subset-check function.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { LeadPlanPayload } from "@agencyhq/contracts";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import type { GitLsFilesFn, LeadPromptFn, ReadFileFn } from "../src/tasks/lead-plan-core.ts";
import {
  resolveLeadRunDir,
  resolveLeadWorktreePath,
  runLeadPlanCore,
} from "../src/tasks/lead-plan-core.ts";

// ---------------------------------------------------------------------------
// Path helper tests
// ---------------------------------------------------------------------------

test("resolveLeadWorktreePath: joins worktreeBase/lead/<workItemId>-<runId>", () => {
  assert.equal(
    resolveLeadWorktreePath({ worktreeBase: "/srv/ag", workItemId: "wi-1", runId: "run-1" }),
    "/srv/ag/lead/wi-1-run-1",
  );
});

test("resolveLeadRunDir: joins worktreeBase/lead-runs/<workItemId>-<runId>", () => {
  assert.equal(
    resolveLeadRunDir({ worktreeBase: "/srv/ag", workItemId: "wi-1", runId: "run-1" }),
    "/srv/ag/lead-runs/wi-1-run-1",
  );
});

test("resolveLeadWorktreePath and resolveLeadRunDir produce different paths", () => {
  const wt = resolveLeadWorktreePath({ worktreeBase: "/srv", workItemId: "x", runId: "r" });
  const rd = resolveLeadRunDir({ worktreeBase: "/srv", workItemId: "x", runId: "r" });
  assert.notEqual(wt, rd);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PAYLOAD: LeadPlanPayload = {
  workItemId: "wi-001",
  projectId: "proj-1",
  repoPath: "/tmp/repo",
  baseRevision: "abc123",
  worktreeBase: "/tmp/worktrees",
  authority: HOST_TRIAL_AUTHORITY,
  operatorIntent: "make hello() return 'hello'",
  model: "openai/gpt-5.6-sol",
};

const VALID_PROPOSAL = {
  kind: "proposal" as const,
  proposal: {
    criteria: [{ id: "c1", text: "hello() returns 'hello'", source: "operator" as const }],
    profileId: "hello-fix",
    changeClass: "behavior" as const,
    review: "adversarial" as const,
    boundary: "artifact" as const,
    paths: { allow: ["src/parser/**"], deny: [] },
    capabilities: {
      bash: { allow: ["pnpm test*"], deny: [] },
      tools: {
        edit: true,
        webfetch: false,
        websearch: false,
        task: false,
        external_directory: false,
        skill: false,
      },
    },
    budget: { maxAttempts: 1, maxDurationSeconds: 600, estimatedSpendUsd: 2 },
    models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
    rationale: "Direct fix to hello function.",
    sources: [{ criterionId: "c1", source: "operator" as const, citation: "operator intent" }],
  },
};

function makeLeadPromptFn(returnValue: unknown): LeadPromptFn {
  return async <T>(input: { parse: (raw: unknown) => T }) => {
    const value = input.parse(returnValue);
    return { sessionId: "ses-test", raw: returnValue, value };
  };
}

function makeWorktreeFakes() {
  const calls: string[] = [];
  const worktreeAdd = async (args: { worktreePath: string }) => {
    calls.push(`add:${args.worktreePath}`);
  };
  const worktreeRemove = async (args: { worktreePath: string }) => {
    calls.push(`remove:${args.worktreePath}`);
  };
  const gitLsFiles: GitLsFilesFn = async () => ["src/hello.ts"];
  const readFileFn: ReadFileFn = async () => undefined;
  return { calls, worktreeAdd, worktreeRemove, gitLsFiles, readFileFn };
}

const FAKE_RULESET = {
  "*": "deny" as const,
  read: "allow" as const,
  glob: "allow" as const,
  grep: "allow" as const,
  list: "allow" as const,
  edit: { "*": "deny" as const },
  bash: { "*": "deny" as const },
  task: "deny" as const,
  webfetch: "deny" as const,
  websearch: "deny" as const,
  skill: "deny" as const,
  external_directory: "deny" as const,
  doom_loop: "deny" as const,
};

// ---------------------------------------------------------------------------
// Core run tests
// ---------------------------------------------------------------------------

test("runLeadPlanCore: valid proposal is returned as-is", async () => {
  const fakes = makeWorktreeFakes();
  const output = await runLeadPlanCore({
    payload: BASE_PAYLOAD,
    runId: "r1",
    env: {},
    ruleset: FAKE_RULESET,
    schema: {},
    leadPromptFn: makeLeadPromptFn(VALID_PROPOSAL),
    worktreeAdd: fakes.worktreeAdd,
    worktreeRemove: fakes.worktreeRemove,
    gitLsFiles: fakes.gitLsFiles,
    readFile: fakes.readFileFn,
    buildPrompt: () => ({ systemContext: "sys", userPrompt: "user" }),
    parseOutput: (raw) => {
      if (typeof raw === "object" && raw !== null && "kind" in raw) return raw as never;
      throw new Error("bad parse");
    },
    timeoutMs: 10_000,
  });
  assert.equal(output.kind, "proposal");
});

test("runLeadPlanCore: garbage output from leadPromptFn → invalid_output", async () => {
  const fakes = makeWorktreeFakes();
  // Return a value that fails the parse function
  const badPromptFn: LeadPromptFn = async <T>(input: { parse: (raw: unknown) => T }) => {
    input.parse({ this_is: "garbage" }); // will throw
    throw new Error("unreachable");
  };
  const output = await runLeadPlanCore({
    payload: BASE_PAYLOAD,
    runId: "r2",
    env: {},
    ruleset: FAKE_RULESET,
    schema: {},
    leadPromptFn: badPromptFn,
    worktreeAdd: fakes.worktreeAdd,
    worktreeRemove: fakes.worktreeRemove,
    gitLsFiles: fakes.gitLsFiles,
    readFile: fakes.readFileFn,
    buildPrompt: () => ({ systemContext: "sys", userPrompt: "user" }),
    parseOutput: (raw) => {
      // Simulate parse failure for garbage input
      if (typeof raw !== "object" || raw === null || !("kind" in raw)) {
        throw new Error("not a LeadPlanOutput shape");
      }
      return raw as never;
    },
    timeoutMs: 10_000,
  });
  assert.equal(output.kind, "invalid_output");
  assert.ok("reason" in output);
});

test("runLeadPlanCore: widened proposal (src/**) is returned as-is — task does not apply subset check", async () => {
  // A proposal that widens paths beyond the authority ceiling should STILL be
  // returned — the task never calls the subset check; that's the coordinator's job.
  const widenedProposal = {
    ...VALID_PROPOSAL,
    proposal: {
      ...VALID_PROPOSAL.proposal,
      paths: { allow: ["src/**"], deny: [] }, // wider than HOST_TRIAL_AUTHORITY.paths.allow
    },
  };
  const fakes = makeWorktreeFakes();
  const output = await runLeadPlanCore({
    payload: BASE_PAYLOAD,
    runId: "r3",
    env: {},
    ruleset: FAKE_RULESET,
    schema: {},
    leadPromptFn: makeLeadPromptFn(widenedProposal),
    worktreeAdd: fakes.worktreeAdd,
    worktreeRemove: fakes.worktreeRemove,
    gitLsFiles: fakes.gitLsFiles,
    readFile: fakes.readFileFn,
    buildPrompt: () => ({ systemContext: "sys", userPrompt: "user" }),
    parseOutput: (raw) => raw as never,
    timeoutMs: 10_000,
  });
  // The task returns it regardless — no subset check here
  assert.equal(output.kind, "proposal");
  if (output.kind === "proposal") {
    assert.deepEqual(output.proposal.paths.allow, ["src/**"]);
  }
});

test("runLeadPlanCore: worktree is removed after a successful run", async () => {
  const fakes = makeWorktreeFakes();
  await runLeadPlanCore({
    payload: BASE_PAYLOAD,
    runId: "r4",
    env: {},
    ruleset: FAKE_RULESET,
    schema: {},
    leadPromptFn: makeLeadPromptFn(VALID_PROPOSAL),
    worktreeAdd: fakes.worktreeAdd,
    worktreeRemove: fakes.worktreeRemove,
    gitLsFiles: fakes.gitLsFiles,
    readFile: fakes.readFileFn,
    buildPrompt: () => ({ systemContext: "sys", userPrompt: "user" }),
    parseOutput: (raw) => raw as never,
    timeoutMs: 10_000,
  });
  const removeCalls = fakes.calls.filter((c) => c.startsWith("remove:"));
  assert.equal(removeCalls.length, 1, "worktree should be removed exactly once");
  assert.match(removeCalls[0] ?? "", /lead\/wi-001-r4/);
});

test("runLeadPlanCore: worktree is removed even when leadPromptFn throws", async () => {
  const fakes = makeWorktreeFakes();
  const throwingFn: LeadPromptFn = async () => {
    throw new Error("SDK exploded");
  };
  const output = await runLeadPlanCore({
    payload: BASE_PAYLOAD,
    runId: "r5",
    env: {},
    ruleset: FAKE_RULESET,
    schema: {},
    leadPromptFn: throwingFn,
    worktreeAdd: fakes.worktreeAdd,
    worktreeRemove: fakes.worktreeRemove,
    gitLsFiles: fakes.gitLsFiles,
    readFile: fakes.readFileFn,
    buildPrompt: () => ({ systemContext: "sys", userPrompt: "user" }),
    parseOutput: (raw) => raw as never,
    timeoutMs: 10_000,
  });
  // Should be invalid_output, not a thrown error
  assert.equal(output.kind, "invalid_output");
  const removeCalls = fakes.calls.filter((c) => c.startsWith("remove:"));
  assert.equal(removeCalls.length, 1, "worktree must be removed even on error");
});

// ---------------------------------------------------------------------------
// Source grep: no subset-check import in lead-plan.ts
// ---------------------------------------------------------------------------

test("lead-plan.ts does not import any authority subset-check function", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const leadPlanSrc = await readFile(join(root, "src/tasks/lead-plan.ts"), "utf8");
  // Subset-check function names from contracts/src/path-pattern.ts
  const forbiddenPatterns = [
    "pathSetSubset",
    "patternSubset",
    "denySetCovers",
    "subsetOf",
    "authority-subset",
    "subsetCheck",
  ];
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(
      leadPlanSrc,
      new RegExp(pattern),
      `lead-plan.ts must not reference subset-check symbol: ${pattern}`,
    );
  }
});
