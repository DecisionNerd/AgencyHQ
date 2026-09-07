import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { descendants, killTree } from "../src/lib/procs.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("killTree leaves no survivors within 5s for a detached shell tree", async () => {
  const child = spawn("sh", ["-c", "sleep 60 & sleep 60; wait"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  assert.ok(pid, "expected the shell to have a pid");

  // Let the shell spawn its background `sleep 60` before we scan for descendants.
  await sleep(300);

  const before = await descendants(pid as number);
  assert.ok(before.length >= 2, `expected at least the shell and its child, got ${before.length}`);

  const result = await killTree({ rootPid: pid as number, pgid: pid as number, graceMs: 1000 });

  assert.deepEqual(result.survivors, []);
  for (const descendantPid of before) {
    assert.equal(isAlive(descendantPid), false, `pid ${descendantPid} should be gone`);
  }
});
