/**
 * Check catalog for @agencyhq/verification.
 *
 * Each CheckDef describes a single verifiable check: the command to run,
 * its timeout, an optional working-directory override, an optional stdout
 * normaliser (applied before ring-buffer trimming), and an optional
 * pass-when predicate (defaults to exit status 0).
 */

/** Minimal run summary passed to passWhen. */
export interface RunSummary {
  exitStatus: number | null;
  stdoutTail: string;
  stderrTail: string;
}

export type CheckDef = {
  /** Catalog identifier, e.g. "pnpm-typecheck@1". */
  id: string;
  /** Semver-like version string, e.g. "1". */
  version: string;
  /** Argv: executable + arguments. */
  command: string[];
  /** Wall-clock timeout in seconds. */
  timeoutSeconds: number;
  /** Override the spawn cwd (defaults to the opts.cwd passed to runCheck). */
  cwd?: string | undefined;
  /** Transform stdout before storage (e.g. strip noise). */
  normalize?: ((stdout: string) => string) | undefined;
  /**
   * Custom pass predicate.  When absent, exit status 0 means pass.
   * When present, the check passes iff this returns true.
   */
  passWhen?: ((r: RunSummary) => boolean) | undefined;
};

export const CHECK_CATALOG: Record<string, CheckDef> = {
  "pnpm-typecheck@1": {
    id: "pnpm-typecheck@1",
    version: "1",
    command: ["pnpm", "typecheck"],
    timeoutSeconds: 600,
  },
  "pnpm-test@1": {
    id: "pnpm-test@1",
    version: "1",
    command: ["pnpm", "test"],
    timeoutSeconds: 900,
  },
  "pnpm-check@1": {
    id: "pnpm-check@1",
    version: "1",
    command: ["pnpm", "check"],
    timeoutSeconds: 300,
  },
  "node-test@1": {
    id: "node-test@1",
    version: "1",
    command: ["node", "--test"],
    timeoutSeconds: 900,
  },
  "git-diff-clean@1": {
    id: "git-diff-clean@1",
    version: "1",
    command: ["git", "status", "--porcelain"],
    timeoutSeconds: 60,
    /** Pass iff stdout is empty (no untracked/modified files). */
    passWhen: (r) => r.stdoutTail.trim() === "",
  },
};
