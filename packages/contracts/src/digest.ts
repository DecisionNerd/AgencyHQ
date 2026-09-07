import { createHash } from "node:crypto";

/**
 * A SHA-256 content digest in the form `sha256:<hex>`.
 */
export type Digest = `sha256:${string}`;

/** Type guard: returns true iff `x` is a Digest-shaped string. */
export function isDigest(x: unknown): x is Digest {
  return typeof x === "string" && /^sha256:[0-9a-f]{64}$/.test(x);
}

/**
 * Recursively canonicalise `value` for deterministic JSON serialisation:
 * - Object keys are sorted lexicographically at every level.
 * - Arrays are kept in order.
 * - `-0` is normalised to `0`.
 * - `undefined`, functions, and `bigint` throw `TypeError`.
 */
function canonicalize(value: unknown): unknown {
  if (value === undefined) throw new TypeError("undefined is not JSON-serialisable");
  if (typeof value === "function") throw new TypeError("functions are not JSON-serialisable");
  if (typeof value === "bigint") throw new TypeError("BigInt is not JSON-serialisable");
  if (value === null) return null;
  if (typeof value === "number") {
    // Normalise -0 → 0 so that JSON.stringify("-0") never leaks.
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") return value; // boolean, string
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  // Plain object: sort keys.
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return result;
}

/**
 * Produce a canonical, deterministic JSON string for `value`:
 * no whitespace, object keys sorted at every depth, `-0` normalised to `0`.
 * Throws `TypeError` on `undefined`, functions, or `BigInt`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Return the SHA-256 digest of `text` (UTF-8 encoded) as a lower-case hex string.
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Return a `Digest` for `value`.  The digest is computed over the canonical
 * JSON representation so it is stable regardless of property insertion order.
 */
export function digestOf(value: unknown): Digest {
  const hex = sha256Hex(canonicalJson(value));
  return `sha256:${hex}`;
}
