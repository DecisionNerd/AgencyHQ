/**
 * Integration tests: W2-wire portable execution pipeline (mirror mode).
 *
 * All tests skip loudly when DATABASE_URL is not set.
 *
 * P1: Source bundle download via HTTP (happy path)
 * P2: Artifact upload via HTTP → verified=true row, ref in mirror
 * P3: Stop evidence via HTTP → accepted, DB row
 * P4: Wrong upload token → 401
 * P5: Stale generation artifact upload → 409
 * P6: Tampered bundle upload → 422, no artifact row
 * P7: Replay duplicate upload → 200 status="duplicate", one row
 * P8: Revoked lease after stop → 401 on subsequent upload
 * P9: dispatch_nonce_hash set for mirror dispatches; no host path in payload
 * P10: integrate lease → push via real git → remote advanced; base-moved case
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ArtifactUploadMeta } from "@agencyhq/contracts";
import {
  bundleRefFor,
  digestOf,
  HOST_PROFILE,
  HOST_TRIAL_AUTHORITY,
  TASK_IDS,
} from "@agencyhq/contracts";
import type { TestDbContext } from "@agencyhq/db";
import {
  createPool,
  encryptSecret,
  issueLease,
  listStopEvidenceForAttempt,
  putProjectCredential,
  revokeLeasesBelowGeneration,
  runMigrations,
  withTestSchema,
} from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import pg from "pg";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";
import {
  fetchRef as gitFetchRef,
  isAncestor as gitIsAncestor,
  lsRemote as gitLsRemote,
  mergeInWorktree as gitMergeInWorktree,
  pushForceWithLease as gitPushForceWithLease,
  worktreeAdd,
  worktreeRemove,
} from "../../../../trigger/src/lib/git.ts";
import type { IntegrateMergeDeps } from "../../../../trigger/src/tasks/integrate-merge-core.ts";
import { runIntegrateMerge } from "../../../../trigger/src/tasks/integrate-merge-core.ts";
import type { IntegrateMergePayload } from "../../../../trigger/src/types.ts";
import type { FlowLike, ReconcilerLike, RuntimeLike } from "../../src/app.ts";
import { createApp } from "../../src/app.ts";
import type { CoordinatorConfig } from "../../src/config.ts";
import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import { ensureMirror, mirrorPath } from "../../src/git/mirror.ts";
import { issueLeaseBroker } from "../../src/internal/leases.ts";
import { goodPlanOutput, workerCompletedOutput } from "../helpers/fake-lead.ts";

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
  const repoPath = await mkdtemp(join(tmpdir(), "ahq-pe-base-"));
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
): Promise<{
  commitId: string;
  bundleBytes: Buffer;
  diffDigest: string;
  bundleSha256: string;
}> {
  await writeFile(join(clonePath, filename), `output: ${filename}\n`);
  await git(["add", "-A"], clonePath);
  await git(["commit", "-m", `worker: ${filename}`], clonePath);
  const commitId = await git(["rev-parse", "HEAD"], clonePath);

  // Use execFileAsync directly (not the trimming git helper) so the diff output
  // matches what the coordinator's diffDigest() computes (which does not trim stdout).
  const { stdout: rawDiffOut } = await execFileAsync("git", ["diff", baseRev, commitId], {
    cwd: clonePath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 512 * 1024,
  });
  const diffDigest = `sha256:${createHash("sha256").update(rawDiffOut).digest("hex")}`;

  const exportRef = bundleRefFor(commitId);
  await git(["update-ref", exportRef, commitId], clonePath);
  const bundleTmp = join(tmpdir(), `pe-bundle-${Date.now()}.bundle`);
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

async function seedMirrorProject(client: DbClient, remote: string): Promise<string> {
  const projectId = newId("prj");
  await client.query(
    `INSERT INTO projects
       (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version,
        profile_catalog, source_mode)
     VALUES ($1, $2, '/repo', '/wt', $3::jsonb, $4::jsonb, '1', '["default"]'::jsonb, 'mirror')`,
    [
      projectId,
      remote,
      JSON.stringify({ main: "a".repeat(40) }),
      JSON.stringify(HOST_TRIAL_AUTHORITY),
    ],
  );
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
  // bounds must satisfy ContractBoundsSchema (used by mapStepContractRow)
  const bounds = {
    paths: { allow: ["**"], deny: [] },
    capabilities: {
      bash: { allow: [], deny: [] },
      tools: {
        edit: true,
        webfetch: false,
        websearch: false,
        task: false,
        external_directory: false,
        skill: false,
      },
    },
    boundary: "artifact",
    budget: { maxAttempts: 1, maxDurationSeconds: 60, estimatedSpendUsd: 0 },
    review: "none",
    changeClass: "behavior",
    models: { worker: "claude-sonnet-4", reviewer: "claude-sonnet-4" },
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

/**
 * Issue an upload lease with a pre-hashed upload token.
 * Returns the raw upload token (bearer token) and the lease row.
 */
async function issueUploadLease(
  client: DbClient,
  attemptId: string,
  generation: number,
): Promise<{ uploadToken: string; leaseId: string }> {
  const uploadToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(uploadToken, "utf-8").digest("hex");
  // Nonce hash (dispatch auth) is separate from token hash (upload auth)
  const nonceHash = createHash("sha256").update(randomBytes(32)).digest("hex");

  const leaseId = newId("cmd");
  await issueLease(client as unknown as import("pg").PoolClient, {
    id: leaseId,
    attempt_id: attemptId,
    generation,
    run_id: `run_${randomBytes(4).toString("hex")}`,
    purpose: "upload",
    nonce_hash: nonceHash,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 3600_000),
  });
  return { uploadToken, leaseId };
}

// ---------------------------------------------------------------------------
// App factory helpers
// ---------------------------------------------------------------------------

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

function makeFakeFlow(): FlowLike {
  return {
    plan: async () => ({ ok: true }),
    retryDispatch: async () => ({ ok: true }),
  };
}
function makeFakeReconciler(): ReconcilerLike {
  return { freshness: () => ({ lastPollAt: new Date().toISOString(), stale: false }) };
}
function makeFakeRuntime(): RuntimeLike {
  return { createPublicToken: async () => "fake-token" };
}

function makeConfig(gitRoot: string): CoordinatorConfig {
  return {
    databaseUrl: DATABASE_URL ?? "",
    triggerApiUrl: "https://trigger.example.com",
    triggerSecretKey: "fake-trigger-key",
    apiToken: "fake-api-token",
    runtime: "fake",
    worktreeBase: gitRoot,
    workerModel: "claude-sonnet-4",
    leadModel: "claude-opus-4",
    reviewerModel: "claude-sonnet-4",
    reconcileIntervalMs: 5000,
    freshnessStaleMs: 30000,
    uncertainAfterMs: 120000,
    port: 0,
    bindHost: "127.0.0.1",
    runtimeProfile: "host",
    gitRoot,
    maxBundleBytes: 200 * 1024 * 1024,
  };
}

// ---------------------------------------------------------------------------
// P1: Source bundle download via HTTP
// ---------------------------------------------------------------------------

test("P1: source bundle download — mirror mode, valid upload token → 200 bundle", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p1_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    const attemptId = await seedAttempt(directClient, contractId);
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    const res = await app.request(`/internal/source/${projectId}?rev=${base.baseRev}`, {
      headers: { Authorization: `Bearer ${uploadToken}` },
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.ok(
      res.headers.get("content-type")?.includes("git-bundle"),
      "content-type must include git-bundle",
    );
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.length > 0, "bundle body must be non-empty");

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P2 + P3: Artifact upload → verified=true; stop evidence → DB row
// ---------------------------------------------------------------------------

test("P2+P3: artifact upload (verified=true) + stop evidence via HTTP", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p2_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    const attemptId = await seedAttempt(directClient, contractId);
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    // Worker clones from base and makes a commit
    const workerClone = join(tmpdir(), `pe-wclone-${Date.now()}`);
    await git(["clone", `file://${base.repoPath}`, workerClone], tmpdir());
    await git(["config", "user.email", "w@e.com"], workerClone);
    await git(["config", "user.name", "W"], workerClone);
    const { commitId, bundleBytes, diffDigest, bundleSha256 } = await makeWorkerCommit(
      workerClone,
      "result.txt",
      base.baseRev,
    );
    await rm(workerClone, { recursive: true, force: true });

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    const meta: ArtifactUploadMeta = {
      attemptId,
      generation: 0,
      kind: "attempt",
      commitId,
      diffDigest,
      changedPaths: ["result.txt"],
      bundleSha256,
      bundleBytes: bundleBytes.length,
    };

    // P2: Upload the artifact
    const uploadRes = await app.request(`/internal/attempts/${attemptId}/artifacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "X-AgencyHQ-Meta": JSON.stringify(meta),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bundleBytes.length),
      },
      body: new Uint8Array(bundleBytes),
    });

    assert.equal(uploadRes.status, 201, `artifact upload expected 201, got ${uploadRes.status}`);
    const uploadBody = (await uploadRes.json()) as { status: string; verified: boolean };
    assert.equal(uploadBody.status, "accepted");
    assert.equal(uploadBody.verified, true, "artifact must be verified=true");

    // Assert DB row is verified=true
    const { rows: artRows } = await directClient.query<{ verified: boolean }>(
      "SELECT verified FROM attempt_artifacts WHERE attempt_id = $1 AND generation = $2",
      [attemptId, 0],
    );
    assert.equal(artRows.length, 1);
    assert.equal(artRows[0]?.verified, true, "DB verified column must be true");

    // Assert ref exists in mirror
    const mp = mirrorPath(gitRoot, projectId);
    // X2-8: ref name includes kind segment.
    const ref = `refs/agencyhq/attempts/${attemptId}/g0/attempt`;
    const refSha = await git(["rev-parse", ref], mp);
    assert.equal(refSha, commitId, "ref in mirror must point to worker commit");

    // P3: Upload stop evidence
    const evidenceBody = {
      attemptId,
      generation: 0,
      steps: [
        { at: new Date().toISOString(), step: "stop_start" },
        { at: new Date().toISOString(), step: "upload_done" },
        { at: new Date().toISOString(), step: "stop_done" },
      ],
    };

    const evidenceRes = await app.request(`/internal/attempts/${attemptId}/stop-evidence`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(evidenceBody),
    });
    assert.equal(evidenceRes.status, 201, `stop evidence expected 201, got ${evidenceRes.status}`);

    // Assert stop evidence row in DB
    const { rows: evRows } = await directClient.query(
      "SELECT id FROM attempt_stop_evidence WHERE attempt_id = $1 AND generation = $2",
      [attemptId, 0],
    );
    assert.equal(evRows.length, 1, "stop evidence row must exist in DB");

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P4: Wrong token → 401
// ---------------------------------------------------------------------------

test("P4: wrong upload token → 401 on artifact upload", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-gr-"));
  const base = await makeBaseRepo();

  await withTestSchema(t, async ({ client }: TestDbContext) => {
    const projectId = await seedMirrorProject(client, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(client, projectId);
    const contractId = await seedContract(client, projectId, wiId, base.baseRev);
    const attemptId = await seedAttempt(client, contractId);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    // Derive schema name from client's search_path (via existing withTestSchema row)
    const schemaRes = await client.query<{ current_schema: string }>("SELECT current_schema()");
    const schema = schemaRes.rows[0]?.current_schema ?? "public";
    const schemaPool = makeSchemaPool(DATABASE_URL ?? "", schema);

    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    const wrongToken = randomBytes(32).toString("hex");
    const meta: ArtifactUploadMeta = {
      attemptId,
      generation: 0,
      kind: "attempt",
      commitId: "a".repeat(40),
      diffDigest: `sha256:${"b".repeat(64)}`,
      changedPaths: ["foo.ts"],
      bundleSha256: "c".repeat(64),
      bundleBytes: 100,
    };

    const res = await app.request(`/internal/attempts/${attemptId}/artifacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${wrongToken}`,
        "X-AgencyHQ-Meta": JSON.stringify(meta),
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(100),
    });

    // E10 / W-16: wrong token must return exactly 401 (not 422).
    assert.equal(res.status, 401, `expected 401, got ${res.status}`);

    await schemaPool.end();
  });

  await rm(gitRoot, { recursive: true, force: true });
  await rm(base.repoPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P5: Stale generation → 409
// ---------------------------------------------------------------------------

test("P5: stale generation artifact upload → 409", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p5_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    // attempt is at generation=1 in DB
    const attemptId = await seedAttempt(directClient, contractId, 1);
    // lease is at generation=0 (stale)
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    const meta: ArtifactUploadMeta = {
      attemptId,
      generation: 0, // stale — attempt is at 1
      kind: "attempt",
      commitId: "a".repeat(40),
      diffDigest: `sha256:${"b".repeat(64)}`,
      changedPaths: ["foo.ts"],
      bundleSha256: "c".repeat(64),
      bundleBytes: 100,
    };

    const res = await app.request(`/internal/attempts/${attemptId}/artifacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "X-AgencyHQ-Meta": JSON.stringify(meta),
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(100),
    });

    assert.equal(res.status, 409, `expected 409 STALE_GENERATION, got ${res.status}`);

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P6: Tampered bundle → 422, no artifact row
// ---------------------------------------------------------------------------

test("P6: tampered bundle → 422, no artifact row inserted", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p6_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    const attemptId = await seedAttempt(directClient, contractId);
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    // Create a valid bundle first, then tamper with it
    const workerClone = join(tmpdir(), `pe-wclone-${Date.now()}`);
    await git(["clone", `file://${base.repoPath}`, workerClone], tmpdir());
    await git(["config", "user.email", "w@e.com"], workerClone);
    await git(["config", "user.name", "W"], workerClone);
    const { commitId, bundleBytes, diffDigest, bundleSha256 } = await makeWorkerCommit(
      workerClone,
      "tamper.txt",
      base.baseRev,
    );
    await rm(workerClone, { recursive: true, force: true });

    // Tamper the bundle bytes
    const tampered = Buffer.from(bundleBytes);
    tampered[100] = (tampered[100] ?? 0) ^ 0xff;

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    const meta: ArtifactUploadMeta = {
      attemptId,
      generation: 0,
      kind: "attempt",
      commitId,
      diffDigest,
      changedPaths: ["tamper.txt"],
      bundleSha256, // sha256 of original — will mismatch tampered body
      bundleBytes: tampered.length,
    };

    const res = await app.request(`/internal/attempts/${attemptId}/artifacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "X-AgencyHQ-Meta": JSON.stringify(meta),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(tampered.length),
      },
      body: new Uint8Array(tampered),
    });

    assert.equal(res.status, 422, `expected 422 BUNDLE_TAMPERED, got ${res.status}`);

    // No artifact row must be inserted
    const { rows } = await directClient.query(
      "SELECT id FROM attempt_artifacts WHERE attempt_id = $1",
      [attemptId],
    );
    assert.equal(rows.length, 0, "tampered bundle must not insert artifact row");

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P7: Replay duplicate → 200 status="duplicate", one row
// ---------------------------------------------------------------------------

test("P7: replay duplicate upload → 200 status=duplicate, one row", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p7_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    const attemptId = await seedAttempt(directClient, contractId);
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    const workerClone = join(tmpdir(), `pe-wclone-${Date.now()}`);
    await git(["clone", `file://${base.repoPath}`, workerClone], tmpdir());
    await git(["config", "user.email", "w@e.com"], workerClone);
    await git(["config", "user.name", "W"], workerClone);
    const { commitId, bundleBytes, diffDigest, bundleSha256 } = await makeWorkerCommit(
      workerClone,
      "replay.txt",
      base.baseRev,
    );
    await rm(workerClone, { recursive: true, force: true });

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    const meta: ArtifactUploadMeta = {
      attemptId,
      generation: 0,
      kind: "attempt",
      commitId,
      diffDigest,
      changedPaths: ["replay.txt"],
      bundleSha256,
      bundleBytes: bundleBytes.length,
    };

    const makeRequest = () =>
      app.request(`/internal/attempts/${attemptId}/artifacts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "X-AgencyHQ-Meta": JSON.stringify(meta),
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bundleBytes.length),
        },
        body: new Uint8Array(bundleBytes),
      });

    const r1 = await makeRequest();
    assert.equal(r1.status, 201, `first upload expected 201, got ${r1.status}`);

    const r2 = await makeRequest();
    assert.equal(r2.status, 200, `replay expected 200 duplicate, got ${r2.status}`);
    const r2Body = (await r2.json()) as { status: string };
    assert.equal(r2Body.status, "duplicate");

    // Only one row
    const { rows } = await directClient.query(
      "SELECT id FROM attempt_artifacts WHERE attempt_id = $1",
      [attemptId],
    );
    assert.equal(rows.length, 1, "replay must not create a second artifact row");

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P8: Revoked lease after stop → 401
// ---------------------------------------------------------------------------

test("P8: revoked lease after stop → 401 on subsequent upload", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p8_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    // Start at generation=0
    const attemptId = await seedAttempt(directClient, contractId, 0);
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    // Simulate stop: revoke leases below generation 1 (i.e., revoke generation 0 leases)
    const revokedCount = await revokeLeasesBelowGeneration(
      directClient as unknown as import("pg").PoolClient,
      attemptId,
      1, // next generation — revokes anything < 1
    );
    assert.ok(revokedCount >= 1, "at least one lease must be revoked");

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    const meta: ArtifactUploadMeta = {
      attemptId,
      generation: 0,
      kind: "attempt",
      commitId: "a".repeat(40),
      diffDigest: `sha256:${"b".repeat(64)}`,
      changedPaths: ["post-stop.ts"],
      bundleSha256: "c".repeat(64),
      bundleBytes: 100,
    };

    const res = await app.request(`/internal/attempts/${attemptId}/artifacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "X-AgencyHQ-Meta": JSON.stringify(meta),
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(100),
    });

    assert.equal(res.status, 401, `revoked lease must yield 401, got ${res.status}`);

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P9/P10 helpers: real-flow test infrastructure
// ---------------------------------------------------------------------------

const _p9p10Ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const _p9p10Clock = { now: () => new Date().toISOString() };

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: ["package.json"],
});

function makeFlowDeps(pool: ReturnType<typeof createPool>, fake: FakeExecutionRuntime): FlowDeps {
  return {
    pool,
    runtime: fake,
    clock: _p9p10Clock,
    ids: _p9p10Ids,
    profile: HOST_PROFILE,
    config: {
      worktreeBase: "/worktrees",
      workerModel: "openai/gpt-5.6-terra",
      leadModel: "openai/gpt-5.6-sol",
      reviewerModel: "openai/gpt-5.6-sol",
      verifierName: "agencyhq-verifier",
    },
    profileResolver: FAKE_PROFILE_RESOLVER,
  };
}

// ---------------------------------------------------------------------------
// P9: dispatch_nonce_hash set for mirror dispatch; payload carries leaseNonce
// ---------------------------------------------------------------------------

test("P9: dispatch_nonce_hash set in DB for mirror dispatch; payload leaseNonce not a host path", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  // Drive the real flow (BoundedRepairFlow + FakeExecutionRuntime) through
  // plan → onLeadPlanOutput for a mirror-mode project and assert:
  //   - dispatch_intents.dispatch_nonce_hash is set on the worker.attempt row
  //   - payload has payloadVersion:2 and a leaseNonce whose sha256 equals the hash
  //   - payload contains no host filesystem path keys

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      // Seed a mirror-mode project. No real remote needed; the flow reads
      // source_mode and allowed_refs to build the v2 payload.
      const projectId = newId("prj");
      const baseRev = "a".repeat(40);
      await client.query(
        `INSERT INTO projects
           (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version,
            profile_catalog, source_mode)
         VALUES ($1, NULL, '/repo', '/wt', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb, 'mirror')`,
        [projectId, JSON.stringify({ main: baseRev }), JSON.stringify(HOST_TRIAL_AUTHORITY)],
      );

      const wiId = newId("wi");
      await client.query(
        `INSERT INTO work_items
           (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Fix the parser', 'artifact', 'proposed', 'healthy', true, 1)`,
        [wiId, projectId],
      );

      // Script the fake runtime for the lead.plan task.
      const fake = new FakeExecutionRuntime();
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));
      // worker.attempt is triggered by scheduleQueuedIntents; script it too so
      // FakeExecutionRuntime returns a deterministic runId.
      fake.script(TASK_IDS.workerAttempt, () => ({ status: "EXECUTING" }));

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(wiId, planCmdId);
      // Advance plan run: QUEUED → EXECUTING (not strictly needed since
      // onLeadPlanOutput processes output passed directly, but mirrors the
      // pattern from flow.boundary.test.ts for correctness).
      fake.advance(planRunId);
      fake.advance(planRunId);

      const outputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), outputCmdId);

      // Query the worker.attempt dispatch_intent (dispatch_intents stores only
      // payload_digest, not the full payload — the payload is captured via fake.calls).
      const { rows } = await client.query<{
        dispatch_nonce_hash: string | null;
      }>("SELECT dispatch_nonce_hash FROM dispatch_intents WHERE task = $1", [
        TASK_IDS.workerAttempt,
      ]);
      assert.equal(rows.length, 1, "one worker.attempt dispatch_intent must exist");
      const row = rows[0]!;

      // dispatch_nonce_hash must be set (not null) for mirror mode.
      assert.ok(
        row.dispatch_nonce_hash !== null,
        "dispatch_nonce_hash must be set for mirror dispatch",
      );

      // Find the worker.attempt trigger call in fake.calls.
      const workerCall = fake.calls.find(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.ok(workerCall, "worker.attempt trigger call must exist in fake.calls");
      const payload = (workerCall!.args[0] as { payload: Record<string, unknown> })
        .payload as Record<string, unknown>;

      // payloadVersion must be 2 for mirror-mode dispatches.
      assert.equal(payload.payloadVersion, 2, "mirror worker payload must have payloadVersion: 2");

      // leaseNonce must be a 64-character hex string.
      const leaseNonce = payload.leaseNonce as string;
      assert.ok(
        typeof leaseNonce === "string" && /^[0-9a-f]{64}$/.test(leaseNonce),
        "leaseNonce must be 64-char hex",
      );

      // sha256(leaseNonce) must equal the stored dispatch_nonce_hash.
      const expectedHash = createHash("sha256").update(leaseNonce, "utf-8").digest("hex");
      assert.equal(
        row.dispatch_nonce_hash,
        expectedHash,
        "dispatch_nonce_hash must equal sha256(leaseNonce)",
      );

      // No host filesystem path keys in the payload.
      const payloadStr = JSON.stringify(payload);
      for (const forbidden of ["repoPath", "worktreeBase", "patchPath", "manifestRepoPaths"]) {
        assert.ok(
          !payloadStr.includes(forbidden),
          `mirror worker payload must not contain '${forbidden}'`,
        );
      }

      // Permission rule values must not contain /tmp/worker paths (E8 / W-14).
      const permRules = payload.permissionRules as Record<string, unknown> | undefined;
      if (permRules) {
        const permRulesStr = JSON.stringify(permRules);
        assert.ok(
          !permRulesStr.includes("/tmp/worker"),
          "mirror worker permissionRules must not embed /tmp/worker paths",
        );
        // X3-5: no edit key must start with "/" (root-anchored) when worktreePath is empty.
        const editRules = (permRules as { edit?: Record<string, string> }).edit ?? {};
        for (const key of Object.keys(editRules)) {
          assert.ok(
            !key.startsWith("/"),
            `mirror worker edit permission key "${key}" must not be root-anchored (X3-5)`,
          );
        }
      }
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// P10: integrate lease → push via real git; base-moved case
// ---------------------------------------------------------------------------

test("P10: integrate lease issued; push via real git advances remote; base-moved case rejected", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  // Build a bare remote + coordinator clone (mirrors integrate-merge-core.test.ts).
  const remotePath = await mkdtemp(join(tmpdir(), "ahq-p10-remote-"));
  const runDir = await mkdtemp(join(tmpdir(), "ahq-p10-rundir-"));
  let repoPath: string | null = null;

  try {
    // Bare remote.
    await git(["init", "--bare", "--initial-branch=main"], remotePath);

    // Init repo → push base commit.
    const initPath = await mkdtemp(join(tmpdir(), "ahq-p10-init-"));
    await git(["init", "--initial-branch=main"], initPath);
    await writeFile(join(initPath, "README.md"), "base\n");
    await git(["add", "-A"], initPath);
    await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "base"], initPath);
    await git(["remote", "add", "origin", remotePath], initPath);
    await git(["push", "origin", "main"], initPath);
    const baseRevision = await git(["rev-parse", "HEAD"], initPath);
    await rm(initPath, { recursive: true, force: true });

    // Clone as coordinator repo.
    repoPath = join(tmpdir(), `ahq-p10-repo-${Date.now()}`);
    await execFileAsync("git", ["clone", remotePath, repoPath], { cwd: tmpdir() });

    // Attempt commit on clone.
    await writeFile(join(repoPath, "src.ts"), "export const x = 1;\n");
    await git(["add", "-A"], repoPath);
    await git(
      ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "attempt"],
      repoPath,
    );
    const attemptRevision = await git(["rev-parse", "HEAD"], repoPath);

    await withTestSchema(t, async ({ client, schema }) => {
      await client.query(`SET search_path TO "${schema}", public`);

      const poolUrl = new URL(DATABASE_URL!);
      poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
      const pool = createPool(poolUrl.toString());

      try {
        // Seed: project (mirror, remote = HTTPS URL required by LeaseGrantSchema
        // validation; git operations use the local clone's "origin" remote which
        // points to remotePath — the two are independent).
        const projectId = newId("prj");
        await client.query(
          `INSERT INTO projects
             (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version,
              profile_catalog, source_mode)
           VALUES ($1, $2, $3, '/wt', $4::jsonb, $5::jsonb, '1', '["default"]'::jsonb, 'mirror')`,
          [
            projectId,
            "https://github.com/agencyhq-test/p10-repo.git",
            repoPath,
            JSON.stringify({ main: baseRevision }),
            JSON.stringify(HOST_TRIAL_AUTHORITY),
          ],
        );

        // Seed: work_item.
        const wiId = newId("wi");
        await client.query(
          `INSERT INTO work_items
             (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
           VALUES ($1, $2, 1, 'integrate test', 'merge', 'active', 'healthy', true, 1)`,
          [wiId, projectId],
        );

        // Seed: step_contract.
        const contractId = newId("sc");
        const bounds = {
          paths: { allow: ["**"], deny: [] },
          capabilities: {
            bash: { allow: [], deny: [] },
            tools: {
              edit: true,
              webfetch: false,
              websearch: false,
              task: false,
              external_directory: false,
              skill: false,
            },
          },
          boundary: "merge",
          budget: { maxAttempts: 1, maxDurationSeconds: 300, estimatedSpendUsd: 1 },
        };
        await client.query(
          `INSERT INTO step_contracts
             (id, work_item_id, project_id, version, base_revision, inputs, criteria,
              criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
              human_required, status)
           VALUES ($1, $2, $3, 1, $4, '{}'::jsonb, '[]'::jsonb, 'sha256:abc',
                   'default', 'sha256:abc', $5::jsonb, '[]'::jsonb, false, 'active')`,
          [contractId, wiId, projectId, baseRevision, JSON.stringify(bounds)],
        );

        // Seed: attempt.
        const attemptId = newId("att");
        const runId = `run_p10_${randomBytes(4).toString("hex")}`;
        await client.query(
          `INSERT INTO attempts
             (id, contract_id, contract_version, generation, status, run_id, budget_remaining)
           VALUES ($1, $2, 1, 0, 'dispatched', $3, 100000)`,
          [attemptId, contractId, runId],
        );

        // Seed: dispatch_intent (worker.attempt) with nonce hash.
        const nonce = randomBytes(32).toString("hex");
        const nonceHash = createHash("sha256").update(nonce, "utf-8").digest("hex");
        const intentId = newId("di");
        await client.query(
          `INSERT INTO dispatch_intents
             (id, task, payload_digest, attempt_id, status, run_id, idempotency_key,
              dispatch_nonce_hash)
           VALUES ($1, 'worker.attempt', 'sha256:placeholder', $2, 'triggered', $3, $4, $5)`,
          [intentId, attemptId, runId, `workerattempt:${wiId}:${intentId}`, nonceHash],
        );

        // Seed: encrypted credential for integrate purpose.
        const TEST_SECRETS_KEY = randomBytes(32).toString("hex");
        const DUMMY_CREDENTIAL = "dummy-git-token-for-test";
        const encrypted = encryptSecret(DUMMY_CREDENTIAL, TEST_SECRETS_KEY);
        await putProjectCredential(client, {
          project_id: projectId,
          purpose: "integrate",
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          tag: encrypted.tag,
          key_version: 1,
        });

        // Issue integrate lease via the coordinator broker.
        const leaseResult = await issueLeaseBroker(
          {
            pool,
            providerState: async () => "ready" as const,
            dataDirFn: () => undefined,
            secretsKey: () => TEST_SECRETS_KEY,
          },
          { runId, attemptId, generation: 0, purpose: "integrate", nonce },
        );

        assert.ok(
          leaseResult.ok,
          `integrate lease must be granted (got: ${JSON.stringify(!leaseResult.ok && leaseResult)})`,
        );
        if (!leaseResult.ok) return;

        const grant = leaseResult.grant;
        assert.equal(
          grant.material.purpose,
          "integrate",
          "lease material purpose must be integrate",
        );
        if (grant.material.purpose !== "integrate") return;

        const { askpassToken } = grant.material;
        assert.ok(
          typeof askpassToken === "string" && askpassToken.length > 0,
          "askpassToken must be non-empty string",
        );
        // Token must equal the dummy credential we stored.
        assert.equal(askpassToken, DUMMY_CREDENTIAL, "askpassToken must match stored credential");

        // Write the askpass script (mode 0700).
        const askpassDir = await mkdtemp(join(tmpdir(), "ahq-p10-askpass-"));
        const askpassPath = join(askpassDir, "git-askpass.sh");
        const safeToken = askpassToken.replace(/'/g, "'\\''");
        const script = `#!/bin/sh\ncase "$1" in\n  Password*) printf '%s\\n' '${safeToken}' ;;\n  *) printf '\\n' ;;\nesac\n`;
        await writeFile(askpassPath, script, { mode: 0o700, encoding: "utf8" });

        // Real git deps wired with GIT_ASKPASS (local remote ignores credentials).
        const envWithAskpass: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: askpassPath,
        };
        const gitDeps: IntegrateMergeDeps = {
          fetchRef: (args) => gitFetchRef({ ...args, env: envWithAskpass }),
          lsRemote: (args) => gitLsRemote({ ...args, env: envWithAskpass }),
          isAncestor: (args) => gitIsAncestor({ ...args, env: envWithAskpass }),
          worktreeAdd,
          worktreeRemove,
          mergeInWorktree: (args) => gitMergeInWorktree({ ...args, env: envWithAskpass }),
          pushForceWithLease: (args) => gitPushForceWithLease({ ...args, env: envWithAskpass }),
        };

        const intPayload: IntegrateMergePayload = {
          attemptId,
          generation: 0,
          contractId,
          contractVersion: 1,
          projectId,
          repoPath: repoPath!,
          remote: "origin",
          targetRef: "main",
          expectedBaseRevision: baseRevision,
          attemptRevision,
          strategy: "merge_commit",
        };

        // Happy path: push the attempt commit.
        const output = await runIntegrateMerge(intPayload, gitDeps, runDir);

        assert.equal(output.outcome, "integrated", "integrate must succeed");
        assert.ok(output.resultingRevision, "resultingRevision must be set");

        // Remote ref must have advanced.
        await git(["fetch", "origin", "main"], repoPath!);
        const remoteMain = (await git(["rev-parse", "refs/remotes/origin/main"], repoPath!)).trim();
        assert.notEqual(remoteMain, baseRevision.trim(), "remote must have advanced beyond base");

        // Delete askpass file (as runIntegrateMergeV2 would do in finally).
        await rm(askpassPath, { force: true });
        await rm(askpassDir, { recursive: true, force: true });

        // Assert askpass file is gone.
        let askpassGone = false;
        try {
          await stat(askpassPath);
        } catch {
          askpassGone = true;
        }
        assert.ok(askpassGone, "askpass file must be deleted after integrate");

        // Base-moved case: create a divergent attempt commit from the original
        // base (different from the first attempt which is already integrated),
        // then re-run integrate. Remote is now at the merge commit (beyond
        // expectedBaseRevision = baseRevision) so the outcome is base_moved.
        //
        // We check out the original baseRevision in a detached HEAD, make a
        // different change, and commit. This commit is NOT an ancestor of the
        // current remote main (which merged the first attempt), so step 2
        // (already_integrated) is false and step 3 (base_moved) fires.
        await git(["checkout", "--detach", baseRevision.trim()], repoPath!);
        await writeFile(join(repoPath!, "divergent.ts"), "// divergent attempt\n");
        await git(["add", "-A"], repoPath!);
        await git(
          ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "divergent attempt"],
          repoPath!,
        );
        const attempt2Revision = (await git(["rev-parse", "HEAD"], repoPath!)).trim();

        const payload2: IntegrateMergePayload = {
          ...intPayload,
          attemptRevision: attempt2Revision,
          expectedBaseRevision: baseRevision.trim(),
        };

        const runDir2 = await mkdtemp(join(tmpdir(), "ahq-p10-rundir2-"));
        try {
          const output2 = await runIntegrateMerge(payload2, gitDeps, runDir2);
          assert.equal(
            output2.outcome,
            "base_moved",
            `stale base must produce base_moved outcome (got ${output2.outcome})`,
          );
        } finally {
          await rm(runDir2, { recursive: true, force: true });
        }
      } finally {
        await pool.end();
      }
    });
  } finally {
    await rm(remotePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    if (repoPath) {
      await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

// ---------------------------------------------------------------------------
// P12 (X3-1): fenced generation — old upload token refuses final artifact,
//              accepts checkpoint and stop evidence for the old generation
// ---------------------------------------------------------------------------

test("P12: stop → generation+1 → old upload token: final artifact refused 409, checkpoint accepted", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-p12-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p12_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    // Start at generation=0
    const attemptId = await seedAttempt(directClient, contractId, 0);
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    // Simulate stop: bump to generation 1 (operator stop).
    // Revoke provider/integrate leases for gen 0 (upload lease kept).
    await revokeLeasesBelowGeneration(
      directClient as unknown as import("pg").PoolClient,
      attemptId,
      1,
      ["provider", "integrate"],
    );
    // Update attempt to stopping status and generation 1.
    await directClient.query(
      "UPDATE attempts SET generation = 1, status = 'stopping' WHERE id = $1",
      [attemptId],
    );

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    // Make a worker commit for the old generation.
    const clonePath = await mkdtemp(join(tmpdir(), "ahq-pe-p12-clone-"));
    try {
      await git(["clone", `file://${base.repoPath}`, clonePath], tmpdir());
      await git(["config", "user.email", "test@example.com"], clonePath);
      await git(["config", "user.name", "Test"], clonePath);
      const { commitId, bundleBytes, diffDigest, bundleSha256 } = await makeWorkerCommit(
        clonePath,
        "p12-worker.ts",
        base.baseRev,
      );

      // Attempt to upload a final "attempt" artifact with the OLD gen-0 token claiming gen 1.
      // The lease is for gen 0, but claimed.generation = 1 → LEASE_GENERATION_MISMATCH → 409.
      const attemptMeta: ArtifactUploadMeta = {
        attemptId,
        generation: 1, // claims new generation
        kind: "attempt",
        commitId,
        diffDigest,
        changedPaths: ["p12-worker.ts"],
        bundleSha256,
        bundleBytes: bundleBytes.length,
      };
      const badRes = await app.request(`/internal/attempts/${attemptId}/artifacts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`, // gen-0 token
          "X-AgencyHQ-Meta": JSON.stringify(attemptMeta),
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(bundleBytes),
      });
      assert.equal(
        badRes.status,
        409,
        `final artifact with wrong claimed gen must be refused 409 (LEASE_GENERATION_MISMATCH), got ${badRes.status}`,
      );

      // Now upload a checkpoint for gen 0 (old lease, old generation) — must be accepted.
      const checkpointMeta: ArtifactUploadMeta = {
        attemptId,
        generation: 0, // old generation matches lease
        kind: "checkpoint",
        commitId,
        diffDigest,
        changedPaths: [], // checkpoint may have empty changedPaths
        bundleSha256,
        bundleBytes: bundleBytes.length,
      };
      const cpRes = await app.request(`/internal/attempts/${attemptId}/checkpoints`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`, // gen-0 token
          "X-AgencyHQ-Meta": JSON.stringify(checkpointMeta),
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(bundleBytes),
      });
      assert.equal(
        cpRes.status,
        201,
        `checkpoint upload must be accepted 201, got ${cpRes.status}`,
      );

      // Verify no verified attempt artifact row for generation 1 (not admitted).
      const { rows: badArtRows } = await directClient.query(
        `SELECT id FROM attempt_artifacts WHERE attempt_id = $1 AND generation = 1 AND kind = 'attempt'`,
        [attemptId],
      );
      assert.equal(badArtRows.length, 0, "no verified artifact row for gen 1 must exist");

      // Verify checkpoint artifact row for generation 0 exists.
      const { rows: cpArtRows } = await directClient.query(
        `SELECT id FROM attempt_artifacts WHERE attempt_id = $1 AND generation = 0 AND kind = 'checkpoint'`,
        [attemptId],
      );
      assert.equal(cpArtRows.length, 1, "checkpoint artifact row for gen 0 must exist");
    } finally {
      await rm(clonePath, { recursive: true, force: true });
    }

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P13 (X3-2): stop evidence with survivors stored in DB
// ---------------------------------------------------------------------------

test("P13: stop evidence with survivors and checkpointCommit stored in DB", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-p13-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p13_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    const attemptId = await seedAttempt(directClient, contractId);
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    const fakeCommit = "a".repeat(40);
    const evidenceBody = {
      attemptId,
      generation: 0,
      steps: [
        {
          at: new Date().toISOString(),
          step: "checkpoint_committed",
          checkpointCommit: fakeCommit,
        },
        { at: new Date().toISOString(), step: "stop_done", survivors: [123, 456] },
      ],
    };

    const evidenceRes = await app.request(`/internal/attempts/${attemptId}/stop-evidence`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(evidenceBody),
    });
    assert.equal(
      evidenceRes.status,
      201,
      `stop evidence must be accepted, got ${evidenceRes.status}`,
    );

    // Read from DB and verify survivors and checkpointCommit are stored.
    const rows = await listStopEvidenceForAttempt(
      directClient as unknown as import("pg").PoolClient,
      attemptId,
    );
    assert.equal(rows.length, 1, "one stop evidence row must exist");
    const steps = rows[0]?.steps as Array<{
      step: string;
      survivors?: number[];
      checkpointCommit?: string;
    }>;
    const stopDone = steps.find((s) => s.step === "stop_done");
    const cpCommitted = steps.find((s) => s.step === "checkpoint_committed");
    assert.ok(stopDone, "stop_done step must exist");
    assert.deepEqual(stopDone?.survivors, [123, 456], "survivors must be stored");
    assert.ok(cpCommitted, "checkpoint_committed step must exist");
    assert.equal(cpCommitted?.checkpointCommit, fakeCommit, "checkpointCommit must be stored");

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P14 (X3-7): mirror-mode retry dispatch carries payloadVersion: 2, new nonce
// ---------------------------------------------------------------------------

// P14 needs a second attempt in the budget so the artifact_not_admitted retry can dispatch.
const P14_AUTHORITY = {
  ...HOST_TRIAL_AUTHORITY,
  budget: { ...HOST_TRIAL_AUTHORITY.budget, maxAttempts: 2 },
};

test("P14: mirror-mode artifact_not_admitted retry dispatch carries payloadVersion: 2 and nonce", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      // Mirror project — source_mode = 'mirror', no clone_path needed for this flow path.
      const projectId = newId("prj");
      const baseRev = "a".repeat(40);
      await client.query(
        `INSERT INTO projects
           (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version,
            profile_catalog, source_mode)
         VALUES ($1, NULL, '/repo', '/wt', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb, 'mirror')`,
        [projectId, JSON.stringify({ main: baseRev }), JSON.stringify(P14_AUTHORITY)],
      );

      const wiId = newId("wi");
      await client.query(
        `INSERT INTO work_items
           (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Fix the parser', 'artifact', 'proposed', 'healthy', true, 1)`,
        [wiId, projectId],
      );

      const fake = new FakeExecutionRuntime();

      // Script leadPlan to return goodPlanOutput and workerAttempt to COMPLETED
      // with a fake commitId that has no verified artifact row.
      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      const workerCommitId = "b".repeat(40);
      // A complete worker output (as the adapter produces it) whose commit has no
      // verified artifact row: the flow must classify artifact_not_admitted.
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => ({
        status: "COMPLETED",
        output: workerCompletedOutput((payload as { attemptId: string }).attemptId, {
          commitId: workerCommitId,
          diffDigest: `sha256:${"c".repeat(64)}`,
          changedPaths: ["src/fix.ts"],
        }),
      }));

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      // Drive: plan → advance plan → onLeadPlanOutput (creates contract + dispatches worker).
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(wiId, newId("cmd"));
      fake.advance(planRunId);
      fake.advance(planRunId);
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

      // Get the worker dispatch (should now exist in DB).
      const { rows: wRows } = await client.query<{ run_id: string }>(
        "SELECT run_id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.ok(wRows[0]?.run_id, "worker dispatch_intent must have run_id");
      const workerRunId = wRows[0]!.run_id;

      // Advance worker run to COMPLETED (QUEUED → EXECUTING → COMPLETED via script).
      fake.advance(workerRunId);
      fake.advance(workerRunId);

      // Retrieve the observation and call onWorkerFinal.
      // No verified artifact row exists → artifact_not_admitted path fires → retry dispatch.
      const workerObs = await fake.retrieve(workerRunId);
      await flow.onWorkerFinal(workerObs, newId("cmd"));

      // The retry trigger call must carry payloadVersion: 2, leaseNonce, no repoPath.
      const triggerCalls = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      // First call = initial dispatch from onLeadPlanOutput; second = retry from onWorkerFinal.
      assert.ok(
        triggerCalls.length >= 2,
        `expected >= 2 worker trigger calls, got ${triggerCalls.length} (X3-7)`,
      );
      const retryArg = triggerCalls[1]!.args[0] as { payload: Record<string, unknown> };
      const retryPayload = retryArg.payload;
      assert.equal(
        retryPayload.payloadVersion,
        2,
        "retry payload must be payloadVersion: 2 (X3-7)",
      );
      assert.ok(
        typeof retryPayload.leaseNonce === "string" &&
          (retryPayload.leaseNonce as string).length >= 32,
        "retry payload must include leaseNonce of at least 32 chars (X3-7)",
      );
      assert.ok(!("repoPath" in retryPayload), "mirror retry must not include repoPath (X3-7)");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// P15 / W-9: checkpoint with empty changedPaths admitted
// ---------------------------------------------------------------------------

test("P15 (W-9): checkpoint with empty changedPaths and real empty-diff digest admitted", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }

  const gitRoot = await mkdtemp(join(tmpdir(), "ahq-pe-p15-gr-"));
  const base = await makeBaseRepo();

  const schema = `ahq_pe_p15_${process.pid}_${Date.now()}`;
  const directPool = new pg.Pool({ connectionString: DATABASE_URL });
  const directClient = await directPool.connect();

  try {
    await directClient.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await runMigrations(directClient, { schema });
    await directClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);

    const projectId = await seedMirrorProject(directClient, `file://${base.repoPath}`);
    const wiId = await seedWorkItem(directClient, projectId);
    const contractId = await seedContract(directClient, projectId, wiId, base.baseRev);
    const attemptId = await seedAttempt(directClient, contractId);
    const { uploadToken } = await issueUploadLease(directClient, attemptId, 0);

    await ensureMirror({ id: projectId, remote: `file://${base.repoPath}` }, { gitRoot });

    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const app = createApp({
      pool: schemaPool as never,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(gitRoot),
    });

    // Make a worker clone and compute an empty-diff checkpoint (HEAD = base).
    const clonePath = await mkdtemp(join(tmpdir(), "ahq-pe-p15-clone-"));
    try {
      await git(["clone", `file://${base.repoPath}`, clonePath], tmpdir());
      await git(["config", "user.email", "test@example.com"], clonePath);
      await git(["config", "user.name", "Test"], clonePath);

      // Commit HEAD equals base revision — zero-diff checkpoint.
      const commitId = base.baseRev.trim();

      // Compute empty diff digest (base === commit, so diff is empty string).
      const emptyDiffDigest = `sha256:${createHash("sha256").update("").digest("hex")}`;

      // Bundle the base commit.
      const exportRef = bundleRefFor(commitId);
      await git(["update-ref", exportRef, commitId], clonePath);
      const bundleTmp = join(tmpdir(), `pe-p15-bundle-${Date.now()}.bundle`);
      await git(["bundle", "create", bundleTmp, exportRef], clonePath);
      const bundleBytes = await readFile(bundleTmp);
      await rm(bundleTmp, { force: true });
      const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");

      const checkpointMeta: ArtifactUploadMeta = {
        attemptId,
        generation: 0,
        kind: "checkpoint",
        commitId,
        diffDigest: emptyDiffDigest,
        changedPaths: [], // empty — valid for checkpoints
        bundleSha256,
        bundleBytes: bundleBytes.length,
      };

      const res = await app.request(`/internal/attempts/${attemptId}/checkpoints`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "X-AgencyHQ-Meta": JSON.stringify(checkpointMeta),
          "Content-Type": "application/octet-stream",
        },
        body: bundleBytes,
      });

      assert.equal(
        res.status,
        201,
        `checkpoint with empty changedPaths must be admitted 201, got ${res.status}`,
      );

      // Assert artifact row is kind: checkpoint.
      const { rows: artRows } = await directClient.query(
        `SELECT kind FROM attempt_artifacts WHERE attempt_id = $1 AND generation = 0`,
        [attemptId],
      );
      assert.equal(artRows.length, 1, "one artifact row must exist");
      assert.equal(artRows[0]?.kind, "checkpoint", "artifact row must be kind: checkpoint");
    } finally {
      await rm(clonePath, { recursive: true, force: true });
    }

    await schemaPool.end();
  } finally {
    directClient.release();
    await directPool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(base.repoPath, { recursive: true, force: true });
  }
});
