import assert from "node:assert/strict";
import test from "node:test";
import {
  asApprovalId,
  asAttemptId,
  asDecisionId,
  asDispatchIntentId,
  asFindingId,
  asProjectId,
  asStepContractId,
  asWorkItemId,
  newId,
} from "../src/ids.ts";

test("newId generates ids with correct prefix", () => {
  const projectId = newId("prj");
  assert.ok(projectId.startsWith("prj_"), `Expected prj_ prefix, got: ${projectId}`);

  const workItemId = newId("wi");
  assert.ok(workItemId.startsWith("wi_"));

  const contractId = newId("sc");
  assert.ok(contractId.startsWith("sc_"));

  const attemptId = newId("att");
  assert.ok(attemptId.startsWith("att_"));

  const intentId = newId("di");
  assert.ok(intentId.startsWith("di_"));

  const artifactId = newId("art");
  assert.ok(artifactId.startsWith("art_"));

  const vrId = newId("vr");
  assert.ok(vrId.startsWith("vr_"));

  const reviewId = newId("rev");
  assert.ok(reviewId.startsWith("rev_"));

  const decisionId = newId("dec");
  assert.ok(decisionId.startsWith("dec_"));

  const approvalId = newId("apr");
  assert.ok(approvalId.startsWith("apr_"));

  const findingId = newId("fnd");
  assert.ok(findingId.startsWith("fnd_"));

  const failureId = newId("fail");
  assert.ok(failureId.startsWith("fail_"));

  const commandId = newId("cmd");
  assert.ok(commandId.startsWith("cmd_"));
});

test("newId generates unique ids", () => {
  const id1 = newId("prj");
  const id2 = newId("prj");
  assert.notEqual(id1, id2);
});

test("asXId succeeds for valid prefixed strings", () => {
  const raw = "prj_abc123";
  const id = asProjectId(raw);
  assert.equal(id, raw);

  const wi = asWorkItemId("wi_abc");
  assert.equal(wi, "wi_abc");

  const sc = asStepContractId("sc_abc");
  assert.equal(sc, "sc_abc");

  const att = asAttemptId("att_abc");
  assert.equal(att, "att_abc");

  const di = asDispatchIntentId("di_abc");
  assert.equal(di, "di_abc");

  const dec = asDecisionId("dec_abc");
  assert.equal(dec, "dec_abc");

  const apr = asApprovalId("apr_abc");
  assert.equal(apr, "apr_abc");

  const fnd = asFindingId("fnd_abc");
  assert.equal(fnd, "fnd_abc");
});

test("asXId throws for wrong prefix", () => {
  assert.throws(() => asProjectId("wi_abc"), /prefix/);
  assert.throws(() => asWorkItemId("prj_abc"), /prefix/);
  assert.throws(() => asAttemptId("bad_abc"), /prefix/);
});

test("asXId throws for empty string", () => {
  assert.throws(() => asProjectId(""), /prefix/);
});
