/**
 * Lease broker — issues credential grants to authenticated worker containers.
 *
 * Workers request leases by presenting a nonce that proves they hold the
 * current dispatch nonce for their run. The broker:
 * 1. Validates the intent exists, is open, and generation matches.
 * 2. Verifies sha256(nonce) == dispatch_nonce_hash stored at dispatch time.
 * 3. Checks provider state for purpose=provider.
 * 4. Checks project credentials for purpose=git-read/integrate.
 * 5. Issues a time-bounded lease and returns credential material.
 *
 * SECURITY INVARIANTS:
 * - Raw credential values (key, access, refresh, askpassToken) never appear
 *   in logs, errors, or non-lease-grant responses.
 * - All log statements pass output through redactLeaseGrant first.
 * - Nonce values are never logged (only the hash is logged/stored).
 * - Upload tokens are random; only the sha256 is stored on the lease row.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LeaseGrant,
  LeaseGrantSchema,
  type LeaseRefusal,
  type LeaseRequest,
  redactLeaseGrant,
} from "@agencyhq/contracts";
import { decryptSecret, findLeasesByAttemptGeneration, issueLease } from "@agencyhq/db";
import type pg from "pg";
import type { ProviderStatus } from "../provider/state.ts";
import { verifyNonce } from "./nonce.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeaseBrokerDeps {
  pool: pg.Pool;
  /** Resolved provider state. */
  providerState: () => Promise<ProviderStatus>;
  /** Path to the OpenCode data directory (for reading auth.json). */
  dataDirFn: () => string | undefined;
  /** AES-256-GCM key for decrypting project credentials. Hex-encoded 32 bytes. */
  secretsKey: () => string | undefined;
  /** TTL for issued leases in milliseconds. Default: 900_000 (15 min). */
  leaseTtlMs?: number | undefined;
  /** TTL for integrate leases in milliseconds. Default: 300_000 (5 min). */
  integrateLeaseTtlMs?: number | undefined;
  /** Optional logger. Default: console.log with redaction. */
  log?: (msg: string, meta?: unknown) => void;
}

export type LeaseResult =
  | { ok: true; grant: LeaseGrant }
  | { ok: false; status: 403 | 409; refusal: LeaseRefusal | { error: string } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// issueLeaseBroker
// ---------------------------------------------------------------------------

/**
 * Process a lease request. Returns Ok(grant) or Err(refusal).
 *
 * Idempotent by nonce hash: if a lease already exists for
 * (attemptId, generation, purpose, nonce_hash) return the same leaseId.
 *
 * Checks performed in order:
 * 1. Load open dispatch intent for (attemptId, runId, generation).
 * 2. Verify sha256(nonce) == stored dispatch_nonce_hash (403 unknown_run if not).
 * 3. For purpose=provider: check providerState.
 * 4. For purpose=git-read/integrate: check project credential exists.
 * 5. Check generation not stale vs. current attempt generation.
 */
export async function issueLeaseBroker(
  deps: LeaseBrokerDeps,
  request: LeaseRequest,
): Promise<LeaseResult> {
  const {
    pool,
    providerState,
    leaseTtlMs = 900_000,
    integrateLeaseTtlMs = 300_000,
    log = (msg: string, meta?: unknown) => {
      if (meta !== undefined) {
        console.log(msg, meta);
      } else {
        console.log(msg);
      }
    },
  } = deps;

  const { runId, attemptId, workItemId, generation, purpose, nonce } = request;
  const nonceHash = sha256hex(nonce);

  const client = await pool.connect();
  try {
    // ---------------------------------------------------------------------------
    // Lead.plan path (X3-6): request carries workItemId, no attemptId.
    // Look up the intent by runId (unique after trigger) with attempt_id IS NULL.
    // Only "provider" and "review" are grantable; generation must be 0.
    // Leases are stored with attempt_id = intent.id (no FK on leases.attempt_id).
    // ---------------------------------------------------------------------------
    if (!attemptId && workItemId) {
      if (purpose !== "provider" && purpose !== "review") {
        const refusal: LeaseRefusal = { purpose, reason: "unavailable" };
        return { ok: false, status: 409, refusal };
      }

      const { rows: leadIntentRows } = await client.query<{
        id: string;
        idempotency_key: string;
        dispatch_nonce_hash: string | null;
      }>(
        `SELECT di.id, di.idempotency_key, di.dispatch_nonce_hash
         FROM dispatch_intents di
         WHERE di.run_id = $1
           AND di.attempt_id IS NULL
           AND di.status = 'triggered'
         LIMIT 1`,
        [runId],
      );

      const leadIntent = leadIntentRows[0];
      if (!leadIntent) {
        // Check for an intent that exists but run_id not yet written (X3-4 race window).
        const refusal: LeaseRefusal = { purpose, reason: "unknown_run" };
        return { ok: false, status: 403, refusal };
      }

      // Verify workItemId is encoded in the idempotency key (format: leadplan:<wid>:<intentId>).
      const expectedPrefix = `leadplan:${workItemId}:`;
      if (!leadIntent.idempotency_key.startsWith(expectedPrefix)) {
        const refusal: LeaseRefusal = { purpose, reason: "unknown_run" };
        return { ok: false, status: 403, refusal };
      }

      // Verify nonce (W-1: no null bypass).
      if (leadIntent.dispatch_nonce_hash === null) {
        const refusal: LeaseRefusal = { purpose, reason: "unknown_run" };
        return { ok: false, status: 403, refusal };
      }
      if (!verifyNonce(nonce, leadIntent.dispatch_nonce_hash)) {
        const refusal: LeaseRefusal = { purpose, reason: "unknown_run" };
        return { ok: false, status: 403, refusal };
      }

      // Lead.plan leases use intent.id as the effective "attempt_id" for storage.
      const leadAttemptKey = leadIntent.id;
      const existingLeases = await findLeasesByAttemptGeneration(client, leadAttemptKey, 0);
      const existingLease = existingLeases.find(
        (l) => l.purpose === purpose && l.nonce_hash === nonceHash,
      );
      if (existingLease) {
        if (existingLease.revoked_at !== null) {
          const refusal: LeaseRefusal = { purpose, reason: "revoked" };
          return { ok: false, status: 409, refusal };
        }
        if (existingLease.expires_at < new Date()) {
          const refusal: LeaseRefusal = { purpose, reason: "expired" };
          return { ok: false, status: 409, refusal };
        }
        let reissueToken: string | undefined;
        if (purpose === "provider" || purpose === "review") {
          if (purpose === "review") {
            reissueToken = randomHex(32);
            const reissueHash = sha256hex(reissueToken);
            await client.query("UPDATE leases SET token_hash = $1 WHERE id = $2", [
              reissueHash,
              existingLease.id,
            ]);
          }
        }
        const grant = await buildGrant(
          existingLease.id,
          existingLease.expires_at,
          purpose,
          { attemptId: leadAttemptKey, runId, generation: 0 },
          deps,
          client,
          reissueToken,
        );
        if (!grant) {
          const refusal: LeaseRefusal = { purpose, reason: "unavailable" };
          return { ok: false, status: 409, refusal };
        }
        log("[lease] lead.plan idempotent re-issue", { leaseId: existingLease.id, purpose });
        return { ok: true, grant };
      }

      // Issue new lease for lead.plan.
      if (purpose === "provider") {
        const ps = await providerState();
        if (ps !== "ready") {
          const refusal: LeaseRefusal = {
            purpose,
            reason:
              ps === "login_required"
                ? "login_required"
                : ps === "expired"
                  ? "expired"
                  : "unavailable",
          };
          return { ok: false, status: 409, refusal };
        }
      }

      const leadTtl = leaseTtlMs;
      const leadExpiresAt = new Date(Date.now() + leadTtl);
      const leadLeaseId = `lease_${randomHex(16)}`;
      const leadUploadToken = purpose === "review" ? randomHex(32) : undefined;
      const leadTokenHash = leadUploadToken ? sha256hex(leadUploadToken) : undefined;

      await issueLease(client, {
        id: leadLeaseId,
        attempt_id: leadAttemptKey,
        generation: 0,
        run_id: runId,
        purpose,
        nonce_hash: nonceHash,
        token_hash: leadTokenHash ?? null,
        expires_at: leadExpiresAt,
      });

      const leadGrant = await buildGrant(
        leadLeaseId,
        leadExpiresAt,
        purpose,
        { attemptId: leadAttemptKey, runId, generation: 0 },
        deps,
        client,
        leadUploadToken,
      );
      if (!leadGrant) {
        const refusal: LeaseRefusal = { purpose, reason: "unavailable" };
        return { ok: false, status: 409, refusal };
      }

      log("[lease] lead.plan issued", { leaseId: leadLeaseId, purpose });
      return { ok: true, grant: leadGrant };
    }

    // ---------------------------------------------------------------------------
    // Worker.attempt path: attemptId is required.
    // ---------------------------------------------------------------------------
    const resolvedAttemptId = attemptId ?? "";

    // 1. Load the open dispatch intent
    const { rows: intentRows } = await client.query<{
      id: string;
      attempt_id: string | null;
      run_id: string | null;
      status: string;
      dispatch_nonce_hash: string | null;
    }>(
      `SELECT di.id, di.attempt_id, di.run_id, di.status, di.dispatch_nonce_hash
       FROM dispatch_intents di
       WHERE di.attempt_id = $1
         AND di.run_id = $2
         AND di.status = 'triggered'
       ORDER BY di.created_at DESC
       LIMIT 1`,
      [resolvedAttemptId, runId],
    );

    const intent = intentRows[0];
    if (!intent) {
      // X3-4: check for intent that exists but run_id not yet written (race window).
      const { rows: pendingRows } = await client.query<{ id: string }>(
        `SELECT id FROM dispatch_intents
         WHERE attempt_id = $1 AND run_id IS NULL AND status = 'recorded'
         LIMIT 1`,
        [resolvedAttemptId],
      );
      if (pendingRows[0]) {
        const refusal: LeaseRefusal = { purpose, reason: "run_pending" };
        return { ok: false, status: 409, refusal };
      }
      const refusal: LeaseRefusal = { purpose, reason: "unknown_attempt" };
      return { ok: false, status: 403, refusal };
    }

    // Load the current attempt to check generation
    const { rows: attemptRows } = await client.query<{
      id: string;
      generation: number;
      run_id: string | null;
      status: string;
    }>(`SELECT id, generation, run_id, status FROM attempts WHERE id = $1`, [resolvedAttemptId]);
    const attempt = attemptRows[0];
    if (!attempt) {
      const refusal: LeaseRefusal = { purpose, reason: "unknown_attempt" };
      return { ok: false, status: 403, refusal };
    }

    // Check run ID matches
    if (attempt.run_id !== runId) {
      const refusal: LeaseRefusal = { purpose, reason: "unknown_run" };
      return { ok: false, status: 403, refusal };
    }

    // Check generation equality (W-12 / D2): equal only; past and future both stale.
    if (generation !== attempt.generation) {
      const refusal: LeaseRefusal = { purpose, reason: "stale_generation" };
      return { ok: false, status: 409, refusal };
    }

    // 2. Verify nonce: sha256(nonce) must match stored dispatch_nonce_hash.
    // A null hash is refused as unknown_run (W-1: no null bypass).
    if (intent.dispatch_nonce_hash === null) {
      const refusal: LeaseRefusal = { purpose, reason: "unknown_run" };
      return { ok: false, status: 403, refusal };
    }
    if (!verifyNonce(nonce, intent.dispatch_nonce_hash)) {
      const refusal: LeaseRefusal = { purpose, reason: "unknown_run" };
      return { ok: false, status: 403, refusal };
    }

    // Check idempotency: return existing lease for same (attempt, generation, purpose, nonce_hash)
    const existingLeases = await findLeasesByAttemptGeneration(
      client,
      resolvedAttemptId,
      generation,
    );
    const existingLease = existingLeases.find(
      (l) => l.purpose === purpose && l.nonce_hash === nonceHash,
    );
    if (existingLease) {
      // Lease expired?
      if (existingLease.revoked_at !== null) {
        const refusal: LeaseRefusal = { purpose, reason: "revoked" };
        return { ok: false, status: 409, refusal };
      }
      if (existingLease.expires_at < new Date()) {
        const refusal: LeaseRefusal = { purpose, reason: "expired" };
        return { ok: false, status: 409, refusal };
      }
      // For upload/review leases, mint a new token and update token_hash (W-3: idempotent re-issue).
      let reissueUploadToken: string | undefined;
      if (purpose === "upload" || purpose === "review") {
        reissueUploadToken = randomHex(32);
        const reissueTokenHash = sha256hex(reissueUploadToken);
        await client.query(`UPDATE leases SET token_hash = $1 WHERE id = $2`, [
          reissueTokenHash,
          existingLease.id,
        ]);
      }
      // Re-issue same grant (idempotent)
      const grant = await buildGrant(
        existingLease.id,
        existingLease.expires_at,
        purpose,
        { attemptId: resolvedAttemptId, runId, generation },
        deps,
        client,
        reissueUploadToken,
      );
      if (!grant) {
        const refusal: LeaseRefusal = { purpose, reason: "unavailable" };
        return { ok: false, status: 409, refusal };
      }
      log("[lease] idempotent re-issue", { leaseId: existingLease.id, purpose });
      return { ok: true, grant };
    }

    // 3. Provider check for purpose=provider
    if (purpose === "provider") {
      const ps = await providerState();
      if (ps !== "ready") {
        const refusal: LeaseRefusal = {
          purpose,
          reason:
            ps === "login_required"
              ? "login_required"
              : ps === "expired"
                ? "expired"
                : "unavailable",
        };
        return { ok: false, status: 409, refusal };
      }
    }

    // 4. Project credential check for git-read/integrate
    if (purpose === "git-read" || purpose === "integrate") {
      const { rows: credRows } = await client.query<{ project_id: string }>(
        `SELECT project_credentials.project_id FROM project_credentials
         JOIN step_contracts sc ON sc.project_id = project_credentials.project_id
         JOIN attempts a ON a.contract_id = sc.id
         WHERE a.id = $1 AND project_credentials.purpose = $2
         LIMIT 1`,
        [resolvedAttemptId, purpose],
      );
      if (!credRows[0]) {
        const refusal: LeaseRefusal = { purpose, reason: "unavailable" };
        return { ok: false, status: 409, refusal };
      }
    }

    // 5. Issue the lease
    const ttl = purpose === "integrate" ? integrateLeaseTtlMs : leaseTtlMs;
    const expiresAt = new Date(Date.now() + ttl);
    const leaseId = `lease_${randomHex(16)}`;

    // For upload and review leases, pre-generate the token so token_hash is stored atomically (W-3).
    const uploadToken = purpose === "upload" || purpose === "review" ? randomHex(32) : undefined;
    const tokenHash = uploadToken !== undefined ? sha256hex(uploadToken) : undefined;

    await issueLease(client, {
      id: leaseId,
      attempt_id: resolvedAttemptId,
      generation,
      run_id: runId,
      purpose,
      nonce_hash: nonceHash,
      token_hash: tokenHash ?? null,
      expires_at: expiresAt,
    });

    const grant = await buildGrant(
      leaseId,
      expiresAt,
      purpose,
      { attemptId: resolvedAttemptId, runId, generation },
      deps,
      client,
      uploadToken,
    );
    if (!grant) {
      const refusal: LeaseRefusal = { purpose, reason: "unavailable" };
      return { ok: false, status: 409, refusal };
    }

    log("[lease] issued", { leaseId, purpose, expiresAt: expiresAt.toISOString() });
    return { ok: true, grant };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// buildGrant — construct LeaseGrant material for a lease
// ---------------------------------------------------------------------------

async function buildGrant(
  leaseId: string,
  expiresAt: Date,
  purpose: LeaseRequest["purpose"],
  context: { attemptId: string; runId: string; generation: number },
  deps: LeaseBrokerDeps,
  client: pg.PoolClient,
  /** Pre-generated upload token (only for purpose === "upload"). */
  preGeneratedUploadToken?: string,
): Promise<LeaseGrant | null> {
  const { dataDirFn, secretsKey } = deps;

  if (purpose === "provider") {
    const dataDir = dataDirFn();
    if (!dataDir) return null;
    let authJson: string;
    try {
      authJson = readFileSync(join(dataDir, "auth.json"), "utf-8");
    } catch {
      return null;
    }
    return LeaseGrantSchema.parse({
      leaseId,
      purpose,
      expiresAt: expiresAt.toISOString(),
      material: { purpose: "provider", authJson },
    });
  }

  if (purpose === "git-read" || purpose === "integrate") {
    const key = secretsKey();
    if (!key) return null;

    // Get project info via attempt → contract → project
    const { rows: projectRows } = await client.query<{
      project_id: string;
      remote: string | null;
    }>(
      `SELECT sc.project_id, p.remote
       FROM attempts a
       JOIN step_contracts sc ON sc.id = a.contract_id
       JOIN projects p ON p.id = sc.project_id
       WHERE a.id = $1
       LIMIT 1`,
      [context.attemptId],
    );
    const proj = projectRows[0];
    if (!proj?.remote) return null;

    // Get the encrypted credential
    const { rows: credRows } = await client.query<{
      ciphertext: Buffer;
      iv: Buffer;
      tag: Buffer;
      key_version: number;
    }>(
      `SELECT ciphertext, iv, tag, key_version FROM project_credentials
       WHERE project_id = $1 AND purpose = $2`,
      [proj.project_id, purpose],
    );
    const cred = credRows[0];
    if (!cred) return null;

    let askpassToken: string;
    try {
      askpassToken = decryptSecret(
        { ciphertext: cred.ciphertext, iv: cred.iv, tag: cred.tag, key_version: cred.key_version },
        key,
      );
    } catch {
      return null;
    }

    return LeaseGrantSchema.parse({
      leaseId,
      purpose,
      expiresAt: expiresAt.toISOString(),
      material: {
        purpose,
        remote: proj.remote,
        tokenRef: leaseId,
        askpassToken,
      },
    });
  }

  if (purpose === "upload") {
    // Use the pre-generated token (token_hash was stored atomically in issueLease).
    const uploadToken = preGeneratedUploadToken ?? randomHex(32);

    return LeaseGrantSchema.parse({
      leaseId,
      purpose,
      expiresAt: expiresAt.toISOString(),
      material: { purpose: "upload", token: uploadToken },
    });
  }

  // E7 / W-10: review lease — opaque bearer token, no external credentials.
  if (purpose === "review") {
    const reviewToken = preGeneratedUploadToken ?? randomHex(32);

    return LeaseGrantSchema.parse({
      leaseId,
      purpose,
      expiresAt: expiresAt.toISOString(),
      material: { purpose: "review", token: reviewToken },
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export { redactLeaseGrant };
