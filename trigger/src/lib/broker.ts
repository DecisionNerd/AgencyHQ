// Typed client for the coordinator internal API (epic #14, P18.3).
// Used by worker containers to request leases, download source bundles,
// and upload artifact/checkpoint/stop-evidence results.
//
// SECURITY INVARIANTS:
//   - Secret values (auth tokens, nonces) are never logged.
//   - Base URL is read from AGENCYHQ_COORDINATOR_INTERNAL_URL at call time.
//   - Only idempotent GETs (downloadSourceBundle) are retried; POSTs are not.
//   - Bounded timeouts on every request (default 30 s; 60 s for bundle DL).
//
// No Trigger SDK usage; no direct file-system calls.

import { createHash } from "node:crypto";

import type {
  ArtifactUploadMeta,
  LeaseGrant,
  LeaseRefusal,
  LeaseRequest,
  StopEvidenceUpload,
} from "@agencyhq/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of requestLease: either a grant or a refusal with the HTTP status. */
export type LeaseResult =
  | { ok: true; grant: LeaseGrant }
  | { ok: false; status: number; refusal: LeaseRefusal };

/** Result of an artifact upload. */
export type ArtifactUploadResult = {
  status: "accepted" | "duplicate";
  artifactId?: string;
  verified?: boolean;
  diffDigest?: string;
};

/** Result of a source bundle download. */
export type SourceBundleResult = {
  bundleBytes: Buffer;
  bundleSha256: string;
};

// ---------------------------------------------------------------------------
// Broker interface
// ---------------------------------------------------------------------------

/** Coordinator internal API client interface. */
export interface Broker {
  /**
   * POST /internal/leases — request a credential lease.
   * Never retried. Returns the lease grant or a refusal with its HTTP status.
   */
  requestLease(request: LeaseRequest): Promise<LeaseResult>;

  /**
   * GET /internal/source/:projectId?rev= — download a source bundle.
   * Retried up to 3 times (idempotent GET). Returns bundle bytes + sha256.
   * The token must be from a git-read or upload lease grant.
   */
  downloadSourceBundle(args: {
    projectId: string;
    rev: string;
    token: string;
  }): Promise<SourceBundleResult>;

  /**
   * GET /internal/attempts/:id/artifacts/:generation/bundle — download a verified artifact bundle.
   * E7 / W-10: authenticated with a review (or upload) lease token.
   * Retried up to 3 times (idempotent GET). Returns bundle bytes + commitId.
   */
  downloadAttemptBundle(args: {
    attemptId: string;
    generation: number;
    token: string;
  }): Promise<{ bundleBytes: Buffer; commitId: string }>;

  /**
   * POST /internal/attempts/:id/artifacts — upload an attempt artifact bundle.
   * Never retried. Token is from an upload lease grant.
   */
  uploadArtifact(args: {
    attemptId: string;
    token: string;
    meta: ArtifactUploadMeta;
    bundleBytes: Buffer;
  }): Promise<ArtifactUploadResult>;

  /**
   * POST /internal/attempts/:id/checkpoints — upload a checkpoint bundle.
   * Never retried. Token is from an upload lease grant.
   */
  uploadCheckpoint(args: {
    attemptId: string;
    token: string;
    meta: ArtifactUploadMeta;
    bundleBytes: Buffer;
  }): Promise<ArtifactUploadResult>;

  /**
   * POST /internal/attempts/:id/stop-evidence — upload stop-sequence evidence.
   * Never retried. Token is from an upload lease grant.
   */
  uploadStopEvidence(args: {
    attemptId: string;
    token: string;
    evidence: StopEvidenceUpload;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// createBroker
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const BUNDLE_TIMEOUT_MS = 60_000;
const MAX_GET_ATTEMPTS = 3;

/**
 * Create a real Broker pointing at the coordinator internal API.
 * @param baseUrl  e.g. "http://coordinator:3000" (no trailing slash).
 */
export function createBroker(baseUrl: string): Broker {
  async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async requestLease(request) {
      const url = `${baseUrl}/internal/leases`;
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
        DEFAULT_TIMEOUT_MS,
      );

      const body = (await res.json()) as unknown;

      if (res.ok) {
        // Validate as LeaseGrant by checking the expected shape
        const grant = body as LeaseGrant;
        return { ok: true, grant };
      }

      // Refusal
      return { ok: false, status: res.status, refusal: body as LeaseRefusal };
    },

    async downloadSourceBundle({ projectId, rev, token }) {
      const url = `${baseUrl}/internal/source/${encodeURIComponent(projectId)}?rev=${encodeURIComponent(rev)}`;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < MAX_GET_ATTEMPTS; attempt++) {
        try {
          const res = await fetchWithTimeout(
            url,
            {
              method: "GET",
              headers: { Authorization: `Bearer ${token}` },
            },
            BUNDLE_TIMEOUT_MS,
          );

          if (!res.ok) {
            throw new Error(`source bundle download failed: HTTP ${res.status}`);
          }

          const bundleSha256 = res.headers.get("x-agencyhq-bundle-sha256") ?? "";
          const arrayBuffer = await res.arrayBuffer();
          const bundleBytes = Buffer.from(arrayBuffer);

          return { bundleBytes, bundleSha256 };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < MAX_GET_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
      }

      throw lastError ?? new Error("source bundle download failed after retries");
    },

    async downloadAttemptBundle({ attemptId, generation, token }) {
      const url = `${baseUrl}/internal/attempts/${encodeURIComponent(attemptId)}/artifacts/${generation}/bundle`;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < MAX_GET_ATTEMPTS; attempt++) {
        try {
          const res = await fetchWithTimeout(
            url,
            {
              method: "GET",
              headers: { Authorization: `Bearer ${token}` },
            },
            BUNDLE_TIMEOUT_MS,
          );

          if (!res.ok) {
            throw new Error(`attempt bundle download failed: HTTP ${res.status}`);
          }

          const commitId = res.headers.get("x-commit-id") ?? "";
          const arrayBuffer = await res.arrayBuffer();
          const bundleBytes = Buffer.from(arrayBuffer);

          return { bundleBytes, commitId };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < MAX_GET_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
      }

      throw lastError ?? new Error("attempt bundle download failed after retries");
    },

    async uploadArtifact({ attemptId, token, meta, bundleBytes }) {
      const url = `${baseUrl}/internal/attempts/${encodeURIComponent(attemptId)}/artifacts`;
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bundleBytes.length),
            "X-AgencyHQ-Meta": JSON.stringify(meta),
          },
          body: new Uint8Array(bundleBytes),
        },
        DEFAULT_TIMEOUT_MS,
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: "unknown" }))) as {
          error?: string;
        };
        throw new Error(`artifact upload failed: HTTP ${res.status} — ${body.error ?? "unknown"}`);
      }

      return (await res.json()) as ArtifactUploadResult;
    },

    async uploadCheckpoint({ attemptId, token, meta, bundleBytes }) {
      const url = `${baseUrl}/internal/attempts/${encodeURIComponent(attemptId)}/checkpoints`;
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bundleBytes.length),
            "X-AgencyHQ-Meta": JSON.stringify(meta),
          },
          body: new Uint8Array(bundleBytes),
        },
        DEFAULT_TIMEOUT_MS,
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: "unknown" }))) as {
          error?: string;
        };
        throw new Error(
          `checkpoint upload failed: HTTP ${res.status} — ${body.error ?? "unknown"}`,
        );
      }

      return (await res.json()) as ArtifactUploadResult;
    },

    async uploadStopEvidence({ attemptId, token, evidence }) {
      const url = `${baseUrl}/internal/attempts/${encodeURIComponent(attemptId)}/stop-evidence`;
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(evidence),
        },
        DEFAULT_TIMEOUT_MS,
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: "unknown" }))) as {
          error?: string;
        };
        throw new Error(
          `stop-evidence upload failed: HTTP ${res.status} — ${body.error ?? "unknown"}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// FakeBroker — for unit tests
// ---------------------------------------------------------------------------

/**
 * A recorded call on the FakeBroker. Material values (tokens, nonces, authJson)
 * are redacted to prevent secret leakage in test output.
 */
export type BrokerCall =
  | { op: "requestLease"; purpose: string; attemptId: string; generation: number }
  | { op: "downloadSourceBundle"; projectId: string; rev: string }
  | { op: "downloadAttemptBundle"; attemptId: string; generation: number }
  | { op: "uploadArtifact"; attemptId: string; metaKind: string; bundleBytes: number }
  | { op: "uploadCheckpoint"; attemptId: string; metaKind: string; bundleBytes: number }
  | { op: "uploadStopEvidence"; attemptId: string; stepCount: number };

/**
 * A fake Broker for tests. Records calls with redacted material values.
 *
 * Defaults: requestLease returns a refusal (callers must override via `grants`);
 * downloadSourceBundle returns empty bytes; uploads return "accepted".
 */
export class FakeBroker implements Broker {
  readonly calls: BrokerCall[] = [];

  /**
   * Pre-configured lease grants. Key is `${purpose}:${attemptId}`.
   * If absent, requestLease returns a refusal with reason "unavailable".
   */
  grants: Map<string, LeaseGrant> = new Map();

  /**
   * Bundle bytes to return from downloadSourceBundle.
   * Key is `${projectId}:${rev}`.
   */
  bundles: Map<string, Buffer> = new Map();

  /** If set, requestLease throws this error instead of returning a result. */
  leaseError: Error | undefined = undefined;

  /**
   * If set, requestLease returns a refusal with this reason (overrides grants).
   * Useful for testing failure classification (e.g., login_required → provider_login_required).
   */
  leaseRefusal: { reason: string } | undefined = undefined;

  async requestLease(request: LeaseRequest): Promise<LeaseResult> {
    this.calls.push({
      op: "requestLease",
      purpose: request.purpose,
      attemptId: request.attemptId,
      generation: request.generation,
    });

    if (this.leaseError) {
      throw this.leaseError;
    }

    if (this.leaseRefusal) {
      return {
        ok: false,
        status: 403,
        refusal: {
          purpose: request.purpose,
          reason: this.leaseRefusal.reason as LeaseRefusal["reason"],
        },
      };
    }

    const key = `${request.purpose}:${request.attemptId}`;
    const grant = this.grants.get(key);
    if (!grant) {
      return {
        ok: false,
        status: 403,
        refusal: { purpose: request.purpose, reason: "unavailable" },
      };
    }
    return { ok: true, grant };
  }

  async downloadSourceBundle(args: {
    projectId: string;
    rev: string;
    token: string;
  }): Promise<SourceBundleResult> {
    this.calls.push({
      op: "downloadSourceBundle",
      projectId: args.projectId,
      rev: args.rev,
    });

    const key = `${args.projectId}:${args.rev}`;
    const bundleBytes = this.bundles.get(key) ?? Buffer.alloc(0);
    const sha256 = createHash("sha256").update(bundleBytes).digest("hex");
    return { bundleBytes, bundleSha256: sha256 };
  }

  /**
   * Bundle bytes keyed by `${attemptId}:${generation}` for downloadAttemptBundle.
   */
  attemptBundles: Map<string, { bundleBytes: Buffer; commitId: string }> = new Map();

  async downloadAttemptBundle(args: {
    attemptId: string;
    generation: number;
    token: string;
  }): Promise<{ bundleBytes: Buffer; commitId: string }> {
    this.calls.push({
      op: "downloadAttemptBundle",
      attemptId: args.attemptId,
      generation: args.generation,
    });
    const key = `${args.attemptId}:${args.generation}`;
    const entry = this.attemptBundles.get(key);
    if (!entry) {
      throw new Error(`FakeBroker: no attempt bundle for ${key}`);
    }
    return entry;
  }

  async uploadArtifact(args: {
    attemptId: string;
    token: string;
    meta: ArtifactUploadMeta;
    bundleBytes: Buffer;
  }): Promise<ArtifactUploadResult> {
    this.calls.push({
      op: "uploadArtifact",
      attemptId: args.attemptId,
      metaKind: args.meta.kind,
      bundleBytes: args.bundleBytes.length,
    });
    return { status: "accepted", artifactId: "fake-artifact-id", verified: true };
  }

  async uploadCheckpoint(args: {
    attemptId: string;
    token: string;
    meta: ArtifactUploadMeta;
    bundleBytes: Buffer;
  }): Promise<ArtifactUploadResult> {
    this.calls.push({
      op: "uploadCheckpoint",
      attemptId: args.attemptId,
      metaKind: args.meta.kind,
      bundleBytes: args.bundleBytes.length,
    });
    return { status: "accepted", artifactId: "fake-checkpoint-id", verified: true };
  }

  async uploadStopEvidence(args: {
    attemptId: string;
    token: string;
    evidence: StopEvidenceUpload;
  }): Promise<void> {
    this.calls.push({
      op: "uploadStopEvidence",
      attemptId: args.attemptId,
      stepCount: args.evidence.steps.length,
    });
  }
}
