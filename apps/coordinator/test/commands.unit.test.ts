/**
 * Unit tests for command helpers that require no database or runtime.
 *
 * H-1: readStopEvidence — parses step/checkpointCommit (adapter format) and
 *      legacy event/commit keys.
 * H-5: stopAttempt cancel-error — command row completed with cancelSkipped when
 *      runtime.cancel throws.
 */

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readStopEvidence } from "../src/commands/confirm-stop.ts";
import type { CommandDeps } from "../src/commands/stop.ts";
import { stopAttempt } from "../src/commands/stop.ts";

// ---------------------------------------------------------------------------
// H-1: readStopEvidence
// ---------------------------------------------------------------------------

describe("readStopEvidence (H-1)", () => {
  const REAL_CONTENT = [
    '{"at":"2026-09-07T18:40:26.081Z","step":"abort_signal"}',
    '{"at":"2026-09-07T18:40:26.081Z","step":"stop_start","order":"kill-first","pid":34936,"pgid":34936}',
    '{"at":"2026-09-07T18:40:26.199Z","step":"killed","terminated":[34936],"killed":[],"survivors":[]}',
    '{"at":"2026-09-07T18:40:26.264Z","step":"checkpoint","checkpointCommit":"9324b35f5a5edc791bc8d3a5b4a2b172ce93ea92"}',
    '{"at":"2026-09-07T18:40:26.316Z","step":"stop_done","survivors":[]}',
  ].join("\n");

  it("parses real adapter format (step/checkpointCommit) → survivors:[] and checkpointCommit set", async () => {
    const dir = join(tmpdir(), `rw5a-h1-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "stop.ndjson"), REAL_CONTENT, "utf-8");
      const result = await readStopEvidence(dir);
      assert.ok(result !== null, "should return non-null");
      assert.deepEqual(result!.survivors, [], "survivors should be empty");
      assert.equal(
        result!.checkpointCommit,
        "9324b35f5a5edc791bc8d3a5b4a2b172ce93ea92",
        "checkpointCommit from step:checkpoint line",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses real adapter format with survivors:[123] → uncertain", async () => {
    const content = [
      '{"at":"2026-09-07T18:40:26.081Z","step":"abort_signal"}',
      '{"at":"2026-09-07T18:40:26.316Z","step":"stop_done","survivors":[123]}',
    ].join("\n");
    const dir = join(tmpdir(), `rw5a-h1-s123-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "stop.ndjson"), content, "utf-8");
      const result = await readStopEvidence(dir);
      assert.ok(result !== null, "should return non-null");
      assert.deepEqual(result!.survivors, [123], "survivors should be [123]");
      assert.equal(result!.checkpointCommit, undefined, "no checkpoint commit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still accepts legacy event/commit keys", async () => {
    const legacy = [
      '{"event":"checkpoint","commit":"legacycommitabc"}',
      '{"event":"stop_done","survivors":[]}',
    ].join("\n");
    const dir = join(tmpdir(), `rw5a-h1-legacy-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "stop.ndjson"), legacy, "utf-8");
      const result = await readStopEvidence(dir);
      assert.ok(result !== null, "should return non-null for legacy format");
      assert.deepEqual(result!.survivors, []);
      assert.equal(result!.checkpointCommit, "legacycommitabc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when file does not exist", async () => {
    const result = await readStopEvidence("/nonexistent/path/xyz");
    assert.equal(result, null);
  });

  it("returns null when stop_done line is absent", async () => {
    const content = '{"at":"2026-09-07T18:40:26.081Z","step":"abort_signal"}\n';
    const dir = join(tmpdir(), `rw5a-h1-no-done-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "stop.ndjson"), content, "utf-8");
      const result = await readStopEvidence(dir);
      assert.equal(result, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// H-5: stopAttempt cancel-error → command completed with cancelSkipped
// ---------------------------------------------------------------------------

describe("stopAttempt cancel-throws (H-5)", () => {
  /** Build a minimal fake pool that simulates a dispatched attempt and records commands. */
  function makeFakePoolForStop(attemptId: string, runId: string) {
    const commands = new Map<string, unknown | null>();

    const pool = {
      connect: async () => {
        const client = {
          query: async (sql: string, params?: unknown[]) => {
            const s = sql.trim();

            // claimCommand INSERT
            if (s.startsWith("INSERT INTO commands")) {
              const cmdId = String((params as unknown[])[0]);
              if (commands.has(cmdId)) return { rows: [] };
              commands.set(cmdId, null);
              return { rows: [{ command_id: cmdId }] };
            }
            // claimCommand SELECT
            if (s.startsWith("SELECT result FROM commands")) {
              const cmdId = String((params as unknown[])[0]);
              const v = commands.get(cmdId);
              return { rows: [{ result: v ?? null }] };
            }
            // completeCommand UPDATE
            if (s.startsWith("UPDATE commands")) {
              const cmdId = String((params as unknown[])[0]);
              commands.set(cmdId, (params as unknown[])[1]);
              return { rows: [] };
            }
            // getAttempt
            if (s.startsWith("SELECT") && s.includes("FROM attempts") && s.includes("WHERE id")) {
              const now = new Date();
              return {
                rows: [
                  {
                    id: attemptId,
                    contract_id: "sc_test",
                    contract_version: 1,
                    generation: 1,
                    status: "dispatched",
                    run_id: runId,
                    worktree_path: null,
                    session_id: null,
                    commit_sha: null,
                    diff_digest: null,
                    checkpoint_commit: null,
                    failure_id: null,
                    budget_remaining: 3,
                    created_at: now,
                    updated_at: now,
                  },
                ],
              };
            }
            // revokeGeneration CTE
            if (s.startsWith("WITH prev")) {
              return {
                rows: [{ old_status: "dispatched", prev_generation: 1, new_generation: 2 }],
              };
            }
            // transitions INSERT
            if (s.startsWith("INSERT INTO transitions")) return { rows: [] };
            // insertDecision INSERT (needs RETURNING *)
            if (s.startsWith("INSERT INTO decisions")) {
              const now = new Date();
              return {
                rows: [
                  {
                    id: String((params as unknown[])[0]),
                    kind: "stop",
                    actor: "coordinator",
                    proposal_digest: null,
                    authority_version: null,
                    work_item_id: null,
                    contract_id: null,
                    contract_version: null,
                    attempt_id: attemptId,
                    causation_id: "cmd",
                    command_id: "cmd",
                    outcome: null,
                    at: now,
                    created_at: now,
                    updated_at: now,
                  },
                ],
              };
            }
            // BEGIN/COMMIT/ROLLBACK
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(s)) return { rows: [] };
            return { rows: [] };
          },
          release: () => {},
        };
        return client;
      },
      end: async () => {},
    };

    return { pool, commands };
  }

  it("command row completed with cancelSkipped:true when runtime.cancel throws", async () => {
    const attemptId = "att_cancel_throws";
    const runId = "run_already_final";
    const { pool, commands } = makeFakePoolForStop(attemptId, runId);

    const cancelError = new Error("run already in terminal state");
    const runtime = {
      cancel: async (_runId: string) => {
        throw cancelError;
      },
    };

    const clock = { now: () => "2026-09-07T18:00:00.000Z" };
    const deps: CommandDeps = {
      pool: pool as unknown as CommandDeps["pool"],
      runtime: runtime as unknown as CommandDeps["runtime"],
      clock,
    };

    const result = await stopAttempt(deps, {
      commandId: "cmd_stop_cancel_throws",
      attemptId,
      actor: "coordinator",
      reason: "test",
    });

    // Should return ok:true (generation revoked, stop committed)
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.runId, runId);
    }

    // The command row should be completed with cancelSkipped:true
    const storedRaw = commands.get("cmd_stop_cancel_throws");
    assert.ok(storedRaw !== null && storedRaw !== undefined, "command result stored");
    const stored = JSON.parse(storedRaw as string) as Record<string, unknown>;
    assert.equal(stored.cancelSkipped, true, "cancelSkipped:true in command result");
    assert.ok(typeof stored.reason === "string", "reason string present");
  });
});
