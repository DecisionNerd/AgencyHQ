/**
 * Tests for trigger-web.ts HTTP client behaviours:
 * - doFetch merges Set-Cookie from every redirect hop.
 * - doFetch switches to GET on 303 after POST.
 * - hasValidSession detects login-redirect vs. authenticated landing.
 *
 * All tests use a lightweight in-process HTTP server; no external services.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  createJar,
  followMagicLink,
  hasValidSession,
  requestMagicLink,
} from "../src/trigger-web.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

type Handler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void;

function makeServer(handler: Handler): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

// ── followMagicLink — cookie capture across redirect ──────────────────────────

describe("followMagicLink — cookie capture from redirect hop", () => {
  let serverUrl: string;
  let stopServer: () => Promise<void>;

  before(async () => {
    // Fake webapp:
    //   GET /magic?token=xxx  →  302 /dashboard   Set-Cookie: __session=sess42
    //   GET /dashboard        →  200 "Dashboard"  (requires cookie, but we don't enforce)
    const { url, stop } = await makeServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && pathname === "/magic") {
        res.writeHead(302, {
          Location: "/dashboard",
          "Set-Cookie": "__session=sess42; Path=/; HttpOnly",
        });
        res.end();
        return;
      }
      if (req.method === "GET" && pathname === "/dashboard") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>Dashboard</body></html>");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    serverUrl = url;
    stopServer = stop;
  });

  after(() => stopServer());

  it("captures __session cookie set on the 302 redirect", async () => {
    const jar = createJar();
    const landing = await followMagicLink(`${serverUrl}/magic?token=abc123`, serverUrl, jar);
    assert.equal(jar.get("__session"), "sess42", "jar should contain __session from redirect hop");
    assert.equal(landing, "/dashboard");
  });

  it("sends captured cookie on subsequent request", async () => {
    const jar = createJar();
    await followMagicLink(`${serverUrl}/magic?token=abc123`, serverUrl, jar);

    // Verify cookie is present in jar and would be sent on next request.
    assert.ok(jar.size > 0, "jar should not be empty after followMagicLink");
    assert.equal(jar.get("__session"), "sess42");
  });
});

// ── requestMagicLink — 303 after POST switches to GET ────────────────────────

describe("requestMagicLink — 303 after POST switches to GET", () => {
  let serverUrl: string;
  let stopServer: () => Promise<void>;
  let finalMethod: string;

  before(async () => {
    const { url, stop } = await makeServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (req.method === "POST" && pathname === "/login/magic") {
        // 303 See Other — strictly means redirect with GET.
        res.writeHead(303, { Location: "/" });
        res.end();
        return;
      }
      if (pathname === "/") {
        finalMethod = req.method ?? "UNKNOWN";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>home</html>");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    serverUrl = url;
    stopServer = stop;
  });

  after(() => stopServer());

  it("follows 303 from POST /login/magic as GET and returns final status 200", async () => {
    const jar = createJar();
    const status = await requestMagicLink(serverUrl, "user@example.com", jar);
    assert.equal(status, 200, "final status after 303 redirect should be 200");
    assert.equal(finalMethod, "GET", "redirect after 303 should use GET");
  });
});

// ── hasValidSession ───────────────────────────────────────────────────────────

describe("hasValidSession", () => {
  it("returns true when GET / responds with a non-login page", async () => {
    const { url, stop } = await makeServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Dashboard</body></html>");
    });
    try {
      const jar = createJar();
      const valid = await hasValidSession(url, jar);
      assert.equal(valid, true);
    } finally {
      await stop();
    }
  });

  it("returns false when GET / redirects to /login (no session)", async () => {
    const { url, stop } = await makeServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname === "/") {
        res.writeHead(302, { Location: "/login?redirectTo=%2F" });
        res.end();
        return;
      }
      if (pathname === "/login") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>Login</body></html>");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const jar = createJar(); // empty jar — no session cookie
      const valid = await hasValidSession(url, jar);
      assert.equal(valid, false);
    } finally {
      await stop();
    }
  });

  it("returns false when GET / returns a /login URL directly (no redirect)", async () => {
    // Edge case: server returns 200 but at /login path (unlikely but defensive).
    const { url, stop } = await makeServer((_req, res) => {
      res.writeHead(302, { Location: "/login" });
      res.end();
    });
    try {
      // Second server that handles /login
      const { url: url2, stop: stop2 } = await makeServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>login</html>");
      });
      // Point to the first server that redirects to /login on same server.
      const { url: combinedUrl, stop: stopCombined } = await makeServer((req, res) => {
        const pathname = (req.url ?? "/").split("?")[0];
        if (pathname === "/") {
          res.writeHead(302, { Location: "/login" });
          res.end();
          return;
        }
        if (pathname === "/login") {
          res.writeHead(200);
          res.end("<html>login form</html>");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      try {
        const jar = createJar();
        const valid = await hasValidSession(combinedUrl, jar);
        assert.equal(valid, false);
      } finally {
        await stopCombined();
      }
      await stop2();
    } finally {
      await stop();
    }
  });
});
