/**
 * Unit tests for packages/db/src/crypto.ts.
 *
 * Tests cover: round-trip, tamper detection, wrong-key rejection.
 * No DATABASE_URL required — pure Node crypto, no DB.
 *
 * SECURITY INVARIANT: test output must not contain secret values.
 * We verify properties (throws/doesn't throw, equality), never log plaintext.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../../src/crypto.ts";

// A valid 64-hex key (32 bytes of 0xaa).
const VALID_KEY = "aa".repeat(32);
// A different valid key (32 bytes of 0xbb).
const DIFFERENT_KEY = "bb".repeat(32);

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test("crypto: round-trip short plaintext", () => {
  const plaintext = "hello, world";
  const row = encryptSecret(plaintext, VALID_KEY);
  const result = decryptSecret({ ...row, key_version: 1 }, VALID_KEY);
  assert.equal(result, plaintext);
});

test("crypto: round-trip empty string", () => {
  const row = encryptSecret("", VALID_KEY);
  const result = decryptSecret({ ...row, key_version: 1 }, VALID_KEY);
  assert.equal(result, "");
});

test("crypto: round-trip long plaintext", () => {
  const plaintext = "x".repeat(10_000);
  const row = encryptSecret(plaintext, VALID_KEY);
  const result = decryptSecret({ ...row, key_version: 1 }, VALID_KEY);
  assert.equal(result, plaintext);
});

test("crypto: round-trip unicode plaintext", () => {
  const plaintext = "🔑 secret token 💥";
  const row = encryptSecret(plaintext, VALID_KEY);
  const result = decryptSecret({ ...row, key_version: 1 }, VALID_KEY);
  assert.equal(result, plaintext);
});

test("crypto: each encryption produces a different ciphertext (random IV)", () => {
  const plaintext = "same plaintext";
  const r1 = encryptSecret(plaintext, VALID_KEY);
  const r2 = encryptSecret(plaintext, VALID_KEY);
  // Different IVs should produce different ciphertexts
  assert.ok(
    !r1.ciphertext.equals(r2.ciphertext) || !r1.iv.equals(r2.iv),
    "Two encryptions of the same plaintext should differ (random IV)",
  );
});

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

test("crypto: flipping a ciphertext byte causes authentication failure", () => {
  const row = encryptSecret("secret value", VALID_KEY);
  // Flip the first byte of ciphertext (plaintext is non-empty so ciphertext has bytes)
  const tampered = Buffer.from(row.ciphertext);
  assert.ok(tampered.length > 0, "ciphertext must have bytes to tamper");
  tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);
  assert.throws(
    () => decryptSecret({ ...row, ciphertext: tampered, key_version: 1 }, VALID_KEY),
    /authentication failed/i,
  );
});

test("crypto: flipping an IV byte causes authentication failure", () => {
  const row = encryptSecret("secret value", VALID_KEY);
  const tamperedIv = Buffer.from(row.iv);
  assert.ok(tamperedIv.length > 0, "iv must have bytes to tamper");
  tamperedIv.writeUInt8(tamperedIv.readUInt8(0) ^ 0x01, 0);
  assert.throws(
    () => decryptSecret({ ...row, iv: tamperedIv, key_version: 1 }, VALID_KEY),
    /authentication failed/i,
  );
});

test("crypto: flipping a tag byte causes authentication failure", () => {
  const row = encryptSecret("secret value", VALID_KEY);
  const tamperedTag = Buffer.from(row.tag);
  assert.ok(tamperedTag.length > 0, "tag must have bytes to tamper");
  tamperedTag.writeUInt8(tamperedTag.readUInt8(0) ^ 0x01, 0);
  assert.throws(
    () => decryptSecret({ ...row, tag: tamperedTag, key_version: 1 }, VALID_KEY),
    /authentication failed/i,
  );
});

// ---------------------------------------------------------------------------
// Wrong key
// ---------------------------------------------------------------------------

test("crypto: wrong key causes authentication failure", () => {
  const row = encryptSecret("secret", VALID_KEY);
  assert.throws(
    () => decryptSecret({ ...row, key_version: 1 }, DIFFERENT_KEY),
    /authentication failed/i,
  );
});

// ---------------------------------------------------------------------------
// Key length validation
// ---------------------------------------------------------------------------

test("crypto: encryptSecret rejects key shorter than 64 hex chars", () => {
  assert.throws(() => encryptSecret("hello", "aa".repeat(16)), /key must be 64/i);
});

test("crypto: encryptSecret rejects key longer than 64 hex chars", () => {
  assert.throws(() => encryptSecret("hello", "aa".repeat(33)), /key must be 64/i);
});

test("crypto: decryptSecret rejects key of wrong length", () => {
  const row = encryptSecret("hello", VALID_KEY);
  assert.throws(
    () => decryptSecret({ ...row, key_version: 1 }, "aa".repeat(16)),
    /key must be 64/i,
  );
});

// ---------------------------------------------------------------------------
// Security: error messages must not contain secret values
// ---------------------------------------------------------------------------

test("crypto: error from wrong key does not contain key material", () => {
  const row = encryptSecret("secret", VALID_KEY);
  try {
    decryptSecret({ ...row, key_version: 1 }, DIFFERENT_KEY);
    assert.fail("Expected throw");
  } catch (e) {
    const msg = String(e);
    // Must not contain the key hex itself
    assert.ok(!msg.includes(DIFFERENT_KEY), "Error must not contain key material");
    assert.ok(!msg.includes(VALID_KEY), "Error must not contain key material");
  }
});
