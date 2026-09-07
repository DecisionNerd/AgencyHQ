/**
 * Seed script: insert a Project and WorkItem for local development / trials.
 *
 * Usage:
 *   node --env-file=../../.env scripts/seed.ts \
 *     --repo <path> \
 *     --intent "<text>" \
 *     [--defect "<text>"] \
 *     [--authority host-trial]
 *
 * Idempotent: reuses the existing project row when the clonePath matches.
 * Prints JSON { projectId, workItemId } to stdout.
 */

import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import { createPool, insertProject, insertWorkItem, runMigrations } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): {
  repo: string;
  intent: string;
  defect?: string;
  authority: string;
} {
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const repo = get("--repo");
  const intent = get("--intent");
  const defect = get("--defect");
  const authority = get("--authority") ?? "host-trial";

  if (!repo) {
    console.error(
      "Usage: seed.ts --repo <path> --intent <text> [--defect <text>] [--authority host-trial]",
    );
    process.exit(1);
  }
  if (!intent) {
    console.error("Error: --intent is required");
    process.exit(1);
  }

  return { repo, intent, defect, authority };
}

const { repo, intent, defect, authority } = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Resolve remote URL from git
// ---------------------------------------------------------------------------

async function resolveRemote(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL is required");
  process.exit(1);
}

const worktreeBase = process.env.AGENCYHQ_WORKTREE_BASE ?? process.env.WORKTREE_BASE;
if (!worktreeBase) {
  console.error("Error: AGENCYHQ_WORKTREE_BASE is required");
  process.exit(1);
}

const pool = createPool(databaseUrl);
const client = await pool.connect();

try {
  await runMigrations(client);

  // Check for existing project with the same clonePath (idempotency)
  const { rows: existingProjects } = await client.query<{ id: string }>(
    "SELECT id FROM projects WHERE clone_path = $1 LIMIT 1",
    [repo],
  );

  let projectId: string;
  if (existingProjects.length > 0 && existingProjects[0]) {
    projectId = existingProjects[0].id;
  } else {
    // Resolve remote URL
    const remote = await resolveRemote(repo);

    projectId = newId("prj");
    const headRevision = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await insertProject(client, {
      id: projectId,
      remote: remote,
      clone_path: repo,
      worktree_base: worktreeBase,
      allowed_refs: { main: headRevision },
      profile_catalog: ["node-pnpm-v1", "minimal-v1"],
      authority: authority === "host-trial" ? HOST_TRIAL_AUTHORITY : HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
  }

  // Insert a WorkItem
  const workItemId = newId("wi");
  await insertWorkItem(client, {
    id: workItemId,
    project_id: projectId,
    rank: 1,
    intent,
    defect: defect ?? null,
    boundary: "artifact",
    lifecycle: "admitted",
    condition: "healthy",
    main_effort: true,
    version: 1,
  });

  console.log(JSON.stringify({ projectId, workItemId }));
} finally {
  client.release();
  await pool.end();
}
