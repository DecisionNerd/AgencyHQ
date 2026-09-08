/**
 * Finding disposition unit tests (R-017).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { FindingLike } from "../src/evidence/types.ts";
import { applyDisposition } from "../src/findings/disposition.ts";

const CONTRACT_DIGEST = `sha256:${"a".repeat(64)}` as `sha256:${string}`;

const CTX = {
  contractDigest: CONTRACT_DIGEST,
  workItemId: "wi-1",
  at: "2024-01-01T00:00:00Z",
};

const FINDING: FindingLike = {
  id: "f-1",
  severity: "non_blocking",
  kind: "unrelated",
  description: "Unrelated diagnostic improvement in parser.",
  evidence: "src/parser.ts:42",
};

const BLOCKING_FINDING: FindingLike = {
  id: "f-2",
  severity: "blocking",
  kind: "unmet_criterion",
  description: "Criterion not met.",
  evidence: "src/output.ts:10",
};

// ---------------------------------------------------------------------------
// Backlog disposition
// ---------------------------------------------------------------------------
test("disposition: backlog produces backlog_work_item_requested event", () => {
  const result = applyDisposition(FINDING, "backlog", CTX);
  assert.equal(result.events.length, 1);
  const ev = result.events[0]!;
  assert.equal(ev.type, "backlog_work_item_requested");
  if (ev.type === "backlog_work_item_requested") {
    assert.equal(ev.subject, FINDING.id);
    assert.equal(ev.description, FINDING.description);
  }
});

test("disposition: backlog contractDigest unchanged (R-017)", () => {
  const result = applyDisposition(FINDING, "backlog", CTX);
  assert.equal(result.contractDigestAfter, CONTRACT_DIGEST);
});

// ---------------------------------------------------------------------------
// Remediate disposition
// ---------------------------------------------------------------------------
test("disposition: remediate produces remediation_attempt_requested event", () => {
  const result = applyDisposition(BLOCKING_FINDING, "remediate", CTX);
  assert.equal(result.events.length, 1);
  const ev = result.events[0]!;
  assert.equal(ev.type, "remediation_attempt_requested");
  if (ev.type === "remediation_attempt_requested") {
    assert.equal(ev.findingId, BLOCKING_FINDING.id);
  }
});

test("disposition: remediate contractDigest unchanged (R-017)", () => {
  const result = applyDisposition(BLOCKING_FINDING, "remediate", CTX);
  assert.equal(result.contractDigestAfter, CONTRACT_DIGEST);
});

// ---------------------------------------------------------------------------
// Scope decision disposition
// ---------------------------------------------------------------------------
test("disposition: scope_decision produces scope_decision_requested event", () => {
  const result = applyDisposition(FINDING, "scope_decision", CTX);
  assert.equal(result.events.length, 1);
  const ev = result.events[0]!;
  assert.equal(ev.type, "scope_decision_requested");
  if (ev.type === "scope_decision_requested") {
    assert.equal(ev.findingId, FINDING.id);
  }
});

test("disposition: scope_decision contractDigest unchanged (R-017)", () => {
  const result = applyDisposition(FINDING, "scope_decision", CTX);
  assert.equal(result.contractDigestAfter, CONTRACT_DIGEST);
});

// ---------------------------------------------------------------------------
// Block disposition
// ---------------------------------------------------------------------------
test("disposition: block produces attempt_blocked event", () => {
  const result = applyDisposition(BLOCKING_FINDING, "block", CTX);
  assert.equal(result.events.length, 1);
  const ev = result.events[0]!;
  assert.equal(ev.type, "attempt_blocked");
  if (ev.type === "attempt_blocked") {
    assert.equal(ev.findingId, BLOCKING_FINDING.id);
  }
});

test("disposition: block contractDigest unchanged (R-017)", () => {
  const result = applyDisposition(BLOCKING_FINDING, "block", CTX);
  assert.equal(result.contractDigestAfter, CONTRACT_DIGEST);
});

// ---------------------------------------------------------------------------
// Dismiss disposition
// ---------------------------------------------------------------------------
test("disposition: dismiss produces finding_dismissed event", () => {
  const result = applyDisposition(FINDING, "dismiss", CTX);
  assert.equal(result.events.length, 1);
  const ev = result.events[0]!;
  assert.equal(ev.type, "finding_dismissed");
  if (ev.type === "finding_dismissed") {
    assert.equal(ev.findingId, FINDING.id);
    assert.ok(typeof ev.reason === "string");
  }
});

test("disposition: dismiss contractDigest unchanged (R-017)", () => {
  const result = applyDisposition(FINDING, "dismiss", CTX);
  assert.equal(result.contractDigestAfter, CONTRACT_DIGEST);
});

// ---------------------------------------------------------------------------
// Finding is returned as-is (not mutated)
// ---------------------------------------------------------------------------
test("disposition: finding is returned unchanged", () => {
  const result = applyDisposition(FINDING, "backlog", CTX);
  assert.deepEqual(result.finding, FINDING);
});

// ---------------------------------------------------------------------------
// Contract digest equality: every disposition type
// ---------------------------------------------------------------------------
test("disposition: contractDigestAfter equals input contractDigest for all disposition types", () => {
  const dispositions = ["backlog", "remediate", "scope_decision", "block", "dismiss"] as const;
  for (const disposition of dispositions) {
    const result = applyDisposition(FINDING, disposition, CTX);
    assert.equal(
      result.contractDigestAfter,
      CONTRACT_DIGEST,
      `disposition "${disposition}" must not change contract digest`,
    );
  }
});
