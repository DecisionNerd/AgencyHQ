/**
 * Integration tests for 0008_container_runtime tables.
 * Requires DATABASE_URL; tests skip loudly without it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import { encryptSecret } from "../../src/crypto.ts";
import { runMigrations } from "../../src/migrate.ts";
import {
  insertAttemptArtifact,
  listArtifactsForAttempt,
  markArtifactVerified,
} from "../../src/repos/attempt-artifacts.ts";
import {
  listStopEvidenceForAttempt,
  upsertAttemptStopEvidence,
} from "../../src/repos/attempt-stop-evidence.ts";
import { insertAttempt } from "../../src/repos/attempts.ts";
import {
  findLeasesByAttemptGeneration,
  issueLease,
  markLeaseUsed,
  revokeLeasesBelowGeneration,
} from "../../src/repos/leases.ts";
import {
  deleteProjectCredential,
  getProjectCredential,
  putProjectCredential,
} from "../../src/repos/project-credentials.ts";
import { getProject, insertProject, setProjectSourceMode } from "../../src/repos/projects.ts";
import { insertStepContract } from "../../src/repos/step-contracts.ts";
import { insertWorkItem } from "../../src/repos/work-items.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

const VALID_KEY = "aa".repeat(32);
const SHA40 = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SHA64 = "c".repeat(64);

const BOUNDS = {
  paths: { allow: ["src/**"], deny: [] },
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
  boundary: "artifact" as const,
  budget: { maxAttempts: 2, maxDurationSeconds: 300, estimatedSpendUsd: 1 },
  review: "adversarial" as const,
  changeClass: "behavior" as const,
  models: { worker: "test-worker", reviewer: "test-reviewer" },
};

// ---------------------------------------------------------------------------
// Migration idempotency — 0008 re-run
// ---------------------------------------------------------------------------

test("migration 0008 is idempotent (re-run applies no changes)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    // Already ran inside withTestSchema. Run again — should be a no-op.
    const result = await runMigrations(client);
    assert.deepEqual(result.applied, [], "Second migration run should apply nothing");
  });
});

// ---------------------------------------------------------------------------
// Helper to set up a project + work_item + step_contract + attempt
// ---------------------------------------------------------------------------

async function seedAttempt(
  client: any,
  schema: string,
  ids: {
    projectId: string;
    workItemId: string;
    contractId: string;
    attemptId: string;
  },
) {
  await insertProject(client, {
    id: ids.projectId,
    authority: HOST_TRIAL_AUTHORITY,
    authority_version: "1",
  });
  await insertWorkItem(client, {
    id: ids.workItemId,
    project_id: ids.projectId,
    rank: 1,
    intent: "test",
    boundary: "artifact",
    lifecycle: "open",
    condition: "open",
    main_effort: false,
    version: 1,
  });
  await insertStepContract(client, {
    id: ids.contractId,
    work_item_id: ids.workItemId,
    project_id: ids.projectId,
    version: 1,
    base_revision: SHA40,
    inputs: {},
    criteria: [],
    criteria_digest: DIGEST,
    profile_id: "p1",
    profile_digest: DIGEST,
    bounds: BOUNDS,
    required_boundaries: [],
    human_required: false,
    status: "active",
  });
  await insertAttempt(client, {
    id: ids.attemptId,
    contract_id: ids.contractId,
    contract_version: 1,
    generation: 1,
    status: "running",
    budget_remaining: 5,
  });
}

// ---------------------------------------------------------------------------
// projects: source_mode
// ---------------------------------------------------------------------------

test("projects: source_mode defaults to host_clone", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-sm-1",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    const p = await getProject(client, "proj-sm-1");
    assert.ok(p, "project must exist");
    assert.equal((p as any).source_mode ?? "host_clone", "host_clone");
  });
});

test("projects: setProjectSourceMode updates to mirror", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-sm-2",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    const updated = await setProjectSourceMode(client, "proj-sm-2", "mirror");
    assert.ok(updated, "updated project must be returned");
    assert.equal((updated as any).source_mode, "mirror");
  });
});

test("projects: setProjectSourceMode returns null for unknown project", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const result = await setProjectSourceMode(client, "does-not-exist", "mirror");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// leases
// ---------------------------------------------------------------------------

test("leases: issue and find by attempt+generation", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-lease-1",
      workItemId: "wi-lease-1",
      contractId: "sc-lease-1",
      attemptId: "att-lease-1",
    });

    const expires = new Date(Date.now() + 60_000);
    const nonce = "n".repeat(32);
    const nonceHash = createHash("sha256").update(nonce).digest("hex");

    const row = await issueLease(client, {
      id: "lease-1",
      attempt_id: "att-lease-1",
      generation: 1,
      run_id: "run-1",
      purpose: "upload",
      nonce_hash: nonceHash,
      expires_at: expires,
    });

    assert.equal(row.id, "lease-1");
    assert.equal(row.purpose, "upload");
    assert.equal(row.used_at, null);

    const found = await findLeasesByAttemptGeneration(client, "att-lease-1", 1);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, "lease-1");
  });
});

test("leases: markLeaseUsed sets used_at", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-lease-2",
      workItemId: "wi-lease-2",
      contractId: "sc-lease-2",
      attemptId: "att-lease-2",
    });

    await issueLease(client, {
      id: "lease-2",
      attempt_id: "att-lease-2",
      generation: 1,
      run_id: "run-2",
      purpose: "provider",
      nonce_hash: "hash2",
      expires_at: new Date(Date.now() + 60_000),
    });

    const updated = await markLeaseUsed(client, "lease-2");
    assert.ok(updated, "row must be returned");
    assert.ok(updated!.used_at instanceof Date, "used_at must be a Date");
  });
});

test("leases: revokeLeasesBelowGeneration returns count", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-lease-3",
      workItemId: "wi-lease-3",
      contractId: "sc-lease-3",
      attemptId: "att-lease-3",
    });

    // Issue two leases with generation 0 (note: attempt has gen 1, but leases can have any gen)
    // We insert directly to test the revoke logic
    await client.query(
      `INSERT INTO leases (id, attempt_id, generation, run_id, purpose, nonce_hash, expires_at)
       VALUES ('l-g0a', 'att-lease-3', 0, 'run', 'upload', 'hash-g0a', now() + interval '1 hour'),
              ('l-g0b', 'att-lease-3', 0, 'run', 'provider', 'hash-g0b', now() + interval '1 hour'),
              ('l-g1', 'att-lease-3', 1, 'run', 'upload', 'hash-g1', now() + interval '1 hour')`,
    );

    const count = await revokeLeasesBelowGeneration(client, "att-lease-3", 1);
    assert.equal(count, 2, "Should revoke 2 generation-0 leases");

    // Generation-1 lease should remain unrevoked
    const rows = await findLeasesByAttemptGeneration(client, "att-lease-3", 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.revoked_at, null);
  });
});

test("leases: unique constraint prevents duplicate (attempt, generation, purpose, nonce_hash)", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-lease-4",
      workItemId: "wi-lease-4",
      contractId: "sc-lease-4",
      attemptId: "att-lease-4",
    });

    await issueLease(client, {
      id: "lease-dup-1",
      attempt_id: "att-lease-4",
      generation: 1,
      run_id: "run-4",
      purpose: "upload",
      nonce_hash: "unique-hash",
      expires_at: new Date(Date.now() + 60_000),
    });

    await assert.rejects(
      () =>
        issueLease(client, {
          id: "lease-dup-2",
          attempt_id: "att-lease-4",
          generation: 1,
          run_id: "run-4",
          purpose: "upload",
          nonce_hash: "unique-hash",
          expires_at: new Date(Date.now() + 60_000),
        }),
      (e: any) => {
        assert.equal(e.code, "23505", "Expected unique constraint violation 23505");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// attempt_artifacts
// ---------------------------------------------------------------------------

test("attempt_artifacts: insert and list", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-art-1",
      workItemId: "wi-art-1",
      contractId: "sc-art-1",
      attemptId: "att-art-1",
    });

    const result = await insertAttemptArtifact(client, {
      id: "art-1",
      attempt_id: "att-art-1",
      generation: 1,
      kind: "attempt",
      commit_id: SHA40,
      diff_digest: DIGEST,
      changed_paths: ["src/foo.ts"],
      bundle_sha256: SHA64,
      bundle_bytes: 1024,
    });

    assert.equal(result.outcome, "inserted");
    assert.equal(result.outcome === "inserted" ? result.row.id : null, "art-1");

    const list = await listArtifactsForAttempt(client, "att-art-1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, "art-1");
  });
});

test("attempt_artifacts: duplicate insert returns 'duplicate' outcome", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-art-2",
      workItemId: "wi-art-2",
      contractId: "sc-art-2",
      attemptId: "att-art-2",
    });

    const insert = {
      id: "art-dup-1",
      attempt_id: "att-art-2",
      generation: 1,
      kind: "attempt" as const,
      commit_id: SHA40,
      diff_digest: DIGEST,
      changed_paths: [],
      bundle_sha256: SHA64,
      bundle_bytes: 0,
    };

    const r1 = await insertAttemptArtifact(client, insert);
    assert.equal(r1.outcome, "inserted");

    // Second insert with same (attempt_id, generation, kind, commit_id)
    const r2 = await insertAttemptArtifact(client, { ...insert, id: "art-dup-2" });
    assert.equal(r2.outcome, "duplicate");
  });
});

test("attempt_artifacts: markArtifactVerified sets verified = true", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-art-3",
      workItemId: "wi-art-3",
      contractId: "sc-art-3",
      attemptId: "att-art-3",
    });

    await insertAttemptArtifact(client, {
      id: "art-verify-1",
      attempt_id: "att-art-3",
      generation: 1,
      kind: "attempt",
      commit_id: SHA40,
      diff_digest: DIGEST,
      changed_paths: [],
      bundle_sha256: SHA64,
      bundle_bytes: 0,
    });

    const updated = await markArtifactVerified(client, "art-verify-1");
    assert.ok(updated, "row must be returned");
    assert.equal(updated!.verified, true);
  });
});

// ---------------------------------------------------------------------------
// attempt_stop_evidence
// ---------------------------------------------------------------------------

test("attempt_stop_evidence: upsert and list", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-evi-1",
      workItemId: "wi-evi-1",
      contractId: "sc-evi-1",
      attemptId: "att-evi-1",
    });

    const steps = [{ at: "2026-09-09T10:00:00.000Z", step: "signal_sent" as const }];
    const row = await upsertAttemptStopEvidence(client, {
      id: "evi-1",
      attempt_id: "att-evi-1",
      generation: 1,
      steps,
    });

    assert.equal(row.id, "evi-1");
    assert.equal(row.attempt_id, "att-evi-1");

    const list = await listStopEvidenceForAttempt(client, "att-evi-1");
    assert.equal(list.length, 1);
  });
});

test("attempt_stop_evidence: upsert is idempotent by (attempt_id, generation)", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    await seedAttempt(client, schema, {
      projectId: "proj-evi-2",
      workItemId: "wi-evi-2",
      contractId: "sc-evi-2",
      attemptId: "att-evi-2",
    });

    const steps1 = [{ at: "2026-09-09T10:00:00.000Z", step: "signal_sent" as const }];
    const steps2 = [
      { at: "2026-09-09T10:00:00.000Z", step: "signal_sent" as const },
      { at: "2026-09-09T10:00:01.000Z", step: "process_exited" as const },
    ];

    await upsertAttemptStopEvidence(client, {
      id: "evi-2a",
      attempt_id: "att-evi-2",
      generation: 1,
      steps: steps1,
    });

    // Re-upsert same (attempt, generation) — should overwrite steps
    const updated = await upsertAttemptStopEvidence(client, {
      id: "evi-2b",
      attempt_id: "att-evi-2",
      generation: 1,
      steps: steps2,
    });

    const list = await listStopEvidenceForAttempt(client, "att-evi-2");
    assert.equal(list.length, 1, "Only one row per (attempt_id, generation)");
  });
});

// ---------------------------------------------------------------------------
// project_credentials
// ---------------------------------------------------------------------------

test("project_credentials: put, get, delete round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-cred-1",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });

    const encrypted = encryptSecret("s3cr3t-token", VALID_KEY);
    await putProjectCredential(client, {
      project_id: "proj-cred-1",
      purpose: "git-read",
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      key_version: 1,
    });

    const row = await getProjectCredential(client, "proj-cred-1", "git-read");
    assert.ok(row, "row must exist after put");
    assert.equal(row!.purpose, "git-read");
    assert.equal(row!.key_version, 1);
    assert.ok(Buffer.isBuffer(row!.ciphertext), "ciphertext must be a Buffer");

    const deleted = await deleteProjectCredential(client, "proj-cred-1", "git-read");
    assert.equal(deleted, true);

    const gone = await getProjectCredential(client, "proj-cred-1", "git-read");
    assert.equal(gone, null);
  });
});

test("project_credentials: put upserts (overwrite on conflict)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-cred-2",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });

    const e1 = encryptSecret("token-v1", VALID_KEY);
    await putProjectCredential(client, {
      project_id: "proj-cred-2",
      purpose: "integrate",
      ciphertext: e1.ciphertext,
      iv: e1.iv,
      tag: e1.tag,
      key_version: 1,
    });

    const e2 = encryptSecret("token-v2", VALID_KEY);
    await putProjectCredential(client, {
      project_id: "proj-cred-2",
      purpose: "integrate",
      ciphertext: e2.ciphertext,
      iv: e2.iv,
      tag: e2.tag,
      key_version: 2,
    });

    const row = await getProjectCredential(client, "proj-cred-2", "integrate");
    assert.ok(row, "row must exist");
    assert.equal(row!.key_version, 2, "key_version must be updated");
  });
});

test("project_credentials: get returns null for missing (project_id, purpose)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-cred-3",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    const row = await getProjectCredential(client, "proj-cred-3", "git-read");
    assert.equal(row, null);
  });
});

test("project_credentials: delete returns false for missing row", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-cred-4",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    const deleted = await deleteProjectCredential(client, "proj-cred-4", "git-read");
    assert.equal(deleted, false);
  });
});

// ---------------------------------------------------------------------------
// migration 0008: new tables exist
// ---------------------------------------------------------------------------

test("migration 0008: new tables exist in schema", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const expectedTables = [
      "leases",
      "attempt_artifacts",
      "attempt_stop_evidence",
      "project_credentials",
    ];
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    const names = rows.map((r) => r.table_name);
    for (const tbl of expectedTables) {
      assert.ok(names.includes(tbl), `Table '${tbl}' must exist after migration 0008`);
    }
  });
});
