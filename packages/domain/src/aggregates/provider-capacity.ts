/**
 * ProviderCapacity aggregate.
 *
 * Timestamped capacity observation for an AI provider/model pair,
 * with a validity window.  Observations past their validUntil are
 * treated conservatively as "unknown" rather than trusted stale data.
 *
 * R-008: conservative stale handling per docs/strategy/roadmap.md Slice 6.
 */

// ---------------------------------------------------------------------------
// ProviderCapacity type
// ---------------------------------------------------------------------------

export type ProviderCapacity = {
  /** Provider identifier, e.g. "anthropic" or "openai". */
  provider: string;
  /** Model identifier within the provider, e.g. "claude-opus-4". */
  model: string;
  /** Declared capacity status at the time of observation. */
  status: "ok" | "limited" | "down";
  /** ISO 8601 datetime string when this observation was recorded. */
  observedAt: string;
  /**
   * ISO 8601 datetime string until which this observation is considered
   * fresh.  After this point the coordinator must treat the observation as
   * "unknown" rather than relying on potentially stale data.
   */
  validUntil: string;
  /** Origin of this observation. */
  source: "adapter" | "operator";
};

// ---------------------------------------------------------------------------
// EffectiveCapacityStatus
// ---------------------------------------------------------------------------

export type EffectiveCapacityStatus = "ok" | "limited" | "down" | "unknown";

// ---------------------------------------------------------------------------
// effectiveCapacity
// ---------------------------------------------------------------------------

/**
 * Compute the effective capacity status for a provider at the given point in
 * time (`now`).
 *
 * Rules:
 *   - If `obs` is absent  → "unknown" (no observation on record)
 *   - If `now > obs.validUntil`  → "unknown" (observation is stale)
 *   - Otherwise  → `obs.status`
 *
 * Boundary: the validUntil instant itself is still fresh (`now === validUntil`
 * returns `obs.status`).  The observation expires strictly after validUntil,
 * i.e. when `now > validUntil`.
 *
 * Both `now` and `validUntil` are compared as ISO 8601 strings using
 * lexicographic order, which is correct for UTC timestamps without offset.
 */
export function effectiveCapacity(
  obs: ProviderCapacity | undefined,
  now: string,
): EffectiveCapacityStatus {
  if (!obs) return "unknown";
  if (now > obs.validUntil) return "unknown";
  return obs.status;
}

// ---------------------------------------------------------------------------
// concurrencyFor
// ---------------------------------------------------------------------------

/**
 * Maximum number of concurrent attempts permitted for a given effective
 * capacity status.
 *
 * | status    | concurrency |
 * |-----------|-------------|
 * | "ok"      | null        | (unbounded — no constraint from this provider)
 * | "limited" | 1           | (at most one attempt at a time)
 * | "unknown" | 1           | (conservative: treat like "limited")
 * | "down"    | 0           | (no new attempts may be started)
 *
 * Returns `null` for "ok" to distinguish "unbounded" from "1".
 */
export function concurrencyFor(status: EffectiveCapacityStatus): number | null {
  switch (status) {
    case "ok":
      return null;
    case "limited":
      return 1;
    case "unknown":
      return 1;
    case "down":
      return 0;
  }
}
