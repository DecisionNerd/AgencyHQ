# Web control plane

React/TypeScript operator interface. Renders coordinator state, submits typed
commands, and subscribes to Trigger.dev Realtime (scoped public access tokens)
for live execution state. Links to Trigger runs for raw logs. Owns no policy.
The minimal return-after-interruption view ships in slice 3.

## Package

Package name: `@agencyhq/web`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite with `node --test`.
