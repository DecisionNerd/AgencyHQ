/**
 * Integration tests: verify.run integrity field consumed by onVerifyFinal (issue #6).
 *
 * Tests:
 * (1) Adapter and coordinator agree on one tampered path → exactly one finding set
 *     (no duplicates), evidence records both sides.
 * (2) Adapter omits integrity field → coordinator's set used unchanged (backward compat).
 * (3) Adapter reports a path coordinator does not (or vice versa) → union written,
 *     evidence records both sides, all findings are blocking.
 *
 * See also flow.options.test.ts Test 5 for the lead.plan tags assertion (issue #8).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import { goodPlanOutput, workerCompletedOutput } from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));

// Profile whose protectedPaths list only "package.json" — predictable coordinator behaviour.
function makeProfileResolver(protectedPaths: string[]) {
  return async (_profileId: string) => ({
    digest: FAKE_PROFILE_DIGEST,
    checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
    protectedPaths,
  });
}

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

function makeFlowDeps(
  pool: ReturnType<typeof createPool>,
  fake: FakeExecutionRuntime,
  protectedPaths: string[],
): FlowDeps {
  return {
    pool,
    runtime: fake,
    clock,
    ids,
    profile: {
      id: "host",
      enforcement: {
        worktree: "before_action",
        fs_isolation: "advisory",
        cpu_memory: "advisory",
        duration: "before_action",
        capability: "before_action",
        output_paths: "on_output",
        push: "before_action",
        integrate: "before_action",
        termination: "trusted_observation",
        egress_spend: "advisory",
        nested_agents: "before_action",
      },
    },
    config: {
      worktreeBase: "/worktrees",
      workerModel: "openai/gpt-5.6-terra",
      leadModel: "openai/gpt-5.6-sol",
      reviewerModel: "openai/gpt-5.6-sol",
      verifierName: "agencyhq-verifier",
    },
    profileResolver: makeProfileResolver(protectedPaths),
  };
}

// ---------------------------------------------------------------------------
// Shared setup: run plan → onLeadPlanOutput → advance worker → return runId
// ---------------------------------------------------------------------------

async function runUntilVerifyDispatched(
  pool: ReturnType<typeof createPool>,
  fake: FakeExecutionRuntime,
  workItemId: string,
  changedPaths: string[],
  client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  protectedPaths: string[],
): Promise<{ flow: BoundedRepairFlow; verifyRunId: string }> {
  const deps = makeFlowDeps(pool, fake, protectedPaths);
  const flow = new BoundedRepairFlow(deps);

  fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));

  const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, newId("cmd"));
  fake.advance(planRunId);
  fake.advance(planRunId);

  const workerOutput = workerCompletedOutput("placeholder", {
    commitId: "cafebabe1234567890cafebabe1234567890cafe",
    changedPaths,
  });
  fake.script(TASK_IDS.workerAttempt, () => ({ status: "COMPLETED", output: workerOutput }));

  await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

  const { rows: workerIntents } = await client.query(
    "SELECT run_id FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.workerAttempt],
  );
  const workerRunId = (workerIntents[0] as { run_id: string }).run_id;

  fake.advance(workerRunId);
  fake.advance(workerRunId);
  const workerObs = await fake.retrieve(workerRunId);
  await flow.onWorkerFinal(workerObs, newId("cmd"));

  const { rows: verifyIntents } = await client.query(
    "SELECT run_id FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.verifyRun],
  );
  const verifyRunId = (verifyIntents[0] as { run_id: string }).run_id;

  return { flow, verifyRunId };
}

// ---------------------------------------------------------------------------
// Test 1: adapter and coordinator agree → one finding set, evidence shows both
// ---------------------------------------------------------------------------

test("flow.integrity (1): adapter and coordinator agree on one tampered path → one finding, evidence records both", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      const PROTECTED = ["package.json"];
      const TAMPERED_PATH = "package.json";

      // Adapter agrees with coordinator: both detect package.json
      fake.script(TASK_IDS.verifyRun, () => ({
        status: "COMPLETED" as const,
        output: {
          results: [],
          integrity: {
            tamperedPaths: [TAMPERED_PATH],
            protectedPathsSource: "payload" as const,
          },
        },
      }));
      fake.script(TASK_IDS.leadReview, () => ({ status: "QUEUED" }));

      const { flow, verifyRunId } = await runUntilVerifyDispatched(
        pool,
        fake,
        workItemId,
        [TAMPERED_PATH, "src/parser/parse.ts"],
        client,
        PROTECTED,
      );

      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);
      await flow.onVerifyFinal(verifyObs, newId("cmd"));

      const { rows: findings } = await client.query(
        "SELECT severity, kind, description, evidence FROM findings WHERE kind = 'verifier_tampered'",
      );

      // Exactly one finding for package.json (not duplicated)
      assert.equal(findings.length, 1, "exactly one verifier_tampered finding (no duplicates)");
      const finding = findings[0] as {
        severity: string;
        kind: string;
        description: string;
        evidence: string;
      };

      assert.equal(finding.severity, "blocking", "finding is blocking");
      assert.ok(
        finding.description.includes("package.json"),
        "finding description mentions package.json",
      );

      // Evidence is JSON with both adapter and coordinator lists
      let evidence: { adapter: string[]; coordinator: string[]; protectedPathsSource?: string };
      try {
        evidence = JSON.parse(finding.evidence) as typeof evidence;
      } catch {
        assert.fail(`finding evidence is not valid JSON: ${finding.evidence}`);
      }

      assert.ok(Array.isArray(evidence.adapter), "evidence has adapter array");
      assert.ok(Array.isArray(evidence.coordinator), "evidence has coordinator array");
      assert.ok(
        evidence.adapter.includes(TAMPERED_PATH),
        `evidence.adapter should include ${TAMPERED_PATH}`,
      );
      assert.ok(
        evidence.coordinator.includes(TAMPERED_PATH),
        `evidence.coordinator should include ${TAMPERED_PATH}`,
      );
      assert.equal(
        evidence.protectedPathsSource,
        "payload",
        "evidence records protectedPathsSource from adapter",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: adapter omits integrity → coordinator set used, old evidence format
// ---------------------------------------------------------------------------

test("flow.integrity (2): adapter omits integrity → coordinator set used, finding has plain evidence string", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      const PROTECTED = ["package.json"];
      const TAMPERED_PATH = "package.json";

      // Adapter does NOT include integrity field (pre-H-6 output)
      fake.script(TASK_IDS.verifyRun, () => ({
        status: "COMPLETED" as const,
        output: { results: [] },
      }));
      fake.script(TASK_IDS.leadReview, () => ({ status: "QUEUED" }));

      const { flow, verifyRunId } = await runUntilVerifyDispatched(
        pool,
        fake,
        workItemId,
        [TAMPERED_PATH],
        client,
        PROTECTED,
      );

      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);
      await flow.onVerifyFinal(verifyObs, newId("cmd"));

      const { rows: findings } = await client.query(
        "SELECT severity, kind, description, evidence FROM findings WHERE kind = 'verifier_tampered'",
      );

      // Coordinator still detects the tampered path
      assert.equal(findings.length, 1, "one verifier_tampered finding from coordinator");
      const finding = findings[0] as { severity: string; evidence: string };
      assert.equal(finding.severity, "blocking", "finding is blocking");

      // Evidence is the old plain string format (not enriched JSON with adapter/coordinator)
      let parsed: unknown;
      try {
        parsed = JSON.parse(finding.evidence);
      } catch {
        parsed = null;
      }
      // Either not valid JSON, or doesn't have adapter/coordinator keys
      if (parsed !== null && typeof parsed === "object") {
        assert.ok(
          !("adapter" in (parsed as object)) && !("coordinator" in (parsed as object)),
          "evidence must not have adapter/coordinator keys when adapter omits integrity",
        );
      }
      // Evidence should reference the tampered path in the legacy format
      assert.ok(
        finding.evidence.includes(TAMPERED_PATH),
        `legacy evidence string should mention ${TAMPERED_PATH}`,
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: adapter and coordinator detect different paths → union, all blocking
// ---------------------------------------------------------------------------

test("flow.integrity (3): adapter reports extra path coordinator does not → union finding set, evidence records both sides, all blocking", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      // Coordinator protects only "package.json"; worker changed both paths.
      // Adapter additionally reports "tsconfig.base.json" (not in coordinator's profile rules).
      const PROTECTED = ["package.json"];
      const COORDINATOR_PATH = "package.json";
      const ADAPTER_ONLY_PATH = "tsconfig.base.json";
      const ALL_ADAPTER_PATHS = [COORDINATOR_PATH, ADAPTER_ONLY_PATH];

      fake.script(TASK_IDS.verifyRun, () => ({
        status: "COMPLETED" as const,
        output: {
          results: [],
          integrity: {
            tamperedPaths: ALL_ADAPTER_PATHS,
            protectedPathsSource: "default" as const,
          },
        },
      }));
      fake.script(TASK_IDS.leadReview, () => ({ status: "QUEUED" }));

      const { flow, verifyRunId } = await runUntilVerifyDispatched(
        pool,
        fake,
        workItemId,
        [COORDINATOR_PATH, ADAPTER_ONLY_PATH, "src/parser/parse.ts"],
        client,
        PROTECTED,
      );

      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);
      await flow.onVerifyFinal(verifyObs, newId("cmd"));

      const { rows: findings } = await client.query(
        "SELECT severity, kind, description, evidence FROM findings WHERE kind = 'verifier_tampered'",
      );

      // Union: at least one finding per path in union of {package.json, tsconfig.base.json}
      assert.ok(findings.length >= 2, `expected >= 2 findings for union, got ${findings.length}`);

      // All findings must be blocking
      for (const f of findings as Array<{ severity: string; evidence: string }>) {
        assert.equal(f.severity, "blocking", "all union findings are blocking");

        // Evidence on every finding must record both sides
        let evidence: { adapter: string[]; coordinator: string[]; protectedPathsSource?: string };
        try {
          evidence = JSON.parse(f.evidence) as typeof evidence;
        } catch {
          assert.fail(`evidence is not valid JSON: ${f.evidence}`);
        }
        assert.ok(Array.isArray(evidence.adapter), "evidence has adapter array");
        assert.ok(Array.isArray(evidence.coordinator), "evidence has coordinator array");
        assert.ok(
          evidence.adapter.includes(COORDINATOR_PATH),
          "adapter list includes coordinator-detected path",
        );
        assert.ok(
          evidence.adapter.includes(ADAPTER_ONLY_PATH),
          "adapter list includes adapter-only path",
        );
        assert.ok(
          evidence.coordinator.includes(COORDINATOR_PATH),
          "coordinator list includes coordinator-detected path",
        );
        assert.equal(
          evidence.protectedPathsSource,
          "default",
          "evidence records protectedPathsSource",
        );
      }

      // One finding must describe the adapter-only path
      const adapterOnlyFindings = (findings as Array<{ description: string }>).filter((f) =>
        f.description.includes(ADAPTER_ONLY_PATH),
      );
      assert.ok(
        adapterOnlyFindings.length >= 1,
        `a finding for adapter-only path "${ADAPTER_ONLY_PATH}" must exist`,
      );
    } finally {
      await pool.end();
    }
  });
});
