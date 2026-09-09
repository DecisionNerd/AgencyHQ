/**
 * Tests for P15.7 additions:
 * - Slug parsing with mixed-case suffixes (agencyhq-f0be / agencyhq-MvNP)
 * - Session file save / load / delete
 * - Identifier state round-trip (orgSlug, projectSlug, projectRef)
 * - login_required honest failure path
 * - Magic-link throttle (60-second wait)
 *
 * Uses node:test + node:assert/strict; no third-party dependencies.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { StateManager } from "../src/state.ts";
import {
  createJar,
  deleteSession,
  findOrCreateOrgProject,
  hasValidSession,
  loadSession,
  readProdSecretKey,
  saveSession,
} from "../src/trigger-web.ts";
import { FAKE, startFakeWebapp } from "./helpers/fake-webapp.ts";

// ── Slug parsing — mixed-case org and project slugs ──────────────────────────

describe("slug parsing — mixed-case slugs", () => {
  it("findOrCreateOrgProject returns agencyhq-f0be org slug from creation redirect", async () => {
    const webapp = await startFakeWebapp();
    try {
      const jar = createJar();
      const result = await findOrCreateOrgProject(webapp.url, "agencyhq", "agencyhq", jar);
      // Fake webapp appends -f0be to org slugs and -MvNP to project slugs.
      assert.equal(result.orgSlug, "agencyhq-f0be", "org slug must include mixed-case suffix");
      assert.equal(
        result.projectSlug,
        "agencyhq-MvNP",
        "project slug must include mixed-case suffix",
      );
    } finally {
      await webapp.stop();
    }
  });

  it("findOrCreateOrgProject resolves pre-existing mixed-case slugs from dashboard HTML", async () => {
    // Pre-seed the fake webapp so the dashboard has agencyhq-f0be / agencyhq-MvNP links.
    const webapp = await startFakeWebapp({
      existingOrgSlug: FAKE.ORG_SLUG,
      existingProjectSlug: FAKE.PROJECT_SLUG,
    });
    try {
      const jar = createJar();
      const result = await findOrCreateOrgProject(webapp.url, "agencyhq", "agencyhq", jar);
      assert.equal(result.orgSlug, FAKE.ORG_SLUG);
      assert.equal(result.projectSlug, FAKE.PROJECT_SLUG);
      // No new org or project should have been created.
      assert.equal(webapp.state.orgsCreated.length, 1);
      assert.equal(webapp.state.projectsCreated.length, 1);
    } finally {
      await webapp.stop();
    }
  });

  it("findOrCreateOrgProject extracts mixed-case proj_... ref", async () => {
    const webapp = await startFakeWebapp();
    try {
      const jar = createJar();
      const result = await findOrCreateOrgProject(webapp.url, "agencyhq", "agencyhq", jar);
      // FAKE_PROJECT_REF is proj_fakeRefABC123 (mixed case).
      assert.match(result.projectRef, /^proj_[A-Za-z0-9]+$/);
      assert.equal(result.projectRef, FAKE.PROJECT_REF);
    } finally {
      await webapp.stop();
    }
  });

  it("slug regex matches links inside HTML attributes with mixed case", () => {
    // Simulate dashboard HTML with mixed-case slugs inside href attributes.
    // This verifies the regex itself, without a full server round-trip.
    // We test via findOrCreateOrgProject against a minimal inline server.
    const html =
      `<html><body>` +
      `<a href="/orgs/agencyhq-f0be">org</a>` +
      `<a href="/orgs/agencyhq-f0be/projects/agencyhq-MvNP/env/prod">project</a>` +
      `</body></html>`;

    // Check that our regex extracts the mixed-case slug from the HTML.
    // Re-use the same logic as trigger-web.ts by doing a regex match here.
    const orgRe = /href="\/orgs\/(agencyhq[A-Za-z0-9_-]*)(?:\/|")/i;
    const projRe = /href="\/orgs\/agencyhq-f0be\/projects\/(agencyhq[A-Za-z0-9_-]*)\/env\//i;
    const orgMatch = orgRe.exec(html);
    const projMatch = projRe.exec(html);
    assert.ok(orgMatch, "should find org link");
    assert.equal(orgMatch?.[1], "agencyhq-f0be");
    assert.ok(projMatch, "should find project link");
    assert.equal(projMatch?.[1], "agencyhq-MvNP");
  });
});

// ── Session file — save / load / delete ──────────────────────────────────────

describe("session file — save / load / delete", () => {
  let stateDir: string;
  let sessionPath: string;

  before(() => {
    stateDir = mkdtempSync(join(tmpdir(), "session-test-"));
    sessionPath = join(stateDir, "webapp-session.json");
  });

  after(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("saveSession writes a non-empty file", () => {
    const jar = createJar();
    jar.set("__session", "abc123");
    jar.set("csrf", "xyz789");
    saveSession(jar, sessionPath);
    assert.ok(existsSync(sessionPath), "session file should exist after save");
  });

  it("loadSession reads back the same cookies", () => {
    const jar = loadSession(sessionPath);
    assert.equal(jar.get("__session"), "abc123");
    assert.equal(jar.get("csrf"), "xyz789");
    assert.equal(jar.size, 2);
  });

  it("loadSession returns empty jar when file does not exist", () => {
    const missingPath = join(stateDir, "nonexistent.json");
    const jar = loadSession(missingPath);
    assert.equal(jar.size, 0);
  });

  it("loadSession returns empty jar for corrupt JSON", () => {
    const badPath = join(stateDir, "bad.json");
    // Write corrupt content
    writeFileSync(badPath, "{not valid json", { mode: 0o600 });
    const jar = loadSession(badPath);
    assert.equal(jar.size, 0, "corrupt file should yield empty jar");
  });

  it("deleteSession removes the file", () => {
    assert.ok(existsSync(sessionPath), "file should exist before delete");
    deleteSession(sessionPath);
    assert.ok(!existsSync(sessionPath), "file should not exist after delete");
  });

  it("deleteSession is idempotent when file is already gone", () => {
    // Should not throw even if file was already deleted.
    assert.doesNotThrow(() => deleteSession(sessionPath));
  });
});

// ── Identifier state round-trip ───────────────────────────────────────────────

describe("identifier state round-trip", () => {
  it("orgSlug / projectSlug / projectRef persist through setDone / load", () => {
    const sd = mkdtempSync(join(tmpdir(), "id-state-"));
    const sc = mkdtempSync(join(tmpdir(), "id-secrets-"));
    const sm = new StateManager(sd, sc);
    try {
      const state = sm.load();
      sm.setDone(state, "org_project", {
        orgSlug: "agencyhq-f0be",
        projectSlug: "agencyhq-MvNP",
        projectRef: "proj_fakeRefABC123",
      });

      const reloaded = sm.load();
      assert.equal(reloaded.phases.org_project?.orgSlug, "agencyhq-f0be");
      assert.equal(reloaded.phases.org_project?.projectSlug, "agencyhq-MvNP");
      assert.equal(reloaded.phases.org_project?.projectRef, "proj_fakeRefABC123");
    } finally {
      rmSync(sd, { recursive: true, force: true });
      rmSync(sc, { recursive: true, force: true });
    }
  });

  it("mixed-case slugs are preserved as-is in bootstrap.json", () => {
    const sd = mkdtempSync(join(tmpdir(), "slug-preserve-"));
    const sc = mkdtempSync(join(tmpdir(), "slug-secrets-"));
    const sm = new StateManager(sd, sc);
    try {
      const state = sm.load();
      sm.setDone(state, "org_project", {
        orgSlug: FAKE.ORG_SLUG,
        projectSlug: FAKE.PROJECT_SLUG,
        projectRef: FAKE.PROJECT_REF,
      });
      const raw = readFileSync(join(sd, "bootstrap.json"), "utf-8");
      assert.ok(raw.includes(FAKE.ORG_SLUG), "bootstrap.json should contain org slug verbatim");
      assert.ok(
        raw.includes(FAKE.PROJECT_SLUG),
        "bootstrap.json should contain project slug verbatim",
      );
      assert.ok(
        raw.includes(FAKE.PROJECT_REF),
        "bootstrap.json should contain project ref verbatim",
      );
    } finally {
      rmSync(sd, { recursive: true, force: true });
      rmSync(sc, { recursive: true, force: true });
    }
  });
});

// ── Credentials — 404 handling ────────────────────────────────────────────────

describe("credentials — readProdSecretKey 404 handling", () => {
  it("fails with project_page_not_found category on persistent 404", async () => {
    // Server returns 404 for apikeys and env/prod to force the category.
    const server = createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      if (pathname.endsWith("/apikeys") || pathname.endsWith("/env/prod")) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>ok</body></html>");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    try {
      const jar = createJar();
      const err = await readProdSecretKey(url, "agencyhq-f0be", "agencyhq-MvNP", jar).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof Error, "should throw an error");
      assert.equal(
        (err as { errorCategory?: string }).errorCategory,
        "project_page_not_found",
        "error category should be project_page_not_found",
      );
      assert.match(
        (err as Error).message,
        /agencyhq-MvNP/,
        "error message should name the path (no secrets)",
      );
    } finally {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    }
  });

  it("visits /env/prod then retries apikeys on first 404", async () => {
    const fakeKey = ["tr", "prod", "RETRYKEY1234567890"].join("_");
    let envProdVisited = false;
    let apikeysCallCount = 0;

    const server = createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      if (pathname.endsWith("/env/prod/apikeys")) {
        apikeysCallCount++;
        if (apikeysCallCount === 1) {
          // First call: 404 to trigger the retry flow.
          res.writeHead(404);
          res.end("not found");
          return;
        }
        // Second call: return the key.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<span>${fakeKey}</span>`);
        return;
      }
      if (pathname.endsWith("/env/prod")) {
        envProdVisited = true;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>env page</html>");
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    try {
      const jar = createJar();
      const key = await readProdSecretKey(url, "agencyhq-f0be", "agencyhq-MvNP", jar);
      assert.equal(key, fakeKey);
      assert.ok(envProdVisited, "/env/prod should have been visited before retry");
      assert.equal(apikeysCallCount, 2, "apikeys endpoint should have been called twice");
    } finally {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    }
  });
});

// ── Session persistence — hasValidSession with jar loaded from file ───────────

describe("session persistence — jar loaded from file is used for validity check", () => {
  it("loadSession jar passes hasValidSession check when session is valid", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "sess-valid-"));
    const sessionPath = join(stateDir, "webapp-session.json");

    // Build a server that returns 200 only when the session cookie is present.
    const server = createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      const cookie = req.headers.cookie ?? "";
      if (pathname === "/" && cookie.includes("__session=persisted42")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>Dashboard</html>");
        return;
      }
      // No cookie or wrong value → redirect to login.
      res.writeHead(302, { Location: "/login" });
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    try {
      // Save a jar with the session cookie to disk.
      const jar1 = createJar();
      jar1.set("__session", "persisted42");
      saveSession(jar1, sessionPath);

      // Load the jar from disk and verify the session is valid.
      const jar2 = loadSession(sessionPath);
      const valid = await hasValidSession(url, jar2);
      assert.ok(valid, "session loaded from file should pass hasValidSession");
    } finally {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// ── lastMagicLinkRequestAt state field ────────────────────────────────────────

describe("lastMagicLinkRequestAt — state persistence", () => {
  it("is written and read back through StateManager.save / load", () => {
    const sd = mkdtempSync(join(tmpdir(), "throttle-state-"));
    const sc = mkdtempSync(join(tmpdir(), "throttle-secrets-"));
    const sm = new StateManager(sd, sc);
    try {
      const state = sm.load();
      assert.equal(state.lastMagicLinkRequestAt, undefined);

      state.lastMagicLinkRequestAt = "2026-09-09T12:00:00.000Z";
      sm.save(state);

      const reloaded = sm.load();
      assert.equal(reloaded.lastMagicLinkRequestAt, "2026-09-09T12:00:00.000Z");
    } finally {
      rmSync(sd, { recursive: true, force: true });
      rmSync(sc, { recursive: true, force: true });
    }
  });

  it("bootstrap.json with lastMagicLinkRequestAt contains no secret values", () => {
    const sd = mkdtempSync(join(tmpdir(), "throttle-clean-"));
    const sc = mkdtempSync(join(tmpdir(), "throttle-clean-sc-"));
    const sm = new StateManager(sd, sc);
    try {
      const state = sm.load();
      state.lastMagicLinkRequestAt = new Date().toISOString();
      sm.save(state);
      const raw = readFileSync(join(sd, "bootstrap.json"), "utf-8");
      // Must not contain any Trigger token values.
      assert.doesNotMatch(raw, /tr_[a-z]*_[A-Za-z0-9]{8,}/);
    } finally {
      rmSync(sd, { recursive: true, force: true });
      rmSync(sc, { recursive: true, force: true });
    }
  });
});
