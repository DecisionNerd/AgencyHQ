// P18.3 C2: v2 adapter tests for lead.plan.
//
// Tests the v2 branch infrastructure:
//   - worktreePath override in runLeadPlanCore wires through to leadPromptFn
//   - source materialization + runLeadPlanCore with injected session
//   - gitLsFiles and readFile use the clone dir
//   - no host path in session dir or file list results

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { LeadPlanOutput, LeadPlanPayload, LeadPlanPayloadV2 } from "@agencyhq/contracts";
import { HOST_TRIAL_AUTHORITY, leadAgentPermissions } from "@agencyhq/contracts";
import { FakeBroker } from "../src/lib/broker.ts";
import { materializeSource } from "../src/lib/source.ts";
import { runLeadPlanV2WithBroker } from "../src/tasks/lead-plan.ts";
import type { LeadPromptFn } from "../src/tasks/lead-plan-core.ts";
import { runLeadPlanCore } from "../src/tasks/lead-plan-core.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agencyhq-plan-v2-"));
}

async function makeSourceBundle(): Promise<{ bundleBytes: Buffer; baseRevision: string }> {
  const repoDir = await makeTmpDir();
  await execFileAsync("git", ["init", repoDir]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "t@t.com"]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "T"]);
  await writeFile(join(repoDir, "AGENTS.md"), "# Agents\nUse TypeScript.");
  await writeFile(join(repoDir, "README.md"), "# Project\nThis is a test project.");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export {};\n");
  await execFileAsync("git", ["-C", repoDir, "add", "-A"]);
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "base"]);
  const { stdout } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  const baseRevision = stdout.trim();

  const bundlePath = join(repoDir, "source.bundle");
  await execFileAsync("git", ["-C", repoDir, "bundle", "create", bundlePath, "--all"]);
  const { readFile } = await import("node:fs/promises");
  const bundleBytes = await readFile(bundlePath);
  await rm(repoDir, { recursive: true, force: true });
  return { bundleBytes, baseRevision };
}

function makeV1Payload(
  baseRevision: string,
  clonedDir: string,
  tempParent: string,
): LeadPlanPayload {
  return {
    payloadVersion: 1,
    workItemId: "work-plan-v2",
    projectId: "proj-plan",
    repoPath: clonedDir,
    baseRevision,
    worktreeBase: tempParent,
    authority: HOST_TRIAL_AUTHORITY,
    operatorIntent: "Add a new function that returns 42.",
    model: "claude-3-5-sonnet-20241022",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("lead-plan v2: worktreePath override causes leadPromptFn to receive clone dir", async () => {
  const { bundleBytes, baseRevision } = await makeSourceBundle();
  const tempParent = await makeTmpDir();
  const cloneDir = join(tempParent, "src");

  try {
    const broker = new FakeBroker();
    broker.bundles.set(`proj-plan:${baseRevision}`, bundleBytes);

    const srcResult = await materializeSource({
      source: { projectId: "proj-plan", revision: baseRevision, bundlePath: "source.bundle" },
      dir: cloneDir,
      broker,
      token: "tok",
    });

    assert.equal(srcResult.ok, true, "source materialization should succeed");
    if (!srcResult.ok) return;

    const clonedDir = srcResult.clonedDir;
    const v1Payload = makeV1Payload(baseRevision, clonedDir, tempParent);

    let sessionDir = "";
    let sessionRunDir = "";

    const output = await runLeadPlanCore({
      payload: v1Payload,
      runId: "run-plan-v2-test",
      env: {},
      ruleset: leadAgentPermissions(),
      schema: {},
      leadPromptFn: (async (input) => {
        sessionDir = input.dir;
        sessionRunDir = input.runDir;
        // Return a minimal valid lead plan output.
        const value: LeadPlanOutput = {
          kind: "invalid_output",
          reason: "Stub: test-only lead plan result.",
        };
        return { value, sessionId: "fake-session", raw: null };
      }) as LeadPromptFn,
      // No worktree needed: clone is already at baseRevision.
      worktreeAdd: async () => {},
      worktreeRemove: async () => {},
      gitLsFiles: async ({ limit }) => {
        // Use the clone dir directly.
        const { stdout } = await execFileAsync("git", ["ls-files"], {
          cwd: clonedDir,
          maxBuffer: 1 * 1024 * 1024,
        });
        return stdout.trim().split("\n").filter(Boolean).slice(0, limit);
      },
      readFile: async (path) => {
        try {
          const { readFile: rf } = await import("node:fs/promises");
          return await rf(path, "utf8");
        } catch {
          return undefined;
        }
      },
      buildPrompt: (_payload, repoContext) => ({
        systemContext: `files: ${repoContext.fileList.join(",")}`,
        userPrompt: "Plan a new feature.",
      }),
      parseOutput: (_raw): LeadPlanOutput => ({
        kind: "invalid_output",
        reason: "Stub: test-only parse output.",
      }),
      onPhase: () => {},
      timeoutMs: 5_000,
      // Override: lead session runs in the clone dir.
      worktreePath: clonedDir,
    });

    // The session must have received the clone dir as its working directory.
    assert.equal(sessionDir, clonedDir, "leadPromptFn dir must be the clone dir");
    // runDir is computed from worktreeBase: ${tempParent}/lead-runs/...
    assert.ok(sessionRunDir.startsWith(tempParent), "runDir is under tempParent");
    // Output should be the plan.
    assert.ok(output !== null);
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
});

test("lead-plan v2: gitLsFiles from clone lists tracked files", async () => {
  const { bundleBytes, baseRevision } = await makeSourceBundle();
  const cloneDir = await makeTmpDir();

  try {
    const broker = new FakeBroker();
    broker.bundles.set(`proj-plan-ls:${baseRevision}`, bundleBytes);

    const srcResult = await materializeSource({
      source: { projectId: "proj-plan-ls", revision: baseRevision, bundlePath: "source.bundle" },
      dir: cloneDir,
      broker,
      token: "tok",
    });
    assert.equal(srcResult.ok, true);
    if (!srcResult.ok) return;

    const clonedDir = srcResult.clonedDir;

    // Run git ls-files directly in the clone.
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: clonedDir,
      maxBuffer: 1 * 1024 * 1024,
    });
    const files = stdout.trim().split("\n").filter(Boolean);

    // The source repo has AGENTS.md, README.md, src/index.ts
    assert.ok(files.includes("AGENTS.md"), "AGENTS.md should be in ls-files");
    assert.ok(files.includes("README.md"), "README.md should be in ls-files");
    assert.ok(files.length > 0, "file list should be non-empty");

    // No host paths in the file list.
    const filesStr = files.join("\n");
    assert.ok(!filesStr.includes("/Users"), "no macOS user paths in file list");
    assert.ok(!filesStr.includes("/home/"), "no linux home paths in file list");
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// X3-6: runLeadPlanV2WithBroker fails loudly on lease refusal.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// X5-3: runLeadPlanV2WithBroker end-to-end with FakeBroker and stub leadPromptFn.
// Verifies: review lease granted, source materialized from served bundle,
// core run with stub lead prompt, proposal output returned.
// ---------------------------------------------------------------------------

test("lead-plan v2 X5-3: runLeadPlanV2WithBroker end-to-end — lease, source, stub prompt, proposal output", async () => {
  const { bundleBytes, baseRevision } = await makeSourceBundle();
  const runRoot = await makeTmpDir();

  const WORK_ITEM_ID = "work-plan-x5-3";
  const PROJECT_ID = "proj-plan-x5-3";

  const broker = new FakeBroker();
  // Review lease: key is "review:<workItemId>" (FakeBroker uses workItemId for plan requests).
  broker.grants.set(`review:${WORK_ITEM_ID}`, {
    leaseId: "lease-x5-3",
    purpose: "review",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: { purpose: "review", token: "review-tok-x5-3" },
  });
  // Source bundle keyed projectId:revision.
  broker.bundles.set(`${PROJECT_ID}:${baseRevision}`, bundleBytes);

  const payload: LeadPlanPayloadV2 = {
    payloadVersion: 2,
    workItemId: WORK_ITEM_ID,
    projectId: PROJECT_ID,
    baseRevision,
    authority: HOST_TRIAL_AUTHORITY,
    operatorIntent: "Add a function that returns 42.",
    model: "claude-3-5-sonnet-20241022",
    source: { projectId: PROJECT_ID, revision: baseRevision, bundlePath: "source.bundle" },
    leaseNonce: "n".repeat(32),
  };

  // Stub leadPromptFn: applies the injected parse function (exercises parseOutput)
  // and returns a well-formed needs_facts output.
  const stubLeadPromptFn: LeadPromptFn = async (input) => {
    const rawOutput = { kind: "needs_facts" as const, questions: ["What is the target scope?"] };
    const value = input.parse(rawOutput);
    return { sessionId: "stub-plan-x5-3", raw: rawOutput, value };
  };

  try {
    const output = await runLeadPlanV2WithBroker(payload, "run-x5-3", broker, runRoot, {
      variant: "low",
      deps: { leadPromptFn: stubLeadPromptFn },
    });

    // Output must be the stub's returned plan kind (needs_facts).
    assert.ok(output !== null, "output must not be null");
    assert.equal(output.kind, "needs_facts", "output kind must match stub's return");
    if (output.kind === "needs_facts") {
      assert.deepEqual(
        output.questions,
        ["What is the target scope?"],
        "questions must match stub output",
      );
    }

    // downloadSourceBundle must have been called at source revision (X5-3: clone materialized).
    const srcCall = broker.calls.find((c) => c.op === "downloadSourceBundle");
    assert.ok(srcCall, "downloadSourceBundle must have been called");
    if (srcCall?.op === "downloadSourceBundle") {
      assert.equal(srcCall.projectId, PROJECT_ID, "source projectId must match");
      assert.equal(srcCall.rev, baseRevision, "source revision must match (clone at baseRevision)");
    }

    // requestLease must have been called with the workItemId.
    const leaseCall = broker.calls.find((c) => c.op === "requestLease");
    assert.ok(leaseCall, "requestLease must have been called");
    if (leaseCall?.op === "requestLease") {
      assert.equal(leaseCall.workItemId, WORK_ITEM_ID, "lease requested for correct workItemId");
    }
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// X3-6: runLeadPlanV2WithBroker fails loudly on lease refusal.
// ---------------------------------------------------------------------------

test("lead-plan v2 X3-6: runLeadPlanV2WithBroker throws on lease refusal (no silent empty token)", async () => {
  // FakeBroker with no grant → requestLease returns unavailable refusal.
  const broker = new FakeBroker();
  const runRoot = await makeTmpDir();

  // Minimal LeadPlanPayloadV2: leaseNonce triggers the lease request.
  const payload: LeadPlanPayloadV2 = {
    payloadVersion: 2,
    workItemId: "work-plan-x3-6",
    projectId: "proj-x3-6",
    baseRevision: "a".repeat(40),
    authority: HOST_TRIAL_AUTHORITY,
    operatorIntent: "Test loud failure on lease refusal.",
    model: "claude-3-5-sonnet-20241022",
    source: { projectId: "proj-x3-6", revision: "a".repeat(40), bundlePath: "source.bundle" },
    leaseNonce: "n".repeat(32),
  };

  try {
    await assert.rejects(
      () => runLeadPlanV2WithBroker(payload, "run-x3-6", broker, runRoot),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return msg.includes("lease refused");
      },
      "runLeadPlanV2WithBroker must throw with 'lease refused' when FakeBroker has no grant",
    );

    // Verify the lease was actually attempted.
    const leaseCall = broker.calls.find((c) => c.op === "requestLease");
    assert.ok(leaseCall, "requestLease must have been called");
    if (leaseCall?.op === "requestLease") {
      assert.equal(
        leaseCall.workItemId,
        "work-plan-x3-6",
        "workItemId passed in lease request (X3-6)",
      );
    }
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
});
