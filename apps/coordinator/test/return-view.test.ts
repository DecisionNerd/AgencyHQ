/**
 * Pure unit tests for buildReturnView.
 * No database, no network, no side effects.
 *
 * ≥ 15 cases covering:
 * - distinct states with source+timestamp
 * - changedSinceLastVisit respects lastAckAt
 * - pending decisions listed with detail
 * - stopping/stopped/uncertain mapping incl. checkpointCommit
 * - stale freshness flag
 * - mainEffort passthrough
 * - ordering by rank
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AttemptLike,
  buildReturnView,
  type ContractLike,
  type DecisionLike,
  type FindingLike,
  type IntegrationLike,
  type ReturnViewInput,
  type WorkItemLike,
  type WorkItemProjectLike,
} from "../src/views/return-view.ts";

// ---------------------------------------------------------------------------
// Fixtures helpers
// ---------------------------------------------------------------------------

const NOW = "2026-09-07T12:00:00.000Z";
const BEFORE = "2026-09-07T10:00:00.000Z";
const AFTER = "2026-09-07T11:00:00.000Z";
const LAST_ACK = "2026-09-07T10:30:00.000Z";

function wi(overrides: Partial<WorkItemLike> & { id: string; intent: string }): WorkItemLike {
  return {
    rank: 1,
    mainEffort: false,
    lifecycle: "active",
    condition: "healthy",
    updatedAt: BEFORE,
    boundary: "artifact",
    ...overrides,
  };
}

function contract(
  overrides: Partial<ContractLike> & { id: string; workItemId: string },
): ContractLike {
  return {
    version: 1,
    status: "active",
    updatedAt: BEFORE,
    ...overrides,
  };
}

function attempt(
  overrides: Partial<AttemptLike> & { id: string; contractId: string },
): AttemptLike {
  return {
    status: "running",
    updatedAt: BEFORE,
    ...overrides,
  };
}

function freshInput(overrides: Partial<ReturnViewInput> = {}): ReturnViewInput {
  return {
    now: NOW,
    lastAckAt: null,
    freshness: { lastPollAt: NOW },
    freshnessStaleMs: 30000,
    workItems: [],
    contracts: [],
    attempts: [],
    decisions: [],
    results: [],
    reviews: [],
    findings: [],
    integrations: [],
    workItemProjects: [],
    ...overrides,
  };
}

function integ(
  overrides: Partial<IntegrationLike> & { id: string; attemptId: string },
): IntegrationLike {
  return {
    targetRef: "refs/heads/main",
    outcome: null,
    resultingRevision: null,
    at: BEFORE,
    ...overrides,
  };
}

function workItemProject(
  overrides: Partial<WorkItemProjectLike> & { workItemId: string },
): WorkItemProjectLike {
  return {
    position: 1,
    resultRevision: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Health: empty input returns empty view
// ---------------------------------------------------------------------------
describe("buildReturnView", () => {
  it("returns empty view for empty input", () => {
    const view = buildReturnView(freshInput());
    assert.deepEqual(view.changedSinceLastVisit, []);
    assert.deepEqual(view.pendingDecisions, []);
    assert.deepEqual(view.continuing, []);
    assert.deepEqual(view.stops, []);
    assert.equal(view.mainEffort, null);
    assert.equal(view.freshness.stale, false);
  });

  // 2. Contract state: source is "ledger", at is contract updatedAt
  it("sets contract state with ledger source and timestamp", () => {
    const c = contract({ id: "c1", workItemId: "w1", updatedAt: BEFORE });
    const w = wi({ id: "w1", intent: "do thing", updatedAt: BEFORE });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c] }));
    assert.equal(view.changedSinceLastVisit.length, 1);
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.contract.source, "ledger");
    assert.equal(item.contract.at, BEFORE);
    assert.equal(item.contract.label, "v1 active");
  });

  // 3. Execution state: running attempt → source = "runtime"
  it("sets execution state source=runtime for running attempt", () => {
    const c = contract({ id: "c1", workItemId: "w1", updatedAt: BEFORE });
    const a = attempt({ id: "a1", contractId: "c1", status: "running", updatedAt: BEFORE });
    const w = wi({ id: "w1", intent: "do thing", updatedAt: BEFORE });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c], attempts: [a] }));
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.execution.source, "runtime");
    assert.equal(item.execution.label, "running");
  });

  // 4. Execution state: completed attempt → source = "ledger"
  it("sets execution state source=ledger for completed attempt", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "do thing" });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c], attempts: [a] }));
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.execution.source, "ledger");
    assert.equal(item.execution.label, "completed");
  });

  // 5. changedSinceLastVisit: only items updated after lastAckAt
  it("changedSinceLastVisit only includes items updated after lastAckAt", () => {
    const w1 = wi({ id: "w1", intent: "old", updatedAt: BEFORE });
    const w2 = wi({ id: "w2", intent: "new", rank: 2, updatedAt: AFTER });
    const view = buildReturnView(freshInput({ workItems: [w1, w2], lastAckAt: LAST_ACK }));
    assert.equal(view.changedSinceLastVisit.length, 1);
    assert.equal(view.changedSinceLastVisit[0]?.workItemId, "w2");
  });

  // 6. changedSinceLastVisit: all items included when lastAckAt is null
  it("includes all items when lastAckAt is null", () => {
    const w1 = wi({ id: "w1", intent: "a", updatedAt: BEFORE });
    const w2 = wi({ id: "w2", intent: "b", rank: 2, updatedAt: BEFORE });
    const view = buildReturnView(freshInput({ workItems: [w1, w2], lastAckAt: null }));
    assert.equal(view.changedSinceLastVisit.length, 2);
  });

  // 7. changedSinceLastVisit: includes item if decision is newer than lastAckAt
  it("includes item changed via newer decision even if workItem.updatedAt is older", () => {
    const w = wi({ id: "w1", intent: "x", updatedAt: BEFORE });
    const d: DecisionLike = {
      id: "d1",
      workItemId: "w1",
      kind: "plan",
      outcome: "recorded",
      at: AFTER,
    };
    const view = buildReturnView(
      freshInput({ workItems: [w], decisions: [d], lastAckAt: LAST_ACK }),
    );
    assert.equal(view.changedSinceLastVisit.length, 1);
  });

  // 8. Pending decisions: outcome = "pending_human" → appears in pendingDecisions
  it("lists pending_human decisions in pendingDecisions with detail", () => {
    const w = wi({ id: "w1", intent: "x" });
    const d: DecisionLike = {
      id: "d1",
      workItemId: "w1",
      kind: "plan",
      outcome: "pending_human",
      at: NOW,
      detail: "scope exceeds authority",
    };
    const view = buildReturnView(freshInput({ workItems: [w], decisions: [d] }));
    assert.equal(view.pendingDecisions.length, 1);
    const pd = view.pendingDecisions[0]!;
    assert.equal(pd.decisionId, "d1");
    assert.equal(pd.kind, "plan");
    assert.equal(pd.detail, "scope exceeds authority");
    assert.equal(pd.at, NOW);
  });

  // 9. Non-pending decisions: outcome = "recorded" → not in pendingDecisions
  it("recorded decisions are not in pendingDecisions", () => {
    const w = wi({ id: "w1", intent: "x" });
    const d: DecisionLike = {
      id: "d1",
      workItemId: "w1",
      kind: "accept",
      outcome: "recorded",
      at: NOW,
    };
    const view = buildReturnView(freshInput({ workItems: [w], decisions: [d] }));
    assert.equal(view.pendingDecisions.length, 0);
  });

  // 10. Stop entry: stopping status
  it("maps stopping attempt to stops entry with state=stopping", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "stopping", updatedAt: NOW });
    const w = wi({ id: "w1", intent: "stop test" });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c], attempts: [a] }));
    assert.equal(view.stops.length, 1);
    assert.equal(view.stops[0]?.state, "stopping");
    assert.equal(view.stops[0]?.attemptId, "a1");
    assert.equal(view.stops[0]?.at, NOW);
  });

  // 11. Stop entry: stopped status with checkpointCommit
  it("maps stopped attempt with checkpointCommit", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({
      id: "a1",
      contractId: "c1",
      status: "stopped",
      checkpointCommit: "abc123",
      updatedAt: NOW,
    });
    const w = wi({ id: "w1", intent: "stop test" });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c], attempts: [a] }));
    assert.equal(view.stops.length, 1);
    assert.equal(view.stops[0]?.state, "stopped");
    assert.equal(view.stops[0]?.checkpointCommit, "abc123");
  });

  // 12. Stop entry: uncertain status (missing contact)
  it("maps uncertain attempt to stops entry with state=uncertain", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "uncertain", updatedAt: NOW });
    const w = wi({ id: "w1", intent: "uncertain test" });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c], attempts: [a] }));
    assert.equal(view.stops.length, 1);
    assert.equal(view.stops[0]?.state, "uncertain");
  });

  // 13. Non-stop statuses do not appear in stops
  it("running attempt does not appear in stops", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "running" });
    const w = wi({ id: "w1", intent: "running test" });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c], attempts: [a] }));
    assert.equal(view.stops.length, 0);
  });

  // 14. Freshness: stale when lastPollAt is older than freshnessStaleMs
  it("marks freshness stale when lastPollAt is older than threshold", () => {
    // now = "2026-09-07T12:00:00.000Z", lastPollAt = 60s ago, threshold = 30s
    const oldPoll = new Date(new Date(NOW).getTime() - 60000).toISOString();
    const view = buildReturnView(
      freshInput({ freshness: { lastPollAt: oldPoll }, freshnessStaleMs: 30000 }),
    );
    assert.equal(view.freshness.stale, true);
    assert.equal(view.freshness.lastPollAt, oldPoll);
  });

  // 15. Freshness: not stale when lastPollAt is recent
  it("freshness not stale when lastPollAt is recent", () => {
    const recentPoll = new Date(new Date(NOW).getTime() - 5000).toISOString();
    const view = buildReturnView(
      freshInput({ freshness: { lastPollAt: recentPoll }, freshnessStaleMs: 30000 }),
    );
    assert.equal(view.freshness.stale, false);
  });

  // 16. Freshness: stale when lastPollAt is null
  it("freshness is stale when lastPollAt is null", () => {
    const view = buildReturnView(
      freshInput({ freshness: { lastPollAt: null }, freshnessStaleMs: 30000 }),
    );
    assert.equal(view.freshness.stale, true);
    assert.equal(view.freshness.lastPollAt, null);
  });

  // 17. mainEffort: work item with mainEffort=true
  it("returns mainEffort id for main effort work item", () => {
    const w = wi({ id: "main-wi", intent: "main effort", mainEffort: true });
    const view = buildReturnView(freshInput({ workItems: [w] }));
    assert.equal(view.mainEffort, "main-wi");
  });

  // 18. mainEffort: null when no main effort item
  it("returns null mainEffort when no main effort item", () => {
    const w = wi({ id: "w1", intent: "normal", mainEffort: false });
    const view = buildReturnView(freshInput({ workItems: [w] }));
    assert.equal(view.mainEffort, null);
  });

  // 19. Ordering by rank in changedSinceLastVisit
  it("orders changedSinceLastVisit by rank ascending", () => {
    const w1 = wi({ id: "w1", intent: "high priority", rank: 1, updatedAt: BEFORE });
    const w2 = wi({ id: "w2", intent: "low priority", rank: 10, updatedAt: BEFORE });
    const w3 = wi({ id: "w3", intent: "mid priority", rank: 5, updatedAt: BEFORE });
    const view = buildReturnView(freshInput({ workItems: [w2, w3, w1] }));
    const ids = view.changedSinceLastVisit.map((i) => i.workItemId);
    assert.deepEqual(ids, ["w1", "w3", "w2"]);
  });

  // 20. continuing: only active-status attempts
  it("only includes items with active-status attempts in continuing", () => {
    const c1 = contract({ id: "c1", workItemId: "w1" });
    const a1 = attempt({ id: "a1", contractId: "c1", status: "running" });
    const c2 = contract({ id: "c2", workItemId: "w2" });
    const a2 = attempt({ id: "a2", contractId: "c2", status: "completed" });
    const w1 = wi({ id: "w1", intent: "active" });
    const w2 = wi({ id: "w2", intent: "done", rank: 2 });
    const view = buildReturnView(
      freshInput({
        workItems: [w1, w2],
        contracts: [c1, c2],
        attempts: [a1, a2],
      }),
    );
    assert.equal(view.continuing.length, 1);
    assert.equal(view.continuing[0]?.workItemId, "w1");
  });

  // 21. Execution state carries stale flag when running and freshness is stale
  it("execution state stale flag propagated when running and freshness stale", () => {
    const oldPoll = new Date(new Date(NOW).getTime() - 60000).toISOString();
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "running" });
    const w = wi({ id: "w1", intent: "stale run" });
    const view = buildReturnView(
      freshInput({
        workItems: [w],
        contracts: [c],
        attempts: [a],
        freshness: { lastPollAt: oldPoll },
        freshnessStaleMs: 30000,
      }),
    );
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.execution.stale, true);
  });

  // 22. No contract → contract state label = "none"
  it("contract state label is none when no contract exists", () => {
    const w = wi({ id: "w1", intent: "no contract" });
    const view = buildReturnView(freshInput({ workItems: [w] }));
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.contract.label, "none");
    assert.equal(item.contract.at, null);
  });

  // 23. Verification state: result present
  it("shows verification result label and timestamp", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const r = { id: "r1", attemptId: "a1", result: "pass", updatedAt: NOW };
    const w = wi({ id: "w1", intent: "verify test" });
    const view = buildReturnView(
      freshInput({ workItems: [w], contracts: [c], attempts: [a], results: [r] }),
    );
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.verification.label, "pass");
    assert.equal(item.verification.source, "ledger");
    assert.equal(item.verification.at, NOW);
  });

  // 24. Multiple pending decisions: sorted by at ascending
  it("pendingDecisions sorted ascending by at", () => {
    const w = wi({ id: "w1", intent: "x" });
    const d1: DecisionLike = {
      id: "d1",
      workItemId: "w1",
      kind: "plan",
      outcome: "pending_human",
      at: AFTER,
    };
    const d2: DecisionLike = {
      id: "d2",
      workItemId: "w1",
      kind: "plan",
      outcome: "pending_human",
      at: BEFORE,
    };
    const view = buildReturnView(freshInput({ workItems: [w], decisions: [d1, d2] }));
    assert.equal(view.pendingDecisions.length, 2);
    assert.equal(view.pendingDecisions[0]?.decisionId, "d2");
    assert.equal(view.pendingDecisions[1]?.decisionId, "d1");
  });

  // 25. Acceptance state: accept decision present
  it("acceptance state reflects accept decision", () => {
    const w = wi({ id: "w1", intent: "accepted" });
    const d: DecisionLike = {
      id: "d1",
      workItemId: "w1",
      kind: "accept",
      outcome: "recorded",
      at: NOW,
    };
    const view = buildReturnView(freshInput({ workItems: [w], decisions: [d] }));
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.acceptance.source, "ledger");
    assert.match(item.acceptance.label, /accept/);
  });

  // ---------------------------------------------------------------------------
  // Integration and manifest tests (Slice 4, R-011, R-019)
  // ---------------------------------------------------------------------------

  // 26. Artifact boundary: integration and manifest are null
  it("artifact item has null integration and manifest", () => {
    const w = wi({ id: "w1", intent: "artifact work", boundary: "artifact" });
    const view = buildReturnView(freshInput({ workItems: [w] }));
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.integration, null);
    assert.equal(item.manifest, null);
  });

  // 27. Merge boundary with no integration row: state=pending
  it("merge item with no integration row has state=pending and null fields", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge" });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c], attempts: [a] }));
    const item = view.changedSinceLastVisit[0]!;
    assert.ok(item.integration !== null);
    assert.equal(item.integration!.state, "pending");
    assert.equal(item.integration!.outcome, null);
    assert.equal(item.integration!.targetRef, null);
    assert.equal(item.integration!.resultingRevision, null);
    assert.equal(item.integration!.at, null);
    assert.equal(item.integration!.source, "ledger");
    assert.equal(item.manifest, null);
  });

  // 28. Merge boundary with pending integration row (no outcome): state=pending
  it("merge item with integration row but no outcome has state=pending", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge" });
    const i = integ({ id: "i1", attemptId: "a1", outcome: null, at: BEFORE });
    const view = buildReturnView(
      freshInput({ workItems: [w], contracts: [c], attempts: [a], integrations: [i] }),
    );
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.integration!.state, "pending");
    assert.equal(item.integration!.targetRef, "refs/heads/main");
  });

  // 29. Merge boundary: integrated outcome, resulting revision present, changed since visit
  it("merge item with integrated outcome appears in changedSinceLastVisit with resultingRevision", () => {
    const c = contract({ id: "c1", workItemId: "w1", updatedAt: BEFORE });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed", updatedAt: BEFORE });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge", updatedAt: BEFORE });
    const i = integ({
      id: "i1",
      attemptId: "a1",
      outcome: "integrated",
      resultingRevision: "abc1234def5678901234567890abcdef12345678",
      at: AFTER, // after lastAckAt
    });
    const view = buildReturnView(
      freshInput({
        workItems: [w],
        contracts: [c],
        attempts: [a],
        integrations: [i],
        lastAckAt: LAST_ACK,
      }),
    );
    // Item should appear in changedSinceLastVisit because integration.at > lastAckAt
    assert.equal(view.changedSinceLastVisit.length, 1);
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.workItemId, "w1");
    assert.equal(item.integration!.state, "integrated");
    assert.equal(item.integration!.outcome, "integrated");
    assert.equal(item.integration!.resultingRevision, "abc1234def5678901234567890abcdef12345678");
    assert.equal(item.integration!.source, "ledger");
  });

  // 30. Merge boundary: already_integrated outcome → state=integrated
  it("already_integrated outcome maps to state=integrated", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge" });
    const i = integ({ id: "i1", attemptId: "a1", outcome: "already_integrated" });
    const view = buildReturnView(
      freshInput({ workItems: [w], contracts: [c], attempts: [a], integrations: [i] }),
    );
    assert.equal(view.changedSinceLastVisit[0]!.integration!.state, "integrated");
  });

  // 31. Merge boundary: conflict outcome → state=failed, pending decision with finding evidence
  it("merge item with conflict outcome has state=failed and enriches pending decision with finding evidence", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge" });
    const i = integ({ id: "i1", attemptId: "a1", outcome: "conflict", at: BEFORE });
    const f: FindingLike = {
      id: "f1",
      attemptId: "a1",
      severity: "error",
      kind: "integration_conflict",
      evidence: "Conflict in src/main.ts lines 10-20",
    };
    const d: DecisionLike = {
      id: "d1",
      workItemId: "w1",
      kind: "integration_conflict",
      outcome: "pending_human",
      at: NOW,
    };
    const view = buildReturnView(
      freshInput({
        workItems: [w],
        contracts: [c],
        attempts: [a],
        integrations: [i],
        findings: [f],
        decisions: [d],
      }),
    );
    // integration state should be failed
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.integration!.state, "failed");
    assert.equal(item.integration!.outcome, "conflict");
    // pending decision should be present with finding evidence as detail
    assert.equal(view.pendingDecisions.length, 1);
    const pd = view.pendingDecisions[0]!;
    assert.equal(pd.decisionId, "d1");
    assert.equal(pd.detail, "Conflict in src/main.ts lines 10-20");
  });

  // 32. Merge boundary: push_rejected outcome → state=failed
  it("push_rejected outcome maps to state=failed", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge" });
    const i = integ({ id: "i1", attemptId: "a1", outcome: "push_rejected" });
    const view = buildReturnView(
      freshInput({ workItems: [w], contracts: [c], attempts: [a], integrations: [i] }),
    );
    assert.equal(view.changedSinceLastVisit[0]!.integration!.state, "failed");
  });

  // 33. Manifest: 1 of 2 projects resolved
  it("manifest shows resolved/total from work_item_projects", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge" });
    const wip1 = workItemProject({ workItemId: "w1", position: 1, resultRevision: "abc123" });
    const wip2 = workItemProject({ workItemId: "w1", position: 2, resultRevision: null });
    const view = buildReturnView(
      freshInput({
        workItems: [w],
        contracts: [c],
        attempts: [a],
        workItemProjects: [wip1, wip2],
      }),
    );
    const item = view.changedSinceLastVisit[0]!;
    assert.ok(item.manifest !== null);
    assert.equal(item.manifest!.resolved, 1);
    assert.equal(item.manifest!.total, 2);
  });

  // 34. Manifest: null when no work_item_projects rows
  it("manifest is null when no work_item_projects rows exist for merge item", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge" });
    const view = buildReturnView(freshInput({ workItems: [w], contracts: [c], attempts: [a] }));
    const item = view.changedSinceLastVisit[0]!;
    assert.equal(item.manifest, null);
  });

  // 35. Decision with explicit detail: finding evidence does not override it
  it("pending decision explicit detail is preserved, not overridden by finding evidence", () => {
    const c = contract({ id: "c1", workItemId: "w1" });
    const a = attempt({ id: "a1", contractId: "c1", status: "completed" });
    const w = wi({ id: "w1", intent: "merge work", boundary: "merge" });
    const i = integ({ id: "i1", attemptId: "a1", outcome: "conflict" });
    const f: FindingLike = {
      id: "f1",
      attemptId: "a1",
      severity: "error",
      kind: "integration_conflict",
      evidence: "finding evidence",
    };
    const d: DecisionLike = {
      id: "d1",
      workItemId: "w1",
      kind: "integration_conflict",
      outcome: "pending_human",
      at: NOW,
      detail: "explicit detail from decision",
    };
    const view = buildReturnView(
      freshInput({
        workItems: [w],
        contracts: [c],
        attempts: [a],
        integrations: [i],
        findings: [f],
        decisions: [d],
      }),
    );
    assert.equal(view.pendingDecisions[0]!.detail, "explicit detail from decision");
  });
});
