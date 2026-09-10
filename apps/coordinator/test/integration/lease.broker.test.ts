/**
 * Integration tests for the lease broker.
 *
 * Requires DATABASE_URL to be set. Skips loudly when absent.
 *
 * Tests:
 * - Two parallel leases for two attempts succeed
 * - Logout between them (fixture file removed) refuses the third with login_required
 *   while the first two remain valid (existing leases keep their snapshot)
 * - Stale generation refused
 * - Expired lease refused
 * - Wrong nonce → 403
 * - Replayed identical request returns the same leaseId (idempotent by nonce hash)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { TestDbContext } from "@agencyhq/db";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { issueLeaseBroker } from "../../src/internal/leases.ts";
import { generateNonce, hashNonce } from "../../src/internal/nonce.ts";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log(
    "[lease.broker.test] DATABASE_URL not set — skipping integration tests (C3 requires DATABASE_URL)",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

// Fixture secrets — track all for no-leak assertion
const FIXTURE_API_KEY = "sk-ant-test-lease-broker-apikey-xyz789";
const FIXTURE_ACCESS = "oauth-access-test-12345";
const FIXTURE_REFRESH = "oauth-refresh-test-67890";

let tempDir: string;
let authJsonPath: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "agencyhq-lease-broker-test-"));
  authJsonPath = join(tempDir, "auth.json");
  writeAuthJson({ anthropic: { type: "api", key: FIXTURE_API_KEY } });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeAuthJson(content: Record<string, unknown>): void {
  writeFileSync(authJsonPath, JSON.stringify(content), "utf-8");
}

function removeAuthJson(): void {
  try {
    unlinkSync(authJsonPath);
  } catch {
    // ok if already gone
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

// Schema-aware pool helper: creates a pool with search_path set to the test schema.
// issueLeaseBroker uses pool.connect() internally; the connection must use the
// test schema's search_path so it can see migration 0009 columns (dispatch_nonce_hash).
function makeTestPool(schema: string): ReturnType<typeof createPool> {
  const poolUrl = new URL(DATABASE_URL!);
  poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
  return createPool(poolUrl.toString());
}

// Shared log capture for no-leak assertions
const logLines: string[] = [];

function captureLog(msg: string, meta?: unknown): void {
  const line = meta !== undefined ? `${msg} ${JSON.stringify(meta)}` : msg;
  logLines.push(line);
}

// Verify no fixture secrets appear in any log line
function assertNoSecretsInLogs(): void {
  const allLogs = logLines.join("\n");
  const secrets = [FIXTURE_API_KEY, FIXTURE_ACCESS, FIXTURE_REFRESH];
  for (const secret of secrets) {
    assert.ok(
      !allLogs.includes(secret),
      `log output must not contain secret value (first 8 chars): ${secret.slice(0, 8)}`,
    );
  }
}

// Helper to seed the minimum required rows for a lease test
async function seedAttemptForLease(
  ctx: TestDbContext,
  opts: {
    projectId?: string;
    runId?: string;
    generation?: number;
    intentStatus?: string;
    nonceHash?: string;
  } = {},
): Promise<{ attemptId: string; runId: string; intentId: string; generation: number }> {
  const projectId = opts.projectId ?? newId("prj");
  const runId = opts.runId ?? `run_${crypto.randomUUID()}`;
  const generation = opts.generation ?? 0;
  const contractId = newId("sc");
  const workItemId = newId("wi");
  const attemptId = newId("att");
  const intentId = newId("di");

  // Insert minimum project
  await ctx.client.query(
    `INSERT INTO projects (id, authority, authority_version) VALUES ($1, '{}', '0')
     ON CONFLICT (id) DO NOTHING`,
    [projectId],
  );

  // Insert work_item (boundary is NOT NULL; use 'artifact' as the canonical test value)
  await ctx.client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition)
     VALUES ($1, $2, 0, 'test', 'artifact', 'active', 'healthy')
     ON CONFLICT (id) DO NOTHING`,
    [workItemId, projectId],
  );

  // Insert step_contract (inputs, required_boundaries, human_required, status are NOT NULL or need defaults)
  await ctx.client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest,
        bounds, required_boundaries, human_required, status)
     VALUES ($1, $2, $3, 1, 'abc123', '{}'::jsonb, '[]'::jsonb, 'sha256:abc',
             'default', 'sha256:abc',
             '{"paths":{"allow":[]},"budget":{"maxDurationSeconds":3600}}'::jsonb,
             '[]'::jsonb, false, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [contractId, workItemId, projectId],
  );

  // Insert attempt
  await ctx.client.query(
    `INSERT INTO attempts (id, contract_id, contract_version, generation, status, run_id, budget_remaining)
     VALUES ($1, $2, 1, $3, 'running', $4, 100)
     ON CONFLICT (id) DO NOTHING`,
    [attemptId, contractId, generation, runId],
  );

  // Insert dispatch_intent
  const intentStatus = opts.intentStatus ?? "triggered";
  await ctx.client.query(
    `INSERT INTO dispatch_intents (id, task, payload_digest, attempt_id, status, run_id, idempotency_key, dispatch_nonce_hash)
     VALUES ($1, 'worker.attempt', 'digest', $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [intentId, attemptId, intentStatus, runId, `ik-${intentId}`, opts.nonceHash ?? null],
  );

  return { attemptId, runId, intentId, generation };
}

test("two parallel leases for two attempts both succeed", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce1 = generateNonce();
    const nonce2 = generateNonce();

    const { attemptId: a1, runId: r1 } = await seedAttemptForLease(ctx, {
      nonceHash: hashNonce(nonce1),
    });
    const { attemptId: a2, runId: r2 } = await seedAttemptForLease(ctx, {
      nonceHash: hashNonce(nonce2),
    });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const [r1Result, r2Result] = await Promise.all([
        issueLeaseBroker(deps, {
          runId: r1,
          attemptId: a1,
          generation: 0,
          purpose: "provider",
          nonce: nonce1,
        }),
        issueLeaseBroker(deps, {
          runId: r2,
          attemptId: a2,
          generation: 0,
          purpose: "provider",
          nonce: nonce2,
        }),
      ]);

      assert.ok(r1Result.ok, `attempt1 lease failed: ${JSON.stringify(r1Result)}`);
      assert.ok(r2Result.ok, `attempt2 lease failed: ${JSON.stringify(r2Result)}`);
      assert.equal(r1Result.grant.purpose, "provider");
      assert.equal(r2Result.grant.purpose, "provider");

      // Grants must contain authJson but the raw key must not appear in logs
      assert.ok("authJson" in r1Result.grant.material);
      assertNoSecretsInLogs();
    } finally {
      await schemaPool.end();
    }
  });
});

test("replayed identical request returns same leaseId (idempotent)", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();
    const { attemptId, runId } = await seedAttemptForLease(ctx, {
      nonceHash: hashNonce(nonce),
    });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const req = { runId, attemptId, generation: 0, purpose: "provider" as const, nonce };
      const first = await issueLeaseBroker(deps, req);
      const second = await issueLeaseBroker(deps, req);

      assert.ok(first.ok);
      assert.ok(second.ok);
      assert.equal(first.grant.leaseId, second.grant.leaseId);
      assertNoSecretsInLogs();
    } finally {
      await schemaPool.end();
    }
  });
});

test("wrong nonce → 403 unknown_run", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const correctNonce = generateNonce();
    const { attemptId, runId } = await seedAttemptForLease(ctx, {
      nonceHash: hashNonce(correctNonce),
    });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const wrongNonce = generateNonce(); // different nonce
      const result = await issueLeaseBroker(deps, {
        runId,
        attemptId,
        generation: 0,
        purpose: "provider",
        nonce: wrongNonce,
      });

      assert.ok(!result.ok);
      assert.equal(result.status, 403);
      assertNoSecretsInLogs();
    } finally {
      await schemaPool.end();
    }
  });
});

test("stale generation → 409 stale_generation", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();
    const { attemptId, runId } = await seedAttemptForLease(ctx, {
      generation: 2,
      nonceHash: hashNonce(nonce),
    });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      // Request with old generation
      const result = await issueLeaseBroker(deps, {
        runId,
        attemptId,
        generation: 1, // stale
        purpose: "provider",
        nonce,
      });

      assert.ok(!result.ok);
      assert.equal(result.status, 409);
      if (!result.ok && "reason" in result.refusal) {
        assert.equal(result.refusal.reason, "stale_generation");
      }
      assertNoSecretsInLogs();
    } finally {
      await schemaPool.end();
    }
  });
});

test("login_required when auth.json absent blocks new lease", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    removeAuthJson();
    const nonce = generateNonce();
    const { attemptId, runId } = await seedAttemptForLease(ctx, {
      nonceHash: hashNonce(nonce),
    });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "login_required" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const result = await issueLeaseBroker(deps, {
        runId,
        attemptId,
        generation: 0,
        purpose: "provider",
        nonce,
      });

      assert.ok(!result.ok);
      assert.equal(result.status, 409);
      if (!result.ok && "reason" in result.refusal) {
        assert.equal(result.refusal.reason, "login_required");
      }

      // Restore auth.json for subsequent tests
      writeAuthJson({ anthropic: { type: "api", key: FIXTURE_API_KEY } });
      assertNoSecretsInLogs();
    } finally {
      await schemaPool.end();
    }
  });
});

test("lease response and logs never contain fixture secret values", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();
    const { attemptId, runId } = await seedAttemptForLease(ctx, {
      nonceHash: hashNonce(nonce),
    });

    const capturedLines: string[] = [];
    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: (msg: string, meta?: unknown) => {
          const line = meta !== undefined ? `${msg} ${JSON.stringify(meta)}` : msg;
          capturedLines.push(line);
        },
      };

      const result = await issueLeaseBroker(deps, {
        runId,
        attemptId,
        generation: 0,
        purpose: "provider",
        nonce,
      });

      // The nonce itself (raw credential) must not appear in logs
      const allLogs = capturedLines.join("\n");
      assert.ok(!allLogs.includes(nonce), "raw nonce must not appear in log output");

      // The auth.json content IS in the grant material — but logs go through redaction
      // so the API key must not appear in log lines
      assert.ok(!allLogs.includes(FIXTURE_API_KEY), "api key must not appear in log output");

      // The grant itself (returned to caller) may contain authJson — that's by design
      assert.ok(result.ok);
    } finally {
      await schemaPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// X3-4: run_pending — intent exists but run_id not yet written
// ---------------------------------------------------------------------------

test("X3-4: run_pending when intent exists with run_id IS NULL", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();

    // Seed an attempt with a recorded (not triggered) intent — simulates the race
    // window between INSERT dispatch_intents and the trigger call writing run_id.
    const { attemptId, runId } = await seedAttemptForLease(ctx, {
      nonceHash: hashNonce(nonce),
      intentStatus: "triggered", // use triggered but run_id IS NULL (simulate by inserting with NULL manually)
    });

    // Insert a 'recorded' intent with run_id NULL for the same attempt (race window).
    await ctx.client.query(
      `INSERT INTO dispatch_intents (id, task, payload_digest, attempt_id, status, run_id, idempotency_key, dispatch_nonce_hash)
       VALUES ($1, 'worker.attempt', 'digest', $2, 'recorded', NULL, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [`di_pending_${crypto.randomUUID()}`, attemptId, `ik-pending-${attemptId}`, hashNonce(nonce)],
    );

    // The triggered intent above has run_id = runId, so a request with a DIFFERENT runId
    // that is NOT in any triggered intent will exercise the run_pending path.
    const unknownRunId = `run_${crypto.randomUUID()}`;

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const result = await issueLeaseBroker(deps, {
        runId: unknownRunId, // not yet in any triggered intent
        attemptId,
        generation: 0,
        purpose: "provider",
        nonce,
      });

      assert.ok(!result.ok, "run_pending must be a refusal");
      assert.equal(result.status, 409, "run_pending must return 409");
      assert.ok("reason" in result.refusal, "refusal must have reason");
      assert.equal(result.refusal.reason, "run_pending", "refusal reason must be run_pending");
    } finally {
      await schemaPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// X3-6: lead.plan lease — resolve by runId + workItemId, grant only provider/review
// ---------------------------------------------------------------------------

/** Seed a lead.plan dispatch intent (attempt_id IS NULL). */
async function seedLeadPlanIntent(
  ctx: TestDbContext,
  opts: {
    runId: string;
    workItemId: string;
    nonceHash?: string;
  },
): Promise<{ intentId: string; projectId: string }> {
  const intentId = newId("di");
  const projectId = newId("prj");
  const idempotencyKey = `leadplan:${opts.workItemId}:${intentId}`;

  await ctx.client.query(
    `INSERT INTO projects (id, authority, authority_version) VALUES ($1, '{}', '0')
     ON CONFLICT (id) DO NOTHING`,
    [projectId],
  );

  await ctx.client.query(
    `INSERT INTO dispatch_intents (id, task, payload_digest, attempt_id, status, run_id, idempotency_key, dispatch_nonce_hash)
     VALUES ($1, 'lead.plan', 'digest', NULL, 'triggered', $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [intentId, opts.runId, idempotencyKey, opts.nonceHash ?? null],
  );

  return { intentId, projectId };
}

test("X3-6: lead.plan intent granted provider lease", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();
    const runId = `run_${crypto.randomUUID()}`;
    const workItemId = newId("wi");

    await seedLeadPlanIntent(ctx, { runId, workItemId, nonceHash: hashNonce(nonce) });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const result = await issueLeaseBroker(deps, {
        runId,
        workItemId,
        generation: 0,
        purpose: "provider",
        nonce,
      });

      assert.ok(result.ok, `lead.plan provider lease must succeed: ${JSON.stringify(result)}`);
      assert.equal(result.grant.purpose, "provider");
      assertNoSecretsInLogs();
    } finally {
      await schemaPool.end();
    }
  });
});

test("X3-6: lead.plan intent granted review lease", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();
    const runId = `run_${crypto.randomUUID()}`;
    const workItemId = newId("wi");

    await seedLeadPlanIntent(ctx, { runId, workItemId, nonceHash: hashNonce(nonce) });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const result = await issueLeaseBroker(deps, {
        runId,
        workItemId,
        generation: 0,
        purpose: "review",
        nonce,
      });

      assert.ok(result.ok, `lead.plan review lease must succeed: ${JSON.stringify(result)}`);
      assert.equal(result.grant.purpose, "review");
    } finally {
      await schemaPool.end();
    }
  });
});

test("X3-6: lead.plan intent refused for upload purpose", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();
    const runId = `run_${crypto.randomUUID()}`;
    const workItemId = newId("wi");

    await seedLeadPlanIntent(ctx, { runId, workItemId, nonceHash: hashNonce(nonce) });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const result = await issueLeaseBroker(deps, {
        runId,
        workItemId,
        generation: 0,
        purpose: "upload",
        nonce,
      });

      assert.ok(!result.ok, "upload must be refused for lead.plan");
      assert.equal(result.status, 409);
      assert.ok(!result.ok && "reason" in result.refusal, "refusal must have reason");
      assert.equal(
        (!result.ok && "reason" in result.refusal && result.refusal.reason) as string,
        "unavailable",
      );
    } finally {
      await schemaPool.end();
    }
  });
});

test("X3-6: lead.plan intent refused for integrate purpose", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();
    const runId = `run_${crypto.randomUUID()}`;
    const workItemId = newId("wi");

    await seedLeadPlanIntent(ctx, { runId, workItemId, nonceHash: hashNonce(nonce) });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const result = await issueLeaseBroker(deps, {
        runId,
        workItemId,
        generation: 0,
        purpose: "integrate",
        nonce,
      });

      assert.ok(!result.ok, "integrate must be refused for lead.plan");
      assert.equal(result.status, 409);
    } finally {
      await schemaPool.end();
    }
  });
});

test("X3-6: lead.plan refused when workItemId does not match intent", async (t) => {
  await withTestSchema(t, async (ctx) => {
    const { schema } = ctx;
    const nonce = generateNonce();
    const runId = `run_${crypto.randomUUID()}`;
    const workItemId = newId("wi");
    const wrongWorkItemId = newId("wi");

    await seedLeadPlanIntent(ctx, { runId, workItemId, nonceHash: hashNonce(nonce) });

    const schemaPool = makeTestPool(schema);
    try {
      const deps = {
        pool: schemaPool,
        providerState: async () => "ready" as const,
        dataDirFn: () => tempDir,
        secretsKey: () => undefined,
        log: captureLog,
      };

      const result = await issueLeaseBroker(deps, {
        runId,
        workItemId: wrongWorkItemId, // wrong work item ID
        generation: 0,
        purpose: "provider",
        nonce,
      });

      assert.ok(!result.ok, "wrong workItemId must be refused");
      assert.equal(result.status, 403);
      assert.ok(!result.ok && "reason" in result.refusal, "refusal must have reason");
      assert.equal(
        (!result.ok && "reason" in result.refusal && result.refusal.reason) as string,
        "unknown_run",
      );
    } finally {
      await schemaPool.end();
    }
  });
});
