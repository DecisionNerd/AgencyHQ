import assert from "node:assert/strict";
import test from "node:test";

import { type SpikeEchoPayload, TASK_IDS } from "../src/types.ts";

test("spike echo task id is exported", () => {
  assert.equal(TASK_IDS.spikeEcho, "spike.echo");
});

test("SpikeEchoPayload shape accepts a message field", () => {
  const payload: SpikeEchoPayload = { message: "hello" };
  assert.equal(payload.message, "hello");
});
