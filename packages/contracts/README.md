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

### `source.ts`

- `SourceRefSchema` / `SourceRef` — `{ projectId, revision (40-hex git SHA), bundlePath }`. Portable source reference for container execution: `bundlePath` must be a relative or internal path (rejected if it contains a URL scheme `://` or userinfo `@`). Replaces host filesystem paths in v2 task payloads.

### `artifact.ts`

- `ArtifactRefSchema` / `ArtifactRef` — `{ attemptId, generation (int ≥ 0), revision (40-hex) }`. Content-addressed pointer to a stored artifact bundle.
- `ArtifactUploadMetaSchema` / `ArtifactUploadMeta` — `{ attemptId, generation, kind ("attempt"|"checkpoint"), commitId, diffDigest (sha256:…), changedPaths, quarantinePatch?, bundleSha256 (64-hex), bundleBytes (int ≥ 0) }`. Metadata a worker submits when uploading an artifact bundle.
- `StopEvidenceUploadSchema` / `StopEvidenceUpload` — `{ attemptId, generation, steps: [{at (ISO), step (enum), detail? (≤2000 chars, no newlines)}] }`. Structured stop evidence submitted by a worker before exit.

### `lease.ts`

- `LeasePurposeSchema` / `LeasePurpose` — `"provider" | "git-read" | "integrate" | "upload"`. The four credential lease purposes.
- `LeaseRequestSchema` / `LeaseRequest` — `{ runId, attemptId, generation, purpose, nonce (≥32 chars) }`. Request from a worker container for a time-bounded credential grant.
- `LeaseGrantSchema` / `LeaseGrant` — `{ leaseId, purpose, expiresAt (ISO), material: LeaseMaterial }`. Successful grant with purpose-specific credentials.
- `LeaseMaterial` — Discriminated union on `purpose`: `provider` carries `authJson`; `git-read`/`integrate` carry `remote` (HTTPS URL, no userinfo), `tokenRef`, and `askpassToken`; `upload` carries `token`.
- `redactLeaseGrant(grant)` — Returns a copy with all secret material values replaced by `"<redacted>"` (remote URLs are preserved). Safe for logs and error messages.
- `LeaseRefusalSchema` / `LeaseRefusal` — `{ purpose, reason }` where reason is one of: `login_required`, `expired`, `stale_generation`, `unknown_run`, `unknown_attempt`, `revoked`, `unavailable`.

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
- `StepContractSchema` / `StepContract` — Immutable contract version. The `inputs` object carries `intent`, optional `defect`, optional `targetRef` (required for merge/deploy boundary contracts; absent for artifact-only contracts), and optional `manifestDigest` (for multi-repository work items). Also includes base revision, criteria with digest, profile with digest, bounds, required boundaries, human-approval flag, and status. Supersede, never rebind (R-018).
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
| `integrate.merge` | `IntegrateMergePayloadSchema` | `IntegrateMergeOutputSchema` |

`TASK_IDS` is a `as const` map of task string identifiers (`lead.plan`, `worker.attempt`, `verify.run`, `lead.review`, `lead.accept`, `integrate.merge`).

`IntegrateMergePayloadSchema` carries `attemptId`, `generation`, `contractId`, `contractVersion`, `projectId`, `repoPath`, `remote`, `targetRef`, `expectedBaseRevision`, `attemptRevision`, and `strategy` (`"merge_commit" | "fast_forward"`). `IntegrateMergeOutputSchema` returns `outcome` (`"integrated" | "already_integrated" | "base_moved" | "conflict" | "push_rejected"`), optional `resultingRevision`, `observedTargetRevision`, `evidence` strings, and optional `conflictingPaths`.

Supporting schemas:

- `LeadProposalSchema` — the Lead's proposal (always a proposal, never a decision; coordinator validates against delegated authority before recording). `criteria` is `z.array(CriterionSchema).min(1)`; `Criterion`/`CriterionSchema`/`CriterionSource` are the canonical definitions from `step-contract.ts`.
- `WorkerReportSchema` — worker self-report; context only, never evidence (TESTING.md §67-73).
- `VerificationResultSchema` — minimum verification record with every field from TESTING.md §89-94.

`LeadPlanPayloadSchema.authority` is `AuthoritySchema`; `narrowing` is `AuthorityNarrowingSchema.optional()`; `manifest` is `RevisionManifestSchema.optional()` — supplied for multi-repository WorkItems so the Lead understands scope and target refs. `WorkerAttemptPayloadSchema.bounds` is `ContractBoundsSchema`; `permissionRules` is `PermissionRulesetSchema`. `VerifyRunPayloadSchema.manifest` is `RevisionManifestSchema.optional()` — supplied when sibling repositories must be materialized for combined verification.

`WorkerAttemptOutputSchema.opencode.denials` is an array of `{ tool: string; pattern: z.string().nullable().optional(); message: string }`. The `pattern` field is nullable (the runtime serializes an absent value as `null` on a tool denial without a command).

`LeadReviewPayloadSchema` contains no session id or transcript fields (ADR-0006 independence invariant, asserted in tests).

### Versioned payload schemas (P18.1 — portable execution)

Every task exports three schema variants and a type guard:

| Task | v1 (primary) | v2 (strict, portable) | union | guard |
| --- | --- | --- | --- | --- |
| `worker.attempt` | `WorkerAttemptPayloadSchema` / `WorkerAttemptPayloadV1Schema` | `WorkerAttemptPayloadV2Schema` | `WorkerAttemptPayloadAnySchema` | `isV2Payload` |
| `lead.plan` | `LeadPlanPayloadSchema` / `LeadPlanPayloadV1Schema` | `LeadPlanPayloadV2Schema` | `LeadPlanPayloadAnySchema` | `isV2Payload` |
| `verify.run` | `VerifyRunPayloadSchema` / `VerifyRunPayloadV1Schema` | `VerifyRunPayloadV2Schema` | `VerifyRunPayloadAnySchema` | `isV2Payload` |
| `lead.review` | `LeadReviewPayloadSchema` / `LeadReviewPayloadV1Schema` | `LeadReviewPayloadV2Schema` | `LeadReviewPayloadAnySchema` | `isV2Payload` |
| `lead.accept` | `LeadAcceptPayloadSchema` / `LeadAcceptPayloadV1Schema` | `LeadAcceptPayloadV2Schema` | `LeadAcceptPayloadAnySchema` | `isV2Payload` |
| `integrate.merge` | `IntegrateMergePayloadSchema` / `IntegrateMergePayloadV1Schema` | `IntegrateMergePayloadV2Schema` | `IntegrateMergePayloadAnySchema` | `isV2Payload` |

**v1** is the current primary schema (trigger-compatible). `payloadVersion: z.literal(1).optional()` is the only addition; all existing field names are unchanged. trigger/ importers that access `.repoPath`, `.worktreeBase`, etc. continue to work without modification.

**v2** is `.strict()` and uses `source: SourceRef` instead of host-path fields (`repoPath`, `worktreeBase`, `patchPath`). Presence of any host-path field is rejected. `payloadVersion: z.literal(2)` is required.

**AnySchema** is `z.union([v1, v2])`. Use it wherever both payload formats must be accepted. `isV2Payload(p)` narrows to the v2 type.

P18.2 (`apps/coordinator/src/internal/artifacts-router.ts`) and P18.3 (`trigger/src/lib/source.ts`, `trigger/src/lib/artifact-upload.ts`, `trigger/src/lib/runtime.ts`) are implemented. Coordinator internal routes and trigger adapter modules use `SourceRef`, `ArtifactUploadMeta`, `StopEvidenceUpload`, `LeaseRequest`, `LeaseGrant`, and `LeaseRefusal` from this package. These paths are declared from code; not yet exercised live (L2 trial pending). Existing v1 payload schemas remain the primary schemas for dispatch.

### JSON Schema export

`src/opencode/json-schema.ts` exports `jsonSchemaFor(schema)` (wraps `z.toJSONSchema` with `target: "draft-2020-12"` and `unrepresentable: "throw"`) and `LEAD_OUTPUT_JSON_SCHEMAS` (pre-built schemas for `LeadPlanOutput`, `ReviewOutput`, and `AcceptanceProposal` for use with OpenCode structured output).

## Modules

### `manifest`

Revision manifest schemas for multi-repository WorkItems.

- `HexRevision40Schema` — 40 lower-case hex characters; used in manifest entry fields.
- `ManifestEntrySchema` / `ManifestEntry` — one entry per repository: `position` (0-based integer, must form an unbroken 0..n-1 sequence), `projectId`, `targetRef`, `expectedBaseRevision` (`HexRevision40Schema`), `resultRevision` (nullable; absent from the digest).
- `manifestDigest(entries)` — computes a stable `sha256:<hex>` digest over entries sorted by position with `resultRevision` excluded. The same plan always yields the same digest regardless of integration progress.
- `RevisionManifestSchema` / `RevisionManifest` — wraps `entries` and `digest`; validates that positions are exactly 0..n-1 with no duplicates and that `digest === manifestDigest(entries)`.

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
