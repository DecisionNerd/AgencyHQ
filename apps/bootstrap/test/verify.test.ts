/**
 * Tests for verifyDeployment (CR4: timeout; E-11: DEPLOYED status check).
 *
 * verifyDeployment uses the global fetch. We replace it temporarily for each test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyDeployment } from "../src/verify.ts";

// Helper: replace global fetch for the duration of a test.
function withFetch(fake: typeof globalThis.fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe("verifyDeployment — timeout", () => {
  it("classifies AbortError (TimeoutError) as verify_failed", async () => {
    await withFetch(
      (_url, init) => {
        // Trigger the timeout signal immediately.
        if (init?.signal) {
          const signal = init.signal as AbortSignal;
          return new Promise<Response>((_resolve, reject) => {
            if (signal.aborted) {
              const err = new DOMException("The operation was aborted.", "TimeoutError");
              reject(err);
            } else {
              signal.addEventListener(
                "abort",
                () => {
                  const err = new DOMException("The operation was aborted.", "TimeoutError");
                  reject(err);
                },
                { once: true },
              );
            }
          });
        }
        return Promise.reject(new Error("no signal"));
      },
      async () => {
        await assert.rejects(
          () => verifyDeployment("http://fake", "key"),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /timed out/);
            assert.equal((err as { errorCategory?: string }).errorCategory, "verify_failed");
            return true;
          },
        );
      },
    );
  });
});

describe("verifyDeployment — status assertion", () => {
  function makeFetch(body: Record<string, unknown>, status = 200): typeof globalThis.fetch {
    return async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
  }

  it("throws verify_failed when status is FAILED", async () => {
    await withFetch(makeFetch({ status: "FAILED", version: "v1" }), async () => {
      await assert.rejects(
        () => verifyDeployment("http://fake", "key"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /FAILED.*expected DEPLOYED/i);
          assert.equal((err as { errorCategory?: string }).errorCategory, "verify_failed");
          return true;
        },
      );
    });
  });

  it("throws verify_failed when status is TIMED_OUT", async () => {
    await withFetch(makeFetch({ status: "TIMED_OUT" }), async () => {
      await assert.rejects(
        () => verifyDeployment("http://fake", "key"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /TIMED_OUT.*expected DEPLOYED/i);
          return true;
        },
      );
    });
  });

  it("returns DeploymentInfo when status is DEPLOYED", async () => {
    const body = {
      status: "DEPLOYED",
      version: "20260909.1",
      imageReference: "registry/image:sha256",
      externalId: "ext-abc123",
    };
    await withFetch(makeFetch(body), async () => {
      const info = await verifyDeployment("http://fake", "key");
      assert.equal(info.status, "DEPLOYED");
      assert.equal(info.version, "20260909.1");
      assert.equal(info.imageRef, "registry/image:sha256");
      assert.equal(info.externalId, "ext-abc123");
    });
  });

  it("throws verify_failed for 404", async () => {
    await withFetch(makeFetch({}, 404), async () => {
      await assert.rejects(
        () => verifyDeployment("http://fake", "key"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /404/);
          assert.equal((err as { errorCategory?: string }).errorCategory, "verify_failed");
          return true;
        },
      );
    });
  });
});

describe("verifyDeployment — external-id equality (E-11)", () => {
  function makeFetch(body: Record<string, unknown>, status = 200): typeof globalThis.fetch {
    return async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
  }

  it("succeeds when expectedExternalId matches the API response", async () => {
    const body = { status: "DEPLOYED", version: "v1", externalId: "ext-match" };
    await withFetch(makeFetch(body), async () => {
      const info = await verifyDeployment("http://fake", "key", "ext-match");
      assert.equal(info.externalId, "ext-match");
    });
  });

  it("throws verify_failed when externalId mismatches", async () => {
    const body = { status: "DEPLOYED", version: "v1", externalId: "ext-api" };
    await withFetch(makeFetch(body), async () => {
      await assert.rejects(
        () => verifyDeployment("http://fake", "key", "ext-deployed"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /ext-deployed/);
          assert.match(err.message, /ext-api/);
          assert.equal((err as { errorCategory?: string }).errorCategory, "verify_failed");
          return true;
        },
      );
    });
  });

  it("succeeds when API response has no externalId (field absent)", async () => {
    const body = { status: "DEPLOYED", version: "v1" };
    await withFetch(makeFetch(body), async () => {
      // When the API doesn't return an externalId, we cannot compare — should not throw.
      const info = await verifyDeployment("http://fake", "key", "ext-deployed");
      assert.equal(info.status, "DEPLOYED");
      assert.equal(info.externalId, undefined);
    });
  });
});
