/**
 * Internal artifact and source routes for the coordinator.
 *
 * Mounted at /internal by the coordinator app. These routes are consumed by
 * worker containers running in the portable execution model (source_mode = 'mirror').
 *
 * Routes:
 *   GET  /internal/source/:projectId?rev=<sha>                    — bundle download
 *   GET  /internal/attempts/:id/artifacts/:generation/bundle      — artifact bundle (D7)
 *   POST /internal/attempts/:id/artifacts                         — artifact upload (kind: attempt)
 *   POST /internal/attempts/:id/checkpoints                       — artifact upload (kind: checkpoint)
 *   POST /internal/attempts/:id/stop-evidence                     — stop-sequence evidence
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

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { ArtifactUploadMetaSchema, StopEvidenceUploadSchema } from "@agencyhq/contracts";
import {
  findUploadLeaseByTokenHash,
  getAttempt,
  getProject,
  getStepContract,
  insertAttemptArtifact,
  upsertAttemptStopEvidence,
} from "@agencyhq/db";
import { validateArtifactAdmission, validateStopEvidenceAdmission } from "@agencyhq/domain";
import type { Context, Hono } from "hono";
import { exportBundle, importBundle } from "../git/bundle.ts";
import { diffDigest, mirrorPath } from "../git/mirror.ts";

const execFileAsync = promisify(execFile);

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
 * Compute SHA-256 hex of a string (for bearer token → token_hash lookup).
 * SECURITY: Only used for lookup; the value itself is never logged.
 */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Delete a git ref from the mirror (best-effort). Used to clean up fetched
 * refs on post-import validation failure (D3: no state advance on failure).
 */
async function deleteRef(mirrorPath: string, ref: string): Promise<void> {
  await execFileAsync("git", ["update-ref", "-d", ref], {
    cwd: mirrorPath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
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
 * Find an upload lease for the given attempt whose token_hash matches the
 * sha256 of the bearer token (W-3: upload leases use token_hash, not nonce_hash).
 * Returns the first matching row or null.
 */
async function findUploadLease(
  client: PgPoolClient,
  attemptId: string,
  bearerToken: string,
): Promise<LeaseRow | null> {
  const tokenHash = sha256Hex(bearerToken);
  return findUploadLeaseByTokenHash(
    client as unknown as import("pg").PoolClient,
    attemptId,
    tokenHash,
  );
}

/**
 * Find a valid upload or review lease for a given project (via attempt) by token_hash.
 * Upload/review leases use token_hash; the bearer token is sha256'd to look up the lease.
 * Used for source download authorization.
 */
async function findSourceLease(
  client: PgPoolClient,
  projectId: string,
  bearerToken: string,
): Promise<boolean> {
  const tokenHash = sha256Hex(bearerToken);
  const result = await client.query(
    `SELECT l.id
       FROM leases l
       JOIN attempts a ON a.id = l.attempt_id
       JOIN step_contracts sc ON sc.id = a.contract_id
      WHERE l.token_hash = $1
        AND l.purpose IN ('upload', 'review')
        AND l.revoked_at IS NULL
        AND l.expires_at > now()
        AND sc.project_id = $2
      LIMIT 1`,
    [tokenHash, projectId],
  );
  return result.rows.length > 0;
}

/**
 * Find a valid review lease for a given attempt by token_hash.
 * E7 / W-10: review leases authenticate artifact bundle download.
 */
async function findReviewLease(
  client: PgPoolClient,
  attemptId: string,
  bearerToken: string,
): Promise<boolean> {
  const tokenHash = sha256Hex(bearerToken);
  const result = await client.query(
    `SELECT id FROM leases
      WHERE token_hash = $1
        AND attempt_id = $2
        AND purpose = 'review'
        AND revoked_at IS NULL
        AND expires_at > now()
      LIMIT 1`,
    [tokenHash, attemptId],
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
      // Read into memory so we can delete the temp file before the response is returned.
      // The caller cannot stream the file safely: the finally block runs when the Response
      // is constructed (not when the body is consumed), so the file would be unlinked while
      // still being read. Bundles are already size-limited by maxBundleBytes.
      const fileBuffer = await readFile(bundlePath);
      await unlink(bundlePath).catch(() => undefined);
      bundlePath = undefined; // prevent double-delete in finally

      return new Response(fileBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/x-git-bundle",
          "Content-Length": String(fileBuffer.length),
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
  // GET /internal/attempts/:id/artifacts/:generation/bundle — D7
  // Serves the verified artifact bundle for (attemptId, generation).
  // Authenticated with an upload-purpose lease (same as upload routes).
  // --------------------------------------------------------------------------

  app.get("/internal/attempts/:id/artifacts/:generation/bundle", async (c: Context) => {
    const attemptId = c.req.param("id");
    const generationStr = c.req.param("generation");

    if (!attemptId || !generationStr) {
      return c.json({ error: "attemptId and generation required" }, 400);
    }

    const generation = parseInt(generationStr, 10);
    if (!Number.isInteger(generation) || generation < 1) {
      return c.json({ error: "generation must be a positive integer" }, 400);
    }

    const authHeader = c.req.header("authorization");
    const token = parseBearerToken(authHeader);
    if (!token) {
      return c.json({ error: "Authorization: Bearer <token> required" }, 401);
    }

    const client = await pool.connect();
    let bundlePath: string | undefined;
    try {
      // Authenticate: upload or review-purpose lease for this attempt (E7 / W-10).
      const leaseRow = await findUploadLease(client, attemptId, token);
      const reviewAuthorized = leaseRow ? true : await findReviewLease(client, attemptId, token);
      if (!reviewAuthorized) {
        return c.json(
          { error: "Forbidden: no valid upload or review lease for this attempt" },
          403,
        );
      }

      // Look up the verified artifact for this (attemptId, generation).
      const { rows: artRows } = await client.query(
        `SELECT aa.commit_id, c.project_id
           FROM attempt_artifacts aa
           JOIN attempts a ON a.id = aa.attempt_id
           JOIN step_contracts c ON c.id = a.contract_id
          WHERE aa.attempt_id = $1
            AND aa.generation = $2
            AND aa.verified = true
            AND aa.kind = 'attempt'
          ORDER BY aa.received_at DESC
          LIMIT 1`,
        [attemptId, generation],
      );
      const artRow = artRows[0] as { commit_id?: string; project_id?: string | null } | undefined;
      if (!artRow) {
        return c.json({ error: "No verified artifact for this attempt/generation" }, 404);
      }

      const commitId = typeof artRow.commit_id === "string" ? artRow.commit_id : undefined;
      const projectId = typeof artRow.project_id === "string" ? artRow.project_id : undefined;
      if (!projectId || !commitId) {
        return c.json({ error: "Artifact missing project or commit" }, 500);
      }

      const mp = mirrorPath(gitRoot, projectId);
      const mirror = { mirrorPath: mp, remote: "" };

      const result = await exportBundle(mirror, commitId, undefined, maxBundleBytes);
      bundlePath = result.bundlePath;
      // Read into memory before returning: the finally block runs when the Response
      // is constructed, which would unlink the temp file before the body is consumed.
      const fileBuffer = await readFile(bundlePath);
      await unlink(bundlePath).catch(() => undefined);
      bundlePath = undefined; // prevent double-delete in finally

      return new Response(fileBuffer, {
        status: 200,
        headers: {
          "content-type": "application/x-git-bundle",
          "content-length": String(fileBuffer.length),
          "cache-control": "no-store",
          "x-commit-id": commitId,
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "BUNDLE_TOO_LARGE") {
        return c.json({ error: "artifact bundle exceeds size limit" }, 413);
      }
      console.error("artifact bundle export failed:", (err as Error).message);
      return c.json({ error: "Failed to export artifact bundle" }, 500);
    } finally {
      client.release();
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
      // 1. Look up the upload lease by token_hash (W-3)
      const leaseRow = await findUploadLease(client, claimed.attemptId, token);

      // 2. Look up the attempt
      const attemptRow = await getAttempt(client as unknown as import("pg").PoolClient, attemptId);
      if (!attemptRow) {
        return c.json({ error: "attempt not found" }, 404);
      }

      // 3. Look up step_contract to find project_id
      const contract = await getStepContract(
        client as unknown as import("pg").PoolClient,
        attemptRow.contract_id,
      );
      if (!contract) {
        return c.json({ error: "step contract not found" }, 500);
      }
      const projectId = contract.project_id;

      // 4. Look up project
      const project = await getProject(client as unknown as import("pg").PoolClient, projectId);
      if (!project) {
        return c.json({ error: "project not found" }, 500);
      }

      const now = clock();
      const mp = mirrorPath(gitRoot, projectId);
      const mirrorRef = { mirrorPath: mp, remote: project.remote ?? "" };

      // 5. Pre-import admission validation (D3 order: lease → generation → project → bundle size → paths).
      // hasCommit is false at this stage; the commit enters the mirror via importBundle below.
      const preAdmission = validateArtifactAdmission({
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
          // Before import, treat commit as absent; the mirror check is deferred to post-import.
          hasCommit: () => false,
          recomputedDiffDigest: null,
        },
        limits: { maxBundleBytes },
      });

      if (!preAdmission.ok) {
        const code = preAdmission.error;
        // COMMIT_NOT_IN_MIRROR and DIGEST_MISMATCH are expected pre-import and handled below.
        if (code !== "COMMIT_NOT_IN_MIRROR" && code !== "DIGEST_MISMATCH") {
          if (
            code === "STALE_GENERATION" ||
            code === "FUTURE_GENERATION" ||
            code === "LEASE_GENERATION_MISMATCH"
          )
            return c.json({ error: code }, 409);
          if (
            code === "LEASE_MISSING" ||
            code === "LEASE_REVOKED" ||
            code === "LEASE_EXPIRED" ||
            code === "LEASE_PURPOSE_MISMATCH"
          )
            return c.json({ error: code }, 401);
          if (code === "ATTEMPT_MISMATCH") return c.json({ error: code }, 403);
          if (code === "BUNDLE_TOO_LARGE") return c.json({ error: code }, 413);
          if (code === "PATH_UNSAFE") return c.json({ error: code }, 422);
          return c.json({ error: code }, 400);
        }
      }

      // 6. Read body as buffer
      const bodyBuffer = Buffer.from(await c.req.arrayBuffer());
      if (bodyBuffer.length > maxBundleBytes) {
        return c.json({ error: "BUNDLE_TOO_LARGE" }, 413);
      }

      // 7. Import bundle into the mirror (D3 order: git bundle verify → fetch → rev-parse).
      let importResult: Awaited<ReturnType<typeof importBundle>>;
      try {
        importResult = await importBundle(mirrorRef, bodyBuffer, {
          attemptId: claimed.attemptId,
          generation: claimed.generation,
          kind,
          expectedHead: claimed.commitId,
          maxBundleBytes,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "BUNDLE_TOO_LARGE") return c.json({ error: "BUNDLE_TOO_LARGE" }, 413);
        if (code === "BUNDLE_PREREQ_MISSING" || code === "BUNDLE_SHA_MISMATCH") {
          return c.json({ error: "BUNDLE_TAMPERED" }, 422);
        }
        if (code === "BUNDLE_FETCH_FAILED") return c.json({ error: "BUNDLE_FETCH_FAILED" }, 422);
        console.error("bundle import failed:", (err as Error).message);
        return c.json({ error: "bundle import failed" }, 500);
      }

      // Idempotency check: if we get a duplicate row, return 200
      // (duplicate detection is based on unique constraint, checked before any DB write)
      const { rows: existingRows } = await (client as unknown as import("pg").PoolClient).query<{
        id: string;
      }>(
        `SELECT id FROM attempt_artifacts WHERE attempt_id = $1 AND generation = $2 AND kind = $3 AND commit_id = $4`,
        [claimed.attemptId, claimed.generation, kind, claimed.commitId],
      );
      if (existingRows[0]) {
        return c.json({ status: "duplicate" }, 200);
      }

      // 8. Post-import: recompute diff digest (commit is now in the mirror).
      const finalDiffDigest = await diffDigest(mirrorRef, contract.base_revision, claimed.commitId);

      // 9. Post-import admission: verify digest matches and bundle sha matches.
      // X2-8: ref name includes kind so attempt and checkpoint refs are distinct.
      const admissionTargetRef = `refs/agencyhq/attempts/${claimed.attemptId}/g${claimed.generation}/${kind}`;
      if (importResult.bundleSha256 !== claimed.bundleSha256) {
        // Delete the fetched ref on failure (D3: no state advance on failure)
        await deleteRef(mirrorRef.mirrorPath, admissionTargetRef).catch(() => undefined);
        return c.json({ error: "BUNDLE_TAMPERED" }, 422);
      }

      if (finalDiffDigest !== claimed.diffDigest) {
        await deleteRef(mirrorRef.mirrorPath, admissionTargetRef).catch(() => undefined);
        return c.json({ error: "DIGEST_MISMATCH" }, 422);
      }

      // 10. Insert artifact row as verified=true (D3: only fully verified rows).
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
          verified: true,
        },
      );

      if (insertResult.outcome === "duplicate") {
        return c.json({ status: "duplicate" }, 200);
      }

      return c.json(
        {
          status: "accepted",
          artifactId: insertResult.row.id,
          verified: true,
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
        const base: { at: string; step: (typeof s)["step"]; detail?: string } = {
          at: s.at,
          step: s.step,
        };
        if (s.detail !== undefined) base.detail = s.detail;
        return base;
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

      // Map steps to the repo type — preserve all optional fields (X3-2 / E4).
      const steps = uploaded.steps.map((s) => {
        const base: import("@agencyhq/db").StopEvidenceStep = { at: s.at, step: s.step };
        if (s.detail !== undefined) base.detail = s.detail;
        if (s.survivors !== undefined) base.survivors = s.survivors;
        if (s.checkpointCommit !== undefined) base.checkpointCommit = s.checkpointCommit;
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
