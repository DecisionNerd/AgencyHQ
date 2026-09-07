import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson, digestOf, isDigest, sha256Hex } from "../src/digest.ts";

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

test("canonicalJson: key order is sorted regardless of insertion order", () => {
  const a = canonicalJson({ z: 1, a: 2, m: 3 });
  const b = canonicalJson({ m: 3, z: 1, a: 2 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"m":3,"z":1}');
});

test("canonicalJson: nested objects also have sorted keys", () => {
  const result = canonicalJson({ outer: { z: 99, a: 1 }, b: { y: 2, x: 3 } });
  assert.equal(result, '{"b":{"x":3,"y":2},"outer":{"a":1,"z":99}}');
});

test("canonicalJson: arrays are kept in order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("canonicalJson: arrays of objects with sorted keys", () => {
  const result = canonicalJson([{ z: 2, a: 1 }, { m: 3 }]);
  assert.equal(result, '[{"a":1,"z":2},{"m":3}]');
});

test("canonicalJson: primitive values pass through unchanged", () => {
  assert.equal(canonicalJson(42), "42");
  assert.equal(canonicalJson("hello"), '"hello"');
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(null), "null");
});

test("canonicalJson: -0 is normalised to 0", () => {
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson({ v: -0 }), '{"v":0}');
});

test("canonicalJson: undefined throws TypeError", () => {
  assert.throws(() => canonicalJson(undefined), TypeError);
});

test("canonicalJson: function throws TypeError", () => {
  assert.throws(() => canonicalJson(() => 1), TypeError);
});

test("canonicalJson: BigInt throws TypeError", () => {
  assert.throws(() => canonicalJson(BigInt(1)), TypeError);
});

test("canonicalJson: undefined inside array throws TypeError", () => {
  assert.throws(() => canonicalJson([undefined]), TypeError);
});

test("canonicalJson: undefined inside object throws TypeError", () => {
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
});

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

test("sha256Hex: returns lowercase 64-char hex", () => {
  const hex = sha256Hex("hello");
  assert.equal(hex.length, 64);
  assert.match(hex, /^[0-9a-f]{64}$/);
});

test("sha256Hex: matches node crypto directly", () => {
  const text = '{"a":1,"b":2}';
  const expected = createHash("sha256").update(text, "utf8").digest("hex");
  assert.equal(sha256Hex(text), expected);
});

test("sha256Hex: different inputs produce different outputs", () => {
  assert.notEqual(sha256Hex("aaa"), sha256Hex("bbb"));
});

// ---------------------------------------------------------------------------
// digestOf
// ---------------------------------------------------------------------------

test("digestOf: produces sha256: prefix", () => {
  const d = digestOf({ x: 1 });
  assert.match(d, /^sha256:[0-9a-f]{64}$/);
});

test("digestOf: deterministic across key orders", () => {
  const d1 = digestOf({ a: 1, z: 9 });
  const d2 = digestOf({ z: 9, a: 1 });
  assert.equal(d1, d2);
});

test("digestOf: tampering with any value changes the digest", () => {
  const d1 = digestOf({ a: 1, b: 2 });
  const d2 = digestOf({ a: 1, b: 3 });
  assert.notEqual(d1, d2);
});

test("digestOf: adding a key changes the digest", () => {
  const d1 = digestOf({ a: 1 });
  const d2 = digestOf({ a: 1, extra: true });
  assert.notEqual(d1, d2);
});

// ---------------------------------------------------------------------------
// isDigest
// ---------------------------------------------------------------------------

test("isDigest: accepts a valid digest", () => {
  const d = digestOf({ hello: "world" });
  assert.equal(isDigest(d), true);
});

test("isDigest: rejects a string without sha256: prefix", () => {
  assert.equal(isDigest("abc123"), false);
});

test("isDigest: rejects a short sha256: string", () => {
  assert.equal(isDigest("sha256:abc"), false);
});

test("isDigest: rejects non-string", () => {
  assert.equal(isDigest(42), false);
  assert.equal(isDigest(null), false);
});

test("isDigest: rejects sha256: with uppercase hex", () => {
  const upper = `sha256:${"A".repeat(64)}`;
  assert.equal(isDigest(upper), false);
});
