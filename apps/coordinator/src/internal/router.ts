/**
 * Internal API router for task containers.
 *
 * Routes under /internal/* are NOT protected by the operator bearer token.
 * Instead, each request is authenticated via the dispatch nonce embedded in
 * the lease request body. The nonce proves the caller holds the current
 * generation's dispatch credential.
 *
 * SECURITY: Internal routes must never return raw credential values in error
 * responses, logs, or telemetry. All lease grants pass through redactLeaseGrant
 * before logging.
 *
 * P18.2 will add additional routes under /internal/ (e.g. artifact upload).
 * This module exports mountInternalRoutes(app, deps) so both P17.1 and P18.2
 * routes can be merged without conflict.
 */

import { LeaseRefusalSchema, LeaseRequestSchema, redactLeaseGrant } from "@agencyhq/contracts";
import type { Hono } from "hono";
import type pg from "pg";
import type { ProviderStatus } from "../provider/state.ts";
import type { LeaseBrokerDeps } from "./leases.ts";
import { issueLeaseBroker } from "./leases.ts";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface InternalRouterDeps {
  pool: pg.Pool;
  /** Resolved provider state (called on each lease request). */
  providerState: () => Promise<ProviderStatus>;
  /** OpenCode data dir (for reading auth.json on lease requests). */
  dataDirFn: () => string | undefined;
  /** AES-256-GCM hex key for decrypting project credentials. */
  secretsKey: () => string | undefined;
  /** Lease TTL in ms. Default: 900_000 (15 min). */
  leaseTtlMs?: number | undefined;
  /** Integrate lease TTL in ms. Default: 300_000 (5 min). */
  integrateLeaseTtlMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// mountInternalRoutes
// ---------------------------------------------------------------------------

/**
 * Mount all /internal/* routes onto the given Hono app.
 *
 * Current routes:
 *   POST /internal/leases — request a credential lease
 *
 * P18.2 will call this function and add its own routes after mounting.
 * Export this function so both slices can be composed in app.ts or main.ts.
 */
export function mountInternalRoutes(app: Hono, deps: InternalRouterDeps): void {
  const brokerDeps: LeaseBrokerDeps = {
    pool: deps.pool,
    providerState: deps.providerState,
    dataDirFn: deps.dataDirFn,
    secretsKey: deps.secretsKey,
    leaseTtlMs: deps.leaseTtlMs,
    integrateLeaseTtlMs: deps.integrateLeaseTtlMs,
    log: (msg, meta) => {
      // Never log raw nonce or credential values — they are never in msg/meta
      // because we only log after redaction.
      if (meta !== undefined) {
        console.log(msg, JSON.stringify(meta));
      } else {
        console.log(msg);
      }
    },
  };

  // ------------------------------------------------------------------
  // POST /internal/leases — request a credential lease
  // ------------------------------------------------------------------
  app.post("/internal/leases", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const parsed = LeaseRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", details: parsed.error.issues }, 400);
    }

    const request = parsed.data;

    const result = await issueLeaseBroker(brokerDeps, request);

    if (!result.ok) {
      // Validate the refusal shape before returning
      const refusalParsed = LeaseRefusalSchema.safeParse(result.refusal);
      if (refusalParsed.success) {
        return c.json(refusalParsed.data, result.status);
      }
      return c.json(result.refusal, result.status);
    }

    // Log redacted grant (never log the raw grant)
    const redacted = redactLeaseGrant(result.grant);
    console.log("[lease] grant issued", JSON.stringify(redacted));

    return c.json(result.grant, 200);
  });
}
