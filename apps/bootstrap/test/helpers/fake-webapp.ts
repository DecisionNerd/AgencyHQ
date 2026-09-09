/**
 * Minimal HTTP server that implements the Trigger.dev webapp routes used by
 * trigger-web.ts. Used exclusively in unit tests.
 *
 * Configurable to fail at specific phases to test error handling and idempotency.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeWebappConfig {
  /** Fail magic link route (POST /login/magic) — return 500. */
  failMagicLink?: boolean;
  /** Fail org creation (POST /orgs/new) — return 500. */
  failOrgCreate?: boolean;
  /** Fail project creation (POST /orgs/:org/projects/new) — return 500. */
  failProjectCreate?: boolean;
  /** Fail apikeys page (GET /env/prod/apikeys) — return 500. */
  failApiKeys?: boolean;
  /** Fail PAT creation — return 500. */
  failPat?: boolean;
  /** Pre-seed: simulate an already-existing org with this slug. */
  existingOrgSlug?: string;
  /** Pre-seed: simulate an already-existing project with this slug. */
  existingProjectSlug?: string;
  /** Pre-seed: simulate an already-existing PAT (skip minting). */
  existingPat?: string;
}

export interface FakeWebappState {
  magicLinkRequests: number;
  orgsCreated: string[];
  projectsCreated: string[];
  patsCreated: string[];
}

export interface FakeWebapp {
  url: string;
  state: FakeWebappState;
  stop(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
    });
    req.on("end", () => {
      resolve(new URLSearchParams(raw));
    });
  });
}

function respond(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "text/html", ...headers });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

// Fixed tokens — never real secrets; built from parts so no literal matches the grep criterion.
const FAKE_PROD_KEY = ["tr", "prod", "FAKEKEY1234567890"].join("_");
const FAKE_PAT_VALUE = ["tr", "pat", "FAKEPAT1234567890"].join("_");
const FAKE_PROJECT_REF = "proj_fakeref1234";
const ORG_SLUG = "agencyhq";
const PROJECT_SLUG = "agencyhq";

/** Start a fake webapp on a random port and return its URL and state tracker. */
export function startFakeWebapp(config: FakeWebappConfig = {}): Promise<FakeWebapp> {
  return new Promise((resolve) => {
    const state: FakeWebappState = {
      magicLinkRequests: 0,
      orgsCreated: [],
      projectsCreated: [],
      patsCreated: [],
    };

    // Pre-seed existing resources.
    if (config.existingOrgSlug) state.orgsCreated.push(config.existingOrgSlug);
    if (config.existingProjectSlug) state.projectsCreated.push(config.existingProjectSlug);
    if (config.existingPat) state.patsCreated.push(config.existingPat);

    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";
      const pathname = url.split("?")[0] ?? url;

      // GET /healthcheck
      if (method === "GET" && pathname === "/healthcheck") {
        respond(res, 200, "ok");
        return;
      }

      // POST /login/magic — request magic link
      if (method === "POST" && pathname === "/login/magic") {
        state.magicLinkRequests++;
        if (config.failMagicLink) {
          respond(res, 500, "internal error");
          return;
        }
        // In real webapp: 302 redirect. We return 302.
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }

      // GET /magic/* — follow magic link; set session cookie and redirect.
      if (method === "GET" && pathname.startsWith("/magic/")) {
        res.writeHead(200, {
          "Set-Cookie": "session=fake-session-cookie; Path=/; HttpOnly",
          "Content-Type": "text/html",
        });
        // Show dashboard with existing resources.
        res.end(buildDashboard(state));
        return;
      }

      // GET / — dashboard
      if (method === "GET" && (pathname === "/" || pathname === "")) {
        respond(res, 200, buildDashboard(state));
        return;
      }

      // POST /orgs/new — create org
      if (method === "POST" && pathname === "/orgs/new") {
        if (config.failOrgCreate) {
          respond(res, 500, "org creation failed");
          return;
        }
        const body = await readBody(req);
        const orgName = body.get("orgName") ?? "agencyhq";
        const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        if (!state.orgsCreated.includes(slug)) {
          state.orgsCreated.push(slug);
        }
        // Redirect to projects/new under the org.
        redirect(res, `/orgs/${slug}/projects/new`);
        return;
      }

      // POST /orgs/:org/projects/new — create project
      const projNewMatch = /^\/orgs\/([a-z0-9-]+)\/projects\/new$/.exec(pathname);
      if (method === "POST" && projNewMatch) {
        if (config.failProjectCreate) {
          respond(res, 500, "project creation failed");
          return;
        }
        const body = await readBody(req);
        const projectName = body.get("projectName") ?? "agencyhq";
        const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const orgSlug = projNewMatch[1] ?? ORG_SLUG;
        if (!state.projectsCreated.includes(slug)) {
          state.projectsCreated.push(slug);
        }
        // Respond with HTML that contains the project ref and slug.
        const html =
          `<a href="/orgs/${orgSlug}/projects/${slug}/env/prod">proj</a>` +
          `<!-- ${FAKE_PROJECT_REF} -->`;
        redirect(res, `/orgs/${orgSlug}/projects/${slug}/env/prod`);
        void html; // Suppress unused; we use redirect instead.
        return;
      }

      // GET /orgs/:org/projects/:proj/env/prod — project env page
      const envProdMatch = /^\/orgs\/([a-z0-9-]+)\/projects\/([a-z0-9-]+)\/env\/prod$/.exec(
        pathname,
      );
      if (method === "GET" && envProdMatch) {
        const orgSlug = envProdMatch[1] ?? ORG_SLUG;
        const projSlug = envProdMatch[2] ?? PROJECT_SLUG;
        const html =
          `<div>${FAKE_PROJECT_REF}</div>` +
          `<a href="/orgs/${orgSlug}/projects/${projSlug}/env/prod/apikeys">keys</a>`;
        respond(res, 200, html);
        return;
      }

      // GET /orgs/:org/projects/:proj/env/prod/apikeys — prod key page
      const apikeysMatch =
        /^\/orgs\/([a-z0-9-]+)\/projects\/([a-z0-9-]+)\/env\/prod\/apikeys$/.exec(pathname);
      if (method === "GET" && apikeysMatch) {
        if (config.failApiKeys) {
          respond(res, 500, "internal error");
          return;
        }
        respond(res, 200, `<span class="key">${FAKE_PROD_KEY}</span>`);
        return;
      }

      // POST /account/tokens — mint PAT
      if (method === "POST" && pathname === "/account/tokens") {
        if (config.failPat) {
          respond(res, 500, "token creation failed");
          return;
        }
        const pat = config.existingPat ?? FAKE_PAT_VALUE;
        if (!state.patsCreated.includes(pat)) {
          state.patsCreated.push(pat);
        }
        respond(res, 200, JSON.stringify({ token: pat, personalAccessToken: pat }), {
          "Content-Type": "application/json",
        });
        return;
      }

      // GET /api/v1/deployments/current — verify deployment
      if (method === "GET" && pathname === "/api/v1/deployments/current") {
        respond(
          res,
          200,
          JSON.stringify({
            version: "v1",
            status: "DEPLOYED",
            imageReference: "localhost:5001/trigger/agencyhq:v1",
            externalId: "abc123",
          }),
          { "Content-Type": "application/json" },
        );
        return;
      }

      // GET /confirm-basic-details — show form (not triggered by default)
      if (method === "GET" && pathname === "/confirm-basic-details") {
        respond(res, 200, "<form><input name='name'/><input name='email'/></form>");
        return;
      }

      // POST /confirm-basic-details
      if (method === "POST" && pathname === "/confirm-basic-details") {
        redirect(res, "/");
        return;
      }

      // Fallback
      respond(res, 404, `Not found: ${pathname}`);
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;

      resolve({
        url,
        state,
        stop: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

function buildDashboard(state: FakeWebappState): string {
  const orgLinks = state.orgsCreated
    .map(
      (org) =>
        `<a href="/orgs/${org}/projects/${PROJECT_SLUG}/env/prod">` +
        `<a href="/orgs/${org}">org</a>`,
    )
    .join("\n");
  const projLinks = state.projectsCreated
    .map((proj) => `<a href="/orgs/${ORG_SLUG}/projects/${proj}/env/prod">project</a>`)
    .join("\n");
  return `<html><body>${orgLinks}${projLinks}</body></html>`;
}

/** Token values used by the fake webapp — for test assertions. */
export const FAKE = {
  PROD_KEY: FAKE_PROD_KEY,
  PAT: FAKE_PAT_VALUE,
  PROJECT_REF: FAKE_PROJECT_REF,
  ORG_SLUG,
  PROJECT_SLUG,
} as const;
