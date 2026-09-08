import assert from "node:assert/strict";
import test from "node:test";

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
  formatAuthorityErrors,
  formatTimestamp,
  lifecycleIcon,
  parseRoute,
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
    impact: { workItemId: "wi-1", contractVersion: 2, attemptId: "att-1" },
    noActionConsequence: "stays pending; no dispatch",
    actions: ["approve", "reject"],
    at: "2026-09-07T10:00:00.000Z",
  };
  const row = buildDecisionRow(entry);

  assert.equal(row.id, "dec-1");
  assert.equal(row.workItemId, "wi-1");
  assert.equal(row.obstacle, "policy_violation");
  assert.equal(row.recommendation, "fix the issue");
  assert.deepEqual(row.impact, { workItemId: "wi-1", contractVersion: 2, attemptId: "att-1" });
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
