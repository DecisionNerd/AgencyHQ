import assert from "node:assert/strict";
import test from "node:test";
import { err, isOk, mapResult, ok } from "../src/result.ts";

test("ok() creates an Ok result", () => {
  const r = ok(42);
  assert.equal(r.ok, true);
  assert.equal(r.value, 42);
});

test("err() creates an Err result", () => {
  const r = err("something went wrong");
  assert.equal(r.ok, false);
  assert.equal(r.error, "something went wrong");
});

test("isOk() returns true for Ok", () => {
  assert.equal(isOk(ok("hello")), true);
});

test("isOk() returns false for Err", () => {
  assert.equal(isOk(err("fail")), false);
});

test("mapResult() transforms value of Ok", () => {
  const r = ok(5);
  const mapped = mapResult(r, (v) => v * 2);
  assert.equal(mapped.ok, true);
  if (mapped.ok) assert.equal(mapped.value, 10);
});

test("mapResult() passes through Err unchanged", () => {
  const r = err("original error");
  const mapped = mapResult(r, (v: number) => v * 2);
  assert.equal(mapped.ok, false);
  if (!mapped.ok) assert.equal(mapped.error, "original error");
});

test("ok() works with object values", () => {
  const val = { a: 1, b: "hello" };
  const r = ok(val);
  assert.deepEqual(r.value, val);
});

test("err() works with object errors", () => {
  const e = { code: "bad_input", field: "email" };
  const r = err(e);
  assert.deepEqual(r.error, e);
});
