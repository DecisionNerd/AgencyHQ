# Verification package

Verification profile definitions, the check catalog, and VerificationResult
construction used by the `verify.run` task. Profiles are frozen into the
StepContract by digest before dispatch and are never in a worker's writable
tree. A VerificationResult is evidence; acceptance is a coordinator decision.

## Package

Package name: `@agencyhq/verification`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite with `node --test`.

## Implementation

`src/checks.ts` defines `CheckDef` and `CHECK_CATALOG` with seven entries: `pnpm-typecheck@1`, `pnpm-test@1`, `pnpm-check@1`, `node-test@1`, `git-diff-clean@1`, `manifest-consumer@1`, and `pnpm-install@1`. Each def carries id, version, command, timeout, and an optional `passWhen` predicate (used by `git-diff-clean@1` to pass on empty stdout). `manifest-consumer@1` spawns `src/manifest-consumer-cmd.mjs` via node; that script first asserts that at least one `AGENCYHQ_MANIFEST_<N>` env var is set and points to an existing directory (fails with reason `manifest_missing` if absent; fails with `manifest_path_not_found` if the path is not a directory), then records the manifest positions and paths as evidence lines in stdout, and finally runs `pnpm test` in the current working directory. `pnpm-install@1` runs `pnpm install --frozen-lockfile`; it fails when the lockfile is out of date with package.json, which is intentional: a worker that changed package.json without updating the lockfile must fail verification here.

`src/profiles.ts` defines `VerificationProfile` and `PROFILE_CATALOG` with six entries. The v1 profiles (`node-pnpm-v1`, `docs-check-v1`, `minimal-v1`, `multi-repo-v1`) are frozen — existing StepContracts reference their digests and must continue to resolve without change. The v2 profiles (`node-pnpm-v2`, `multi-repo-v2`) were added 2026-09-08 and prepend `pnpm-install@1` so that fresh git worktrees always install dependencies explicitly before typecheck or test runs. `node-pnpm-v2` runs `pnpm-install@1`, `pnpm-typecheck@1`, then `pnpm-test@1`; use it for new StepContracts on Node/pnpm repositories. `multi-repo-v2` runs `pnpm-install@1`, `pnpm-typecheck@1`, then `manifest-consumer@1`; use it when the coordinator has assembled a manifest of sibling worktrees and the check environment must assert cross-repo consistency (R-006, R-014). All profiles use `DEFAULT_PROTECTED_PATHS`. `profileDigest(profile)` hashes a canonical object that includes resolved check versions from the catalog, so the digest changes when any check is bumped. `resolveProfile(id)` looks up by id and throws on unknown ids. Each profile's `protectedPaths` covers verifier-configuration files only (package manifests, lock files, workspace file, tsconfig*, biome.json, .github/**, vitest/jest configs); test source files are not protected — changes to tests are governed by the contract's `paths.allow` and the adversarial review, not by tampering detection. A change to a protected path produces a blocking `verifier_tampered` Finding; `evaluateAcceptance` rejects with reason `VERIFIER_TAMPERED` when any such finding is present, independently of the review.

`src/runner.ts` exports `runCheck(def, opts)`, which spawns the command as a detached process group, captures the last `maxBytes` (default 16 384) of stdout and stderr via a ring buffer, and kills the process group with SIGTERM (then SIGKILL after 2 s) on timeout. It never throws on non-zero exit.

`src/fingerprint.ts` exports `environmentFingerprint(cwd)`, which returns a map with keys `node`, `pnpm`, `git`, `os`, and `arch`. Missing tools are recorded as `"unavailable"`.

`src/result.ts` exports `buildVerificationResult(input)`, which derives `result` from the run observation (`"error"` on timeout or null exit, `"pass"` or `"fail"` via the check's `passWhen` predicate or exit status 0) and validates the record through `VerificationResultSchema.parse` before returning.

`src/run-profile.ts` exports `runProfile(input)`, which runs all checks in a profile sequentially (regardless of individual failures) and returns one `VerificationResult` per check.

All modules are re-exported from `src/index.ts`. The package depends only on `@agencyhq/contracts` and `@agencyhq/domain`.

## Trial

`verify.run` used the profiles and result builder from this package in the Slice 3 trial on 2026-09-07. Both `pnpm-typecheck@1` and `pnpm-test@1` checks passed on the fixture parser at attempt revision `63a2eb1029468b81af5c3ed2c71fb2bd1b970308`. See [docs/engineering/trials/2026-09-slice3.md](../../docs/engineering/trials/2026-09-slice3.md).

Slice 6 trial (2026-09-08): v2 profiles (`node-pnpm-v2`, `multi-repo-v2`) prepend `pnpm-install@1` — added after defect 3 was found live (`pnpm-typecheck@1` failed in all four first-pair runs because node_modules were absent in the task process; run_cmtt5usml, 709154c). With `node-pnpm-v2`, the same attempt passed install, typecheck, and test in a single `verify.run` task process (run_cmtt6awoj). The v1 profiles are frozen; existing StepContracts continue to resolve against them without change. See [docs/engineering/trials/2026-09-slice6.md](../../docs/engineering/trials/2026-09-slice6.md).
