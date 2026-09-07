# Web control plane

React/TypeScript operator interface. Renders coordinator state, submits typed
commands, and subscribes to Trigger.dev Realtime (scoped public access tokens)
for live execution state. Links to Trigger runs for raw logs. Owns no policy.
The minimal return-after-interruption view ships in Slice 3 and was exercised in the Slice 3 trial on 2026-09-07; see [docs/engineering/trials/2026-09-slice3.md](../../docs/engineering/trials/2026-09-slice3.md).

## Package

Package name: `@agencyhq/web`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite with `node --test`; `build` runs `vite build`; `dev` starts the Vite dev server; `preview` previews the production build.

## Slice 3: return-after-interruption view

The minimal operator view ships in `apps/web/src/`:

- `api.ts` — types (`ReturnView`, `Item`, `State`, `Stop`, `PendingDecision`, etc.) and fetch helpers (`fetchReturnView(since)`, `fetchWorkItem(id)`, `fetchRealtimeToken(id)`, `postCommand(cmd)`). All fetch calls go to relative `/api/*` paths.
- `App.tsx` — the main page. Reads `agencyhq.lastAckAt` from `localStorage` as the `since` parameter; displays sections in order: **Changed since your last visit**, **Decisions pending**, **Stops**, **Continuing**. An **Acknowledge visit** button posts `ack_visit` and updates `lastAckAt`. Each work item shows four state cards (contract, execution, verification, acceptance) with label, source, and timestamp. The `mainEffort` item is highlighted and floated to the top of its section.
- `ExecutionState.tsx` — for items with an active run, fetches a scoped realtime token from `GET /api/work-items/:id/realtime-token` and wraps `useRealtimeRunsWithTag(tag)` inside `TriggerAuthContext.Provider { accessToken, baseURL }`. Shows run status and a "Open run" link to `${apiUrl}/runs/${runId}` in the self-hosted Trigger dashboard. Falls back to the ledger execution state when no token is available.
- `view-helpers.ts` — pure functions (`formatState`, `stopBadge`, `isStale`, `orderItems`) with 16 unit tests in `test/view-helpers.test.ts`.
- `styles.css` — minimal system-font CSS with light/dark theme tokens, no framework.

## Development

Run the Vite dev server (`pnpm dev`) while the coordinator runs on port 8787. The `vite.config.ts` proxies `/api` to `http://localhost:8787`.

## Production

Run `pnpm build`. The coordinator serves `apps/web/dist` as static files. The Vite config outputs to `dist/` (already in `.gitignore`).

## Note on @vitejs/plugin-react

`@vitejs/plugin-react@6.x` requires `vite@^8`, but this workspace pins `vite@^7`. The `vite.config.ts` therefore uses Vite 7's built-in `esbuild` JSX transform (`jsx: "automatic", jsxImportSource: "react"`) instead of the plugin; React Fast Refresh is not active in the dev server as a result. This constraint resolves when the workspace upgrades to vite@8.
