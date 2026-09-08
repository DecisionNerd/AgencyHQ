import assert from "node:assert/strict";
import test from "node:test";

import { HOST_TRIAL_AUTHORITY } from "../src/authority.ts";
import {
  leadAgentPermissions,
  PermissionRulesetSchema,
  permissionRulesFor,
  runConfigFor,
  WORKER_ALWAYS_DENY_BASH,
  WORKER_ALWAYS_DENY_PATHS,
} from "../src/opencode/permissions.ts";
import type { ContractBounds } from "../src/step-contract.ts";

// ---------------------------------------------------------------------------
// Fixture: ContractBounds derived from HOST_TRIAL_AUTHORITY
// ---------------------------------------------------------------------------

const TRIAL_BOUNDS: ContractBounds = {
  paths: HOST_TRIAL_AUTHORITY.paths,
  capabilities: HOST_TRIAL_AUTHORITY.capabilities,
  boundary: "artifact",
  budget: HOST_TRIAL_AUTHORITY.budget,
  review: "adversarial",
  changeClass: "behavior",
  models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
};

const WORKTREE = "/worktrees/test-attempt";

// ---------------------------------------------------------------------------
// (a) Worker ruleset never allows WORKER_ALWAYS_DENY_BASH / WORKER_ALWAYS_DENY_PATHS
// ---------------------------------------------------------------------------

test("permissionRulesFor: bash map never has allow for WORKER_ALWAYS_DENY_BASH patterns", () => {
  const ruleset = permissionRulesFor(TRIAL_BOUNDS, { worktreePath: WORKTREE });
  for (const pattern of WORKER_ALWAYS_DENY_BASH) {
    const action = ruleset.bash[pattern];
    assert.notEqual(
      action,
      "allow",
      `WORKER_ALWAYS_DENY_BASH pattern "${pattern}" must not be "allow" in bash map (got "${action}")`,
    );
  }
});

test("permissionRulesFor: edit map never has allow for WORKER_ALWAYS_DENY_PATHS patterns", () => {
  const ruleset = permissionRulesFor(TRIAL_BOUNDS, { worktreePath: WORKTREE });
  for (const glob of WORKER_ALWAYS_DENY_PATHS) {
    // Check both relative and absolute forms.
    const relAction = ruleset.edit[glob];
    const absAction = ruleset.edit[`${WORKTREE}/${glob}`];
    assert.notEqual(
      relAction,
      "allow",
      `WORKER_ALWAYS_DENY_PATHS pattern "${glob}" (relative) must not be "allow" in edit map`,
    );
    assert.notEqual(
      absAction,
      "allow",
      `WORKER_ALWAYS_DENY_PATHS pattern "${glob}" (absolute) must not be "allow" in edit map`,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) task and external_directory are always deny, even if crafted bounds says otherwise
// ---------------------------------------------------------------------------

test("permissionRulesFor: task is always deny even when bounds.capabilities.tools has no task key", () => {
  const ruleset = permissionRulesFor(TRIAL_BOUNDS, { worktreePath: WORKTREE });
  assert.equal(ruleset.task, "deny");
});

test("permissionRulesFor: task is always deny even when crafted bounds sets tools.task=true", () => {
  const craftedBounds: ContractBounds = {
    ...TRIAL_BOUNDS,
    capabilities: {
      ...TRIAL_BOUNDS.capabilities,
      tools: { ...TRIAL_BOUNDS.capabilities.tools, task: true },
    },
  };
  const ruleset = permissionRulesFor(craftedBounds, { worktreePath: WORKTREE });
  assert.equal(ruleset.task, "deny");
});

test("permissionRulesFor: external_directory is always deny even when crafted bounds sets it true", () => {
  const craftedBounds: ContractBounds = {
    ...TRIAL_BOUNDS,
    capabilities: {
      ...TRIAL_BOUNDS.capabilities,
      tools: { ...TRIAL_BOUNDS.capabilities.tools, external_directory: true },
    },
  };
  const ruleset = permissionRulesFor(craftedBounds, { worktreePath: WORKTREE });
  assert.equal(ruleset.external_directory, "deny");
});

// ---------------------------------------------------------------------------
// (c) edit map has allow for exactly the contract globs in both forms
// ---------------------------------------------------------------------------

test("permissionRulesFor: edit map allows each paths.allow glob in both relative and absolute forms", () => {
  const ruleset = permissionRulesFor(TRIAL_BOUNDS, { worktreePath: WORKTREE });
  for (const glob of TRIAL_BOUNDS.paths.allow) {
    assert.equal(ruleset.edit[glob], "allow", `edit["${glob}"] should be "allow"`);
    assert.equal(
      ruleset.edit[`${WORKTREE}/${glob}`],
      "allow",
      `edit["${WORKTREE}/${glob}"] should be "allow"`,
    );
  }
});

test("permissionRulesFor: edit map has no allow entries beyond the contract globs", () => {
  const ruleset = permissionRulesFor(TRIAL_BOUNDS, { worktreePath: WORKTREE });
  const allowEntries = Object.entries(ruleset.edit).filter(([, v]) => v === "allow");
  // Expected: 2 globs × 2 forms = 4 allow entries
  const expectedCount = TRIAL_BOUNDS.paths.allow.length * 2;
  assert.equal(
    allowEntries.length,
    expectedCount,
    `Expected ${expectedCount} allow entries in edit map, got ${allowEntries.length}: ${JSON.stringify(allowEntries)}`,
  );
});

// ---------------------------------------------------------------------------
// (d) Key order is deterministic across calls with shuffled input arrays
// ---------------------------------------------------------------------------

test("permissionRulesFor: output is deterministic regardless of input array order", () => {
  const boundsA: ContractBounds = {
    ...TRIAL_BOUNDS,
    paths: {
      allow: ["test/parser/**", "src/parser/**"],
      deny: ["package.json", ".github/**"],
    },
  };
  const boundsB: ContractBounds = {
    ...TRIAL_BOUNDS,
    paths: {
      allow: ["src/parser/**", "test/parser/**"],
      deny: [".github/**", "package.json"],
    },
  };
  const rulesetA = permissionRulesFor(boundsA, { worktreePath: WORKTREE });
  const rulesetB = permissionRulesFor(boundsB, { worktreePath: WORKTREE });
  assert.equal(
    JSON.stringify(rulesetA),
    JSON.stringify(rulesetB),
    "permissionRulesFor output must be identical for equivalent bounds with shuffled arrays",
  );
});

// ---------------------------------------------------------------------------
// Structural compatibility: satisfies PermissionRulesetSchema and
// contains every key the spike's trigger/src/lib/opencode.ts ruleset contains.
// ---------------------------------------------------------------------------

const SPIKE_EXPECTED_KEYS = [
  "*",
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "bash",
  "task",
  "webfetch",
  "websearch",
  "skill",
  "external_directory",
  "doom_loop",
] as const;

test("permissionRulesFor: generated ruleset satisfies PermissionRulesetSchema", () => {
  const ruleset = permissionRulesFor(TRIAL_BOUNDS, { worktreePath: WORKTREE });
  const result = PermissionRulesetSchema.safeParse(ruleset);
  assert.equal(result.success, true, JSON.stringify(result));
});

test("permissionRulesFor: generated ruleset contains every key from the spike ruleset", () => {
  const ruleset = permissionRulesFor(TRIAL_BOUNDS, { worktreePath: WORKTREE });
  for (const key of SPIKE_EXPECTED_KEYS) {
    assert.ok(
      key in ruleset,
      `Ruleset is missing key "${key}" (required by spike's buildPermissionRuleset)`,
    );
  }
});

// ---------------------------------------------------------------------------
// Lead ruleset tests
// ---------------------------------------------------------------------------

test("leadAgentPermissions: edit is fully denied", () => {
  const ruleset = leadAgentPermissions();
  assert.equal(ruleset.edit["*"], "deny");
  // No allow entries in edit map.
  const allowEntries = Object.entries(ruleset.edit).filter(([, v]) => v === "allow");
  assert.equal(
    allowEntries.length,
    0,
    `edit map should have no allow entries, found: ${JSON.stringify(allowEntries)}`,
  );
});

test("leadAgentPermissions: WORKER_ALWAYS_DENY_BASH patterns are not allowed in bash map", () => {
  const ruleset = leadAgentPermissions();
  for (const pattern of WORKER_ALWAYS_DENY_BASH) {
    const action = ruleset.bash[pattern];
    assert.notEqual(
      action,
      "allow",
      `Lead bash map must not allow "${pattern}" (WORKER_ALWAYS_DENY_BASH pattern)`,
    );
  }
});

test("leadAgentPermissions: git diff* is allowed in bash map", () => {
  const ruleset = leadAgentPermissions();
  assert.equal(ruleset.bash["git diff*"], "allow");
});

test("leadAgentPermissions: satisfies PermissionRulesetSchema", () => {
  const ruleset = leadAgentPermissions();
  const result = PermissionRulesetSchema.safeParse(ruleset);
  assert.equal(result.success, true, JSON.stringify(result));
});

// ---------------------------------------------------------------------------
// runConfigFor shape test
// ---------------------------------------------------------------------------

test("runConfigFor: produces correct config shape for worker agent", () => {
  const ruleset = permissionRulesFor(TRIAL_BOUNDS, { worktreePath: WORKTREE });
  const config = runConfigFor({
    model: "openai/gpt-5.6-terra",
    agentName: "worker",
    ruleset,
    disableMcp: ["jean", "t3-coordinator"],
  });

  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.equal(config.share, "disabled");
  assert.equal(config.autoupdate, false);
  assert.deepEqual(config.permission, ruleset);

  const agent = config.agent as Record<string, unknown>;
  assert.ok("worker" in agent, "agent should have 'worker' key");
  const workerAgent = agent.worker as Record<string, unknown>;
  assert.equal(workerAgent.mode, "primary");
  assert.equal(workerAgent.model, "openai/gpt-5.6-terra");
  assert.deepEqual(workerAgent.permission, ruleset);

  const mcp = config.mcp as Record<string, unknown>;
  assert.deepEqual(mcp.jean, { enabled: false });
  assert.deepEqual(mcp["t3-coordinator"], { enabled: false });
});

test("runConfigFor: produces correct config shape for agencyhq-lead agent", () => {
  const ruleset = leadAgentPermissions();
  const config = runConfigFor({
    model: "openai/gpt-5.6-sol",
    agentName: "agencyhq-lead",
    ruleset,
    disableMcp: [],
  });

  const agent = config.agent as Record<string, unknown>;
  assert.ok("agencyhq-lead" in agent, "agent should have 'agencyhq-lead' key");
  const leadAgent = agent["agencyhq-lead"] as Record<string, unknown>;
  assert.equal(leadAgent.mode, "primary");
  assert.equal(leadAgent.model, "openai/gpt-5.6-sol");
});

// ---------------------------------------------------------------------------
// F-9: Lead ruleset — removed allows are absent (regression)
// ---------------------------------------------------------------------------

// These patterns were considered for the Lead but must NOT be allowed.
// If any of them appear as "allow" in the bash map, a regression has occurred.
const LEAD_FORBIDDEN_BASH_PATTERNS = [
  "cat *",
  "head *",
  "tail *",
  "pnpm test*",
  "pnpm typecheck*",
  "node --test*",
];

test("leadAgentPermissions: forbidden bash patterns (cat, head, tail, pnpm test*, pnpm typecheck*, node --test*) are absent or deny", () => {
  const ruleset = leadAgentPermissions();
  for (const pattern of LEAD_FORBIDDEN_BASH_PATTERNS) {
    const action = ruleset.bash[pattern];
    assert.notEqual(
      action,
      "allow",
      `Lead bash map must not allow "${pattern}" — it must be absent (undefined) or "deny", got "${String(action)}"`,
    );
  }
});

// The exact set of bash allows defined in leadAgentPermissions() as of
// 2026-09-07. Enumerate them from the source to detect accidental additions
// or removals.
const LEAD_ALLOWED_BASH_PATTERNS = [
  "git status*",
  "git diff*",
  "git log*",
  "git show*",
  "git ls-files*",
  "ls*",
  "wc *",
  "rg *",
  "grep *",
  "find *",
] as const;

test("leadAgentPermissions: exactly the read-only git/ls patterns are allowed in bash map", () => {
  const ruleset = leadAgentPermissions();

  // Every pattern in the canonical allow list must be "allow".
  for (const pattern of LEAD_ALLOWED_BASH_PATTERNS) {
    assert.equal(ruleset.bash[pattern], "allow", `Lead bash map must allow "${pattern}"`);
  }

  // No entry other than these and WORKER_ALWAYS_DENY_BASH (which are "deny")
  // should be "allow".
  const allowEntries = Object.entries(ruleset.bash).filter(([, v]) => v === "allow");
  const allowKeys = allowEntries.map(([k]) => k).sort();
  const expectedKeys = [...LEAD_ALLOWED_BASH_PATTERNS].sort();
  assert.deepEqual(
    allowKeys,
    expectedKeys,
    `Lead bash map allow keys must be exactly ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(allowKeys)}`,
  );
});
