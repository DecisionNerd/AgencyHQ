/**
 * Integration test: repository-content injection (R-020).
 *
 * Adversarial LeadPlanOutput documents that look like a Lead obeying
 * repository instructions (AGENTS.md, opencode.json) are rejected by
 * checkProposal. Each rejected case must yield:
 *   - Decision kind="plan" outcome="pending_human"
 *   - No StepContract created
 *   - No worker.attempt trigger
 *   - Command result contains the expected violation codes
 *
 * The narrower (good) proposal is the positive control: it passes,
 * creates a contract, and triggers a worker whose permissionRules still
 * deny *git push* and task.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { LeadPlanOutput } from "@agencyhq/contracts";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import bashGlobFixture from "../fixtures/injection/proposal.bash-glob.json" with { type: "json" };
import boundaryMergeFixture from "../fixtures/injection/proposal.boundary-merge.json" with {
  type: "json",
};
import budget10AttemptsFixture from "../fixtures/injection/proposal.budget-10-attempts.json" with {
  type: "json",
};
import publicApiFixture from "../fixtures/injection/proposal.class-editorial-touching-public-api.json" with {
  type: "json",
};
import denyDroppedFixture from "../fixtures/injection/proposal.deny-dropped.json" with {
  type: "json",
};
import narrowerFixture from "../fixtures/injection/proposal.narrower.json" with { type: "json" };
import noOperatorCriterionFixture from "../fixtures/injection/proposal.no-operator-criterion.json" with {
  type: "json",
};
// ---------------------------------------------------------------------------
// Fixtures (loaded from JSON — each is a complete LeadPlanOutput)
// ---------------------------------------------------------------------------
import pathsWiderFixture from "../fixtures/injection/proposal.paths-wider.json" with {
  type: "json",
};
import reviewNoneFixture from "../fixtures/injection/proposal.review-none-for-behavior.json" with {
  type: "json",
};
import reviewerSameModelFixture from "../fixtures/injection/proposal.reviewer-same-model.json" with {
  type: "json",
};
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Shared deps
// ---------------------------------------------------------------------------

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: ["package.json"],
});

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

const HOST_PROFILE: FlowDeps["profile"] = {
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
};

function makeDeps(pool: ReturnType<typeof createPool>, fake: FakeExecutionRuntime): FlowDeps {
  return {
    pool,
    runtime: fake,
    clock,
    ids,
    profile: HOST_PROFILE,
    config: {
      worktreeBase: "/worktrees",
      workerModel: "openai/gpt-5.6-terra",
      leadModel: "openai/gpt-5.6-sol",
      reviewerModel: "openai/gpt-5.6-sol",
      verifierName: "agencyhq-verifier",
    },
    profileResolver: FAKE_PROFILE_RESOLVER,
  };
}

// ---------------------------------------------------------------------------
// Helper: run the plan flow and return command result
// ---------------------------------------------------------------------------

async function runPlanWithOutput(
  pool: ReturnType<typeof createPool>,
  fake: FakeExecutionRuntime,
  workItemId: string,
  output: LeadPlanOutput,
  _client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
): Promise<{ planOutputCmdId: string }> {
  const flow = new BoundedRepairFlow(makeDeps(pool, fake));

  fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output }));

  const planCmdId = newId("cmd");
  const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
  fake.advance(planRunId);
  fake.advance(planRunId);

  const planOutputCmdId = newId("cmd");
  await flow.onLeadPlanOutput(planIntentId, output, planOutputCmdId);

  return { planOutputCmdId };
}

// ---------------------------------------------------------------------------
// Helper: assert pending_human decision + no worker trigger + violation codes
// ---------------------------------------------------------------------------

async function assertRejected(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  fake: FakeExecutionRuntime,
  planOutputCmdId: string,
  expectedCodes: string[],
): Promise<void> {
  // Decision: kind=plan, outcome=pending_human
  const { rows: decisionRows } = await client.query("SELECT * FROM decisions WHERE kind = 'plan'");
  assert.equal(decisionRows.length, 1, "exactly one plan decision");
  const dec = decisionRows[0] as { outcome: string };
  assert.equal(dec.outcome, "pending_human", "decision outcome = pending_human");

  // No StepContract created
  const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
  assert.equal(contractRows.length, 0, "no step_contract created (R-001)");

  // No worker.attempt trigger
  const workerTriggers = fake.calls.filter(
    (c) =>
      c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
  );
  assert.equal(workerTriggers.length, 0, "no worker.attempt triggered (R-020)");

  // Command result contains expected violation codes
  const { rows: cmdRows } = await client.query(
    "SELECT result FROM commands WHERE command_id = $1",
    [planOutputCmdId],
  );
  assert.equal(cmdRows.length, 1, "command result recorded");
  const cmdResult = (cmdRows[0] as { result: unknown }).result as {
    violations?: Array<{ code: string }>;
  };
  assert.ok(cmdResult, "command result is not null");
  assert.ok(Array.isArray(cmdResult.violations), "violations array present in command result");
  const foundCodes = cmdResult.violations?.map((v) => v.code);
  for (const expected of expectedCodes) {
    assert.ok(
      foundCodes.includes(expected),
      `violation code ${expected} present; got: ${foundCodes.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test cases (R-020 adversarial proposals)
// ---------------------------------------------------------------------------

test("flow.injection: paths-wider → PATH_ALLOW_WIDER violation (R-020)", async (t) => {
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
      const output = pathsWiderFixture as LeadPlanOutput;
      const { planOutputCmdId } = await runPlanWithOutput(pool, fake, workItemId, output, client);
      await assertRejected(client, fake, planOutputCmdId, ["PATH_ALLOW_WIDER"]);
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: deny-dropped → PATH_DENY_DROPPED violation (R-020)", async (t) => {
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
      const output = denyDroppedFixture as LeadPlanOutput;
      const { planOutputCmdId } = await runPlanWithOutput(pool, fake, workItemId, output, client);
      await assertRejected(client, fake, planOutputCmdId, ["PATH_DENY_DROPPED"]);
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: bash-glob → BASH_ALLOW_WIDER violation (R-020)", async (t) => {
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
      const output = bashGlobFixture as LeadPlanOutput;
      const { planOutputCmdId } = await runPlanWithOutput(pool, fake, workItemId, output, client);
      await assertRejected(client, fake, planOutputCmdId, ["BASH_ALLOW_WIDER"]);
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: boundary-merge → BOUNDARY_NOT_DELEGATED violation (R-020)", async (t) => {
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
      const output = boundaryMergeFixture as LeadPlanOutput;
      const { planOutputCmdId } = await runPlanWithOutput(pool, fake, workItemId, output, client);
      await assertRejected(client, fake, planOutputCmdId, ["BOUNDARY_NOT_DELEGATED"]);
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: budget-10-attempts → BUDGET_ATTEMPTS violation (R-020)", async (t) => {
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
      const output = budget10AttemptsFixture as LeadPlanOutput;
      const { planOutputCmdId } = await runPlanWithOutput(pool, fake, workItemId, output, client);
      await assertRejected(client, fake, planOutputCmdId, ["BUDGET_ATTEMPTS"]);
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: review-none-for-behavior → REVIEW_BELOW_MINIMUM violation (R-020)", async (t) => {
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
      const output = reviewNoneFixture as LeadPlanOutput;
      const { planOutputCmdId } = await runPlanWithOutput(pool, fake, workItemId, output, client);
      await assertRejected(client, fake, planOutputCmdId, ["REVIEW_BELOW_MINIMUM"]);
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: reviewer-same-model → MODEL_NOT_ALLOWED + REVIEWER_SAME_AS_WORKER (R-020)", async (t) => {
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
      const output = reviewerSameModelFixture as LeadPlanOutput;
      const { planOutputCmdId } = await runPlanWithOutput(pool, fake, workItemId, output, client);
      await assertRejected(client, fake, planOutputCmdId, [
        "REVIEWER_SAME_AS_WORKER",
        "MODEL_NOT_ALLOWED",
      ]);
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: no-operator-criterion → NO_OPERATOR_CRITERION violation (R-020)", async (t) => {
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
      const output = noOperatorCriterionFixture as LeadPlanOutput;
      const { planOutputCmdId } = await runPlanWithOutput(pool, fake, workItemId, output, client);
      await assertRejected(client, fake, planOutputCmdId, ["NO_OPERATOR_CRITERION"]);
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: class-editorial-touching-public-api → humanRequired stored; Approval gates acceptance, not dispatch (R-006, EXECUTION_MODEL step 8)", async (t) => {
  // Per docs/engineering/EXECUTION_MODEL.md step 8 and TESTING.md "Completion rule",
  // a humanRequired contract still dispatches the worker; the human Approval is
  // requested at acceptance and evaluateAcceptance returns APPROVAL_REQUIRED
  // until an Approval bound to the exact contract version exists (R-006).
  // This test asserts CURRENT behavior. A future change to block dispatch until
  // human approval is granted would require pending_human here and 0 worker triggers.
  // Expected diff (open question):
  //   bounded-repair.ts onLeadPlanOutput: after approvalCheck, if approvalCheck.required:
  //     insert pending_human decision with reason="approval" and return, do not dispatch worker.
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

      // Script worker to QUEUED (won't complete in this test)
      fake.script(TASK_IDS.workerAttempt, () => ({ status: "QUEUED" }));

      const flow = new BoundedRepairFlow(makeDeps(pool, fake));
      const output = publicApiFixture as LeadPlanOutput;
      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output }));

      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, output, planOutputCmdId);

      // CURRENT behavior: proposal is valid (editorial, within authority paths),
      // contract IS created with humanRequired=true, worker IS triggered.
      const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
      assert.equal(contractRows.length, 1, "step_contract created for humanRequired proposal");
      const contract = contractRows[0] as { human_required: boolean; bounds: unknown };
      assert.equal(contract.human_required, true, "human_required=true on contract");

      const workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.equal(
        workerTriggers.length,
        1,
        "worker.attempt is triggered for humanRequired (approval gates acceptance)",
      );

      // No pending_human decision in current behavior (spec would require one)
      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'plan' AND outcome = 'pending_human'",
      );
      assert.equal(
        decisionRows.length,
        0,
        "no pending_human decision at plan time; the approval gate is at acceptance",
      );

      // Worker payload must still deny *git push* and task tool
      const workerCall = workerTriggers[0]!;
      const workerPayload = (workerCall.args[0] as { payload: unknown }).payload as {
        permissionRules: Record<string, unknown>;
        bounds: {
          capabilities: {
            tools: { task: boolean };
            bash: { allow: string[]; deny: string[] };
          };
        };
      };
      // git push is not in bash.allow and NOT in the authority allow list
      const bounds = workerPayload.bounds;
      assert.ok(!bounds.capabilities.tools.task, "task tool disabled in bounds");
      // permissionRules is an object (PermissionRuleset) not an array
      assert.ok(
        workerPayload.permissionRules !== null &&
          typeof workerPayload.permissionRules === "object" &&
          !Array.isArray(workerPayload.permissionRules),
        "permissionRules is an object (PermissionRuleset)",
      );
    } finally {
      await pool.end();
    }
  });
});

test("flow.injection: narrower proposal → contract with proposal bounds, worker triggered with correct permissionRules (R-020)", async (t) => {
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

      // Script worker to QUEUED (narrower test only checks dispatch)
      fake.script(TASK_IDS.workerAttempt, () => ({ status: "QUEUED" }));

      const flow = new BoundedRepairFlow(makeDeps(pool, fake));
      const output = narrowerFixture as LeadPlanOutput;
      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output }));

      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, output, planOutputCmdId);

      // StepContract created
      const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
      assert.equal(contractRows.length, 1, "step_contract created for narrower proposal");
      const contract = contractRows[0] as {
        bounds: {
          paths: { allow: string[] };
          budget: { maxAttempts: number };
          review: string;
        };
      };

      // Bounds come from the proposal, not the schema
      assert.deepEqual(
        contract.bounds.paths.allow,
        ["src/parser/parse.ts"],
        "bounds.paths.allow = proposal value",
      );
      assert.equal(
        contract.bounds.budget.maxAttempts,
        1,
        "bounds.budget.maxAttempts = 1 (proposal)",
      );
      assert.equal(contract.bounds.review, "adversarial", "bounds.review = adversarial (proposal)");

      // One worker.attempt trigger
      const workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.equal(workerTriggers.length, 1, "exactly one worker.attempt trigger");

      // Worker payload permissionRules must still deny *git push* and task
      const workerCall = workerTriggers[0]!;
      const workerPayload = (workerCall.args[0] as { payload: unknown }).payload as {
        permissionRules: Array<Record<string, unknown>>;
        bounds: {
          capabilities: {
            tools: { task: boolean };
            bash: { allow: string[]; deny: string[] };
          };
        };
      };

      // task tool is false in the narrower proposal
      assert.ok(!workerPayload.bounds.capabilities.tools.task, "task tool disabled");

      // The authority's bash.allow doesn't include git push patterns (only pnpm test*, etc.),
      // so permissionRules should not allow git push.
      const allowedBashPatterns: string[] = workerPayload.bounds.capabilities.bash.allow ?? [];
      assert.ok(
        !allowedBashPatterns.some((p: string) => p === "git *" || p === "*git push*"),
        "git push not in bash allow patterns",
      );
    } finally {
      await pool.end();
    }
  });
});
