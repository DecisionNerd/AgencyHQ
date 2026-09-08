# Web control plane

React/TypeScript operator interface. Renders coordinator state, submits typed
commands, and subscribes to Trigger.dev Realtime (scoped public access tokens)
for live execution state. Links to Trigger runs for raw logs. Owns no policy.
The minimal return-after-interruption view ships in Slice 3 and was exercised in the Slice 3 trial on 2026-09-07; see [docs/engineering/trials/2026-09-slice3.md](../../docs/engineering/trials/2026-09-slice3.md).

## Package

Package name: `@agencyhq/web`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite with `node --test`; `build` runs `vite build`; `dev` starts the Vite dev server; `preview` previews the production build.

## Slice 3: return-after-interruption view

The minimal operator view ships in `apps/web/src/`:

- `auth.ts` — pure auth helpers (no DOM dependency): `StorageLike` interface, `buildAuthHeaders(token)`, `getStoredToken`/`setStoredToken`/`clearStoredToken` (injected storage), `handle401(storage)` (clears token, returns `UnauthorizedError`). Tested in `test/auth.test.ts`.
- `api.ts` — types (`ReturnView`, `Item`, `State`, `Stop`, `PendingDecision`, `OverviewView`, `DecisionsView`, `EvidenceView`, `AuthorityView`, `CommandResult`, etc.), token store (`getToken`, `setToken`, `clearToken` backed by `localStorage["agencyhq.apiToken"]`), and fetch helpers (`fetchReturnView(since)`, `fetchWorkItem(id)`, `fetchRealtimeToken(id)`, `fetchOverview()`, `fetchDecisions()`, `fetchEvidence(id)`, `fetchAuthority(id)`, `putAuthority(id, body)`, `postCommand(body)`). All fetch calls go to relative `/api/*` paths and include `Authorization: Bearer <token>` when a token is stored; a 401 response clears the token and throws `UnauthorizedError`. `postCommand` adds a fresh `commandId` and returns the parsed result including `replayed`.
- `App.tsx` — hash-router with four routes plus the legacy return view. `#/` renders the overview (campaigns, projects, ranked work items with lifecycle/condition/boundary/pending-decision count, links to item view); `#/work-items/:id` renders the five state cards (contract, execution, verification, acceptance, integration) plus an evidence panel (attempts with run ids, artifacts, verification results, reviews with findings, decisions, approvals, integrations, manifest rows) and actions (approve prefilled from pending decision, reject with reason, stop, pause, resume, remediate via disposition, invalidate acceptance); `#/decisions` lists every pending decision with obstacle, recommendation, impact, no-action consequence, and inline approve/reject actions; `#/projects/:id/authority` shows a JSON textarea editor with the current authority, version history, and a confirmation before saving (names the project and new version); `#/return` is the existing return-after-interruption view. Every destructive or irreversible action shows a `ConfirmDialog` that names the project, work item, and contract version. When the API returns 401, a minimal token entry form is shown (label "API token", text input, submit); on submit the token is stored and the request is retried.
- `ExecutionState.tsx` — for items with an active run, fetches a scoped realtime token from `GET /api/work-items/:id/realtime-token` and wraps `useRealtimeRunsWithTag(tag)` inside `TriggerAuthContext.Provider { accessToken, baseURL }`. Shows run status and a "Open run" link to `${apiUrl}/runs/${runId}` in the self-hosted Trigger dashboard. Falls back to the ledger execution state when no token is available.
- `view-helpers.ts` — pure functions (`formatState`, `stopBadge`, `isStale`, `orderItems`, `shortSha`, `manifestLabel`, `integrationCardModel`) with unit tests in `test/view-helpers.test.ts`. `shortSha(sha)` truncates a commit sha to 7 chars or returns null. `manifestLabel(manifest)` formats "Manifest n/m" or returns null. `integrationCardModel(item)` derives a DOM-free model for the integration card (label, iconKey, outcome, targetRef, shortRevision, fullRevision, at, source) or returns null when integration is absent.
- `control-plane-helpers.ts` — pure DOM-free helpers for the control-plane views: `parseRoute(hash)` parses `window.location.hash` into a typed `Route` union; `formatTimestamp(at)` renders ISO timestamps like the existing state cards; `lifecycleIcon(s)` and `conditionIcon(s)` return text icons; `buildOverviewWorkItemRow(entry)` adds icon fields to the overview entry; `buildDecisionRow(entry)` adds `formattedAt`; action body builders (`buildApproveBody`, `buildRejectBody`, `buildStopBody`, `buildPauseBody`, `buildResumeBody`, `buildDispositionRemediateBody`, `buildInvalidateAcceptanceBody`) produce the exact field shape the coordinator's `POST /api/commands` expects; `formatAuthorityErrors(errors)` formats 422 schema errors. Tested in `test/control-plane-helpers.test.ts`.
- `styles.css` — minimal system-font CSS with light/dark theme tokens, no framework.

## Development

Run the Vite dev server (`pnpm dev`) while the coordinator runs on port 8787. The `vite.config.ts` proxies `/api` to `http://localhost:8787`.

## Production

Run `pnpm build`. The coordinator serves `apps/web/dist` as static files. The Vite config outputs to `dist/` (already in `.gitignore`).

## Note on @vitejs/plugin-react

`@vitejs/plugin-react@6.x` requires `vite@^8`, but this workspace pins `vite@^7`. The `vite.config.ts` therefore uses Vite 7's built-in `esbuild` JSX transform (`jsx: "automatic", jsxImportSource: "react"`) instead of the plugin; React Fast Refresh is not active in the dev server as a result. This constraint resolves when the workspace upgrades to vite@8.
