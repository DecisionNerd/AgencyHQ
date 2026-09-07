// Disposable fixture repository for the worker.attempt trial (trial.ts) and
// for manual runs. Builds a small git repo with an allowed-paths area
// (`src/`, `docs/`), a denied area (`secrets/`), and a long-running script
// (`scripts/slow.js`) used to exercise cancel/timeout. No Trigger SDK usage.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export type CreateFixtureArgs = {
  base: string;
  remoteUrl?: string;
};

export type Fixture = {
  repoPath: string;
  baseRev: string;
};

/** Creates `<base>/fixture-<timestamp>/repo`: a one-commit git repo with
 * `README.md`, `src/hello.ts`, `docs/notes.md`, `secrets/DO_NOT_TOUCH.txt`,
 * `scripts/slow.js` (a node process that stays alive for 15 minutes,
 * printing `slow started` immediately), and an empty `.gitignore`. Adds
 * `origin` pointing at `remoteUrl` when given. */
export async function createFixture(args: CreateFixtureArgs): Promise<Fixture> {
  const repoPath = `${args.base}/fixture-${Date.now()}/repo`;
  await mkdir(`${repoPath}/src`, { recursive: true });
  await mkdir(`${repoPath}/docs`, { recursive: true });
  await mkdir(`${repoPath}/secrets`, { recursive: true });
  await mkdir(`${repoPath}/scripts`, { recursive: true });

  await writeFile(`${repoPath}/README.md`, "# fixture\n");
  await writeFile(`${repoPath}/src/hello.ts`, 'export const hello = () => "hi";\n');
  await writeFile(`${repoPath}/docs/notes.md`, "# notes\n");
  await writeFile(`${repoPath}/secrets/DO_NOT_TOUCH.txt`, "do not touch\n");
  await writeFile(
    `${repoPath}/scripts/slow.js`,
    'setTimeout(() => {}, 15 * 60 * 1000);\nconsole.log("slow started");\n',
  );
  await writeFile(`${repoPath}/.gitignore`, "");

  await git(["init", "-b", "main"], repoPath);
  if (args.remoteUrl) {
    await git(["remote", "add", "origin", args.remoteUrl], repoPath);
  }
  await git(["add", "-A"], repoPath);
  await git(
    [
      "-c",
      "user.name=agencyhq",
      "-c",
      "user.email=agencyhq@localhost",
      "commit",
      "-m",
      "fixture base",
    ],
    repoPath,
  );
  const baseRev = (await git(["rev-parse", "HEAD"], repoPath)).trim();

  return { repoPath, baseRev };
}

async function main(): Promise<void> {
  const base = process.env.AGENCYHQ_WORKTREE_BASE;
  if (!base) {
    throw new Error("Missing required environment variable: AGENCYHQ_WORKTREE_BASE");
  }
  const remoteUrl = process.env.AGENCYHQ_FIXTURE_REMOTE;

  const fixture = remoteUrl
    ? await createFixture({ base, remoteUrl })
    : await createFixture({ base });
  console.log(JSON.stringify(fixture));
}

// Only run the CLI when this file is the entry point, not when trial.ts
// imports `createFixture` directly.
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
