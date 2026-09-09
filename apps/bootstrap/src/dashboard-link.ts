/**
 * dashboard-link core logic — extracted from cli.ts so tests can import it
 * without triggering cli.ts's top-level process.argv / process.exit side effects.
 */
import type { CookieJar } from "./run.ts";
import type { MagicLinkResult } from "./trigger-web.ts";

export type DashboardLinkDeps = {
  webappUrl: string;
  email: string;
  smtpPort: number;
  sessionFile: string;
  loadSession: (path: string) => CookieJar;
  startSmtpSink: (opts: {
    port: number;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<{ magicLink: string; stop: () => void }>;
  requestMagicLink: (url: string, email: string, jar: CookieJar) => Promise<MagicLinkResult>;
  sleep: (ms: number) => Promise<void>;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  exit: (code: number) => never;
};

/**
 * Request a fresh magic link and print only the URL to stdout.
 * Never follows the link. On rate limit: print reset time to stderr and exit 1.
 * Exported so tests can drive it with fakes.
 */
export async function runDashboardLink(deps: DashboardLinkDeps): Promise<void> {
  const jar = deps.loadSession(deps.sessionFile);
  const abort = new AbortController();
  const sinkPromise = deps.startSmtpSink({
    port: deps.smtpPort,
    timeoutMs: 60_000,
    signal: abort.signal,
  });
  await deps.sleep(200);
  let mlResult: MagicLinkResult;
  try {
    mlResult = await deps.requestMagicLink(deps.webappUrl, deps.email, jar);
  } catch (mlErr) {
    sinkPromise.catch(() => {});
    abort.abort();
    throw mlErr;
  }
  if (mlResult.kind === "rate_limited") {
    sinkPromise.catch(() => {});
    abort.abort();
    const resetMsg =
      mlResult.resetAt !== null
        ? `rate limit resets at ${new Date(mlResult.resetAt).toISOString()}`
        : "rate limit reset time unknown";
    deps.stderr(`[bootstrap] dashboard-link: magic link rate limited; ${resetMsg}\n`);
    deps.exit(1);
  }
  const sinkResult = await sinkPromise;
  sinkResult.stop();
  // Print to stdout only — not to logs (link is a one-time URL).
  deps.stdout(`${sinkResult.magicLink}\n`);
}
