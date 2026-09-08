import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthHeaders,
  clearStoredToken,
  getStoredToken,
  handle401,
  type StorageLike,
  setStoredToken,
  TOKEN_STORAGE_KEY,
  UnauthorizedError,
} from "../src/auth.ts";

// ---- In-memory storage fixture --------------------------------------------

function makeStorage(initial: Record<string, string> = {}): StorageLike {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/** A storage that always throws on every method. */
const throwingStorage: StorageLike = {
  getItem() {
    throw new Error("storage unavailable");
  },
  setItem() {
    throw new Error("storage unavailable");
  },
  removeItem() {
    throw new Error("storage unavailable");
  },
};

// ---- buildAuthHeaders -----------------------------------------------------

test("buildAuthHeaders: returns empty object when token is null", () => {
  assert.deepEqual(buildAuthHeaders(null), {});
});

test("buildAuthHeaders: returns Authorization header when token is present", () => {
  const headers = buildAuthHeaders("my-secret-token");
  assert.equal(headers.Authorization, "Bearer my-secret-token");
  assert.equal(Object.keys(headers).length, 1);
});

test("buildAuthHeaders: empty string token returns empty object", () => {
  assert.deepEqual(buildAuthHeaders(""), {});
});

// ---- getStoredToken -------------------------------------------------------

test("getStoredToken: returns null when storage is empty", () => {
  const storage = makeStorage();
  assert.equal(getStoredToken(storage), null);
});

test("getStoredToken: returns stored token", () => {
  const storage = makeStorage({ [TOKEN_STORAGE_KEY]: "tok-abc" });
  assert.equal(getStoredToken(storage), "tok-abc");
});

test("getStoredToken: returns null when storage throws", () => {
  assert.equal(getStoredToken(throwingStorage), null);
});

// ---- setStoredToken -------------------------------------------------------

test("setStoredToken: persists token to storage", () => {
  const storage = makeStorage();
  setStoredToken(storage, "tok-xyz");
  assert.equal(getStoredToken(storage), "tok-xyz");
});

test("setStoredToken: silently ignores storage errors", () => {
  // Should not throw
  assert.doesNotThrow(() => setStoredToken(throwingStorage, "tok"));
});

// ---- clearStoredToken -----------------------------------------------------

test("clearStoredToken: removes an existing token", () => {
  const storage = makeStorage({ [TOKEN_STORAGE_KEY]: "tok-abc" });
  clearStoredToken(storage);
  assert.equal(getStoredToken(storage), null);
});

test("clearStoredToken: silently ignores storage errors", () => {
  assert.doesNotThrow(() => clearStoredToken(throwingStorage));
});

// ---- handle401 ------------------------------------------------------------

test("handle401: clears the stored token", () => {
  const storage = makeStorage({ [TOKEN_STORAGE_KEY]: "old-token" });
  handle401(storage);
  assert.equal(getStoredToken(storage), null, "token must be cleared after 401");
});

test("handle401: returns an UnauthorizedError", () => {
  const storage = makeStorage();
  const err = handle401(storage);
  assert.ok(err instanceof UnauthorizedError);
  assert.equal(err.name, "UnauthorizedError");
});

test("handle401: returned error is an instance of Error", () => {
  const storage = makeStorage();
  const err = handle401(storage);
  assert.ok(err instanceof Error);
});

test("handle401: tolerates storage failure while still returning UnauthorizedError", () => {
  const err = handle401(throwingStorage);
  assert.ok(err instanceof UnauthorizedError);
});
