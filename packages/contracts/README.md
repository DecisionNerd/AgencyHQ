# Contracts package

Versioned schemas shared by the coordinator and task adapters: StepContract,
delegated-authority schema, task payloads and outputs (`lead.plan`,
`worker.attempt`, `verify.run`, `lead.review`, `lead.accept`,
`integrate.merge`), worker report, Lead proposal, and OpenCode permission-rule
generation. Also the JSON schemas handed to OpenCode structured output.

## Package

Package name: `@agencyhq/contracts`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite with `node --test`.

## Schemas

The following Zod schemas are exported from this package:

### `authority.ts`

- `ChangeClassSchema` / `ChangeClass` — `"editorial" | "behavior" | "shared_interface"`. Change class categorises the nature of a diff for review-depth decisions.
- `ReviewProfileSchema` / `ReviewProfile` — `"none" | "lead_inspection" | "adversarial" | "adversarial_distinct_model"`. Ordered least-to-most. `REVIEW_PROFILE_ORDER` is the canonical ordering array. `reviewProfileAtLeast(a, b)` returns true when `a` is at least as strong as `b`.
- `BoundarySchema` / `Boundary` — `"artifact" | "merge" | "deploy"`. The completion boundary a Lead may select without a human.
- `WorkerToolSchema` / `WorkerTool` — `"edit" | "webfetch" | "websearch" | "task" | "external_directory" | "skill"`. Tools that can be granted or denied in a worker's permission ruleset.
- `DigestSchema` / `Digest` — `sha256:<64 hex chars>`. Content-addressed identity (branded via `z.custom`); use for authority-level fields. Task schemas use `DigestStringSchema` (from `step-contract.ts`) for JSON-Schema-representable digest fields.
- `PathsSchema` / `Paths` — `{ allow: string[]; deny: string[] }`. Sub-schema shared by `AuthoritySchema` and `AuthorityNarrowingSchema`.
- `BudgetSchema` / `Budget` — Sub-schema for attempt budget (maxAttempts, maxDurationSeconds, machine, estimatedSpendUsd).
- `CapabilitiesSchema` / `Capabilities` — Sub-schema for bash allow/deny lists and tool permission flags.
- `ModelsSchema` / `Models` — Sub-schema for worker/lead/reviewer model identifiers.
- `HumanRequiredSchema` / `HumanRequired` — Sub-schema for human-approval conditions (paths, changeClasses, boundaries).
- `ReviewMinimumSchema` / `ReviewMinimum` — Sub-schema for `{ minimum: Record<ChangeClass, ReviewProfile> }`.
- `AuthoritySchema` / `Authority` — The versioned delegated-authority object on each Project. Fields: `version`, `paths`, `capabilities`, `boundaries`, `budget`, `review`, `models`, `humanRequired`.
- `AuthorityNarrowingSchema` / `AuthorityNarrowing` — All fields optional; used for per-WorkItem narrowing. Authority only narrows, never widens.
- `HOST_TRIAL_AUTHORITY` — Example authority constant scoped to parser work, suitable for tests and integration fixtures.

### `runtime-profile.ts`

- `BoundaryKindSchema` / `BoundaryKind` — The 11 enforcement boundary kinds: `worktree`, `fs_isolation`, `cpu_memory`, `duration`, `capability`, `output_paths`, `push`, `integrate`, `termination`, `egress_spend`, `nested_agents`.
- `EnforcementKindSchema` / `EnforcementKind` — `"before_action" | "on_output" | "trusted_observation" | "advisory"`.
- `RuntimeProfileSchema` / `RuntimeProfile` — Maps every `BoundaryKind` to its `EnforcementKind` for a given execution environment (`"host"` or `"container"`).
- `HOST_PROFILE` — Transcribed from `ARCHITECTURE.md` lines 105–127. Advisory boundaries on the host: `fs_isolation`, `cpu_memory`, `egress_spend`.
- `enforceableBoundaries(profile)` — Returns all `BoundaryKind`s that are not advisory in the profile. Dispatch rejects a contract that requires an advisory boundary (R-016).

### `step-contract.ts`

- `CriterionSourceSchema` / `CriterionSource` — `"operator" | "repository" | "lead"`. Tracks which principal authored each criterion.
- `CriterionSchema` / `Criterion` — One acceptance criterion with `id`, `text`, `source`, and optional `citation`.
- `ContractBoundsSchema` / `ContractBounds` — The concrete bounds frozen into a StepContract at creation: paths, capabilities, boundary, budget, review profile, change class, and single-model worker/reviewer identifiers.
- `DigestStringSchema` — `z.string().regex(...)` version of the digest validator. JSON-Schema-representable (unlike `DigestSchema`). Used in task payload and output schemas.
- `StepContractSchema` / `StepContract` — Immutable contract version. Includes base revision, criteria with digest, profile with digest, bounds, required boundaries, human-approval flag, and status. Supersede, never rebind (R-018).
- `criteriaDigestInput(criteria)` — Returns the canonical `{id, text, source}[]` object that `packages/domain` passes to `digestOf` to produce `criteriaDigest`. Citation is excluded for digest stability.

## Task schemas

Each task pair lives in `src/tasks/<name>.ts` and exports `XPayloadSchema` / `XOutputSchema` with inferred types.

| Task ID | Payload schema | Output schema |
| --- | --- | --- |
| `lead.plan` | `LeadPlanPayloadSchema` | `LeadPlanOutputSchema` (discriminated union on `kind`) |
| `worker.attempt` | `WorkerAttemptPayloadSchema` | `WorkerAttemptOutputSchema` |
| `verify.run` | `VerifyRunPayloadSchema` | `VerifyRunOutputSchema` |
| `lead.review` | `LeadReviewPayloadSchema` | `ReviewOutputSchema` |
| `lead.accept` | `LeadAcceptPayloadSchema` | `AcceptanceProposalSchema` |

`TASK_IDS` is a `as const` map of task string identifiers (`lead.plan`, `worker.attempt`, `verify.run`, `lead.review`, `lead.accept`).

Supporting schemas:

- `LeadProposalSchema` — the Lead's proposal (always a proposal, never a decision; coordinator validates against delegated authority before recording). `criteria` is `z.array(CriterionSchema).min(1)`; `Criterion`/`CriterionSchema`/`CriterionSource` are the canonical definitions from `step-contract.ts`.
- `WorkerReportSchema` — worker self-report; context only, never evidence (TESTING.md §67-73).
- `VerificationResultSchema` — minimum verification record with every field from TESTING.md §89-94.

`LeadPlanPayloadSchema.authority` is `AuthoritySchema`; `narrowing` is `AuthorityNarrowingSchema.optional()`. `WorkerAttemptPayloadSchema.bounds` is `ContractBoundsSchema`; `permissionRules` is `PermissionRulesetSchema`.

`LeadReviewPayloadSchema` contains no session id or transcript fields (ADR-0006 independence invariant, asserted in tests).

### JSON Schema export

`src/opencode/json-schema.ts` exports `jsonSchemaFor(schema)` (wraps `z.toJSONSchema` with `target: "draft-2020-12"` and `unrepresentable: "throw"`) and `LEAD_OUTPUT_JSON_SCHEMAS` (pre-built schemas for `LeadPlanOutput`, `ReviewOutput`, and `AcceptanceProposal` for use with OpenCode structured output).

## Modules

### `digest`

Content-addressing utilities for frozen evidence records (TESTING.md §Evidence integrity).

- `canonicalJson(value)` — deterministic JSON with sorted object keys at every depth, no whitespace, `-0` normalised to `0`; throws `TypeError` on `undefined`, functions, or `BigInt`.
- `sha256Hex(text)` — SHA-256 of a UTF-8 string as lower-case hex.
- `digestOf(value)` — computes `canonicalJson` then SHA-256; returns a branded `Digest` (`sha256:<hex>`).
- `isDigest(x)` — type guard for `Digest`.

### `path-pattern`

Repo-relative POSIX glob patterns and authority-subset checks (ADR-0006).

- `parsePathPattern(s)` — validates and brands a `PathPattern`; rejects absolute paths, `..` segments, empty segments, backslashes, `./` prefix, trailing `/`.
- `matchesPath(pattern, path)` — same semantics as `trigger/src/lib/paths.ts`: `*` never crosses `/`, `**` crosses, `?` single non-slash char.
- `patternSubset(narrow, wide)` — returns `true` iff every path matched by `narrow` is also matched by `wide`; implemented decidably via segment-wise structural analysis with backtracking on `**`.
- `pathSetSubset(narrow[], wide[])` — every narrow pattern is covered by at least one wide pattern (conservative: pattern-level, not union-level).
- `denySetCovers(narrowDeny[], wideDeny[])` — every wide deny pattern is covered by at least one narrow deny pattern (deny sets may only grow as authority narrows).

### `opencode/permissions`

OpenCode permission-rule generator (ADR-0006 §33-37, ADR-0007).

- `PermissionActionSchema` / `PermissionAction` — `"allow" | "ask" | "deny"`.
- `PermissionPatternMapSchema` / `PermissionPatternMap` — `Record<string, PermissionAction>`. Per-tool pattern map (last-match-wins in OpenCode).
- `PermissionRulesetSchema` / `PermissionRuleset` — Full ruleset object with keys: `*`, `read`, `glob`, `grep`, `list`, `edit` (pattern map), `bash` (pattern map), `task`, `webfetch`, `websearch`, `skill`, `external_directory`, `doom_loop`.
- `WORKER_ALWAYS_DENY_BASH` — Bash patterns unconditionally denied for workers (`*git push*`, `*gh *`, `*curl*`, etc.).
- `WORKER_ALWAYS_DENY_PATHS` — File globs unconditionally denied for workers (`opencode.json*`, `.opencode/**`).
- `permissionRulesFor(bounds, { worktreePath })` — Builds the worker permission ruleset from `ContractBounds`. Sorts input arrays for deterministic output (shuffled inputs produce identical JSON). `task` and `external_directory` are always denied regardless of bounds. `webfetch`/`websearch` follow `bounds.capabilities.tools`. Always-deny patterns override allows (last-match-wins). The coordinator sets `WorkerAttemptPayload.permissionRules` from this function; the `worker.attempt` task then merges `WORKER_ALWAYS_DENY_BASH` and `WORKER_ALWAYS_DENY_PATHS` on top via `enforceAlwaysDeny` for defense in depth.
- `leadAgentPermissions()` — Read-only Lead ruleset: edit fully denied, bash read-only commands allowed (git status/diff/log/show, ls, cat, grep, find, pnpm test/typecheck), WORKER_ALWAYS_DENY_BASH overrides all.
- `runConfigFor({ model, agentName, ruleset, disableMcp })` — Produces the `opencode.worker.json` config object (`$schema`, `share: "disabled"`, `autoupdate: false`, `permission`, `agent.<agentName>`, `mcp`). Superset-compatible with the trigger package's spike config.
