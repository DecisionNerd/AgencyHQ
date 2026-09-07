# Verification package

Verification profile definitions, the check catalog, and VerificationResult
construction used by the `verify.run` task. Profiles are frozen into the
StepContract by digest before dispatch and are never in a worker's writable
tree. A VerificationResult is evidence; acceptance is a coordinator decision.

## Package

Package name: `@agencyhq/verification`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite with `node --test`.
