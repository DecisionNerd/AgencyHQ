# Trigger.dev task adapters

Task definitions run by `trigger dev` on the OpenCode host (host profile) and,
later, by the deployed supervisor from a task image (container profile).
Tasks: `lead.plan`, `worker.attempt`, `verify.run`, `lead.review`,
`lead.accept`, `integrate.merge`. Each is a thin adapter with no policy: it
does the work, reports progress through run metadata, returns structured
output, and throws `AbortTaskRunError` on contract failures so Trigger does
not retry them. `worker.attempt` performs the worktree-scrub-run-diff-commit
sequence and the `onCancel` checkpoint-and-kill sequence in ADR-0007. Pin the
Trigger image, SDK/CLI, and OpenCode versions together.

## Running

The `@agencyhq/trigger` workspace package pins `@trigger.dev/sdk` and
`trigger.dev` at `4.5.16`. `trigger.config.ts` declares the project ref (from
`TRIGGER_PROJECT_REF`), task directory (`./src/tasks`), Node runtime,
`maxDuration: 900`, and single-attempt retries with `enabledInDev: false`.

`src/tasks/spike-echo.ts` defines a single throwaway task, `spike.echo`,
that echoes its payload message alongside the sorted environment variable
key list and the running Node version — used to inspect what a task process
can see under the host profile. `scripts/echo.ts` triggers that task against
a running Trigger instance (`TRIGGER_API_URL`, `TRIGGER_SECRET_KEY`) and
polls `runs.retrieve` for a final status. `test/smoke.test.ts` is a
`node --test` smoke check that the package's types import cleanly under
Node's built-in TypeScript type stripping.

See `.env.example` for the environment variables these scripts and
`trigger dev` expect.

## Libraries

`src/lib/**` holds pure adapter functions for the `worker.attempt` effect
model (ADR-0007): no Trigger SDK usage, node built-ins only.

- `git.ts`: `worktreeAdd`, `worktreeRemove`, `commitTree` (adapter commits,
  `agencyhq` identity, returns `null` when there is nothing to commit),
  `updateRef`, `changedPaths` (tracked diff plus untracked files),
  `diffDigest` (deterministic sha256 over the diff and untracked contents),
  and `revertPaths` (restores or deletes listed paths back to a base
  revision, for quarantine).
- `env.ts`: `scrubbedChildEnv` builds an allowlisted child environment
  (`HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_*`,
  `TMPDIR`, plus `AGENCYHQ_ATTEMPT_ID` and the `GIT_*` overrides that empty
  the credential helper and disable prompting/SSH); `assertPushBlocked` is
  the before-action control that proves a scrubbed env cannot push.
- `paths.ts`: a minimal glob matcher (`*`, `**`, `?`, exact) plus
  `classifyPaths` (allow/violation split against `paths.allow`, rejecting
  `..` and absolute paths) and `quarantinePatch` (captures violating paths
  as a diff/patch for the record before they are reverted).
- `procs.ts`: `descendants`, `killTree` (SIGTERM the process group and every
  descendant, wait out the grace period, then SIGKILL survivors), and
  `survivorScan` (finds any process still tagged with an attempt's
  `AGENCYHQ_ATTEMPT_ID`) for the stop sequence in EXECUTION_MODEL.md.
- `opencode.ts`: `buildPermissionRuleset` and `writeRunConfig` produce the
  worker's permission ruleset and `opencode.worker.json`; `spawnOpenCode`
  runs `opencode run --format json` as a detached process group against a
  worktree with the scrubbed env, `OPENCODE_DISABLE_PROJECT_CONFIG`,
  `--pure`, and `OPENCODE_PERMISSION`, streaming events and stderr to the
  run directory; `parseEvents`/`summarize` reduce the NDJSON stream to
  denials, errors, tool uses, and a text tail. See the file's header comment
  for the OpenCode CLI/config/permission facts this encodes and their
  source dates, and for what the required smoke run actually observed.

`scripts/opencode-smoke.ts` exercises `opencode.ts` end to end against a
disposable temp fixture repo and worktree: an allowed edit, three
escape-path attempts, a `git push`, and a `task`-tool attempt, run once each.
