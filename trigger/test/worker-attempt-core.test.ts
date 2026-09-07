import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WORKER_ALWAYS_DENY_BASH, WORKER_ALWAYS_DENY_PATHS } from "@agencyhq/contracts";
import { writeRunConfig } from "../src/lib/opencode.ts";
import type { KillTreeResult, RunState, StopDeps } from "../src/tasks/worker-attempt-core.ts";
import {
  buildOutput,
  checkpointAndKill,
  enforceAlwaysDeny,
  getRunState,
  outcomeFromViolations,
  registerRunState,
  resolveModel,
  resolveRunDir,
  resolveWorkerRuleset,
  resolveWorktreePath,
} from "../src/tasks/worker-attempt-core.ts";

test("resolveWorktreePath joins worktreeBase, attempts, and the attempt id", () => {
  assert.equal(
    resolveWorktreePath({ worktreeBase: "/srv/agencyhq", attemptId: "a-1" }),
    "/srv/agencyhq/attempts/a-1",
  );
});

test("resolveRunDir joins worktreeBase, runs, and the attempt id (outside the worktree)", () => {
  assert.equal(
    resolveRunDir({ worktreeBase: "/srv/agencyhq", attemptId: "a-1" }),
    "/srv/agencyhq/runs/a-1",
  );
  assert.notEqual(
    resolveRunDir({ worktreeBase: "/srv/agencyhq", attemptId: "a-1" }),
    resolveWorktreePath({ worktreeBase: "/srv/agencyhq", attemptId: "a-1" }),
  );
});

test("outcomeFromViolations maps an empty violation list to completed", () => {
  assert.equal(outcomeFromViolations([]), "completed");
});

test("outcomeFromViolations maps any violation to path_violation", () => {
  assert.equal(outcomeFromViolations(["secrets/leak.txt"]), "path_violation");
});

test("buildOutput returns the fields it was given plus sessionId and a default report", () => {
  const output = buildOutput({
    attemptId: "a-1",
    outcome: "completed",
    worktreePath: "/srv/agencyhq/attempts/a-1",
    runDir: "/srv/agencyhq/runs/a-1",
    commitId: "deadbeef",
    diffDigest: "digest",
    changedPaths: ["src/hello.ts"],
    pathViolations: [],
    checkpointCommit: null,
    survivors: [],
    opencode: { sessionID: "s-1", exitCode: 0, denials: [], errors: [] },
  });

  assert.deepEqual(output, {
    attemptId: "a-1",
    sessionId: "s-1",
    report: {
      attempted: "",
      outputs: ["src/hello.ts"],
      checksRun: [],
      unmetCriteria: [],
      limitations: [],
      findings: [],
    },
    outcome: "completed",
    worktreePath: "/srv/agencyhq/attempts/a-1",
    runDir: "/srv/agencyhq/runs/a-1",
    commitId: "deadbeef",
    diffDigest: "digest",
    changedPaths: ["src/hello.ts"],
    pathViolations: [],
    checkpointCommit: null,
    survivors: [],
    opencode: { sessionID: "s-1", exitCode: 0, denials: [], errors: [] },
  });
});

function fakeState(overrides: Partial<RunState> = {}): RunState {
  return {
    pid: 111,
    pgid: 111,
    worktreePath: "/srv/agencyhq/attempts/a-1",
    repoPath: "/srv/agencyhq/repo",
    attemptId: "a-1",
    cancelled: false,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<StopDeps> = {}): { deps: StopDeps; calls: string[] } {
  const calls: string[] = [];
  const killResult: KillTreeResult = { terminated: [111], killed: [], survivors: [] };
  const deps: StopDeps = {
    commitTree: async () => {
      calls.push("commitTree");
      return "checkpointsha";
    },
    updateRef: async () => {
      calls.push("updateRef");
    },
    killTree: async () => {
      calls.push("killTree");
      return killResult;
    },
    survivorScan: async () => {
      calls.push("survivorScan");
      return [];
    },
    ...overrides,
  };
  return { deps, calls };
}

test("checkpointAndKill returns null when no state is registered for the run id", async () => {
  const states = new Map<string, RunState>();
  const { deps } = fakeDeps();
  const result = await checkpointAndKill(states, "missing-run", "kill-first", deps);
  assert.equal(result, null);
});

test("checkpointAndKill runs kill before checkpoint for the kill-first order", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());
  const { deps, calls } = fakeDeps();

  const result = await checkpointAndKill(states, "run-1", "kill-first", deps);

  assert.deepEqual(calls, ["killTree", "commitTree", "updateRef", "survivorScan"]);
  assert.deepEqual(result, { checkpointCommit: "checkpointsha", survivors: [], killed: false });
});

test("checkpointAndKill runs checkpoint before kill for the checkpoint-first order", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());
  const { deps, calls } = fakeDeps();

  await checkpointAndKill(states, "run-1", "checkpoint-first", deps);

  assert.deepEqual(calls, ["commitTree", "updateRef", "killTree", "survivorScan"]);
});

test("checkpointAndKill does not call updateRef when commitTree has nothing to commit", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());
  const { deps, calls } = fakeDeps({
    commitTree: async () => {
      calls.push("commitTree");
      return null;
    },
  });

  const result = await checkpointAndKill(states, "run-1", "checkpoint-first", deps);

  assert.deepEqual(calls, ["commitTree", "killTree", "survivorScan"]);
  assert.equal(result?.checkpointCommit, null);
});

test("checkpointAndKill is idempotent: a second call returns the first call's result", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());
  const { deps, calls } = fakeDeps();

  const first = await checkpointAndKill(states, "run-1", "kill-first", deps);
  const second = await checkpointAndKill(states, "run-1", "checkpoint-first", deps);

  assert.notEqual(first, null);
  // The late caller gets the same completed result rather than null, so a
  // hook that arrives second still waits for the kill to finish.
  assert.deepEqual(second, first);
  // Only the first call's steps ran; the second did not repeat the kill or
  // the commit.
  assert.deepEqual(calls, ["killTree", "commitTree", "updateRef", "survivorScan"]);
  assert.equal(getRunState(states, "run-1")?.cancelled, true);
});

test("checkpointAndKill is idempotent under concurrent callers racing on the same run id", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());

  let killCalls = 0;
  let commitCalls = 0;
  const deps: StopDeps = {
    commitTree: async () => {
      commitCalls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "checkpointsha";
    },
    updateRef: async () => {},
    killTree: async () => {
      killCalls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { terminated: [], killed: [], survivors: [] };
    },
    survivorScan: async () => [],
  };

  // Both the run()-scoped abort listener (kill-first) and the onCancel hook
  // (checkpoint-first) can reach this in the same tick; only one may
  // actually run the sequence.
  const [fromAbortListener, fromOnCancel] = await Promise.all([
    checkpointAndKill(states, "run-1", "kill-first", deps),
    checkpointAndKill(states, "run-1", "checkpoint-first", deps),
  ]);

  // Both callers observe the single completed sequence: the loser awaits the
  // winner's promise instead of returning early (trial item 2, 2026-09-07:
  // an early-returning onCancel let Trigger kill the task process mid-kill).
  assert.notEqual(fromAbortListener, null);
  assert.deepEqual(fromOnCancel, fromAbortListener);
  assert.equal(killCalls, 1);
  assert.equal(commitCalls, 1);
});

// ---------------------------------------------------------------------------
// resolveWorkerRuleset tests (G-3)
// ---------------------------------------------------------------------------

const SAMPLE_CONTRACT_RULESET = {
  "*": "deny" as const,
  read: "allow" as const,
  glob: "allow" as const,
  grep: "allow" as const,
  list: "allow" as const,
  edit: {
    "*": "deny" as const,
    "src/a.ts": "allow" as const,
  },
  bash: {
    "*": "deny" as const,
    "pnpm test*": "allow" as const,
  },
  task: "deny" as const,
  webfetch: "deny" as const,
  websearch: "deny" as const,
  skill: "deny" as const,
  external_directory: "deny" as const,
  doom_loop: "deny" as const,
};

test("resolveWorkerRuleset: source is always 'contract'", () => {
  const { source } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  assert.equal(source, "contract");
});

test("resolveWorkerRuleset: bash allow entry from contract is preserved", () => {
  const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  assert.equal(ruleset.bash["pnpm test*"], "allow");
});

test("resolveWorkerRuleset: bash default deny from contract is preserved", () => {
  const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  assert.equal(ruleset.bash["*"], "deny");
});

test("resolveWorkerRuleset: edit allow entry from contract is preserved", () => {
  const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  assert.equal(ruleset.edit["src/a.ts"], "allow");
});

test("resolveWorkerRuleset: all WORKER_ALWAYS_DENY_BASH entries are denied", () => {
  const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  for (const pattern of WORKER_ALWAYS_DENY_BASH) {
    assert.equal(
      ruleset.bash[pattern],
      "deny",
      `WORKER_ALWAYS_DENY_BASH pattern "${pattern}" must be "deny" (got "${ruleset.bash[pattern]}")`,
    );
  }
});

test("resolveWorkerRuleset: all WORKER_ALWAYS_DENY_PATHS entries are denied in edit map", () => {
  const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  for (const glob of WORKER_ALWAYS_DENY_PATHS) {
    assert.equal(
      ruleset.edit[glob],
      "deny",
      `WORKER_ALWAYS_DENY_PATHS pattern "${glob}" must be "deny" in edit map (got "${ruleset.edit[glob]}")`,
    );
  }
});

test("resolveWorkerRuleset: edit denies opencode.json* and .opencode/**", () => {
  const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  assert.equal(ruleset.edit["opencode.json*"], "deny");
  assert.equal(ruleset.edit[".opencode/**"], "deny");
});

test("resolveWorkerRuleset: task is always deny even if contract set it allow", () => {
  const maliciousRuleset = { ...SAMPLE_CONTRACT_RULESET, task: "allow" as const };
  const { ruleset } = resolveWorkerRuleset({ permissionRules: maliciousRuleset });
  assert.equal(ruleset.task, "deny");
});

test("resolveWorkerRuleset: external_directory is always deny even if contract set it allow", () => {
  const maliciousRuleset = { ...SAMPLE_CONTRACT_RULESET, external_directory: "allow" as const };
  const { ruleset } = resolveWorkerRuleset({ permissionRules: maliciousRuleset });
  assert.equal(ruleset.external_directory, "deny");
});

test("resolveWorkerRuleset: webfetch propagated from contract (deny)", () => {
  const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  assert.equal(ruleset.webfetch, "deny");
});

test("resolveWorkerRuleset: websearch propagated from contract (deny)", () => {
  const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
  assert.equal(ruleset.websearch, "deny");
});

test("resolveWorkerRuleset: malicious bash allow for *git push* is overridden to deny", () => {
  const maliciousRuleset = {
    ...SAMPLE_CONTRACT_RULESET,
    bash: { ...SAMPLE_CONTRACT_RULESET.bash, "*git push*": "allow" as const },
  };
  const { ruleset } = resolveWorkerRuleset({ permissionRules: maliciousRuleset });
  assert.equal(ruleset.bash["*git push*"], "deny");
});

test("resolveWorkerRuleset: throws when permissionRules is absent at runtime", () => {
  assert.throws(
    () =>
      resolveWorkerRuleset({ permissionRules: undefined } as unknown as {
        permissionRules: typeof SAMPLE_CONTRACT_RULESET;
      }),
    /permissionRules is required/,
  );
});

test("resolveWorkerRuleset: throws when permissionRules is null at runtime", () => {
  assert.throws(
    () =>
      resolveWorkerRuleset({ permissionRules: null } as unknown as {
        permissionRules: typeof SAMPLE_CONTRACT_RULESET;
      }),
    /permissionRules is required/,
  );
});

// ---------------------------------------------------------------------------
// enforceAlwaysDeny: malicious allow entries are overridden
// ---------------------------------------------------------------------------

test("enforceAlwaysDeny: all WORKER_ALWAYS_DENY_BASH entries overridden to deny even if allow in input", () => {
  const maliciousBash: Record<string, "allow" | "deny"> = { "*": "allow" };
  for (const pattern of WORKER_ALWAYS_DENY_BASH) {
    maliciousBash[pattern] = "allow";
  }
  const input = { ...SAMPLE_CONTRACT_RULESET, bash: maliciousBash };
  const result = enforceAlwaysDeny(input);
  for (const pattern of WORKER_ALWAYS_DENY_BASH) {
    assert.equal(
      result.bash[pattern],
      "deny",
      `enforceAlwaysDeny must override "${pattern}" to deny`,
    );
  }
});

test("enforceAlwaysDeny: all WORKER_ALWAYS_DENY_PATHS entries overridden to deny even if allow in input", () => {
  const maliciousEdit: Record<string, "allow" | "deny"> = { "*": "deny" };
  for (const glob of WORKER_ALWAYS_DENY_PATHS) {
    maliciousEdit[glob] = "allow";
  }
  const input = { ...SAMPLE_CONTRACT_RULESET, edit: maliciousEdit };
  const result = enforceAlwaysDeny(input);
  for (const glob of WORKER_ALWAYS_DENY_PATHS) {
    assert.equal(
      result.edit[glob],
      "deny",
      `enforceAlwaysDeny must override "${glob}" to deny in edit map`,
    );
  }
});

// ---------------------------------------------------------------------------
// writeRunConfig round-trip: ruleset written and read back correctly (G-3)
// ---------------------------------------------------------------------------

test("writeRunConfig: permission field in opencode.worker.json matches the ruleset exactly", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "agencyhq-writerunconfig-test-"));
  try {
    const { ruleset } = resolveWorkerRuleset({ permissionRules: SAMPLE_CONTRACT_RULESET });
    await writeRunConfig({ runDir: tmpDir, model: "openai/gpt-5.6-terra", ruleset });

    const configPath = join(tmpDir, "opencode.worker.json");
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw) as { permission: unknown };

    assert.deepEqual(
      config.permission,
      ruleset,
      "permission in opencode.worker.json must deep-equal the ruleset passed to writeRunConfig",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveModel: CR-9
// ---------------------------------------------------------------------------

test("resolveModel: returns payloadModel when both payload and env are set (payload wins)", () => {
  const result = resolveModel({
    payloadModel: "provider/model-payload",
    envModel: "provider/model-env",
  });
  assert.equal(result, "provider/model-payload");
});

test("resolveModel: returns envModel when payloadModel is undefined", () => {
  const result = resolveModel({ payloadModel: undefined, envModel: "provider/model-env" });
  assert.equal(result, "provider/model-env");
});

test("resolveModel: returns envModel when payloadModel is null", () => {
  const result = resolveModel({ payloadModel: null, envModel: "provider/model-env" });
  assert.equal(result, "provider/model-env");
});

test("resolveModel: throws when both payloadModel and envModel are absent", () => {
  assert.throws(
    () => resolveModel({ payloadModel: undefined, envModel: undefined }),
    /no model configured/,
  );
});

test("resolveModel: throws when payloadModel is null and envModel is undefined", () => {
  assert.throws(
    () => resolveModel({ payloadModel: null, envModel: undefined }),
    /no model configured/,
  );
});

test("resolveModel: error message references payload.model and AGENCYHQ_OPENCODE_MODEL", () => {
  let message = "";
  try {
    resolveModel({ payloadModel: undefined, envModel: undefined });
  } catch (e: unknown) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert.ok(message.includes("payload.model"), "error should mention payload.model");
  assert.ok(
    message.includes("AGENCYHQ_OPENCODE_MODEL"),
    "error should mention AGENCYHQ_OPENCODE_MODEL",
  );
});
