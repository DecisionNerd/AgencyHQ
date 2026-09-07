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
