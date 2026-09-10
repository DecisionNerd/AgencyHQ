/**
 * Lease schemas for credential delegation to worker containers.
 *
 * The coordinator issues time-bounded leases granting workers access to
 * external resources (provider auth, git remotes, upload tokens). Workers
 * request leases by proving they hold the current generation nonce.
 *
 * SECURITY: Secret values (authJson, tokens, askpassToken) must never appear
 * in logs, errors, JSON summaries, or test snapshots. Use redactLeaseGrant
 * before logging or passing to telemetry.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// LeasePurpose
// ---------------------------------------------------------------------------

// E7 / W-10: "review" purpose — grants an opaque bearer token (like upload) for
// downloading attempt bundles; carries no external credentials.
export const LeasePurposeSchema = z.enum(["provider", "git-read", "integrate", "upload", "review"]);
export type LeasePurpose = z.infer<typeof LeasePurposeSchema>;

// ---------------------------------------------------------------------------
// LeaseRequest
// ---------------------------------------------------------------------------

export const LeaseRequestSchema = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  generation: z.number().int().min(0),
  purpose: LeasePurposeSchema,
  /** Random nonce proving the worker knows the current generation. Min 32 chars. */
  nonce: z.string().min(32),
});
export type LeaseRequest = z.infer<typeof LeaseRequestSchema>;

// ---------------------------------------------------------------------------
// LeaseGrant material (discriminated by purpose)
// ---------------------------------------------------------------------------

/**
 * Validates an HTTPS URL that contains no userinfo (credentials) in the
 * authority component.
 */
const HttpsUrlNoUserInfoSchema = z
  .string()
  .url()
  .refine(
    (s) => {
      try {
        const u = new URL(s);
        // username or password present → reject
        return !u.username && !u.password;
      } catch {
        return false;
      }
    },
    { message: "remote must be an https URL without userinfo" },
  );

const LeaseMaterialSchema = z.discriminatedUnion("purpose", [
  z.object({
    purpose: z.literal("provider"),
    /** Serialized provider auth JSON. Treat as secret. */
    authJson: z.string(),
  }),
  z.object({
    purpose: z.literal("git-read"),
    /** HTTPS remote URL (no credentials embedded). */
    remote: HttpsUrlNoUserInfoSchema,
    /** Reference name for the token (not the token value itself). */
    tokenRef: z.string(),
    /** Short-lived askpass token for git credential helper. Treat as secret. */
    askpassToken: z.string(),
  }),
  z.object({
    purpose: z.literal("integrate"),
    /** HTTPS remote URL (no credentials embedded). */
    remote: HttpsUrlNoUserInfoSchema,
    /** Reference name for the token. */
    tokenRef: z.string(),
    /** Short-lived askpass token for git credential helper. Treat as secret. */
    askpassToken: z.string(),
  }),
  z.object({
    purpose: z.literal("upload"),
    /** Upload bearer token. Treat as secret. */
    token: z.string(),
  }),
  z.object({
    // E7 / W-10: review lease — opaque bearer token for artifact bundle downloads.
    // No external credentials (no authJson, no askpassToken).
    purpose: z.literal("review"),
    /** Bearer token for bundle download authentication. Treat as secret. */
    token: z.string(),
  }),
]);

type LeaseMaterial = z.infer<typeof LeaseMaterialSchema>;

// ---------------------------------------------------------------------------
// LeaseGrant
// ---------------------------------------------------------------------------

export const LeaseGrantSchema = z.object({
  leaseId: z.string().min(1),
  purpose: LeasePurposeSchema,
  /** ISO 8601 expiry timestamp. */
  expiresAt: z.string().datetime({ message: "expiresAt must be an ISO 8601 datetime" }),
  material: LeaseMaterialSchema,
});
export type LeaseGrant = z.infer<typeof LeaseGrantSchema>;

// ---------------------------------------------------------------------------
// redactLeaseGrant
// ---------------------------------------------------------------------------

/**
 * Return a copy of the grant with every secret material value replaced by
 * the string "<redacted>". Non-secret values (e.g. remote URL, leaseId,
 * purpose, expiresAt) are preserved.
 *
 * Use before logging, telemetry, or passing grant metadata to untrusted
 * code. Verify with: JSON.stringify(redactLeaseGrant(g)) must not contain
 * any of the original secret values.
 */
export function redactLeaseGrant(grant: LeaseGrant): LeaseGrant {
  const { material } = grant;
  let redactedMaterial: LeaseMaterial;

  switch (material.purpose) {
    case "provider":
      redactedMaterial = { purpose: "provider", authJson: "<redacted>" };
      break;
    case "git-read":
      redactedMaterial = {
        purpose: "git-read",
        remote: material.remote,
        tokenRef: "<redacted>",
        askpassToken: "<redacted>",
      };
      break;
    case "integrate":
      redactedMaterial = {
        purpose: "integrate",
        remote: material.remote,
        tokenRef: "<redacted>",
        askpassToken: "<redacted>",
      };
      break;
    case "upload":
      redactedMaterial = { purpose: "upload", token: "<redacted>" };
      break;
    case "review":
      redactedMaterial = { purpose: "review", token: "<redacted>" };
      break;
  }

  return { ...grant, material: redactedMaterial };
}

// ---------------------------------------------------------------------------
// LeaseRefusal
// ---------------------------------------------------------------------------

export const LeaseRefusalSchema = z.object({
  purpose: LeasePurposeSchema,
  reason: z.enum([
    "login_required",
    "expired",
    "stale_generation",
    "unknown_run",
    "unknown_attempt",
    "revoked",
    "unavailable",
  ]),
});
export type LeaseRefusal = z.infer<typeof LeaseRefusalSchema>;
