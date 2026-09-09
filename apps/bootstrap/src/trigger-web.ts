/**
 * HTTP client for the Trigger.dev webapp.
 *
 * Drives the same webapp routes bootstrap.sh uses: wait for readiness, request
 * a magic link, establish a session, find-or-create the org/project, read the
 * prod environment secret key, and mint a PAT.
 *
 * Every request and response is logged with secrets and one-time URLs redacted.
 * No third-party dependencies — uses Node's built-in fetch.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Character class for Trigger.dev slug characters.
 * Trigger appends random mixed-case alphanumeric suffixes (e.g. agencyhq-MvNP),
 * so slugs are [A-Za-z0-9_-]+, not the lowercase-only [a-z0-9-] pattern.
 */
const SLUG_CHARS = "A-Za-z0-9_-";

/** Redact Trigger token values and magic-link URLs from a string. */
export function redact(text: string): string {
  return text
    .replace(/tr_[a-z]*_[A-Za-z0-9]{8,}/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s"<>]*\/magic[^\s"<>]*/g, "[MAGIC_URL_REDACTED]");
}

// ── Cookie jar ───────────────────────────────────────────────────────────────

type CookieJar = Map<string, string>;

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Merge Set-Cookie headers from a response into the jar.
 * Uses getSetCookie() so each Set-Cookie directive is handled separately.
 * Overwrites by name; ignores Expires/Max-Age/Path attributes for simplicity.
 */
function mergeCookiesFromResponse(jar: CookieJar, headers: Headers): void {
  for (const cookieStr of headers.getSetCookie()) {
    const nameVal = (cookieStr.split(";")[0] ?? "").trim();
    const eq = nameVal.indexOf("=");
    if (eq < 0) continue;
    const name = nameVal.slice(0, eq).trim();
    const value = nameVal.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[bootstrap:web] ${redact(msg)}`);
}

// ── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Rewrite a magic-link URL (which may use the public LOGIN_ORIGIN) to use
 * the internal webapp URL so the bootstrap container can follow it.
 */
function rewriteToInternal(rawUrl: string, webappUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const base = new URL(webappUrl);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

interface FetchResult {
  status: number;
  url: string;
  text: string;
  headers: Headers;
}

async function doFetch(
  method: string,
  url: string,
  jar: CookieJar,
  body?: URLSearchParams,
  extraHeaders?: Record<string, string>,
): Promise<FetchResult> {
  const MAX_REDIRECTS = 10;
  let currentMethod = method;
  let currentUrl = url;
  let currentBody: URLSearchParams | undefined = body;
  let redirectCount = 0;

  for (;;) {
    const reqHeaders: Record<string, string> = { ...extraHeaders };
    if (jar.size > 0) reqHeaders["Cookie"] = cookieHeader(jar);
    const needsBody = currentMethod !== "GET" && currentMethod !== "HEAD";
    if (needsBody && currentBody) {
      reqHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    }

    log(`→ ${currentMethod} ${currentUrl}`);

    const resp = await fetch(currentUrl, {
      method: currentMethod,
      headers: reqHeaders,
      ...(needsBody && currentBody !== undefined ? { body: currentBody.toString() } : {}),
      redirect: "manual",
    });

    // Merge Set-Cookie from every hop so session cookies set on redirects are captured.
    mergeCookiesFromResponse(jar, resp.headers);

    const isRedirect = resp.status >= 300 && resp.status < 400;
    const location = isRedirect ? resp.headers.get("location") : null;

    if (location !== null && redirectCount < MAX_REDIRECTS) {
      // Resolve relative Location against the current URL.
      currentUrl = new URL(location, currentUrl).toString();
      redirectCount++;

      // RFC 9110 redirect method rules:
      // 303: always switch to GET.
      // 301/302 after POST: switch to GET (common browser behaviour).
      // 307/308: keep original method.
      if (
        resp.status === 303 ||
        ((resp.status === 301 || resp.status === 302) && currentMethod === "POST")
      ) {
        currentMethod = "GET";
        currentBody = undefined;
      }

      // Do NOT consume the body of a redirect response.
      continue;
    }

    // Final response — consume body.
    const text = await resp.text();
    log(`← ${resp.status} ${currentUrl} (${text.length} bytes)`);
    return { status: resp.status, url: currentUrl, text, headers: resp.headers };
  }
}

// ── HTML parsing helpers ─────────────────────────────────────────────────────

function findOrgSlug(html: string, orgPrefix: string): string | null {
  const re = new RegExp(`href="/orgs/(${escapeRe(orgPrefix)}[${SLUG_CHARS}]*)(?:/|")`, "i");
  return re.exec(html)?.[1] ?? null;
}

function findProjectSlug(html: string, orgSlug: string, projectPrefix: string): string | null {
  const re = new RegExp(
    `href="/orgs/${escapeRe(orgSlug)}/projects/(${escapeRe(projectPrefix)}[${SLUG_CHARS}]*)/env/`,
    "i",
  );
  return re.exec(html)?.[1] ?? null;
}

function findProjectRef(html: string): string | null {
  return /\bproj_[A-Za-z0-9]+\b/.exec(html)?.[0] ?? null;
}

function findProdKey(html: string): string | null {
  const decoded = html
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return /\btr_prod_[A-Za-z0-9]+\b/.exec(decoded)?.[0] ?? null;
}

function findPat(text: string): string | null {
  const matches = [...text.matchAll(/\btr_pat_[A-Za-z0-9]+\b/g)].map((m) => m[0]);
  if (!matches.length) return null;
  // Return the longest match (most complete token)
  return matches.reduce((a, b) => (a.length >= b.length ? a : b));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function landingPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ── DNS resolution for deploy (avoid localhost → host.docker.internal rewrite) ─

/**
 * Resolve the hostname in webappUrl to its IP address.
 * Returns a new URL with the IP substituted for the hostname so the Trigger
 * CLI does not rewrite it to host.docker.internal.
 */
export async function resolveWebappIp(webappUrl: string): Promise<string> {
  const parsed = new URL(webappUrl);
  const hostname = parsed.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname === "localhost") {
    return webappUrl; // Already an IP or localhost (caller handles localhost case).
  }
  try {
    const { address } = await dnsLookup(hostname);
    parsed.hostname = address;
    return parsed.toString();
  } catch {
    log(`DNS resolution failed for ${hostname}; using original URL`);
    return webappUrl;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface OrgProject {
  orgSlug: string;
  projectSlug: string;
  projectRef: string;
}

/**
 * Poll GET /healthcheck until the webapp responds 200 or timeoutMs elapses.
 */
export async function waitForReadiness(webappUrl: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${webappUrl}/healthcheck`);
      if (resp.status === 200) {
        log("webapp is ready");
        return;
      }
      lastErr = `HTTP ${resp.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(2000);
  }
  throw new Error(`webapp not ready after ${timeoutMs}ms: ${lastErr}`);
}

/**
 * POST /login/magic to request a magic link for the bootstrap email.
 * Returns HTTP status (expect 302 on success).
 */
export async function requestMagicLink(
  webappUrl: string,
  email: string,
  jar: CookieJar,
): Promise<number> {
  const body = new URLSearchParams({ action: "send", email });
  const r = await doFetch("POST", `${webappUrl}/login/magic`, jar, body);
  return r.status;
}

/**
 * Follow the raw magic-link URL (rewritten to the internal webapp URL),
 * establishing a session cookie. Returns the landing URL path.
 */
export async function followMagicLink(
  rawMagicLink: string,
  webappUrl: string,
  jar: CookieJar,
): Promise<string> {
  const internalLink = rewriteToInternal(rawMagicLink, webappUrl);
  const r = await doFetch("GET", internalLink, jar);
  if (r.status !== 200) {
    throw new Error(`magic link returned HTTP ${r.status}`);
  }
  return landingPath(r.url);
}

/**
 * If the landing page is /confirm-basic-details, POST the account details.
 */
export async function confirmBasicDetailsIfNeeded(
  webappUrl: string,
  email: string,
  jar: CookieJar,
  currentPath: string,
): Promise<string> {
  if (currentPath !== "/confirm-basic-details") return currentPath;
  log("confirming basic details for new account");
  const body = new URLSearchParams({
    name: "AgencyHQ Bootstrap",
    email,
    confirmEmail: email,
  });
  const r = await doFetch("POST", `${webappUrl}/confirm-basic-details`, jar, body);
  return landingPath(r.url);
}

/**
 * Load the dashboard page to scan for existing org/project links.
 */
async function loadDashboard(webappUrl: string, jar: CookieJar): Promise<string> {
  const r = await doFetch("GET", webappUrl, jar);
  return r.text;
}

/**
 * Find or create the org and project by slug prefix. Idempotent.
 */
export async function findOrCreateOrgProject(
  webappUrl: string,
  orgName: string,
  projectName: string,
  jar: CookieJar,
): Promise<OrgProject> {
  const orgPrefix = slugify(orgName);
  const projectPrefix = slugify(projectName);

  const dashboard = await loadDashboard(webappUrl, jar);

  // Try to find both org and project in the dashboard.
  const existingOrgSlug = findOrgSlug(dashboard, orgPrefix);
  let orgSlug: string;

  if (!existingOrgSlug) {
    log(`creating org "${orgName}"`);
    const body = new URLSearchParams({ orgName });
    const r = await doFetch("POST", `${webappUrl}/orgs/new`, jar, body);
    // After creating, the redirect lands on /orgs/<slug>/projects/new
    const createdSlug = /\/orgs\/([A-Za-z0-9_-]+)\/projects\/new/.exec(r.url)?.[1];
    if (!createdSlug) {
      throw new Error(`could not determine org slug after creation (landed: ${r.url})`);
    }
    orgSlug = createdSlug;
    log(`created org slug: ${orgSlug}`);
  } else {
    orgSlug = existingOrgSlug;
    log(`found existing org: ${orgSlug}`);
  }

  // Scan dashboard (or org page) for existing project.
  const existingProjectSlug = findProjectSlug(dashboard, orgSlug, projectPrefix);
  let projectSlug: string;

  if (!existingProjectSlug) {
    log(`creating project "${projectName}" in org "${orgSlug}"`);
    const body = new URLSearchParams({
      projectName,
      projectVersion: "v3",
      workingOn: "[]",
      workingOnPositions: "[]",
      technologies: "[]",
      technologiesOther: "[]",
      goals: "[]",
      goalsPositions: "[]",
    });
    const r = await doFetch("POST", `${webappUrl}/orgs/${orgSlug}/projects/new`, jar, body);
    const createdSlug = /\/orgs\/[A-Za-z0-9_-]+\/projects\/([A-Za-z0-9_-]+)/.exec(r.url)?.[1];
    if (!createdSlug) {
      throw new Error(`could not determine project slug after creation (landed: ${r.url})`);
    }
    projectSlug = createdSlug;
    log(`created project slug: ${projectSlug}`);
    // Extract ref from the creation response HTML.
    const ref = findProjectRef(r.text);
    if (!ref) throw new Error("could not find project ref (proj_...) after project creation");
    return { orgSlug, projectSlug, projectRef: ref };
  } else {
    projectSlug = existingProjectSlug;
    log(`found existing project: ${projectSlug}`);
  }

  // Load the env/prod page to get the project ref.
  const envPage = await doFetch(
    "GET",
    `${webappUrl}/orgs/${orgSlug}/projects/${projectSlug}/env/prod`,
    jar,
  );
  const ref = findProjectRef(envPage.text);
  if (!ref) throw new Error("could not find project ref (proj_...) on env/prod page");

  return { orgSlug, projectSlug, projectRef: ref };
}

/**
 * Read the prod environment secret key (tr_prod_...) from the apikeys page.
 * If the apikeys page returns 404, visits /env/prod first to ensure the env
 * is provisioned, then retries. On a second 404 fails with category
 * `project_page_not_found` naming the path (no secret values in the message).
 */
export async function readProdSecretKey(
  webappUrl: string,
  orgSlug: string,
  projectSlug: string,
  jar: CookieJar,
): Promise<string> {
  const apikeysPath = `/orgs/${orgSlug}/projects/${projectSlug}/env/prod/apikeys`;
  let r = await doFetch("GET", `${webappUrl}${apikeysPath}`, jar);
  if (r.status === 404) {
    // Visit /env/prod to ensure the environment is provisioned, then retry once.
    log(`apikeys page 404; visiting env/prod to provision then retrying`);
    await doFetch("GET", `${webappUrl}/orgs/${orgSlug}/projects/${projectSlug}/env/prod`, jar);
    r = await doFetch("GET", `${webappUrl}${apikeysPath}`, jar);
  }
  if (r.status === 404) {
    throw Object.assign(new Error(`project page not found: ${apikeysPath}`), {
      errorCategory: "project_page_not_found",
    });
  }
  const key = findProdKey(r.text);
  if (!key) throw new Error("could not find prod secret key (tr_prod_...) on apikeys page");
  log("prod secret key found");
  return key;
}

/**
 * Mint a new personal access token (tr_pat_...) via the account tokens route.
 */
export async function mintPAT(
  webappUrl: string,
  tokenName: string,
  jar: CookieJar,
): Promise<string> {
  const body = new URLSearchParams({ action: "create", tokenName });
  const r = await doFetch(
    "POST",
    `${webappUrl}/account/tokens?_data=routes%2Faccount.tokens`,
    jar,
    body,
    { Accept: "application/json" },
  );
  const pat = findPat(r.text);
  if (!pat) throw new Error("could not find PAT (tr_pat_...) in token creation response");
  log("PAT created");
  return pat;
}

/**
 * Request a fresh magic link and return the raw URL (for dashboard-link command).
 * The caller prints this to stdout only.
 */
export async function requestFreshMagicLinkUrl(webappUrl: string, email: string): Promise<string> {
  const jar: CookieJar = new Map();
  const status = await requestMagicLink(webappUrl, email, jar);
  if (status !== 200 && status !== 302) {
    throw new Error(`magic link request returned HTTP ${status}`);
  }
  // The URL is in the SMTP sink in normal flow; for dashboard-link we can't
  // capture it here without an SMTP sink. Return a note for the caller.
  throw new Error(
    "dashboard-link requires the SMTP sink to capture the URL; " +
      "the bootstrap SMTP sink (port 2525) must be running to intercept the email.",
  );
}

/**
 * Check whether the current cookie jar holds a valid webapp session.
 * Performs GET / and returns true if the final URL is NOT a /login page.
 * Returns false when the server redirects to /login (session absent or expired).
 */
export async function hasValidSession(webappUrl: string, jar: CookieJar): Promise<boolean> {
  const r = await doFetch("GET", webappUrl, jar);
  try {
    const finalPath = new URL(r.url).pathname;
    return !finalPath.startsWith("/login");
  } catch {
    return false;
  }
}

/** Create a fresh cookie jar. */
export function createJar(): CookieJar {
  return new Map();
}

/**
 * Serialise the cookie jar to a JSON file at sessionPath (mode 0600).
 * The file is treated as secret — never log its path or contents.
 */
export function saveSession(jar: CookieJar, sessionPath: string): void {
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, JSON.stringify(Object.fromEntries(jar)), { mode: 0o600 });
}

/**
 * Load a previously-saved session file into a new cookie jar.
 * Returns an empty jar if the file does not exist or cannot be parsed.
 */
export function loadSession(sessionPath: string): CookieJar {
  const jar: CookieJar = new Map();
  if (!existsSync(sessionPath)) return jar;
  try {
    const obj = JSON.parse(readFileSync(sessionPath, "utf-8")) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === "string" && typeof v === "string") jar.set(k, v);
    }
  } catch {
    // Corrupt file — return empty jar; caller will re-login.
  }
  return jar;
}

/**
 * Delete a persisted session file (idempotent, best-effort).
 */
export function deleteSession(sessionPath: string): void {
  try {
    if (existsSync(sessionPath)) unlinkSync(sessionPath);
  } catch {
    // Best-effort.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
