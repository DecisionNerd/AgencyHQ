# infra/tests — container integration test helpers

This directory holds documentation for live integration tests that require a running
Trigger instance and a deployed task image.  The scripts themselves are in
`trigger/scripts/` (where `@trigger.dev/sdk` resolves from the `@agencyhq/trigger`
package's node_modules).

## Image smoke script (L1)

**Script:** `trigger/scripts/image-smoke.ts`
**Purpose:** #16 BDD 1-3 — proves the deployed task image toolchain works.
**Run by:** Fable-main during the L1 qualification step (not by Sonnet workers).

### Required environment variables (L1 run command)

```
TRIGGER_API_URL          Trigger webapp URL, e.g. http://127.0.0.1:8030
TRIGGER_SECRET_KEY       Trigger prod environment secret key
AGENCYHQ_FIXTURE_REMOTE  Public https git URL of the fixture repository
AGENCYHQ_FIXTURE_REVISION Git revision (branch, tag, or commit SHA) to check out
```

The script refuses to run if any of these four names are absent or empty.
It prints the missing names (never the values) and exits 1.

### Optional environment variables

```
AGENCYHQ_PLATFORM  Expected task container platform, default "linux/arm64"
```

### Example L1 command

```sh
cd trigger
node --import tsx/esm scripts/image-smoke.ts \
  2>image-smoke-diag.txt | tee image-smoke-report.json
echo "exit: $?"
```

Or with an `.env` file (Trigger SDK reads `TRIGGER_SECRET_KEY` from env):

```sh
node --env-file .env --import tsx/esm scripts/image-smoke.ts
```

### What the script proves (for C1 / #16)

1. **runtime.probe passed:** the task image has git, opencode@`OPENCODE_VERSION`,
   pnpm@`PNPM_VERSION`, and node v24.x on PATH; uid is 1000; HOME and
   `AGENCYHQ_RUN_ROOT` are writable; the platform matches `AGENCYHQ_PLATFORM`;
   no secret env keys (SSH_AUTH_SOCK, GH_TOKEN, GITHUB_TOKEN, AWS_*) are
   present in the task environment.

2. **image.smoke passed:** the `fixture-node-v1` verification profile
   (`pnpm-install@1`, `pnpm-typecheck@1`, `pnpm-test@1`) ran to completion
   against a fresh git clone of the public fixture repository inside the
   container.  This proves the installed toolchain can install a real project's
   dependencies from a lockfile and pass its typecheck and test suites.

### What the script does NOT prove

- **No coordinator:** the script talks to Trigger directly; no AgencyHQ
  coordinator is involved and no work items, projects, or attempts are created.
- **No Lead or authority:** only the diagnostic probe and the fixture smoke run;
  no bounded repair, review, or approval.
- **No provider credentials:** no OpenCode auth, API keys, or lease broker are
  exercised.
- **No artifact transport:** no git bundles, manifests, or CAS integration.
- **No private repositories:** the fixture must be publicly accessible.

Full qualification (C1-C7) requires L1-L4 with all components running.

### Output

On success, the script prints a compact JSON report to stdout:

```json
{
  "timestamp": "<ISO-8601>",
  "totalMs": 42000,
  "probe": {
    "runId": "run_...",
    "status": "COMPLETED",
    "durationMs": 8000,
    "tools": { "git": "git version 2.43.0", "opencode": "1.18.29", ... },
    "uid": "1000",
    "platform": "linux/arm64",
    "homeWritable": true,
    "runRootWritable": true
  },
  "smoke": {
    "runId": "run_...",
    "status": "COMPLETED",
    "durationMs": 34000,
    "profileId": "fixture-node-v1",
    "results": [
      { "checkId": "pnpm-install@1", "passed": true, "exitStatus": 0, "timedOut": false },
      { "checkId": "pnpm-typecheck@1", "passed": true, "exitStatus": 0, "timedOut": false },
      { "checkId": "pnpm-test@1", "passed": true, "exitStatus": 0, "timedOut": false }
    ]
  }
}
```

Diagnostic messages (non-secret) are written to stderr.

On failure, the script exits non-zero and prints the failing assertion name to
stderr.  Env variable values are never printed.

### Negative case (#16 BDD 3)

If any tool is missing (e.g. opencode is "unavailable: ...") or any check
fails, the script exits non-zero and names the specific failing assertion:

```
assertion failed: opencode is unavailable in the task image
```

This proves that image qualification is not silently bypassed.
