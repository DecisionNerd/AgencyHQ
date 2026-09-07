/**
 * Integration test: false-success adversarial cases (R-014, R-017).
 *
 * R-014: The worker's self-reported checks are never consulted for acceptance.
 * R-017: Findings receive dispositions without widening the contract.
 *
 * Test cases:
 * (a) claims-pass + verify fails + honest accept → reject CITED_RESULT_NOT_PASSING
 * (b) tampers-verifier → blocking Finding kind=verifier_tampered + accept rejects VERIFIER_TAMPERED
 * (b+) test-only diff → no verifier_tampered finding, acceptance not integrity-blocked
 * (c) blocking review → reject REVIEW_BLOCKING
 * (d) stale digest → reject RESULT_VERSION_MISMATCH
 * (e) overclaims → reject CITED_RESULT_MISSING + CRITERION_UNCITED
 *
 * In each case: decision.detail must NOT contain the string "checksRun" (R-014).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationResult } from "@agencyhq/contracts";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import {
  goodAcceptanceProposal,
  goodPlanOutput,
  goodReviewOutput,
  workerCompletedOutput,
} from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const STALE_PROFILE_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000001";

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
// VerificationResult builder
// ---------------------------------------------------------------------------

function makeVerifyResult(
  p: {
    contractId: string;
    attemptId: string;
    criteriaDigest: string;
    profileDigest: string;
    baseRevision: string;
    attemptRevision: string;
    diffDigest: string;
  },
  result: "pass" | "fail",
  overrideProfileDigest?: string,
): VerificationResult {
  return {
    verifier: { name: "agencyhq-verifier", version: "1.0.0" },
    stepContractId: p.contractId,
    attemptId: p.attemptId,
    criteriaDigest: p.criteriaDigest as import("@agencyhq/contracts").Digest,
    profileDigest: (overrideProfileDigest ??
      p.profileDigest) as import("@agencyhq/contracts").Digest,
    repository: "/repo",
    baseRevision: p.baseRevision,
    attemptRevision: p.attemptRevision,
    diffDigest: p.diffDigest as import("@agencyhq/contracts").Digest,
    checkId: "pnpm-test",
    environmentFingerprint: { node: "20.0.0" },
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitStatus: result === "pass" ? 0 : 1,
    stdoutTail: result === "pass" ? "All tests passed" : "FAIL\n1 test failed",
    stderrTail: "",
    artifactDigests: [],
    result,
  };
}

// ---------------------------------------------------------------------------
// Helper: run through plan → worker dispatch (CALLER sets verify script before advancing worker)
// ---------------------------------------------------------------------------

interface DispatchedState {
  flow: BoundedRepairFlow;
  workerRunId: string;
}

async function runUntilWorkerDispatched(
  pool: ReturnType<typeof createPool>,
  fake: FakeExecutionRuntime,
  workItemId: string,
  workerOutput: import("@agencyhq/contracts").WorkerAttemptOutput,
  planOutput: import("@agencyhq/contracts").LeadPlanOutput,
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
): Promise<DispatchedState> {
  const flow = new BoundedRepairFlow(makeDeps(pool, fake));

  fake.script(TASK_IDS.leadPlan, () => ({
    status: "COMPLETED",
    output: planOutput,
  }));

  const planCmdId = newId("cmd");
  const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
  fake.advance(planRunId);
  fake.advance(planRunId);

  // Script worker with the provided output
  fake.script(TASK_IDS.workerAttempt, () => ({
    status: "COMPLETED",
    output: workerOutput,
  }));

  const planOutputCmdId = newId("cmd");
  await flow.onLeadPlanOutput(planIntentId, planOutput, planOutputCmdId);

  const { rows: workerIntents } = await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.workerAttempt],
  );
  const workerRunId = (workerIntents[0] as { run_id: string }).run_id;

  return { flow, workerRunId };
}

// ---------------------------------------------------------------------------
// Helper: assert decision detail never mentions checksRun (R-014)
// ---------------------------------------------------------------------------

async function assertNoChecksRunInDecisions(client: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<void> {
  const { rows: decisionRows } = await client.query("SELECT * FROM decisions");
  const { rows: cmdRows } = await client.query("SELECT result FROM commands");
  for (const row of decisionRows) {
    const text = JSON.stringify(row);
    assert.ok(!text.includes("checksRun"), `'checksRun' must not appear in decisions row: ${text}`);
  }
  for (const row of cmdRows) {
    const text = JSON.stringify((row as { result: unknown }).result);
    assert.ok(
      !text.includes("checksRun"),
      `'checksRun' must not appear in command result: ${text}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test (a): claims-pass + verify fails + honest accept → CITED_RESULT_NOT_PASSING
// ---------------------------------------------------------------------------

test("flow.false-success (a): verify fails → reject CITED_RESULT_NOT_PASSING (R-014)", async (t) => {
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

      const workerOutput = workerCompletedOutput("placeholder", {
        commitId: "deadbeef1234567890deadbeef1234567890dead",
        changedPaths: ["test/parser/reject.test.ts", "src/parser/parse.ts"],
      });

      // Script verify.run to FAIL BEFORE triggering worker (script is resolved at trigger time)
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          contractId: string;
          attemptId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: { results: [makeVerifyResult(p, "fail")] },
        };
      });

      const { flow, workerRunId } = await runUntilWorkerDispatched(
        pool,
        fake,
        workItemId,
        workerOutput,
        goodPlanOutput(),
        client,
      );

      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);

      // Script review (artifacts not yet created — scripted after onWorkerFinal)
      fake.script(TASK_IDS.leadReview, (payload: unknown) => {
        const p = payload as {
          attemptRevision: string;
          diffDigest: string;
          criteriaDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: goodReviewOutput({
            attemptRevision: p.attemptRevision,
            diffDigest: p.diffDigest,
            criteriaDigest: p.criteriaDigest,
            profileDigest: FAKE_PROFILE_DIGEST,
          }),
        };
      });

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      const { rows: artifactRows } = await client.query("SELECT * FROM artifacts");
      const artifactRow = artifactRows[0] as { revision: string; diff_digest: string };

      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      const verifyRunId = (verifyIntents[0] as { run_id: string }).run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);

      const verifyFinalCmdId = newId("cmd");
      await flow.onVerifyFinal(verifyObs, verifyFinalCmdId);

      const { rows: reviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      const reviewRunId = (reviewIntents[0] as { run_id: string }).run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);

      // Script lead.accept with "honest" proposal (cites real ref, which has result=fail)
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED" as const,
        output: {
          accept: true,
          criteria: [
            {
              criterionId: "c1",
              satisfied: true,
              evidence: [{ kind: "verification_result" as const, ref: vrRef }],
            },
          ],
          findingDispositions: [],
          rationale: "Claiming pass despite fail result",
        },
      }));

      const reviewFinalCmdId = newId("cmd");
      await flow.onReviewFinal(reviewObs, reviewFinalCmdId);

      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = (acceptIntents[0] as { run_id: string }).run_id;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);

      const acceptFinalCmdId = newId("cmd");
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);

      // Decision must be rejected with CITED_RESULT_NOT_PASSING
      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(decisionRows.length, 1, "accept decision recorded");
      assert.equal(
        (decisionRows[0] as { outcome: string }).outcome,
        "rejected",
        "decision rejected",
      );

      // WorkItem NOT completed
      const { rows: wiRows } = await client.query(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(
        (wiRows[0] as { lifecycle: string }).lifecycle,
        "proposed",
        "WorkItem NOT completed",
      );

      // Command result has CITED_RESULT_NOT_PASSING reason
      const { rows: cmdRows } = await client.query(
        "SELECT result FROM commands WHERE command_id = $1",
        [acceptFinalCmdId],
      );
      const cmdResult = (cmdRows[0] as { result: { reasons?: Array<{ code: string }> } }).result;
      const reasonCodes = (cmdResult.reasons ?? []).map((r: { code: string }) => r.code);
      assert.ok(
        reasonCodes.includes("CITED_RESULT_NOT_PASSING"),
        `CITED_RESULT_NOT_PASSING in reasons; got: ${reasonCodes.join(", ")}`,
      );

      // Attempt status retained (not superseded)
      const { rows: attemptRows } = await client.query(
        "SELECT status FROM attempts WHERE status = 'completed'",
      );
      assert.ok(attemptRows.length >= 1, "attempt stays completed");

      // R-014: checksRun must NOT appear in any decision or command result
      await assertNoChecksRunInDecisions(client);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (b): tampers-verifier → blocking Finding kind=verifier_tampered + accept rejects VERIFIER_TAMPERED
// ---------------------------------------------------------------------------

test("flow.false-success (b): tampers-verifier → verifier_tampered finding AND acceptance rejected VERIFIER_TAMPERED (R-014, R-017)", async (t) => {
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

      // Worker output that tampers with package.json (protected path)
      const workerOutput = workerCompletedOutput("placeholder", {
        commitId: "cafebabe1234567890cafebabe1234567890cafe",
        changedPaths: ["src/parser/parse.ts", "package.json"],
      });

      // Script verify.run to pass (tampering detection happens in onVerifyFinal via changedPaths)
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          contractId: string;
          attemptId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: { results: [makeVerifyResult(p, "pass")] },
        };
      });

      // Script lead.review to complete with clean findings (no blocking review findings —
      // the integrity gate, not the review, must block acceptance).
      fake.script(TASK_IDS.leadReview, (payload: unknown) => {
        const p = payload as {
          attemptRevision: string;
          diffDigest: string;
          criteriaDigest: string;
          profileDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: goodReviewOutput({
            attemptRevision: p.attemptRevision,
            diffDigest: p.diffDigest,
            criteriaDigest: p.criteriaDigest,
            profileDigest: FAKE_PROFILE_DIGEST,
          }),
        };
      });

      const { flow, workerRunId } = await runUntilWorkerDispatched(
        pool,
        fake,
        workItemId,
        workerOutput,
        goodPlanOutput(),
        client,
      );

      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      const { rows: artifactRows } = await client.query("SELECT * FROM artifacts");
      const artifactRow = artifactRows[0] as { revision: string; diff_digest: string };

      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      const verifyRunId = (verifyIntents[0] as { run_id: string }).run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);

      const verifyFinalCmdId = newId("cmd");
      await flow.onVerifyFinal(verifyObs, verifyFinalCmdId);

      // Blocking Finding kind=verifier_tampered must exist before review
      const { rows: findingRows } = await client.query(
        "SELECT * FROM findings WHERE kind = 'verifier_tampered'",
      );
      assert.ok(findingRows.length >= 1, "verifier_tampered finding created");
      const finding = findingRows[0] as { severity: string; kind: string; description: string };
      assert.equal(finding.severity, "blocking", "finding is blocking");
      assert.ok(finding.description.includes("package.json"), "finding mentions package.json");

      // Review WAS dispatched (flow still runs review despite tampering finding)
      const { rows: reviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      assert.equal(reviewIntents.length, 1, "lead.review dispatched");

      // Complete the review step
      const reviewRunId = (reviewIntents[0] as { run_id: string }).run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);

      // Script lead.accept with a valid proposal referencing the verification result
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED" as const,
        output: goodAcceptanceProposal(["c1"], [vrRef]),
      }));

      const reviewFinalCmdId = newId("cmd");
      await flow.onReviewFinal(reviewObs, reviewFinalCmdId);

      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = (acceptIntents[0] as { run_id: string }).run_id;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);

      const acceptFinalCmdId = newId("cmd");
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);

      // Decision must be rejected (VERIFIER_TAMPERED blocks acceptance)
      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(decisionRows.length, 1, "accept decision recorded");
      assert.equal(
        (decisionRows[0] as { outcome: string }).outcome,
        "rejected",
        "decision rejected due to verifier tampering",
      );

      // WorkItem NOT completed (stays in proposed lifecycle)
      const { rows: wiRows } = await client.query(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(
        (wiRows[0] as { lifecycle: string }).lifecycle,
        "proposed",
        "WorkItem NOT completed",
      );

      // Command result has VERIFIER_TAMPERED reason code
      const { rows: acceptCmdRows } = await client.query(
        "SELECT result FROM commands WHERE command_id = $1",
        [acceptFinalCmdId],
      );
      const acceptCmdResult = (
        acceptCmdRows[0] as { result: { reasons?: Array<{ code: string }> } }
      ).result;
      const reasonCodes = (acceptCmdResult.reasons ?? []).map((r: { code: string }) => r.code);
      assert.ok(
        reasonCodes.includes("VERIFIER_TAMPERED"),
        `VERIFIER_TAMPERED in reasons; got: ${reasonCodes.join(", ")}`,
      );

      // R-014: checksRun must NOT appear in any decision or command result
      await assertNoChecksRunInDecisions(client);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (b+): test-only diff → no verifier_tampered finding, not integrity-blocked
// (FAKE_PROFILE_RESOLVER only protects ["package.json"]; test files are not protected)
// ---------------------------------------------------------------------------

test("flow.false-success (b+): diff touching only test files produces no verifier_tampered finding and acceptance is not integrity-blocked", async (t) => {
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

      // Worker output with only test files changed (no protected paths)
      const workerOutput = workerCompletedOutput("placeholder", {
        commitId: "aabbcc1234567890aabbcc1234567890aabbcc12",
        changedPaths: ["test/parser/x.test.ts", "tests/y.spec.ts"],
      });

      // verify.run passes
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          contractId: string;
          attemptId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: { results: [makeVerifyResult(p, "pass")] },
        };
      });

      // Review returns clean (no blocking findings)
      fake.script(TASK_IDS.leadReview, (payload: unknown) => {
        const p = payload as {
          attemptRevision: string;
          diffDigest: string;
          criteriaDigest: string;
          profileDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: goodReviewOutput({
            attemptRevision: p.attemptRevision,
            diffDigest: p.diffDigest,
            criteriaDigest: p.criteriaDigest,
            profileDigest: FAKE_PROFILE_DIGEST,
          }),
        };
      });

      const { flow, workerRunId } = await runUntilWorkerDispatched(
        pool,
        fake,
        workItemId,
        workerOutput,
        goodPlanOutput(),
        client,
      );

      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      const { rows: artifactRows } = await client.query("SELECT * FROM artifacts");
      const artifactRow = artifactRows[0] as { revision: string; diff_digest: string };

      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      const verifyRunId = (verifyIntents[0] as { run_id: string }).run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);

      const verifyFinalCmdId = newId("cmd");
      await flow.onVerifyFinal(verifyObs, verifyFinalCmdId);

      // No verifier_tampered findings (test files are not protected verifier config)
      const { rows: findingRows } = await client.query(
        "SELECT * FROM findings WHERE kind = 'verifier_tampered'",
      );
      assert.equal(findingRows.length, 0, "no verifier_tampered finding for test-only diff");

      // Complete review step
      const { rows: reviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      assert.equal(reviewIntents.length, 1, "lead.review dispatched");
      const reviewRunId = (reviewIntents[0] as { run_id: string }).run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);

      // Script a valid acceptance proposal
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED" as const,
        output: goodAcceptanceProposal(["c1"], [vrRef]),
      }));

      const reviewFinalCmdId = newId("cmd");
      await flow.onReviewFinal(reviewObs, reviewFinalCmdId);

      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = (acceptIntents[0] as { run_id: string }).run_id;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);

      const acceptFinalCmdId = newId("cmd");
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);

      // Decision must be accepted (no integrity blocker, review passes)
      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(decisionRows.length, 1, "accept decision recorded");
      assert.equal(
        (decisionRows[0] as { outcome: string }).outcome,
        "accepted",
        "decision accepted — test-file diff is not integrity-blocked",
      );

      // WorkItem completed
      const { rows: wiRows } = await client.query(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(
        (wiRows[0] as { lifecycle: string }).lifecycle,
        "completed",
        "WorkItem completed",
      );

      // No VERIFIER_TAMPERED reason in command result
      const { rows: acceptCmdRows } = await client.query(
        "SELECT result FROM commands WHERE command_id = $1",
        [acceptFinalCmdId],
      );
      const acceptCmdResult = (acceptCmdRows[0] as { result: { accepted?: boolean } }).result;
      assert.equal(acceptCmdResult.accepted, true, "command result is accepted:true");

      await assertNoChecksRunInDecisions(client);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (c): blocking review → REVIEW_BLOCKING rejection
// ---------------------------------------------------------------------------

test("flow.false-success (c): blocking review finding → reject REVIEW_BLOCKING (R-014)", async (t) => {
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

      const workerOutput = workerCompletedOutput("placeholder", {
        commitId: "deadbeef1234567890deadbeef1234567890dead",
        changedPaths: ["test/parser/reject.test.ts", "src/parser/parse.ts"],
      });

      // Script verify.run to pass
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          contractId: string;
          attemptId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: { results: [makeVerifyResult(p, "pass")] },
        };
      });

      // Blocking review output — scripted via payload callback for correct digests
      fake.script(TASK_IDS.leadReview, (payload: unknown) => {
        const p = payload as {
          attemptRevision: string;
          diffDigest: string;
          criteriaDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: {
            reviewer: { model: "openai/gpt-5.6-sol" },
            subject: {
              attemptRevision: p.attemptRevision,
              diffDigest: p.diffDigest,
              criteriaDigest: p.criteriaDigest,
              profileDigest: FAKE_PROFILE_DIGEST,
            },
            findings: [
              {
                id: "f1",
                severity: "blocking" as const,
                kind: "weakened_check" as const,
                description: "Test file skips all assertions using .skip",
                evidence: "test/parser/reject.test.ts:1",
              },
            ],
          },
        };
      });

      const { flow, workerRunId } = await runUntilWorkerDispatched(
        pool,
        fake,
        workItemId,
        workerOutput,
        goodPlanOutput(),
        client,
      );

      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      const verifyRunId = (verifyIntents[0] as { run_id: string }).run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);

      const verifyFinalCmdId = newId("cmd");
      await flow.onVerifyFinal(verifyObs, verifyFinalCmdId);

      const { rows: reviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      const reviewRunId = (reviewIntents[0] as { run_id: string }).run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);

      const { rows: artifactRows } = await client.query("SELECT * FROM artifacts");
      const artifactRow = artifactRows[0] as { revision: string };

      // Script accept — tries to claim success despite blocking review
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED" as const,
        output: {
          accept: true,
          criteria: [
            {
              criterionId: "c1",
              satisfied: true,
              evidence: [{ kind: "verification_result" as const, ref: vrRef }],
            },
          ],
          findingDispositions: [],
          rationale: "Criteria satisfied",
        },
      }));

      const reviewFinalCmdId = newId("cmd");
      await flow.onReviewFinal(reviewObs, reviewFinalCmdId);

      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = (acceptIntents[0] as { run_id: string }).run_id;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);

      const acceptFinalCmdId = newId("cmd");
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);

      // Decision rejected with REVIEW_BLOCKING
      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(decisionRows.length, 1, "accept decision recorded");
      assert.equal(
        (decisionRows[0] as { outcome: string }).outcome,
        "rejected",
        "decision rejected",
      );

      const { rows: cmdRows } = await client.query(
        "SELECT result FROM commands WHERE command_id = $1",
        [acceptFinalCmdId],
      );
      const cmdResult = (cmdRows[0] as { result: { reasons?: Array<{ code: string }> } }).result;
      const reasonCodes = (cmdResult.reasons ?? []).map((r: { code: string }) => r.code);
      assert.ok(
        reasonCodes.includes("REVIEW_BLOCKING"),
        `REVIEW_BLOCKING in reasons; got: ${reasonCodes.join(", ")}`,
      );

      // WorkItem NOT completed
      const { rows: wiRows } = await client.query(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(
        (wiRows[0] as { lifecycle: string }).lifecycle,
        "proposed",
        "WorkItem NOT completed",
      );

      // R-014: checksRun must NOT appear in any decision or command result
      await assertNoChecksRunInDecisions(client);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (d): stale digest → RESULT_VERSION_MISMATCH
// ---------------------------------------------------------------------------

test("flow.false-success (d): stale profileDigest → reject RESULT_VERSION_MISMATCH (R-014)", async (t) => {
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

      const workerOutput = workerCompletedOutput("placeholder", {
        commitId: "deadbeef1234567890deadbeef1234567890dead",
        changedPaths: ["src/parser/parse.ts"],
      });

      // Script verify.run with stale profileDigest (pass result but wrong profile version)
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          contractId: string;
          attemptId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
        };
        // Override profileDigest with stale value — version mismatch
        return {
          status: "COMPLETED" as const,
          output: { results: [makeVerifyResult(p, "pass", STALE_PROFILE_DIGEST)] },
        };
      });

      // Script review as good (digests from payload callback)
      fake.script(TASK_IDS.leadReview, (payload: unknown) => {
        const p = payload as {
          attemptRevision: string;
          diffDigest: string;
          criteriaDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: goodReviewOutput({
            attemptRevision: p.attemptRevision,
            diffDigest: p.diffDigest,
            criteriaDigest: p.criteriaDigest,
            profileDigest: FAKE_PROFILE_DIGEST,
          }),
        };
      });

      const { flow, workerRunId } = await runUntilWorkerDispatched(
        pool,
        fake,
        workItemId,
        workerOutput,
        goodPlanOutput(),
        client,
      );

      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      const verifyRunId = (verifyIntents[0] as { run_id: string }).run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);

      const verifyFinalCmdId = newId("cmd");
      await flow.onVerifyFinal(verifyObs, verifyFinalCmdId);

      const { rows: reviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      const reviewRunId = (reviewIntents[0] as { run_id: string }).run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);

      const { rows: artifactRows } = await client.query("SELECT * FROM artifacts");
      const artifactRow = artifactRows[0] as { revision: string };

      // Accept cites the real ref (ref is by attemptRevision, not profileDigest)
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED" as const,
        output: {
          accept: true,
          criteria: [
            {
              criterionId: "c1",
              satisfied: true,
              evidence: [{ kind: "verification_result" as const, ref: vrRef }],
            },
          ],
          findingDispositions: [],
          rationale: "Claiming criteria satisfied with stale profileDigest",
        },
      }));

      const reviewFinalCmdId = newId("cmd");
      await flow.onReviewFinal(reviewObs, reviewFinalCmdId);

      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = (acceptIntents[0] as { run_id: string }).run_id;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);

      const acceptFinalCmdId = newId("cmd");
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);

      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(decisionRows.length, 1, "accept decision recorded");
      assert.equal(
        (decisionRows[0] as { outcome: string }).outcome,
        "rejected",
        "decision rejected",
      );

      const { rows: cmdRows } = await client.query(
        "SELECT result FROM commands WHERE command_id = $1",
        [acceptFinalCmdId],
      );
      const cmdResult = (cmdRows[0] as { result: { reasons?: Array<{ code: string }> } }).result;
      const reasonCodes = (cmdResult.reasons ?? []).map((r: { code: string }) => r.code);
      assert.ok(
        reasonCodes.includes("RESULT_VERSION_MISMATCH"),
        `RESULT_VERSION_MISMATCH in reasons; got: ${reasonCodes.join(", ")}`,
      );

      // R-014: checksRun must NOT appear in any decision or command result
      await assertNoChecksRunInDecisions(client);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (e): overclaims → CITED_RESULT_MISSING + CRITERION_UNCITED
//
// Uses a two-criterion proposal so the contract has c1 + c2.
// The accept proposal includes c1 (with nonexistent ref) → CITED_RESULT_MISSING
// and omits c2 → CRITERION_UNCITED.
// ---------------------------------------------------------------------------

/** Two-criterion plan output for the overclaims test. */
function twoCriterionPlanOutput(): import("@agencyhq/contracts").LeadPlanOutput {
  return {
    kind: "proposal",
    proposal: {
      criteria: [
        { id: "c1", text: "Parser edge cases pass", source: "operator", citation: "Issue #42" },
        {
          id: "c2",
          text: "No regressions in existing tests",
          source: "operator",
          citation: "Issue #42",
        },
      ],
      profileId: "default",
      changeClass: "behavior",
      review: "adversarial",
      boundary: "artifact",
      paths: {
        allow: ["src/parser/edge-cases.ts"],
        deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
      },
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
      budget: { maxAttempts: 2, maxDurationSeconds: 600, estimatedSpendUsd: 2 },
      models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
      rationale: "Two-criterion fix",
      sources: [
        { criterionId: "c1", source: "operator", citation: "Issue #42" },
        { criterionId: "c2", source: "operator", citation: "Issue #42" },
      ],
    },
  };
}

test("flow.false-success (e): overclaims → CITED_RESULT_MISSING + CRITERION_UNCITED (R-014)", async (t) => {
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

      const workerOutput = workerCompletedOutput("placeholder", {
        commitId: "deadbeef1234567890deadbeef1234567890dead",
        changedPaths: ["src/parser/parse.ts"],
      });

      // Script verify.run to pass
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          contractId: string;
          attemptId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: { results: [makeVerifyResult(p, "pass")] },
        };
      });

      fake.script(TASK_IDS.leadReview, (payload: unknown) => {
        const p = payload as {
          attemptRevision: string;
          diffDigest: string;
          criteriaDigest: string;
        };
        return {
          status: "COMPLETED" as const,
          output: goodReviewOutput({
            attemptRevision: p.attemptRevision,
            diffDigest: p.diffDigest,
            criteriaDigest: p.criteriaDigest,
            profileDigest: FAKE_PROFILE_DIGEST,
          }),
        };
      });

      const planOut = twoCriterionPlanOutput();
      const { flow, workerRunId } = await runUntilWorkerDispatched(
        pool,
        fake,
        workItemId,
        workerOutput,
        planOut,
        client,
      );

      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      const verifyRunId = (verifyIntents[0] as { run_id: string }).run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);

      const verifyFinalCmdId = newId("cmd");
      await flow.onVerifyFinal(verifyObs, verifyFinalCmdId);

      const { rows: reviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      const reviewRunId = (reviewIntents[0] as { run_id: string }).run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);

      // Overclaiming accept:
      //   - includes c1 with nonexistent ref → CITED_RESULT_MISSING for c1
      //   - omits c2 → CRITERION_UNCITED for c2
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED" as const,
        output: {
          accept: true,
          criteria: [
            {
              criterionId: "c1",
              satisfied: true,
              evidence: [
                {
                  kind: "verification_result" as const,
                  ref: "agencyhq-verifier:pnpm-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                },
              ],
            },
            // c2 deliberately omitted → CRITERION_UNCITED
          ],
          findingDispositions: [],
          rationale: "c1 cites nonexistent ref; c2 omitted",
        },
      }));

      const reviewFinalCmdId = newId("cmd");
      await flow.onReviewFinal(reviewObs, reviewFinalCmdId);

      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = (acceptIntents[0] as { run_id: string }).run_id;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);

      const acceptFinalCmdId = newId("cmd");
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);

      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(decisionRows.length, 1, "accept decision recorded");
      assert.equal(
        (decisionRows[0] as { outcome: string }).outcome,
        "rejected",
        "decision rejected",
      );

      const { rows: cmdRows } = await client.query(
        "SELECT result FROM commands WHERE command_id = $1",
        [acceptFinalCmdId],
      );
      const cmdResult = (cmdRows[0] as { result: { reasons?: Array<{ code: string }> } }).result;
      const reasonCodes = (cmdResult.reasons ?? []).map((r: { code: string }) => r.code);
      assert.ok(
        reasonCodes.includes("CITED_RESULT_MISSING"),
        `CITED_RESULT_MISSING in reasons; got: ${reasonCodes.join(", ")}`,
      );
      assert.ok(
        reasonCodes.includes("CRITERION_UNCITED"),
        `CRITERION_UNCITED in reasons; got: ${reasonCodes.join(", ")}`,
      );

      // WorkItem NOT completed
      const { rows: wiRows } = await client.query(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(
        (wiRows[0] as { lifecycle: string }).lifecycle,
        "proposed",
        "WorkItem NOT completed",
      );

      // R-014: checksRun must NOT appear in any decision or command result
      await assertNoChecksRunInDecisions(client);
    } finally {
      await pool.end();
    }
  });
});
