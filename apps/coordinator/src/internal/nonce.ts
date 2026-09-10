/**
 * Nonce generation and verification for dispatch-to-lease authentication.
 *
 * The coordinator generates a 32-byte random nonce at dispatch time, stores
 * only its SHA-256 hash in dispatch_intents.dispatch_nonce_hash, and passes
 * the raw nonce to the task container in the payload. The container presents
 * the nonce when requesting a lease; the broker verifies sha256(nonce) matches
 * the stored hash.
 *
 * SECURITY: The raw nonce value is never logged, stored in the database, or
 * included in any error message. Only the SHA-256 hash (hex-encoded) is stored.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Length of the generated nonce in bytes. */
const NONCE_BYTES = 32;

/**
 * Generate a cryptographically random 32-byte nonce encoded as a hex string.
 * The returned string is 64 hex characters.
 */
export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex");
}

/**
 * Compute the SHA-256 hash of a nonce string (UTF-8 encoded).
 * Returns the hash as a 64-character lowercase hex string.
 *
 * This function is used both when storing the hash at dispatch time and
 * when verifying the nonce presented by a worker container.
 */
export function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/**
 * Verify that a presented nonce matches a stored hash.
 * Uses timing-safe comparison to prevent timing side-channels.
 *
 * Returns true when sha256(nonce) equals storedHash, false otherwise.
 */
export function verifyNonce(nonce: string, storedHash: string): boolean {
  const computed = hashNonce(nonce);
  // SHA-256 always produces 64 hex chars; if lengths differ, reject immediately.
  if (computed.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(storedHash, "utf8"));
}
