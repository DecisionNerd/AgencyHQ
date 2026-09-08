# Verification package

Verification profile definitions, the check catalog, and VerificationResult
construction used by the `verify.run` task. Profiles are frozen into the
StepContract by digest before dispatch and are never in a worker's writable
tree. A VerificationResult is evidence; acceptance is a coordinator decision.

## Package

Package name: `@agencyhq/verification`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite with `node --test`.

## Implementation

`src/checks.ts` defines `CheckDef` and `CHECK_CATALOG` with five entries: `pnpm-typecheck@1`, `pnpm-test@1`, `pnpm-check@1`, `node-test@1`, and `git-diff-clean@1`. Each def carries id, version, command, timeout, and an optional `passWhen` predicate (used by `git-diff-clean@1` to pass on empty stdout).

`src/profiles.ts` defines `VerificationProfile` and `PROFILE_CATALOG` with three entries: `node-pnpm-v1`, `docs-check-v1`, and `minimal-v1` (all at version `"2"` after protected-path tightening). `profileDigest(profile)` hashes a canonical object that includes resolved check versions from the catalog, so the digest changes when any check is bumped. `resolveProfile(id)` looks up by id and throws on unknown ids. Each profile's `protectedPaths` covers verifier-configuration files only (package manifests, lock files, workspace file, tsconfig*, biome.json, .github/**, vitest/jest configs); test source files are not protected — changes to tests are governed by the contract's `paths.allow` and the adversarial review, not by tampering detection. A change to a protected path produces a blocking `verifier_tampered` Finding; `evaluateAcceptance` rejects with reason `VERIFIER_TAMPERED` when any such finding is present, independently of the review.

`src/runner.ts` exports `runCheck(def, opts)`, which spawns the command as a detached process group, captures the last `maxBytes` (default 16 384) of stdout and stderr via a ring buffer, and kills the process group with SIGTERM (then SIGKILL after 2 s) on timeout. It never throws on non-zero exit.

`src/fingerprint.ts` exports `environmentFingerprint(cwd)`, which returns a map with keys `node`, `pnpm`, `git`, `os`, and `arch`. Missing tools are recorded as `"unavailable"`.

`src/result.ts` exports `buildVerificationResult(input)`, which derives `result` from the run observation (`"error"` on timeout or null exit, `"pass"` or `"fail"` via the check's `passWhen` predicate or exit status 0) and validates the record through `VerificationResultSchema.parse` before returning.

`src/run-profile.ts` exports `runProfile(input)`, which runs all checks in a profile sequentially (regardless of individual failures) and returns one `VerificationResult` per check.

All modules are re-exported from `src/index.ts`. The package depends only on `@agencyhq/contracts` and `@agencyhq/domain`.

## Trial

`verify.run` used the profiles and result builder from this package in the Slice 3 trial on 2026-09-07. Both `pnpm-typecheck@1` and `pnpm-test@1` checks passed on the fixture parser at attempt revision `63a2eb1029468b81af5c3ed2c71fb2bd1b970308`. See [docs/engineering/trials/2026-09-slice3.md](../../docs/engineering/trials/2026-09-slice3.md).
