/**
 * Integration tests for repos/commands.ts — claimCommand and completeCommand.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { claimCommand, completeCommand } from "../../src/repos/commands.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

test("claimCommand: first call returns claimed=true", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const commandId = `cmd-${randomUUID()}`;
    const result = await claimCommand(client, commandId, "stop");
    assert.deepEqual(result, { claimed: true });
  });
});

test("claimCommand: second call after complete returns stored result", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const commandId = `cmd-${randomUUID()}`;

    const first = await claimCommand(client, commandId, "stop");
    assert.ok(first.claimed, "First claim should succeed");

    await completeCommand(client, commandId, { ok: true, status: "stopped" });

    const second = await claimCommand(client, commandId, "stop");
    assert.ok(!second.claimed, "Second claim should fail");
    if (!second.claimed) {
      assert.ok(second.result !== null, "Result should be present");
      // Result is stored as JSONB — pg returns a parsed object
      const r = second.result as { ok: boolean; status: string };
      assert.equal(r.ok, true);
      assert.equal(r.status, "stopped");
    }
  });
});

test("claimCommand: second call before complete reports inFlight=true", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const commandId = `cmd-${randomUUID()}`;

    const first = await claimCommand(client, commandId, "stop");
    assert.ok(first.claimed, "First claim should succeed");

    // No completeCommand — still in flight
    const second = await claimCommand(client, commandId, "stop");
    assert.ok(!second.claimed, "Second claim should fail");
    if (!second.claimed) {
      assert.equal(second.result, null);
      assert.equal(second.inFlight, true);
    }
  });
});
