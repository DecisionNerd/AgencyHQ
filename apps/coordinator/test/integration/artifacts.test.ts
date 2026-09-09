/**
 * Integration tests: P18.2 portable source and artifacts.
 *
 * All tests skip loudly when DATABASE_URL is not set.
 *
 * C1: cross-container reconstruction (commit → bundle → import → artifact row)
 * C2: tampered bundle → error code, no row
 * C3: stale generation → STALE_GENERATION, no row
 * C4: cross-project lease → ATTEMPT_MISMATCH
 * C5: path traversal in changedPaths → PATH_UNSAFE
 * C6: oversized upload → BUNDLE_TOO_LARGE
 * C7: replay idempotency → duplicate, one row
 * C8: stop evidence DB-first vs file fallback
 * C9: import/revert round trip
 * C10: v1/v2 payload selection by source_mode
 * C11: no host path in any v2 payload
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ArtifactUploadMeta } from "@agencyhq/contracts";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import type { TestDbContext } from "@agencyhq/db";
import {
  insertAttemptArtifact,
  issueLease,
  runMigrations,
  upsertAttemptStopEvidence,
  withTestSchema,
} from "@agencyhq/db";
import { newId, validateArtifactAdmission } from "@agencyhq/domain";
import pg from "pg";
import { readStopEvidenceDbFirst } from "../../src/commands/confirm-stop.ts";
import { importHostProject, revertImport } from "../../src/commands/import-host-project.ts";
import { leadPlanPayload } from "../../src/flow/payloads.ts";
import { importBundle } from "../../src/git/bundle.ts";
import { ensureMirror, mirrorPath } from "../../src/git/mirror.ts";

const execFileAsync = promisify(execFile);
const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function makeBaseRepo(): Promise<{ repoPath: string; baseRev: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "ahq-base-"));
  await git(["init", "--initial-branch=main"], repoPath);
  await git(["config", "user.email", "test@example.com"], repoPath);
  await git(["config", "user.name", "Test"], repoPath);
  await writeFile(join(repoPath, "README.md"), "hello\n");
  await git(["add", "-A"], repoPath);
  await git(["commit", "-m", "base"], repoPath);
  const baseRev = await git(["rev-parse", "HEAD"], repoPath);
  return { repoPath, baseRev };
}

async function makeWorkerCommit(
  clonePath: string,
  filename: string,
  baseRev: string,
): Promise<{ commitId: string; bundleBytes: Buffer; diffDigest: string; bundleSha256: string }> {
  await writeFile(join(clonePath, filename), `output: ${filename}\n`);
  await git(["add", "-A"], clonePath);
  await git(["commit", "-m", `worker: ${filename}`], clonePath);
  const commitId = await git(["rev-parse", "HEAD"], clonePath);

  const diffOut = await git(["diff", baseRev, commitId], clonePath);
  const diffDigest = `sha256:${createHash("sha256").update(diffOut).digest("hex")}`;

  // git bundle create refuses a bare SHA; create a named export ref first.
  const exportRef = `refs/agencyhq/export/${commitId}`;
  await git(["update-ref", exportRef, commitId], clonePath);
  const bundleTmp = join(tmpdir(), `test-bundle-${Date.now()}.bundle`);
  await git(["bundle", "create", bundleTmp, exportRef], clonePath);
  const bundleBytes = await readFile(bundleTmp);
  await rm(bundleTmp, { force: true });

  const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
  return { commitId, bundleBytes, diffDigest, bundleSha256 };
}

// ---------------------------------------------------------------------------
// DB seed helpers
// ---------------------------------------------------------------------------

type DbClient = pg.PoolClient;

async function seedProject(
  client: DbClient,
  opts: { remote?: string; sourceMode?: "host_clone" | "mirror" } = {},
): Promise<string> {
  const projectId = newId("prj");
  await client.query(
    `INSERT INTO projects
       (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
     VALUES ($1, $2, '/repo', '/wt', $3::jsonb, $4::jsonb, '1', '["default"]'::jsonb)`,
    [
      projectId,
      opts.remote ?? null,
      JSON.stringify({ main: "a".repeat(40) }),
      JSON.stringify(HOST_TRIAL_AUTHORITY),
    ],
  );
  if (opts.sourceMode && opts.sourceMode !== "host_clone") {
    await client.query("UPDATE projects SET source_mode = $1 WHERE id = $2", [
      opts.sourceMode,
      projectId,
    ]);
  }
  return projectId;
}

async function seedWorkItem(client: DbClient, projectId: string): Promise<string> {
  const wiId = newId("wi");
  await client.query(
    `INSERT INTO work_items
       (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
     VALUES ($1, $2, 1, 'fix it', 'artifact', 'admitted', 'healthy', true, 1)`,
    [wiId, projectId],
  );
  return wiId;
}

async function seedContract(
  client: DbClient,
  projectId: string,
  workItemId: string,
  baseRevision: string,
): Promise<string> {
  const contractId = newId("sc");
  const bounds = {
    paths: { allow: ["**"], deny: [] },
    capabilities: [],
    boundary: "artifact",
    budget: { tokens: 100000 },
    duration: { seconds: 3600 },
  };
  await client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status)
     VALUES ($1, $2, $3, 1, $4, '{}'::jsonb, '[]'::jsonb, 'sha256:abc',
             'default', 'sha256:abc', $5::jsonb, '[]'::jsonb, false, 'active')`,
    [contractId, workItemId, projectId, baseRevision, JSON.stringify(bounds)],
  );
  return contractId;
}

async function seedAttempt(client: DbClient, contractId: string, generation = 0): Promise<string> {
  const attemptId = newId("att");
  await client.query(
    `INSERT INTO attempts (id, contract_id, contract_version, generation, status, budget_remaining)
     VALUES ($1, $2, 1, $3, 'running', 100000)`,
    [attemptId, contractId, generation],
  );
  return attemptId;
}

async function _seedLease(
  client: DbClient,
  attemptId: string,
  generation: number,
): Promise<string> {
  const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
  const nonceHash = createHash("sha256").update(nonce, "utf-8").digest("hex");
  await issueLease(client, {
    id: newId("cmd"),
    attempt_id: attemptId,
    generation,
    run_id: "fake-run",
    purpose: "upload",
    nonce_hash: nonceHash,
    expires_at: new Date(Date.now() + 60000),
  });
  return nonce;
}

// Schema-aware pool wrapper (for commands that call pool.connect() internally)
function makeSchemaPool(url: string, schema: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url });
  const origConnect = pool.connect.bind(pool);
  // biome-ignore lint/suspicious/noExplicitAny: schema pool override for tests
  (pool as any).connect = async () => {
    const c = await origConnect();
    await c.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);
    return c;
  };
  return pool;
}

// ---------------------------------------------------------------------------
// C1: cross-container reconstruction
// ---------------------------------------------------------------------------

test("C1: cross-container reconstruction — commit → bundle → import → artifact row", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-git-root-"));
  const base = await makeBaseRepo();

  try {
    await withTestSchema(t, async ({ client }: TestDbContext) => {
      const projectId = await seedProject(client, {
        remote: `file://${base.repoPath}`,
        sourceMode: "mirror",
      });
      const wiId = await seedWorkItem(client, projectId);
      const contractId = await seedContract(client, projectId, wiId, base.baseRev);
      const attemptId = await seedAttempt(client, contractId);

      await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });
      const mp = mirrorPath(gitRoot, projectId);

      const workerClone = join(tmpdir(), `ahq-worker-c1-${Date.now()}`);
      await git(["clone", `file://${base.repoPath}`, workerClone], tmpdir());
      await git(["config", "user.email", "w@e.com"], workerClone);
      await git(["config", "user.name", "W"], workerClone);

      const { commitId, bundleBytes, diffDigest, bundleSha256 } = await makeWorkerCommit(
        workerClone,
        "out.txt",
        base.baseRev,
      );
      await rm(workerClone, { recursive: true, force: true });

      const imported = await importBundle(
        { mirrorPath: mp, remote: `file://${base.repoPath}` },
        bundleBytes,
        { attemptId, generation: 0, expectedHead: commitId, maxBundleBytes: 200 * 1024 * 1024 },
      );
      assert.equal(imported.headSha, commitId);

      const result = await insertAttemptArtifact(client, {
        id: newId("att"),
        attempt_id: attemptId,
        generation: 0,
        kind: "attempt",
        commit_id: commitId,
        diff_digest: diffDigest,
        changed_paths: ["out.txt"],
        bundle_sha256: bundleSha256,
        bundle_bytes: bundleBytes.length,
      });
      assert.equal(result.outcome, "inserted");

      const { rows } = await client.query(
        "SELECT id FROM attempt_artifacts WHERE attempt_id = $1",
        [attemptId],
      );
      assert.equal(rows.length, 1);
    });
  } finally {
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C2: tampered bundle → error code, no row
// ---------------------------------------------------------------------------

test("C2: tampered bundle — byte flipped → import throws, no artifact row", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-git-root-"));
  const base = await makeBaseRepo();

  try {
    await withTestSchema(t, async ({ client }: TestDbContext) => {
      const projectId = await seedProject(client, {
        remote: `file://${base.repoPath}`,
        sourceMode: "mirror",
      });
      const wiId = await seedWorkItem(client, projectId);
      const contractId = await seedContract(client, projectId, wiId, base.baseRev);
      const attemptId = await seedAttempt(client, contractId);

      await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });
      const mp = mirrorPath(gitRoot, projectId);

      const workerClone = join(tmpdir(), `ahq-worker-c2-${Date.now()}`);
      await git(["clone", `file://${base.repoPath}`, workerClone], tmpdir());
      await git(["config", "user.email", "w@e.com"], workerClone);
      await git(["config", "user.name", "W"], workerClone);
      const { commitId, bundleBytes } = await makeWorkerCommit(workerClone, "f.txt", base.baseRev);
      await rm(workerClone, { recursive: true, force: true });

      const tampered = Buffer.from(bundleBytes);
      tampered[100] = (tampered[100] ?? 0) ^ 0xff;

      let threw = false;
      try {
        await importBundle({ mirrorPath: mp, remote: `file://${base.repoPath}` }, tampered, {
          attemptId,
          generation: 0,
          expectedHead: commitId,
          maxBundleBytes: 200 * 1024 * 1024,
        });
      } catch (e) {
        threw = true;
        const code = (e as { code?: string }).code;
        assert.ok(
          code === "BUNDLE_PREREQ_MISSING" ||
            code === "BUNDLE_FETCH_FAILED" ||
            code === "BUNDLE_SHA_MISMATCH",
          `unexpected error code: ${code}`,
        );
      }
      assert.ok(threw, "tampered bundle must throw");

      const { rows } = await client.query(
        "SELECT id FROM attempt_artifacts WHERE attempt_id = $1",
        [attemptId],
      );
      assert.equal(rows.length, 0);
    });
  } finally {
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C3: stale generation → STALE_GENERATION (pure validator)
// ---------------------------------------------------------------------------

test("C3: stale generation → STALE_GENERATION", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const claimed: ArtifactUploadMeta = {
    attemptId: "att-c3",
    generation: 0, // stale (current = 1)
    kind: "attempt",
    commitId: "a".repeat(40),
    diffDigest: `sha256:${"b".repeat(64)}`,
    changedPaths: ["foo.ts"],
    bundleSha256: "c".repeat(64),
    bundleBytes: 1024,
  };

  const result = validateArtifactAdmission({
    claimed,
    lease: {
      purpose: "upload",
      attemptId: "att-c3",
      generation: 0,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      revokedAt: null,
    },
    attempt: { id: "att-c3", projectId: "prj-c3", currentGeneration: 1, status: "running" },
    now: new Date().toISOString(),
    mirror: { hasCommit: () => false, recomputedDiffDigest: null },
    limits: { maxBundleBytes: 200 * 1024 * 1024 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "STALE_GENERATION");
});

// ---------------------------------------------------------------------------
// C4: cross-project lease → ATTEMPT_MISMATCH (pure)
// ---------------------------------------------------------------------------

test("C4: cross-project lease → ATTEMPT_MISMATCH", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const claimed: ArtifactUploadMeta = {
    attemptId: "att-c4b",
    generation: 0,
    kind: "attempt",
    commitId: "a".repeat(40),
    diffDigest: `sha256:${"b".repeat(64)}`,
    changedPaths: ["foo.ts"],
    bundleSha256: "c".repeat(64),
    bundleBytes: 1024,
  };

  const result = validateArtifactAdmission({
    claimed,
    lease: {
      purpose: "upload",
      attemptId: "att-c4a", // different attempt
      generation: 0,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      revokedAt: null,
    },
    attempt: { id: "att-c4b", projectId: "prj-c4b", currentGeneration: 0, status: "running" },
    now: new Date().toISOString(),
    mirror: { hasCommit: () => false, recomputedDiffDigest: null },
    limits: { maxBundleBytes: 200 * 1024 * 1024 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "ATTEMPT_MISMATCH");
});

// ---------------------------------------------------------------------------
// C5: path traversal → PATH_UNSAFE (pure)
// ---------------------------------------------------------------------------

test("C5: path traversal in changedPaths → PATH_UNSAFE", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const claimed: ArtifactUploadMeta = {
    attemptId: "att-c5",
    generation: 0,
    kind: "attempt",
    commitId: "a".repeat(40),
    diffDigest: `sha256:${"b".repeat(64)}`,
    changedPaths: ["../etc/passwd"], // traversal
    bundleSha256: "c".repeat(64),
    bundleBytes: 1024,
  };

  const result = validateArtifactAdmission({
    claimed,
    lease: {
      purpose: "upload",
      attemptId: "att-c5",
      generation: 0,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      revokedAt: null,
    },
    attempt: { id: "att-c5", projectId: "prj-c5", currentGeneration: 0, status: "running" },
    now: new Date().toISOString(),
    mirror: { hasCommit: () => true, recomputedDiffDigest: `sha256:${"b".repeat(64)}` },
    limits: { maxBundleBytes: 200 * 1024 * 1024 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "PATH_UNSAFE");
});

// ---------------------------------------------------------------------------
// C6: oversized upload → BUNDLE_TOO_LARGE (pure)
// ---------------------------------------------------------------------------

test("C6: oversized upload → BUNDLE_TOO_LARGE", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const claimed: ArtifactUploadMeta = {
    attemptId: "att-c6",
    generation: 0,
    kind: "attempt",
    commitId: "a".repeat(40),
    diffDigest: `sha256:${"b".repeat(64)}`,
    changedPaths: ["foo.ts"],
    bundleSha256: "c".repeat(64),
    bundleBytes: 300 * 1024 * 1024, // 300 MiB > 200 MiB limit
  };

  const result = validateArtifactAdmission({
    claimed,
    lease: {
      purpose: "upload",
      attemptId: "att-c6",
      generation: 0,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      revokedAt: null,
    },
    attempt: { id: "att-c6", projectId: "prj-c6", currentGeneration: 0, status: "running" },
    now: new Date().toISOString(),
    mirror: { hasCommit: () => false, recomputedDiffDigest: null },
    limits: { maxBundleBytes: 200 * 1024 * 1024 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "BUNDLE_TOO_LARGE");
});

// ---------------------------------------------------------------------------
// C7: replay idempotency → duplicate, one row
// ---------------------------------------------------------------------------

test("C7: replay idempotency — duplicate upload → one row", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  await withTestSchema(t, async ({ client }: TestDbContext) => {
    const projectId = await seedProject(client);
    const wiId = await seedWorkItem(client, projectId);
    const contractId = await seedContract(client, projectId, wiId, "a".repeat(40));
    const attemptId = await seedAttempt(client, contractId);

    const row = {
      id: newId("att"),
      attempt_id: attemptId,
      generation: 0,
      kind: "attempt" as const,
      commit_id: "a".repeat(40),
      diff_digest: `sha256:${"b".repeat(64)}`,
      changed_paths: ["foo.ts"],
      bundle_sha256: "c".repeat(64),
      bundle_bytes: 100,
    };

    const r1 = await insertAttemptArtifact(client, row);
    assert.equal(r1.outcome, "inserted");

    const r2 = await insertAttemptArtifact(client, { ...row, id: newId("att") });
    assert.equal(r2.outcome, "duplicate");

    const { rows } = await client.query("SELECT id FROM attempt_artifacts WHERE attempt_id = $1", [
      attemptId,
    ]);
    assert.equal(rows.length, 1);
  });
});

// ---------------------------------------------------------------------------
// C8: stop evidence DB-first vs file fallback
// ---------------------------------------------------------------------------

test("C8: stop evidence — DB row wins; host_clone falls back to file (null when absent)", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  await withTestSchema(t, async ({ client }: TestDbContext) => {
    const projectId = await seedProject(client, { sourceMode: "mirror" });
    const wiId = await seedWorkItem(client, projectId);
    const contractId = await seedContract(client, projectId, wiId, "a".repeat(40));
    const attemptId = await seedAttempt(client, contractId);

    await upsertAttemptStopEvidence(client, {
      id: newId("att"),
      attempt_id: attemptId,
      generation: 0,
      steps: [
        { at: new Date().toISOString(), step: "signal_sent" },
        { at: new Date().toISOString(), step: "process_exited" },
        { at: new Date().toISOString(), step: "upload_done" },
      ],
    });

    // mirror: DB row found
    const mirrorEvidence = await readStopEvidenceDbFirst(client, attemptId, 0, "mirror", undefined);
    assert.ok(mirrorEvidence !== null, "mirror mode returns DB row");

    // host_clone: no file → null
    const hostEvidence = await readStopEvidenceDbFirst(
      client,
      attemptId,
      0,
      "host_clone",
      "/nonexistent/run/dir",
    );
    assert.equal(hostEvidence, null, "host_clone without file → null");
  });
});

// ---------------------------------------------------------------------------
// C9: import/revert round trip
// ---------------------------------------------------------------------------

test("C9: import/revert — source_mode toggles; work items unchanged", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-git-root-"));
  const base = await makeBaseRepo();

  // Manage schema manually so we can pass a schema-aware pool to importHostProject
  const schema = `ahq_t_c9_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedProject(directClient, {
      remote: `file://${base.repoPath}`,
      sourceMode: "host_clone",
    });
    await seedWorkItem(directClient, projectId);

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const clock = { now: () => new Date().toISOString() };

    const importResult = await importHostProject(
      { pool: schemaPool, runtime: undefined as never, clock, gitRoot },
      { commandId: newId("cmd"), projectId },
    );

    assert.ok(importResult.ok, `import failed: ${JSON.stringify(importResult)}`);
    if (importResult.ok) assert.equal(importResult.sourceMode, "mirror");

    const { rows: afterImport } = await directClient.query(
      "SELECT source_mode FROM projects WHERE id = $1",
      [projectId],
    );
    assert.equal((afterImport[0] as { source_mode: string }).source_mode, "mirror");

    const revertResult = await revertImport(
      { pool: schemaPool, runtime: undefined as never, clock },
      { commandId: newId("cmd"), projectId },
    );

    assert.ok(revertResult.ok, `revert failed: ${JSON.stringify(revertResult)}`);
    if (revertResult.ok) assert.equal(revertResult.sourceMode, "host_clone");

    const { rows: afterRevert } = await directClient.query(
      "SELECT source_mode FROM projects WHERE id = $1",
      [projectId],
    );
    assert.equal((afterRevert[0] as { source_mode: string }).source_mode, "host_clone");

    // Work item lifecycle unchanged
    const { rows: wiRows } = await directClient.query(
      "SELECT lifecycle FROM work_items WHERE project_id = $1",
      [projectId],
    );
    assert.equal(wiRows.length, 1);
    assert.equal((wiRows[0] as { lifecycle: string }).lifecycle, "admitted");

    await schemaPool.end();
  } finally {
    await directClient
      .query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`)
      .catch(() => undefined);
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C10: v1/v2 payload selection by source_mode
// ---------------------------------------------------------------------------

test("C10: payload selection — mirror → v2 (source), host_clone → v1 (repoPath)", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const baseRevision = "a".repeat(40);

  const mirrorProject = {
    id: "prj-c10-mirror",
    clone_path: "/secret/clone",
    worktree_base: "/secret/wt",
    authority: HOST_TRIAL_AUTHORITY,
    authority_version: "1",
    source_mode: "mirror" as const,
    remote: "https://github.com/example/repo",
  };

  const hostProject = {
    id: "prj-c10-host",
    clone_path: "/secret/clone",
    worktree_base: "/secret/wt",
    authority: HOST_TRIAL_AUTHORITY,
    authority_version: "1",
    source_mode: "host_clone" as const,
  };

  const workItem = {
    id: "wi-c10",
    project_id: mirrorProject.id,
    intent: "fix it",
    boundary: "artifact" as const,
  };

  const mirrorPayload = leadPlanPayload(mirrorProject, workItem, {
    baseRevision,
    worktreeBase: "/secret/wt",
    model: "gpt-5",
  });

  const mp = mirrorPayload as Record<string, unknown>;
  assert.equal(mp.payloadVersion, 2, "mirror → v2");
  assert.ok("source" in mirrorPayload, "v2 has source");
  assert.ok(!("repoPath" in mirrorPayload), "v2 has no repoPath");
  assert.ok(!("worktreeBase" in mirrorPayload), "v2 has no worktreeBase");

  const hostPayload = leadPlanPayload(hostProject, workItem, {
    baseRevision,
    worktreeBase: "/secret/wt",
    model: "gpt-5",
  });

  const hp = hostPayload as Record<string, unknown>;
  assert.ok(hp.payloadVersion !== 2, "host_clone → v1");
  assert.ok("repoPath" in hostPayload, "v1 has repoPath");
  assert.ok(!("source" in hostPayload), "v1 has no source");
});

// ---------------------------------------------------------------------------
// C11: no host path in any v2 payload
// ---------------------------------------------------------------------------

test("C11: v2 payloads contain no host filesystem paths", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const mirrorProject = {
    id: "prj-c11",
    clone_path: "/secret/host/clone",
    worktree_base: "/secret/host/wt",
    authority: HOST_TRIAL_AUTHORITY,
    authority_version: "1",
    source_mode: "mirror" as const,
    remote: "https://github.com/example/repo",
  };

  const workItem = {
    id: "wi-c11",
    project_id: mirrorProject.id,
    intent: "fix it",
    boundary: "artifact" as const,
  };

  const payload = leadPlanPayload(mirrorProject, workItem, {
    baseRevision: "a".repeat(40),
    worktreeBase: "/secret/host/wt",
    model: "gpt-5",
  });

  const json = JSON.stringify(payload);

  for (const forbidden of [
    "/secret/host/clone",
    "/secret/host/wt",
    "repoPath",
    "worktreeBase",
    "patchPath",
    "manifestRepoPaths",
  ]) {
    assert.ok(!json.includes(forbidden), `v2 payload must not contain '${forbidden}'`);
  }
});
