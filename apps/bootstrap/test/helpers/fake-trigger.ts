/**
 * Creates a temporary `trigger` binary shim on a PATH-prepended directory for tests.
 * The shim script exits 0 by default; call setFail() to make it exit non-zero.
 *
 * Uses only node:fs, node:os, node:path.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeTrigger {
  /** Directory containing the fake `trigger` binary (prepend to PATH). */
  binDir: string;
  /** Call to make subsequent invocations exit 1 with a message. */
  setFail(message: string): void;
  /** Restore original exit-0 behaviour. */
  setPass(): void;
  /** Remove the temp directory. */
  cleanup(): void;
}

export function createFakeTrigger(): FakeTrigger {
  const binDir = mkdtempSync(join(tmpdir(), "fake-trigger-"));
  const scriptPath = join(binDir, "trigger");
  const flagPath = join(binDir, "trigger-fail.txt");

  function writeScript(): void {
    const script = [
      "#!/bin/sh",
      `if [ -f "${flagPath}" ]; then`,
      `  cat "${flagPath}" >&2`,
      "  exit 1",
      "fi",
      `echo "trigger deploy: success (fake)"`,
      "exit 0",
    ].join("\n");
    writeFileSync(scriptPath, script + "\n", { mode: 0o755 });
    chmodSync(scriptPath, 0o755);
  }

  writeScript();

  return {
    binDir,

    setFail(message: string): void {
      writeFileSync(flagPath, message + "\n");
    },

    setPass(): void {
      if (existsSync(flagPath)) rmSync(flagPath);
    },

    cleanup(): void {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

/** Return a copy of process.env with binDir prepended to PATH. */
export function envWithFakeTrigger(binDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
  };
}
