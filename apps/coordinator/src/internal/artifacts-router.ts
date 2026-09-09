/**
 * Internal artifact and source routes for the coordinator.
 *
 * Mounted at /internal by the coordinator app. These routes are consumed by
 * worker containers running in the portable execution model (source_mode = 'mirror').
 *
 * Routes:
 *   GET  /internal/source/:projectId?rev=<sha>     — bundle download
 *   POST /internal/attempts/:id/artifacts           — artifact upload (kind: attempt)
 *   POST /internal/attempts/:id/checkpoints         — artifact upload (kind: checkpoint)
 *   POST /internal/attempts/:id/stop-evidence       — stop-sequence evidence
 *
 * SECURITY INVARIANTS:
 *  - Secret values (bearer tokens) never appear in logs or error bodies.
 *  - Path traversal in changedPaths rejected with 422 PATH_UNSAFE.
 *  - Cross-project leases rejected with 403.
 *  - Stale generation rejected with 409.
 *  - Oversize bodies rejected with 413.
 *  - Tampered bundles rejected with 422.
 *  - All rejections: no DB state change.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";

import { ArtifactUploadMetaSchema, StopEvidenceUploadSchema } from "@agencyhq/contracts";
import {
  getAttempt,
  getProject,
  getStepContract,
  insertAttemptArtifact,
  upsertAttemptStopEvidence,
} from "@agencyhq/db";
import { validateArtifactAdmission, validateStopEvidenceAdmission } from "@agencyhq/domain";
import type { Context, Hono } from "hono";

import { exportBundle, importBundle } from "../git/bundle.ts";
import { diffDigest, hasCommit, mirrorPath } from "../git/mirror.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PgPoolClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release(): void;
};

type PgPool = {
  connect(): Promise<PgPoolClient>;
};

export interface ArtifactRouteDeps {
  pool: PgPool;
  /** Root directory for git mirrors; e.g. /var/agencyhq/git. */
  gitRoot: string;
  /** Maximum allowed bundle bytes (default 200 MiB). */
  maxBundleBytes: number;
  /** ISO clock. */
  clock: () => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex of a string (for bearer token → nonce_hash lookup).
 * SECURITY: Only used for lookup; the value itself is never logged.
 */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

interface LeaseRow {
  id: string;
  attempt_id: string;
  generation: number;
  purpose: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * Find an upload lease for the given attempt whose nonce_hash matches the
 * sha256 of the bearer token. Returns the first matching row or null.
 */
async function findUploadLease(
  client: PgPoolClient,
  attemptId: string,
  bearerToken: string,
): Promise<LeaseRow | null> {
  const nonceHash = sha256Hex(bearerToken);
  const result = await client.query(
    `SELECT id, attempt_id, generation, purpose, expires_at, revoked_at
       FROM leases
      WHERE attempt_id = $1
        AND purpose = 'upload'
        AND nonce_hash = $2
      ORDER BY issued_at DESC
      LIMIT 1`,
    [attemptId, nonceHash],
  );
  const first = (result.rows as LeaseRow[])[0];
  return first ?? null;
}

/**
 * Find a git-read or upload lease for a given project (via attempt).
 * Used for source download authorization.
 */
async function findSourceLease(
  client: PgPoolClient,
  projectId: string,
  bearerToken: string,
): Promise<boolean> {
  const nonceHash = sha256Hex(bearerToken);
  const result = await client.query(
    `SELECT l.id
       FROM leases l
       JOIN attempts a ON a.id = l.attempt_id
       JOIN step_contracts sc ON sc.id = a.contract_id
      WHERE l.nonce_hash = $1
        AND l.purpose IN ('git-read', 'upload')
        AND l.revoked_at IS NULL
        AND l.expires_at > now()
        AND sc.project_id = $2
      LIMIT 1`,
    [nonceHash, projectId],
  );
  return result.rows.length > 0;
}

/**
 * Parse the bearer token from an Authorization header.
 * Returns null if the header is missing or malformed.
 */
function parseBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// mountArtifactRoutes
// ---------------------------------------------------------------------------

/**
 * Mount internal artifact and source routes onto the given Hono app.
 *
 * P17.1 owns the lease-issuance routes on /internal; P18.2 adds source
 * download and artifact upload/stop-evidence routes here.
 */
export function mountArtifactRoutes(app: Hono, deps: ArtifactRouteDeps): void {
  const { pool, gitRoot, maxBundleBytes, clock } = deps;

  // --------------------------------------------------------------------------
  // GET /internal/source/:projectId — bundle download
  // --------------------------------------------------------------------------

  app.get("/internal/source/:projectId", async (c: Context) => {
    const projectId = c.req.param("projectId");
    const rev = c.req.query("rev");

    if (!projectId || !rev) {
      return c.json({ error: "projectId and rev are required" }, 400);
    }

    // Path traversal guard on projectId
    if (projectId.includes("/") || projectId.includes("..") || projectId.includes("\0")) {
      return c.json({ error: "PATH_UNSAFE: invalid projectId" }, 400);
    }

    // SHA format guard
    if (!/^[0-9a-f]{40}$/.test(rev)) {
      return c.json({ error: "rev must be a 40-hex git SHA" }, 400);
    }

    const authHeader = c.req.header("authorization");
    const token = parseBearerToken(authHeader);
    if (!token) {
      return c.json({ error: "Authorization: Bearer <token> required" }, 401);
    }

    const client = await pool.connect();
    try {
      const authorized = await findSourceLease(client, projectId, token);
      if (!authorized) {
        return c.json({ error: "Forbidden: no valid lease for this project" }, 403);
      }
    } finally {
      client.release();
    }

    const mp = mirrorPath(gitRoot, projectId);
    const mirror = { mirrorPath: mp, remote: "" };

    let bundlePath: string | undefined;
    try {
      const result = await exportBundle(mirror, rev, undefined, maxBundleBytes);
      bundlePath = result.bundlePath;
      const s = await stat(bundlePath);
      const rs = createReadStream(bundlePath);

      const stream = new ReadableStream({
        start(controller) {
          rs.on("data", (chunk: unknown) => {
            if (Buffer.isBuffer(chunk)) controller.enqueue(chunk);
          });
          rs.on("end", () => controller.close());
          rs.on("error", (err: Error) => controller.error(err));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/x-git-bundle",
          "Content-Length": String(s.size),
          "X-AgencyHQ-Bundle-Sha256": result.bundleSha256,
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "BUNDLE_TOO_LARGE") {
        return c.json({ error: "source bundle exceeds size limit" }, 413);
      }
      console.error("source bundle export failed:", (err as Error).message);
      return c.json({ error: "Failed to export source bundle" }, 500);
    } finally {
      if (bundlePath) {
        await unlink(bundlePath).catch(() => undefined);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Shared artifact upload logic
  // --------------------------------------------------------------------------

  async function handleArtifactUpload(
    c: Context,
    kind: "attempt" | "checkpoint",
  ): Promise<Response> {
    const attemptId = c.req.param("id");
    if (!attemptId) {
      return c.json({ error: "attemptId required" }, 400);
    }

    // Check body size first (Content-Length hint)
    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader) {
      const declaredBytes = parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(declaredBytes) && declaredBytes > maxBundleBytes) {
        return c.json({ error: "BUNDLE_TOO_LARGE: body exceeds size limit" }, 413);
      }
    }

    // Parse bearer token
    const authHeader = c.req.header("authorization");
    const token = parseBearerToken(authHeader);
    if (!token) {
      return c.json({ error: "Authorization: Bearer <token> required" }, 401);
    }

    // Parse X-AgencyHQ-Meta header
    const metaHeader = c.req.header("x-agencyhq-meta");
    if (!metaHeader) {
      return c.json({ error: "X-AgencyHQ-Meta header required" }, 400);
    }

    let metaParsed: unknown;
    try {
      metaParsed = JSON.parse(metaHeader);
    } catch {
      return c.json({ error: "X-AgencyHQ-Meta must be valid JSON" }, 400);
    }

    const metaResult = ArtifactUploadMetaSchema.safeParse(metaParsed);
    if (!metaResult.success) {
      return c.json({ error: "X-AgencyHQ-Meta invalid", issues: metaResult.error.issues }, 400);
    }
    const claimed = metaResult.data;

    // Enforce kind consistency
    if (claimed.kind !== kind) {
      return c.json(
        { error: `kind mismatch: route expects ${kind}, meta says ${claimed.kind}` },
        400,
      );
    }

    // Path traversal guard on attemptId
    if (attemptId.includes("/") || attemptId.includes("..") || attemptId.includes("\0")) {
      return c.json({ error: "PATH_UNSAFE: invalid attemptId" }, 400);
    }

    const client = await pool.connect();
    try {
      // Look up the upload lease (by nonce_hash match on the claimed attemptId)
      const leaseRow = await findUploadLease(client, claimed.attemptId, token);

      // Look up the attempt
      const attemptRow = await getAttempt(client as unknown as import("pg").PoolClient, attemptId);
      if (!attemptRow) {
        return c.json({ error: "attempt not found" }, 404);
      }

      // Look up step_contract to find project_id
      const contract = await getStepContract(
        client as unknown as import("pg").PoolClient,
        attemptRow.contract_id,
      );
      if (!contract) {
        return c.json({ error: "step contract not found" }, 500);
      }
      const projectId = contract.project_id;

      // Look up project
      const project = await getProject(client as unknown as import("pg").PoolClient, projectId);
      if (!project) {
        return c.json({ error: "project not found" }, 500);
      }

      const now = clock();

      // Set up mirror ref
      const mp = mirrorPath(gitRoot, projectId);
      const mirrorRef = { mirrorPath: mp, remote: project.remote ?? "" };

      // Check if commit is in mirror
      const commitInMirror = await hasCommit(mirrorRef, claimed.commitId);
      let recomputedDiffDigest: string | null = null;
      if (commitInMirror) {
        recomputedDiffDigest = await diffDigest(
          mirrorRef,
          contract.base_revision,
          claimed.commitId,
        );
      }

      // Validate via domain admission
      const admissionResult = validateArtifactAdmission({
        claimed,
        lease: leaseRow
          ? {
              purpose: leaseRow.purpose,
              attemptId: leaseRow.attempt_id,
              generation: leaseRow.generation,
              expiresAt: leaseRow.expires_at.toISOString(),
              revokedAt: leaseRow.revoked_at?.toISOString() ?? null,
            }
          : null,
        attempt: {
          id: attemptRow.id,
          projectId,
          currentGeneration: attemptRow.generation,
          status: attemptRow.status,
        },
        now,
        mirror: {
          hasCommit: () => commitInMirror,
          recomputedDiffDigest,
        },
        limits: { maxBundleBytes },
      });

      if (!admissionResult.ok) {
        const code = admissionResult.error;
        if (code === "STALE_GENERATION") {
          return c.json({ error: code }, 409);
        }
        if (
          code === "LEASE_MISSING" ||
          code === "LEASE_REVOKED" ||
          code === "LEASE_EXPIRED" ||
          code === "LEASE_PURPOSE_MISMATCH"
        ) {
          return c.json({ error: code }, 401);
        }
        if (code === "ATTEMPT_MISMATCH") {
          return c.json({ error: code }, 403);
        }
        if (code === "BUNDLE_TOO_LARGE") {
          return c.json({ error: code }, 413);
        }
        if (code === "PATH_UNSAFE") {
          return c.json({ error: code }, 422);
        }
        if (code === "COMMIT_NOT_IN_MIRROR" || code === "DIGEST_MISMATCH") {
          return c.json({ error: code }, 422);
        }
        return c.json({ error: code }, 400);
      }

      // Read body as buffer for bundle import
      const bodyBuffer = Buffer.from(await c.req.arrayBuffer());

      if (bodyBuffer.length > maxBundleBytes) {
        return c.json({ error: "BUNDLE_TOO_LARGE" }, 413);
      }

      // Import bundle into the mirror
      let importResult: Awaited<ReturnType<typeof importBundle>>;
      try {
        importResult = await importBundle(mirrorRef, bodyBuffer, {
          attemptId: claimed.attemptId,
          generation: claimed.generation,
          expectedHead: claimed.commitId,
          maxBundleBytes,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "BUNDLE_TOO_LARGE") {
          return c.json({ error: "BUNDLE_TOO_LARGE" }, 413);
        }
        if (code === "BUNDLE_PREREQ_MISSING" || code === "BUNDLE_SHA_MISMATCH") {
          return c.json({ error: "BUNDLE_TAMPERED" }, 422);
        }
        if (code === "BUNDLE_FETCH_FAILED") {
          return c.json({ error: "BUNDLE_FETCH_FAILED" }, 422);
        }
        console.error("bundle import failed:", (err as Error).message);
        return c.json({ error: "bundle import failed" }, 500);
      }

      // Recompute diff digest post-import (now the commit is in the mirror)
      const finalDiffDigest = await diffDigest(mirrorRef, contract.base_revision, claimed.commitId);

      // verified = bundle sha matches AND diff digest matches
      const verified =
        importResult.bundleSha256 === claimed.bundleSha256 &&
        finalDiffDigest === claimed.diffDigest;

      // Insert artifact row (idempotent: ON CONFLICT DO NOTHING)
      const insertResult = await insertAttemptArtifact(
        client as unknown as import("pg").PoolClient,
        {
          id: randomUUID(),
          attempt_id: claimed.attemptId,
          generation: claimed.generation,
          kind,
          commit_id: claimed.commitId,
          diff_digest: finalDiffDigest,
          changed_paths: claimed.changedPaths,
          quarantine_patch: claimed.quarantinePatch ?? null,
          bundle_sha256: importResult.bundleSha256,
          bundle_bytes: importResult.bundleBytes,
        },
      );

      if (insertResult.outcome === "duplicate") {
        return c.json({ status: "duplicate" }, 200);
      }

      // Mark as verified if all checks passed
      if (verified) {
        await client.query(`UPDATE attempt_artifacts SET verified = true WHERE id = $1`, [
          insertResult.row.id,
        ]);
      }

      return c.json(
        {
          status: "accepted",
          artifactId: insertResult.row.id,
          verified,
          diffDigest: finalDiffDigest,
        },
        201,
      );
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------------------------------
  // POST /internal/attempts/:id/artifacts
  // --------------------------------------------------------------------------

  app.post("/internal/attempts/:id/artifacts", (c: Context) => handleArtifactUpload(c, "attempt"));

  // --------------------------------------------------------------------------
  // POST /internal/attempts/:id/checkpoints
  // --------------------------------------------------------------------------

  app.post("/internal/attempts/:id/checkpoints", (c: Context) =>
    handleArtifactUpload(c, "checkpoint"),
  );

  // --------------------------------------------------------------------------
  // POST /internal/attempts/:id/stop-evidence
  // --------------------------------------------------------------------------

  app.post("/internal/attempts/:id/stop-evidence", async (c: Context) => {
    const attemptId = c.req.param("id");
    if (!attemptId) {
      return c.json({ error: "attemptId required" }, 400);
    }

    // Path traversal guard
    if (attemptId.includes("/") || attemptId.includes("..") || attemptId.includes("\0")) {
      return c.json({ error: "PATH_UNSAFE: invalid attemptId" }, 400);
    }

    const authHeader = c.req.header("authorization");
    const token = parseBearerToken(authHeader);
    if (!token) {
      return c.json({ error: "Authorization: Bearer <token> required" }, 401);
    }

    let bodyParsed: unknown;
    try {
      bodyParsed = await c.req.json();
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }

    const bodyResult = StopEvidenceUploadSchema.safeParse(bodyParsed);
    if (!bodyResult.success) {
      return c.json({ error: "stop-evidence body invalid", issues: bodyResult.error.issues }, 400);
    }
    const uploaded = bodyResult.data;

    const client = await pool.connect();
    try {
      // Look up upload lease
      const leaseRow = await findUploadLease(client, uploaded.attemptId, token);

      // Look up attempt
      const attemptRow = await getAttempt(client as unknown as import("pg").PoolClient, attemptId);
      if (!attemptRow) {
        return c.json({ error: "attempt not found" }, 404);
      }

      const now = clock();

      // Map steps for domain admission (handle exactOptionalPropertyTypes)
      const domainSteps = uploaded.steps.map((s) => {
        if (s.detail !== undefined) {
          return { at: s.at, step: s.step, detail: s.detail };
        }
        return { at: s.at, step: s.step };
      });

      // Validate via domain admission
      const admissionResult = validateStopEvidenceAdmission({
        attemptId: uploaded.attemptId,
        generation: uploaded.generation,
        steps: domainSteps,
        lease: leaseRow
          ? {
              purpose: leaseRow.purpose,
              attemptId: leaseRow.attempt_id,
              generation: leaseRow.generation,
              expiresAt: leaseRow.expires_at.toISOString(),
              revokedAt: leaseRow.revoked_at?.toISOString() ?? null,
            }
          : null,
        attempt: {
          id: attemptRow.id,
          currentGeneration: attemptRow.generation,
        },
        now,
      });

      if (!admissionResult.ok) {
        const code = admissionResult.error;
        if (code === "GENERATION_MISMATCH") {
          return c.json({ error: code }, 409);
        }
        if (
          code === "LEASE_MISSING" ||
          code === "LEASE_REVOKED" ||
          code === "LEASE_EXPIRED" ||
          code === "LEASE_PURPOSE_MISMATCH"
        ) {
          return c.json({ error: code }, 401);
        }
        if (code === "ATTEMPT_MISMATCH") {
          return c.json({ error: code }, 403);
        }
        return c.json({ error: code }, 400);
      }

      // Map steps to the repo type (handle exactOptionalPropertyTypes)
      const steps = uploaded.steps.map((s) => {
        const base = { at: s.at, step: s.step };
        if (s.detail !== undefined) {
          return { ...base, detail: s.detail };
        }
        return base;
      });

      // Upsert stop evidence
      await upsertAttemptStopEvidence(client as unknown as import("pg").PoolClient, {
        id: randomUUID(),
        attempt_id: uploaded.attemptId,
        generation: uploaded.generation,
        steps,
      });

      return c.json({ status: "accepted" }, 201);
    } finally {
      client.release();
    }
  });
}
