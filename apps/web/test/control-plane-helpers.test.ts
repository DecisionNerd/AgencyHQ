import assert from "node:assert/strict";
import test from "node:test";

import type { OpenPendingDecisionHelper } from "../src/control-plane-helpers.ts";
import {
  buildApproveBody,
  buildDecisionRow,
  buildDispositionRemediateBody,
  buildInvalidateAcceptanceBody,
  buildOverviewWorkItemRow,
  buildPauseBody,
  buildRejectBody,
  buildResumeBody,
  buildStopBody,
  conditionIcon,
  confirmMessage,
  formatAuthorityErrors,
  formatTimestamp,
  lifecycleIcon,
  parseRoute,
  pickLatestAttempt,
  pickOpenDecision,
} from "../src/control-plane-helpers.ts";

// ---- parseRoute ------------------------------------------------------------

test("parseRoute: #/ returns overview", () => {
  assert.deepEqual(parseRoute("#/"), { page: "overview" });
});

test("parseRoute: empty string returns overview", () => {
  assert.deepEqual(parseRoute(""), { page: "overview" });
});

test("parseRoute: bare / returns overview", () => {
  assert.deepEqual(parseRoute("/"), { page: "overview" });
});

test("parseRoute: #/return returns return page", () => {
  assert.deepEqual(parseRoute("#/return"), { page: "return" });
});

test("parseRoute: #/decisions returns decisions page", () => {
  assert.deepEqual(parseRoute("#/decisions"), { page: "decisions" });
});

test("parseRoute: #/work-items/:id returns work-item page with id", () => {
  const result = parseRoute("#/work-items/wi-abc123");
  assert.deepEqual(result, { page: "work-item", id: "wi-abc123" });
});

test("parseRoute: #/work-items/:id decodes URL-encoded id", () => {
  const result = parseRoute("#/work-items/wi%20abc");
  assert.deepEqual(result, { page: "work-item", id: "wi abc" });
});

test("parseRoute: #/projects/:id/authority returns authority page", () => {
  const result = parseRoute("#/projects/proj-1/authority");
  assert.deepEqual(result, { page: "authority", projectId: "proj-1" });
});

test("parseRoute: #/projects/:id/authority decodes URL-encoded id", () => {
  const result = parseRoute("#/projects/proj%20a/authority");
  assert.deepEqual(result, { page: "authority", projectId: "proj a" });
});

test("parseRoute: unknown path returns not-found", () => {
  assert.deepEqual(parseRoute("#/unknown/path"), { page: "not-found" });
});

test("parseRoute: /work-items/ without id returns not-found", () => {
  // Just the prefix without an id segment
  assert.deepEqual(parseRoute("#/work-items/"), { page: "not-found" });
});

test("parseRoute: route table — all main routes", () => {
  const cases: Array<[string, ReturnType<typeof parseRoute>]> = [
    ["#/", { page: "overview" }],
    ["#/return", { page: "return" }],
    ["#/decisions", { page: "decisions" }],
    ["#/work-items/wi-1", { page: "work-item", id: "wi-1" }],
    ["#/projects/p-1/authority", { page: "authority", projectId: "p-1" }],
    ["#/nope", { page: "not-found" }],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseRoute(input), expected, `parseRoute(${input})`);
  }
});

// ---- formatTimestamp -------------------------------------------------------

test("formatTimestamp: returns locale string for valid ISO date", () => {
  const result = formatTimestamp("2026-09-07T10:00:00.000Z");
  assert.ok(typeof result === "string" && result.length > 0);
  assert.notEqual(result, "no timestamp");
});

test("formatTimestamp: returns 'no timestamp' for null", () => {
  assert.equal(formatTimestamp(null), "no timestamp");
});

test("formatTimestamp: returns 'no timestamp' for undefined", () => {
  assert.equal(formatTimestamp(undefined), "no timestamp");
});

// ---- lifecycleIcon ---------------------------------------------------------

test("lifecycleIcon: running returns ▶", () => {
  assert.equal(lifecycleIcon("running"), "▶");
});

test("lifecycleIcon: done returns ✅", () => {
  assert.equal(lifecycleIcon("done"), "✅");
});

test("lifecycleIcon: unknown returns ○", () => {
  assert.equal(lifecycleIcon("xyzzy"), "○");
});

test("lifecycleIcon: case-insensitive", () => {
  assert.equal(lifecycleIcon("RUNNING"), "▶");
});

// ---- conditionIcon ---------------------------------------------------------

test("conditionIcon: nominal returns ✓", () => {
  assert.equal(conditionIcon("nominal"), "✓");
});

test("conditionIcon: blocked returns ✗", () => {
  assert.equal(conditionIcon("blocked"), "✗");
});

test("conditionIcon: unknown returns ○", () => {
  assert.equal(conditionIcon("xyzzy"), "○");
});

// ---- buildOverviewWorkItemRow ----------------------------------------------

test("buildOverviewWorkItemRow: maps all fields correctly", () => {
  const row = buildOverviewWorkItemRow({
    id: "wi-1",
    intent: "Add feature X",
    rank: 3,
    mainEffort: true,
    lifecycle: "running",
    condition: "nominal",
    boundary: "merge",
    campaignId: "camp-1",
    pendingDecisionCount: 2,
  });

  assert.equal(row.id, "wi-1");
  assert.equal(row.intent, "Add feature X");
  assert.equal(row.rank, 3);
  assert.equal(row.mainEffort, true);
  assert.equal(row.lifecycle, "running");
  assert.equal(row.lifecycleIcon, "▶");
  assert.equal(row.condition, "nominal");
  assert.equal(row.conditionIcon, "✓");
  assert.equal(row.boundary, "merge");
  assert.equal(row.campaignId, "camp-1");
  assert.equal(row.pendingDecisionCount, 2);
});

test("buildOverviewWorkItemRow: unknown lifecycle/condition get fallback icons", () => {
  const row = buildOverviewWorkItemRow({
    id: "wi-2",
    intent: "x",
    rank: 1,
    mainEffort: false,
    lifecycle: "new_unknown",
    condition: "new_unknown",
    boundary: "artifact",
    campaignId: null,
    pendingDecisionCount: 0,
  });
  assert.equal(row.lifecycleIcon, "○");
  assert.equal(row.conditionIcon, "○");
});

// ---- buildDecisionRow ------------------------------------------------------

test("buildDecisionRow: maps all fields and adds formattedAt", () => {
  const entry = {
    id: "dec-1",
    workItemId: "wi-1",
    obstacle: "policy_violation",
    recommendation: "fix the issue",
    impact: {
      workItemId: "wi-1",
      contractVersion: 2,
      attemptId: "att-1",
      contractId: "ct-1",
      attemptRevision: "rev-abc",
    },
    noActionConsequence: "stays pending; no dispatch",
    actions: ["approve", "reject"],
    at: "2026-09-07T10:00:00.000Z",
  };
  const row = buildDecisionRow(entry);

  assert.equal(row.id, "dec-1");
  assert.equal(row.workItemId, "wi-1");
  assert.equal(row.obstacle, "policy_violation");
  assert.equal(row.recommendation, "fix the issue");
  assert.deepEqual(row.impact, {
    workItemId: "wi-1",
    contractVersion: 2,
    attemptId: "att-1",
    contractId: "ct-1",
    attemptRevision: "rev-abc",
  });
  assert.equal(row.noActionConsequence, "stays pending; no dispatch");
  assert.deepEqual(row.actions, ["approve", "reject"]);
  assert.equal(row.at, "2026-09-07T10:00:00.000Z");
  assert.ok(typeof row.formattedAt === "string" && row.formattedAt !== "no timestamp");
});

// ---- buildApproveBody ------------------------------------------------------

test("buildApproveBody: matches coordinator field names exactly", () => {
  const body = buildApproveBody({
    commandId: "cmd-1",
    workItemId: "wi-1",
    contractId: "con-1",
    contractVersion: 3,
    attemptRevision: "rev-abc",
  });

  assert.deepEqual(body, {
    commandId: "cmd-1",
    kind: "approve",
    workItemId: "wi-1",
    contractId: "con-1",
    contractVersion: 3,
    attemptRevision: "rev-abc",
    actor: "human",
  });
});

// ---- buildRejectBody -------------------------------------------------------

test("buildRejectBody: matches coordinator field names exactly", () => {
  const body = buildRejectBody({
    commandId: "cmd-2",
    workItemId: "wi-2",
    decisionId: "dec-2",
    reason: "not ready",
  });

  assert.deepEqual(body, {
    commandId: "cmd-2",
    kind: "reject",
    workItemId: "wi-2",
    decisionId: "dec-2",
    reason: "not ready",
  });
});

// ---- buildStopBody ---------------------------------------------------------

test("buildStopBody: matches coordinator field names exactly", () => {
  const body = buildStopBody({
    commandId: "cmd-3",
    attemptId: "att-3",
  });

  assert.deepEqual(body, {
    commandId: "cmd-3",
    kind: "stop",
    attemptId: "att-3",
    actor: "human",
    reason: "operator requested",
  });
});

// ---- buildPauseBody --------------------------------------------------------

test("buildPauseBody: matches coordinator field names exactly", () => {
  const body = buildPauseBody({
    commandId: "cmd-4",
    workItemId: "wi-4",
    reason: "operator pause",
  });

  assert.deepEqual(body, {
    commandId: "cmd-4",
    kind: "pause",
    workItemId: "wi-4",
    reason: "operator pause",
  });
});

// ---- buildResumeBody -------------------------------------------------------

test("buildResumeBody: matches coordinator field names exactly", () => {
  const body = buildResumeBody({
    commandId: "cmd-5",
    workItemId: "wi-5",
    reason: "operator resume",
  });

  assert.deepEqual(body, {
    commandId: "cmd-5",
    kind: "resume",
    workItemId: "wi-5",
    reason: "operator resume",
  });
});

// ---- buildDispositionRemediateBody -----------------------------------------

test("buildDispositionRemediateBody: matches coordinator field names exactly", () => {
  const body = buildDispositionRemediateBody({
    commandId: "cmd-6",
    findingId: "find-6",
  });

  assert.deepEqual(body, {
    commandId: "cmd-6",
    kind: "disposition",
    findingId: "find-6",
    disposition: "remediate",
    actor: "human",
    reason: "",
  });
});

// ---- buildInvalidateAcceptanceBody -----------------------------------------

test("buildInvalidateAcceptanceBody: matches coordinator field names exactly", () => {
  const body = buildInvalidateAcceptanceBody({
    commandId: "cmd-7",
    workItemId: "wi-7",
    attemptId: "att-7",
    reason: "stale acceptance",
  });

  assert.deepEqual(body, {
    commandId: "cmd-7",
    kind: "invalidate_acceptance",
    workItemId: "wi-7",
    attemptId: "att-7",
    reason: "stale acceptance",
  });
});

// ---- formatAuthorityErrors -------------------------------------------------

test("formatAuthorityErrors: returns empty string for empty array", () => {
  assert.equal(formatAuthorityErrors([]), "");
});

test("formatAuthorityErrors: formats error with path", () => {
  const result = formatAuthorityErrors([{ message: "required", path: ["maxBudget"] }]);
  assert.equal(result, "maxBudget: required");
});

test("formatAuthorityErrors: formats error without path", () => {
  const result = formatAuthorityErrors([{ message: "Invalid authority" }]);
  assert.equal(result, "Invalid authority");
});

test("formatAuthorityErrors: joins multiple errors with newline", () => {
  const result = formatAuthorityErrors([
    { message: "required", path: ["maxBudget"] },
    { message: "must be string", path: ["scope", "0"] },
    { message: "root error" },
  ]);
  assert.equal(result, "maxBudget: required\nscope.0: must be string\nroot error");
});

test("formatAuthorityErrors: deep path is joined with dots", () => {
  const result = formatAuthorityErrors([{ message: "too short", path: ["a", "b", "c"] }]);
  assert.equal(result, "a.b.c: too short");
});

// ---- confirmMessage ---------------------------------------------------------

test("confirmMessage: contains project id, work item id, and capitalised action", () => {
  const msg = confirmMessage({
    action: "approve",
    projectId: "prj-abc",
    workItemId: "wi-xyz",
  });
  assert.ok(msg.includes("prj-abc"), "should contain projectId");
  assert.ok(msg.includes("wi-xyz"), "should contain workItemId");
  assert.ok(msg.startsWith("Approve"), "should capitalise action");
});

test("confirmMessage: appends contract version when provided", () => {
  const msg = confirmMessage({
    action: "approve",
    projectId: "prj-1",
    workItemId: "wi-1",
    contractVersion: 3,
  });
  assert.ok(msg.includes("prj-1"), "should contain projectId");
  assert.ok(msg.includes("wi-1"), "should contain workItemId");
  assert.ok(msg.includes("v3"), "should contain 'v3'");
});

test("confirmMessage: omits version suffix when contractVersion is null", () => {
  const msg = confirmMessage({
    action: "reject",
    projectId: "prj-2",
    workItemId: "wi-2",
    contractVersion: null,
  });
  assert.ok(msg.includes("prj-2"), "should contain projectId");
  assert.ok(msg.includes("wi-2"), "should contain workItemId");
  assert.ok(!msg.includes("contract"), "should not mention contract when version is null");
});

test("confirmMessage: omits version suffix when contractVersion is undefined", () => {
  const msg = confirmMessage({
    action: "stop",
    projectId: "prj-3",
    workItemId: "wi-3",
  });
  assert.ok(msg.includes("prj-3"), "should contain projectId");
  assert.ok(msg.includes("wi-3"), "should contain workItemId");
  assert.ok(!msg.includes("contract"), "should not mention contract when version is omitted");
});

test("confirmMessage: includes attempt id when provided", () => {
  const msg = confirmMessage({
    action: "approve",
    projectId: "prj-1",
    workItemId: "wi-1",
    contractVersion: 3,
    attemptId: "att-abc123",
  });
  assert.ok(msg.includes("att-abc123"), "should contain attemptId");
  assert.ok(msg.includes("v3"), "should contain contract version");
  assert.ok(msg.includes("prj-1"), "should contain projectId");
  assert.ok(msg.includes("wi-1"), "should contain workItemId");
});

test("confirmMessage: omits attempt id when not provided", () => {
  const msg = confirmMessage({
    action: "approve",
    projectId: "prj-1",
    workItemId: "wi-1",
    contractVersion: 2,
  });
  assert.ok(!msg.includes("attempt"), "should not mention attempt when not provided");
});

test("confirmMessage: includes consequence phrase when provided", () => {
  const msg = confirmMessage({
    action: "reject",
    projectId: "prj-1",
    workItemId: "wi-1",
    consequence: "halts the work item; no further attempts",
  });
  assert.ok(msg.includes("halts the work item"), "should contain consequence phrase");
  assert.ok(msg.includes("no further attempts"), "should contain full consequence");
});

test("confirmMessage: consequence appears on a new line", () => {
  const msg = confirmMessage({
    action: "stop",
    projectId: "prj-1",
    workItemId: "wi-1",
    attemptId: "att-xyz",
    consequence: "stops the running attempt; the checkpoint is kept",
  });
  assert.ok(msg.includes("\n"), "consequence should be on a new line");
  assert.ok(msg.includes("stops the running attempt"), "should contain stop consequence");
});

test("confirmMessage: stop includes contract version and consequence", () => {
  const msg = confirmMessage({
    action: "stop",
    projectId: "prj-stop",
    workItemId: "wi-stop",
    attemptId: "att-stop-1",
    contractVersion: 3,
    consequence: "stops the running attempt; the checkpoint is kept",
  });
  assert.ok(/v3/.test(msg), "should contain contract version v3");
  assert.ok(msg.includes("att-stop-1"), "should contain attemptId");
  assert.ok(msg.includes("stops the running attempt"), "should contain stop consequence");
  assert.ok(msg.includes("\n"), "consequence should be on a new line");
});

test("confirmMessage: pause includes consequence and version when provided", () => {
  const msg = confirmMessage({
    action: "pause",
    projectId: "prj-pause",
    workItemId: "wi-pause",
    attemptId: "att-pause-1",
    contractVersion: 2,
    consequence: "pauses dispatch for this work item; running attempts continue",
  });
  assert.ok(/v2/.test(msg), "should contain contract version v2");
  assert.ok(msg.includes("att-pause-1"), "should contain attemptId");
  assert.ok(msg.includes("pauses dispatch"), "should contain pause consequence");
});

test("confirmMessage: omits consequence when not provided", () => {
  const msg = confirmMessage({
    action: "pause",
    projectId: "prj-1",
    workItemId: "wi-1",
  });
  // No consequence → no newline in the message
  assert.ok(!msg.includes("\n"), "no newline when consequence is omitted");
});

// ---- pickOpenDecision --------------------------------------------------------

test("pickOpenDecision: returns null for undefined input", () => {
  assert.equal(pickOpenDecision(undefined), null);
});

test("pickOpenDecision: returns null for null input", () => {
  assert.equal(pickOpenDecision(null), null);
});

test("pickOpenDecision: returns null for empty array", () => {
  assert.equal(pickOpenDecision([]), null);
});

test("pickOpenDecision: returns first element of a non-empty array", () => {
  const decision: OpenPendingDecisionHelper = {
    id: "dec-1",
    kind: "accept",
    attemptId: "att-1",
    contractVersion: 3,
    at: "2026-09-08T10:00:00.000Z",
  };
  assert.deepEqual(pickOpenDecision([decision]), decision);
});

test("pickOpenDecision: returns first of multiple decisions", () => {
  const first: OpenPendingDecisionHelper = {
    id: "dec-1",
    kind: "accept",
    attemptId: "att-1",
    contractVersion: 3,
    at: "2026-09-08T10:00:00.000Z",
  };
  const second: OpenPendingDecisionHelper = {
    id: "dec-2",
    kind: "review",
    attemptId: null,
    contractVersion: null,
    at: "2026-09-08T11:00:00.000Z",
  };
  assert.deepEqual(pickOpenDecision([first, second]), first);
});

// ---- pickLatestAttempt -----------------------------------------------------

test("pickLatestAttempt: returns undefined for empty array", () => {
  assert.equal(pickLatestAttempt([]), undefined);
});

test("pickLatestAttempt: returns undefined for null", () => {
  assert.equal(pickLatestAttempt(null), undefined);
});

test("pickLatestAttempt: returns undefined for undefined", () => {
  assert.equal(pickLatestAttempt(undefined), undefined);
});

test("pickLatestAttempt: v1 completed + v2 running → returns the running v2 attempt", () => {
  const v1Completed = {
    id: "att-v1-completed",
    contractVersion: 1,
    status: "completed",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  const v2Running = {
    id: "att-v2-running",
    contractVersion: 2,
    status: "running",
    updatedAt: "2026-09-01T11:00:00.000Z",
  };
  // Evidence route returns ascending by contractVersion, so v1 first.
  assert.deepEqual(pickLatestAttempt([v1Completed, v2Running]), v2Running);
});

test("pickLatestAttempt: two completed attempts → returns the one with the higher contract version", () => {
  const v1 = {
    id: "att-v1",
    contractVersion: 1,
    status: "completed",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  const v2 = {
    id: "att-v2",
    contractVersion: 2,
    status: "completed",
    updatedAt: "2026-09-01T11:00:00.000Z",
  };
  assert.deepEqual(pickLatestAttempt([v1, v2]), v2);
});

test("pickLatestAttempt: same version, two completed → returns the one with later updatedAt", () => {
  const older = {
    id: "att-older",
    contractVersion: 1,
    status: "completed",
    updatedAt: "2026-09-01T09:00:00.000Z",
  };
  const newer = {
    id: "att-newer",
    contractVersion: 1,
    status: "completed",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  assert.deepEqual(pickLatestAttempt([older, newer]), newer);
});

test("pickLatestAttempt: dispatched attempt preferred over higher-version completed", () => {
  const dispatched = {
    id: "att-dispatched",
    contractVersion: 1,
    status: "dispatched",
    updatedAt: "2026-09-01T08:00:00.000Z",
  };
  const completed = {
    id: "att-completed",
    contractVersion: 2,
    status: "completed",
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
  // dispatched is active → preferred despite lower version
  assert.deepEqual(pickLatestAttempt([dispatched, completed]), dispatched);
});

test("pickLatestAttempt: stopping attempt is treated as active", () => {
  const stopping = {
    id: "att-stopping",
    contractVersion: 1,
    status: "stopping",
    updatedAt: "2026-09-01T08:00:00.000Z",
  };
  const completed = {
    id: "att-completed",
    contractVersion: 3,
    status: "completed",
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
  assert.deepEqual(pickLatestAttempt([stopping, completed]), stopping);
});

test("pickLatestAttempt: pause confirm message names version when there is no open decision (unit coverage for X-3)", () => {
  // Verifies the pause path: no openDecision, so pause uses latestAttempt directly.
  // pickLatestAttempt picks the running attempt; confirmMessage uses its version.
  const v1Completed = {
    id: "att-v1",
    contractVersion: 1,
    status: "completed",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  const v2Running = {
    id: "att-v2",
    contractVersion: 2,
    status: "running",
    updatedAt: "2026-09-01T11:00:00.000Z",
  };
  const latest = pickLatestAttempt([v1Completed, v2Running]);
  assert.equal(latest?.id, "att-v2");

  // No open decision → pause uses latestAttempt's version and id.
  const msg = confirmMessage({
    action: "pause",
    projectId: "prj-1",
    workItemId: "wi-1",
    attemptId: latest?.id,
    contractVersion: latest?.contractVersion,
    consequence: "pauses dispatch for this work item; running attempts continue",
  });
  assert.match(msg, /contract v2/);
  assert.ok(msg.includes("att-v2"), "pause message should include the running attempt id");
  assert.ok(msg.includes("pauses dispatch"), "pause message should include consequence");
});
