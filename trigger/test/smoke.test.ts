import assert from "node:assert/strict";
import test from "node:test";

import { type RuntimeProbePayload, TASK_IDS } from "../src/types.ts";

test("runtime probe task id is exported", () => {
  assert.equal(TASK_IDS.runtimeProbe, "runtime.probe");
});

test("RuntimeProbePayload shape accepts an empty object", () => {
  const payload: RuntimeProbePayload = {};
  // Record<string, never> — no fields expected, just type-checks
  assert.deepEqual(payload, {});
});
