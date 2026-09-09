// Tests for lib/evidence.ts — collectStopEvidence and uploadStopEvidence.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FakeBroker } from "../src/lib/broker.ts";
import { collectStopEvidence, uploadStopEvidence } from "../src/lib/evidence.ts";

async function makeRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agencyhq-evidence-test-"));
}

test("collectStopEvidence: returns empty steps when stop.ndjson does not exist", async () => {
  const runDir = await makeRunDir();
  try {
    const result = await collectStopEvidence(runDir);
    assert.deepEqual(result.steps, []);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("collectStopEvidence: parses known step names and drops unknown ones", async () => {
  const runDir = await makeRunDir();
  try {
    const lines = [
      JSON.stringify({ at: "2026-09-09T10:00:00.000Z", step: "signal_sent" }),
      JSON.stringify({ at: "2026-09-09T10:00:01.000Z", step: "unknown_step", detail: "ignored" }),
      JSON.stringify({ at: "2026-09-09T10:00:02.000Z", step: "process_exited", detail: "exit 0" }),
      JSON.stringify({ at: "2026-09-09T10:00:03.000Z", step: "checkpoint_committed" }),
    ].join("\n");

    await writeFile(join(runDir, "stop.ndjson"), lines, "utf8");

    const result = await collectStopEvidence(runDir);
    assert.equal(result.steps.length, 3, "unknown steps should be dropped");
    assert.equal(result.steps[0]?.step, "signal_sent");
    assert.equal(result.steps[1]?.step, "process_exited");
    assert.equal(result.steps[1]?.detail, "exit 0");
    assert.equal(result.steps[2]?.step, "checkpoint_committed");
    assert.equal(result.steps[2]?.detail, undefined);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("collectStopEvidence: detail newlines are stripped", async () => {
  const runDir = await makeRunDir();
  try {
    const line = JSON.stringify({
      at: "2026-09-09T10:00:00.000Z",
      step: "aborted",
      detail: "line one\nline two",
    });
    await writeFile(join(runDir, "stop.ndjson"), line, "utf8");

    const result = await collectStopEvidence(runDir);
    assert.equal(result.steps.length, 1);
    assert.ok(!result.steps[0]?.detail?.includes("\n"), "detail must not contain newlines");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("uploadStopEvidence: posts steps equal to those in stop.ndjson", async () => {
  const runDir = await makeRunDir();
  try {
    const lines = [
      JSON.stringify({ at: "2026-09-09T10:00:00.000Z", step: "signal_sent" }),
      JSON.stringify({ at: "2026-09-09T10:00:01.000Z", step: "process_exited", detail: "exit 0" }),
    ].join("\n");
    await writeFile(join(runDir, "stop.ndjson"), lines, "utf8");

    const broker = new FakeBroker();
    const result = await uploadStopEvidence({
      runDir,
      attemptId: "attempt-1",
      generation: 0,
      broker,
      token: "upload-token",
    });

    assert.equal(result.uploadStatus, "uploaded");
    assert.equal(broker.calls.length, 1);
    const call = broker.calls[0];
    if (!call) {
      assert.fail("expected a recorded call");
      return;
    }
    assert.equal(call.op, "uploadStopEvidence");
    if (call.op === "uploadStopEvidence") {
      // Must match the count in stop.ndjson.
      assert.equal(call.stepCount, 2);
    }

    // Token must not appear in call records.
    const callStr = JSON.stringify(broker.calls);
    assert.ok(!callStr.includes("upload-token"), "token must not appear in call records");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("uploadStopEvidence: returns skipped when no steps exist", async () => {
  const runDir = await makeRunDir();
  try {
    const broker = new FakeBroker();
    const result = await uploadStopEvidence({
      runDir,
      attemptId: "attempt-1",
      generation: 0,
      broker,
      token: "tok",
    });
    assert.equal(result.uploadStatus, "skipped");
    assert.equal(broker.calls.length, 0);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("uploadStopEvidence: returns failed when broker throws", async () => {
  const runDir = await makeRunDir();
  try {
    const line = JSON.stringify({ at: "2026-09-09T10:00:00.000Z", step: "signal_sent" });
    await writeFile(join(runDir, "stop.ndjson"), line, "utf8");

    const broker = new FakeBroker();
    broker.uploadStopEvidence = async () => {
      throw new Error("network error");
    };

    const result = await uploadStopEvidence({
      runDir,
      attemptId: "attempt-1",
      generation: 0,
      broker,
      token: "tok",
    });

    assert.equal(result.uploadStatus, "failed");
    assert.ok(result.failureReason?.includes("network error"));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
