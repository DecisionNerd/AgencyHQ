/**
 * Provider state reader.
 *
 * Reads the OpenCode auth.json file and derives the overall provider state
 * for the configured worker/lead models.
 *
 * SECURITY: Never returns key, access, or refresh values. Only type, expires,
 * and derived states are exposed. The raw JSON is parsed and discarded.
 *
 * Provider id = model prefix before "/" (e.g. "anthropic" from "anthropic/claude-opus-4").
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderStatus = "ready" | "login_required" | "expired" | "unavailable";

export interface ProviderEntry {
  id: string;
  type: "api" | "oauth";
  expiresAt?: string; // ISO 8601; only for oauth entries
}

export interface ProviderState {
  status: ProviderStatus;
  providers: ProviderEntry[];
  reason?: string;
}

export interface ReadProviderStateOptions {
  /** Path to the OpenCode data directory (contains auth.json). */
  dataDir: string | undefined;
  /** ISO 8601 current timestamp for expiry comparison. */
  now: string;
  /**
   * Treat an OAuth entry as expired when its token expires within this many
   * milliseconds of `now`. Also used to limit the capacity-401 lookback window.
   * Default: 30 minutes (1_800_000 ms).
   */
  expiredWithinMs?: number;
  /** Provider ids to check (derived from worker/lead model prefixes). */
  requiredProviderIds?: string[];
  /**
   * Recent provider capacity rows for 401/invalid-key detection.
   * When the latest row for a required provider reports a 401-classified
   * status within `expiredWithinMs`, the provider is treated as expired.
   */
  capacityRows?: Array<{
    provider: string;
    model: string;
    status: "ok" | "limited" | "down";
    observedAt: string;
    validUntil: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a provider id from a model string (prefix before "/").
 * Returns undefined when the model string has no slash.
 */
export function providerIdFromModel(model: string): string | undefined {
  const idx = model.indexOf("/");
  return idx > 0 ? model.slice(0, idx) : undefined;
}

// ---------------------------------------------------------------------------
// readProviderState
// ---------------------------------------------------------------------------

/**
 * Read the OpenCode auth.json and derive the overall provider state.
 *
 * Decision order:
 * 1. unavailable — dataDir is unset or auth.json is unreadable
 * 2. login_required — auth.json is empty, or does not contain a required provider
 * 3. expired — any OAuth entry's expires is in the past (within expiredWithinMs),
 *    or the latest capacity row for a required provider reports a 401-like status
 * 4. ready — all required providers present and valid
 *
 * Return value NEVER contains key, access, or refresh fields.
 */
export function readProviderState(options: ReadProviderStateOptions): ProviderState {
  const {
    dataDir,
    now,
    expiredWithinMs = 1_800_000,
    requiredProviderIds = [],
    capacityRows = [],
  } = options;

  // 1. Unavailable when dataDir is unset
  if (!dataDir) {
    return { status: "unavailable", providers: [], reason: "dataDir not configured" };
  }

  const authPath = join(dataDir, "auth.json");

  // Parse auth.json — only read type and expires fields, never key/access/refresh
  let rawObj: Record<string, unknown>;
  try {
    const raw = readFileSync(authPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {
        status: "login_required",
        providers: [],
        reason: "auth.json is not a JSON object",
      };
    }
    rawObj = parsed as Record<string, unknown>;
  } catch {
    // File missing or unreadable → login_required (not unavailable — dir exists)
    return { status: "login_required", providers: [], reason: "auth.json not found or unreadable" };
  }

  // 2. login_required when auth.json is empty
  const providerIds = Object.keys(rawObj);
  if (providerIds.length === 0) {
    return { status: "login_required", providers: [], reason: "auth.json is empty" };
  }

  // Build provider entries — parse only type and expires, discard secrets
  const entries: ProviderEntry[] = [];
  for (const id of providerIds) {
    const entry = rawObj[id];
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const type = e.type === "api" ? "api" : e.type === "oauth" ? "oauth" : null;
    if (type === null) continue;
    const pe: ProviderEntry = { id, type };
    if (type === "oauth" && typeof e.expires === "number") {
      pe.expiresAt = new Date(e.expires).toISOString();
    }
    entries.push(pe);
  }

  // 2. login_required when a required provider is missing entirely
  for (const reqId of requiredProviderIds) {
    const found = entries.find((e) => e.id === reqId);
    if (!found) {
      return {
        status: "login_required",
        providers: entries,
        reason: `Required provider '${reqId}' not found in auth.json`,
      };
    }
  }

  const nowMs = new Date(now).getTime();

  // 3. expired — check OAuth expiry
  for (const entry of entries) {
    if (!requiredProviderIds.includes(entry.id) && requiredProviderIds.length > 0) continue;
    if (entry.type === "oauth" && entry.expiresAt !== undefined) {
      const expiresMs = new Date(entry.expiresAt).getTime();
      if (expiresMs <= nowMs + expiredWithinMs) {
        return {
          status: "expired",
          providers: entries,
          reason: `OAuth token for '${entry.id}' expires at ${entry.expiresAt}`,
        };
      }
    }
  }

  // 3. expired — check capacity rows for 401/invalid-key within the lookback window
  for (const reqId of requiredProviderIds.length > 0 ? requiredProviderIds : providerIds) {
    const relevant = capacityRows
      .filter((r) => r.provider === reqId && r.status === "down")
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
    const latest = relevant[0];
    if (latest) {
      const obsMs = new Date(latest.observedAt).getTime();
      if (nowMs - obsMs <= expiredWithinMs) {
        return {
          status: "expired",
          providers: entries,
          reason: `Provider '${reqId}' reported a capacity error at ${latest.observedAt}`,
        };
      }
    }
  }

  return { status: "ready", providers: entries };
}
