# Domain model

The model is sized for the first executable path — one repository, one bounded
process, one worker — and grows only when a later slice needs a concept.
Concepts marked *deferred* are vocabulary now and code later.

## Aggregate map

| Concept | Meaning and key invariants | Slice |
| --- | --- | --- |
| Project | A linked Git repository: remote, coordinator-owned clone and worktree base folder, allowed refs, verification profile catalog, and its versioned [delegated-authority schema](adrs/0006-lead-role-and-delegated-authority.md). | 2 |
| WorkItem | A ranked, scoped unit of intended change with a versioned definition of done and a completion boundary (`artifact`, `merge`, `deploy`). Owns lifecycle. The Campaign/Initiative/Goal split of the original baseline collapses into this until multiple campaigns exist. | 2 |
| StepContract | Immutable version: inputs, base revision, allowed paths, OpenCode permission rules, required runtime boundaries, `maxDuration`, attempt budget, expected outputs, criteria and profile digests. | 2 |
| Attempt | One execution of a StepContract: Trigger run id, authority generation, worktree path, OpenCode session id, attempt commit, checkpoint commit, report, and failure record. At most one active Attempt per StepContract. | 2 |
| DispatchIntent | Coordinator-recorded intent to trigger a task, keyed by intent id (the Trigger idempotency key), with the resulting run id once known. | 2 |
| Artifact | Content-addressed output: attempt commit id, diff digest, path summary, and worktree location. | 2 |
| VerificationResult | Result of one approved check against exact inputs, from a `verify.run` task. | 2 |
| Review | Adversarial review evidence: reviewer identity (model or human), subject versions, findings, and blocking status. | 2 |
| Decision | A Lead proposal accepted by the coordinator's authority check, or a human decision; immutable, versioned, with sources and rationale. Kinds: definition-of-done, profile, boundary, disposition, classification, acceptance, scope change. | 2 |
| Approval | Human decision over an exact subject version and evidence set, required only where the authority schema says so. Never a mutable boolean. | 2 |
| Finding | Evidence-backed observation from any task with an owned disposition; never silently widens a contract. | 2 |
| Campaign | Grouping of WorkItems across Projects with a shared rank order and declared main effort. `setMainEffort(campaign, workItem)` requires the work item's `campaignId` to match. `campaignRankOrder(items)` returns a total order `(rank asc, createdAt asc, id asc)`. `selectDispatch` is implemented in the domain and tested (`dispatch.campaign.test.ts`): members cluster at the campaign main effort's rank; main effort sorts first; remaining members follow in rank/createdAt/id order; items without a `campaignId` are unaffected. The coordinator does not currently call `selectDispatch` — dispatch is per-command; batch scheduling is Slice 6 scope (planned). | 5 |
| RevisionManifest | Ordered list of `(projectId, targetRef, expectedBaseRevision, resultRevision?)` entries covering all repositories in a multi-repository WorkItem. The manifest digest is computed from entries excluding `resultRevision` and is stable throughout the WorkItem's lifetime. Merge completion requires every entry to carry a non-null `resultRevision` (all entries resolved). | 4 |
| IntegrationDecision | The outcome of one `integrate.merge` run: `integrated`, `already_integrated`, `base_moved`, `conflict`, or `push_rejected`. Non-integrated outcomes produce a `pending_human` decision with an `integration_conflict` finding. | 4 |
| ProcessDefinition | Versioned step/gate sequence. The bounded repair process is code until a second process exists; extract when a second catalog entry needs a different step/gate sequence. *Deferred.* | 4 |
| AuthorityVersion | Append-only log of delegated-authority schema versions per project: `(project_id, version)` primary key, `authority` jsonb, `actor`, `at`. The `update_authority` command validates the proposed schema with `AuthoritySchema`, requires strictly increasing version, writes the project row, appends the `authority_versions` row (idempotent on `(project_id, version)`), and records an `authority_update` decision. Frozen `step_contracts` rows are never modified (R-018); only future Lead proposals are governed by the new schema. | 5 |
| ProviderCapacity | Timestamped capacity observation with validity window. `{ provider, model, status: "ok"|"limited"|"down", observedAt, validUntil, source: "adapter"|"operator" }`. `effectiveCapacity(obs, now)` returns `"ok"|"limited"|"down"|"unknown"` (past `validUntil` → `"unknown"`). `concurrencyFor(status)` maps `ok→null` (unconstrained), `limited→1`, `unknown→1`, `down→0` (conservative stale handling). **Provider gate applies only when the `provider_capacity` table is non-empty**: with no rows the gate is skipped entirely (unconstrained). Once any row exists, a missing or expired observation for a `provider`/`model` pair yields `unknown` → concurrency 1. Live caveat: T1 concurrent workers (run_cmtt6e0rj / run_cmtt6evmq, 21:23:08–21:23:14Z) ran with an empty capacity table — no observation, no gate. K7 hit `provider_unknown` at 22:08Z after the operator row for `openai/gpt-5.6-terra` expired (validUntil 21:44Z). | 6 |

*Implementation: all Slice 2 aggregates in `packages/domain/src/aggregates/`; lifecycle transitions namespaced per aggregate in `packages/domain/src/transitions/`.*

## Container execution records (wave 2 — P17.1/P18.1–P18.4)

The following records were added for the portable container execution model.
None has been exercised in a live Trigger task container; L2 trial evidence is
pending.

### `projects.source_mode`

Column on the `projects` table (migration `0008_container_runtime.sql`). Values:
`'host_clone'` (default) — use host worktrees and local stop.ndjson; `'mirror'`
— use the coordinator bundle mirror and internal API for source and artifacts.
`setProjectSourceMode(client, projectId, mode)` switches the value.

### `dispatch_intents.dispatch_nonce_hash`

Nullable `text` column (migration `0009_dispatch_nonce.sql`). Stores the
SHA-256 hex hash of the 32-byte random dispatch nonce generated at dispatch time
for mirror-mode projects. The raw nonce is passed to the task container and never
persisted. The broker verifies `sha256(presented_nonce) == dispatch_nonce_hash`
(timing-safe) before issuing any lease. Null for host-clone dispatches;
the broker rejects any request where the hash is null (no null bypass).

### `dispatch_intents.seq`

`BIGSERIAL` column (migration `0010_dispatch_seq.sql`). Monotonically increasing
insertion order. Used as the final tiebreaker in `selectDispatch` when rank,
`createdAt`, and id all compare equal — guarantees a stable sort when two intents
are inserted within the same microsecond (fast test environments). Absent or
null items sort last (`Number.MAX_SAFE_INTEGER`).

### `leases`

Time-bounded credential grants issued to worker containers (migration
`0008_container_runtime.sql`). Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | text PK | Random `lease_<32hex>`. |
| `attempt_id` | text FK → `attempts` | The attempt this lease is scoped to. |
| `generation` | int | The authority generation for which the lease was issued. |
| `run_id` | text | Trigger run id of the requesting container. |
| `purpose` | enum | `provider`, `git-read`, `integrate`, `upload`, `review`. |
| `nonce_hash` | text | SHA-256 hex of the worker's lease request nonce. |
| `token_hash` | text | SHA-256 hex of the bearer token handed out with `upload` and `review` leases. |
| `issued_at` | timestamptz | Insertion timestamp. |
| `expires_at` | timestamptz | Hard expiry; not renewable. |
| `used_at` | timestamptz | Reserved; `markLeaseUsed` has no callers (not set in current code). |
| `revoked_at` | timestamptz | Set by the coordinator on generation advance or stop. |

**Invariants:** Each `(attempt_id, generation, purpose, nonce_hash)` is unique
(idempotent re-request returns the same lease). Leases below the current
generation are revoked by `revokeLeasesBelowGeneration()` when a new generation
starts. The raw nonce is never stored; only its SHA-256 hash.

**Purposes and material:**

- `provider` — `authJson`: serialized OpenCode auth.json. Read from
  `AGENCYHQ_OPENCODE_DATA_DIR/auth.json` on the coordinator; written to the
  per-run HOME at `0600` inside the container.
- `git-read` — `remote` (HTTPS URL, no userinfo), `tokenRef`, `askpassToken`:
  decrypted from `project_credentials` (AES-256-GCM) for reading the source
  repository.
- `integrate` — same shape as `git-read`, TTL is `AGENCYHQ_INTEGRATE_LEASE_TTL_MS`
  (default 5 min) rather than the standard TTL.
- `review` — `token`: random 32-byte hex (download only: source bundles and
  verified attempt bundles). Issued to lead.plan (attempt-less intents, keyed by
  the dispatch intent id), lead.review and integrate. No provider or git material.
- `upload` — `token`: random 32-byte hex; SHA-256 stored in `token_hash` for
  bearer-token lookup on artifact/stop-evidence routes.

**Revocation policy.** Leases are not hard-deleted; `revoked_at` is set instead.
Logout blocks new leases (the provider state check returns `login_required`
before issuing). In-flight leases run to expiry.

**Repository:** `packages/db/src/repos/leases.ts` — `issueLease`,
`findLeasesByAttemptGeneration`, `markLeaseUsed`, `revokeLeasesBelowGeneration`,
`revokeExpiredLeases`.

### `attempt_artifacts`

Coordinator-persisted artifact bundle metadata from worker containers (migration
`0008_container_runtime.sql`). Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | text PK | Random UUID. |
| `attempt_id` | text FK → `attempts` | |
| `generation` | int | Authority generation at upload time. |
| `kind` | enum | `attempt` or `checkpoint`. |
| `commit_id` | text | 40-hex git SHA produced by the worker. |
| `diff_digest` | text | `sha256:<hex>` recomputed from the mirror after import. |
| `changed_paths` | jsonb | Array of repo-relative paths changed. |
| `quarantine_patch` | text | Optional patch when path violations detected. |
| `bundle_sha256` | text | 64-hex SHA-256 of the uploaded bundle. |
| `bundle_bytes` | bigint | Bundle byte length. |
| `verified` | boolean | `true` when SHA and diff digest both match. |
| `received_at` | timestamptz | Insertion timestamp. |

**Invariants.** Unique on `(attempt_id, generation, kind, commit_id)`. Insert is
idempotent (ON CONFLICT DO NOTHING); caller detects duplicates via the
`"inserted" | "duplicate"` discriminant from `insertAttemptArtifact()`. The
`verified` flag reflects coordinator-side bundle import and digest recomputation.

**Repository:** `packages/db/src/repos/attempt-artifacts.ts` —
`insertAttemptArtifact`, `listArtifactsForAttempt`, `markArtifactVerified`.

### `attempt_stop_evidence`

Structured stop-sequence evidence uploaded by worker containers on graceful
shutdown (migration `0008_container_runtime.sql`). Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | text PK | Random UUID. |
| `attempt_id` | text FK → `attempts` | |
| `generation` | int | Authority generation at upload time. |
| `steps` | jsonb | Ordered `{ at (ISO), step (enum), detail?, survivors? (number[]), checkpointCommit? }` array. |
| `received_at` | timestamptz | Last upsert timestamp. |

**Invariants.** Unique on `(attempt_id, generation)`. Upserted idempotently;
later uploads overwrite the `steps` and refresh `received_at`. Steps are one of:
`signal_sent`, `process_exited`, `survivor_scan`, `checkpoint_committed`,
`upload_done`, `aborted`, `abort_signal`, `soft_deadline`, `on_cancel_entered`,
`stop_start`, `killed`, `checkpoint`, `checkpoint_failed`, `stop_done`.
`stop_done` may carry `survivors` (surviving PIDs). `checkpoint` and
`checkpoint_committed` may carry `checkpointCommit` (git SHA).

**Repository:** `packages/db/src/repos/attempt-stop-evidence.ts` —
`upsertAttemptStopEvidence`, `listStopEvidenceForAttempt`.

### `project_credentials`

AES-256-GCM encrypted project-level credentials for git operations (migration
`0008_container_runtime.sql`). Keyed by `(project_id, purpose)`.

| Field | Type | Meaning |
| --- | --- | --- |
| `project_id` | text FK → `projects` | |
| `purpose` | enum | `git-read` or `integrate`. |
| `ciphertext` | bytea | AES-256-GCM ciphertext of the plaintext credential. |
| `iv` | bytea | 12-byte random IV. |
| `tag` | bytea | 16-byte GCM authentication tag. |
| `key_version` | int | Key version (for rotation; default 1). |
| `created_at` / `updated_at` | timestamptz | Timestamps. |

**Invariants.** Primary key `(project_id, purpose)`. Upserted via `putProjectCredential`
(ON CONFLICT UPDATE). The 64-hex encryption key is read from
`AGENCYHQ_SECRETS_KEY` on the coordinator; it never appears in logs, errors, or
test snapshots. Decryption via `decryptSecret()` (`packages/db/src/crypto.ts`)
throws `"authentication failed"` on tamper or wrong key, never revealing the key
or plaintext.

**Repository:** `packages/db/src/repos/project-credentials.ts` —
`putProjectCredential`, `getProjectCredential`, `deleteProjectCredential`.

### Admission reason codes

The domain admission layer (`packages/domain/src/admission/`) exposes the
following failure codes. Each code is returned by `validateArtifactAdmission`
or `validateStopEvidenceAdmission` as the first failing condition (fail-fast,
deterministic):

**Artifact admission** (`artifact.ts`):

| Code | Condition |
| --- | --- |
| `LEASE_MISSING` | No upload lease found for the attempt. |
| `LEASE_REVOKED` | Lease `revoked_at` is set. |
| `LEASE_EXPIRED` | Lease `expires_at` ≤ now. |
| `LEASE_PURPOSE_MISMATCH` | Lease purpose is not `upload`. |
| `ATTEMPT_MISMATCH` | Lease `attemptId` ≠ claimed `attemptId`. |
| `STALE_GENERATION` | Claimed generation < attempt's current generation. |
| `FUTURE_GENERATION` | Claimed generation > attempt's current generation. |
| `ATTEMPT_TERMINAL` | Attempt status is `completed`, `quarantined`, `failed`, or `stopped`. |
| `BUNDLE_TOO_LARGE` | `bundleBytes` > `maxBundleBytes`. |
| `PATH_UNSAFE` | A changed path contains `..` or fails the path-safety check. |
| `COMMIT_NOT_IN_MIRROR` | The claimed `commitId` is not present in the git mirror. |
| `DIGEST_MISMATCH` | Recomputed diff digest ≠ claimed `diffDigest`. |

**Stop evidence admission** (`evidence.ts`):

| Code | Condition |
| --- | --- |
| `LEASE_MISSING` | No upload lease found. |
| `LEASE_REVOKED` | Lease revoked. |
| `LEASE_EXPIRED` | Lease expired. |
| `LEASE_PURPOSE_MISMATCH` | Lease purpose is not `upload`. |
| `ATTEMPT_MISMATCH` | Lease `attemptId` ≠ claimed `attemptId`. |
| `GENERATION_MISMATCH` | Claimed generation ≠ attempt's current generation. |

## Relationships

- A WorkItem belongs to one or more Projects via a RevisionManifest (one
  entry per repository). Merge-boundary WorkItems targeting a single repository
  have a manifest with one entry; artifact-boundary WorkItems have no manifest.
  Merge completion requires a resolved manifest (all entries have a non-null
  `resultRevision`).
- A WorkItem has one or more StepContracts; the bounded repair process has one.
- Each Attempt binds to exactly one StepContract version, one Trigger run, and
  one authority generation.
- Artifacts, VerificationResults, and Reviews name the Attempt and revision
  they cover; Decisions and Approvals name the exact versions and digests they
  cover, so later changes cannot inherit them.

## The Lead and the definition of done

The Lead proposes; the coordinator decides (ADR-0006). Before dispatch the
Lead's `lead.plan` task produces, from operator intent and repository context,
a proposal containing: the criteria for done with a source for each (operator
intent or repository instruction); required checks and the verification
profile; review depth by change class; completion boundary; allowed paths and
capabilities; and budget. The coordinator checks every bound is a subset of the
Project's delegated authority. In-bounds proposals are recorded as Decisions
and frozen into the StepContract. Out-of-bounds proposals become a pending
human decision.

The Lead must not weaken the requested outcome to fit a result. Workers report
what they attempted, exact outputs, checks run, unmet criteria, limitations,
and Findings. An honest partial or failed report is valid execution evidence,
not acceptance. Missing results remain unknown.

A worker output with a null commit id (nothing changed) is classified as a
failure; no Artifact is created for that attempt. Test: `flow.parking (a)`
(`apps/coordinator/test/integration/flow.parking.test.ts`) asserts one
`failures` row with `class='contract'`, `phase='final'`, `cause` mentioning
`null commitId`; `attempt.status='failed'`; no `artifacts` row; no
`dispatch_intents` row for `verify.run`.

When the authority schema sets `humanRequired` true, the work item is parked as
`pending_human` after acceptance is proposed, and stays there until a matching
Approval bound to the same contract version and attempt exists. The `approve`
command (`POST /api/commands` with `kind: "approve"`) supplies the Approval
(`contractId`, `contractVersion`, `attemptRevision`), writes an `approvals`
row, and re-runs acceptance via `evaluateAcceptanceForAttempt`; the command is
idempotent by `commandId`. `APPROVAL_VERSION_MISMATCH` leaves the item
`pending_human`. Test: `flow.parking (b)` asserts one `decisions` row with
`kind='accept'`, `outcome='pending_human'`, `actor='coordinator'`; `work_items`
lifecycle not `'completed'`; no `approvals` row; replay is a no-op (still
exactly one decision row). The Approval command is covered by
`apps/coordinator/test/integration/approve.test.ts`.

## Delegated authority

The schema is defined in ADR-0006. Two rules govern it here:

1. Authority only narrows down the hierarchy: Project schema ⊇ WorkItem
   narrowing ⊇ StepContract bounds ⊇ what a worker's permission rules allow.
2. Widening any bound is a new StepContract version and, where `humanRequired`
   applies, an Approval. Workers cannot request widening; they report Findings.

The Project's **verification profile catalog is an authority ceiling**: the Lead may only choose a `profileId` from this catalog. A proposal naming an unknown profile becomes a `pending_human` decision with `PROFILE_NOT_IN_CATALOG`.

*Implementation: authority subset check with 15 violation codes in `packages/domain/src/authority/subset.ts`; human-approval determination in `packages/domain/src/authority/human-required.ts`; dispatch enforceability in `packages/domain/src/authority/runtime.ts`.*

## Allocation

The coordinator dispatches at most `AGENCYHQ_WORKER_SLOTS` worker attempts per
polling pass, in WorkItem rank order, with Trigger serializing attempts per
repository (`concurrencyKey`). Rank is explicit; the highest-ranked runnable
WorkItem is the main effort. Being blocked does not change rank. Running attempts
are not preempted by rank changes. Every time supporting work runs ahead of the
main effort, the reason (blocked, awaiting decision, repository busy,
provider_down, provider_limited, provider_unknown, no_slot) is recorded.

Active attempts are counted by `listActiveAttemptsForScheduling`: only attempts
with an in-flight `worker.attempt` intent or in `stopping` status count; attempts
left `dispatched` after a `verify.run`/`lead.review`/`lead.accept` dispatch, and
attempts belonging to halted or completed items, are excluded. Provider capacity
gating (`ProviderCapacity` aggregate) precedes the slot gate in `selectDispatch`
(Slice 6, confirmed live 2026-09-08).

Lifecycle (queued, active, paused, completed, cancelled), execution condition
(ready, running, blocked, awaiting decision), and rank are distinct. A
completed Attempt is not a completed WorkItem.

## Findings and dispositions

The Lead classifies each Finding; the coordinator records the disposition.

| Finding | Disposition |
| --- | --- |
| Required by current criteria and within bounds | Bounded remediation under the same contract, new Attempt. |
| Needs different scope, architecture, or criteria | Scope Decision; replacement contract if within authority, else human decision. |
| Unrelated defect or improvement | Linked backlog WorkItem; does not block acceptance. |
| Prevents safe or correct continuation | Block the WorkItem and name the resume condition. |
| Duplicate or unsupported | Link the original or dismiss with a reason. |

Match Findings by subject and cause before creating another.

*Implementation: finding dispositions in `packages/domain/src/findings/disposition.ts`; acceptance rule with 14 reason codes (`PROPOSAL_REJECTS`, `VERIFIER_TAMPERED`, `CRITERION_UNCITED`, `CRITERION_UNSATISFIED`, `CITED_RESULT_MISSING`, `CITED_RESULT_NOT_PASSING`, `RESULT_VERSION_MISMATCH`, `REVIEW_MISSING`, `REVIEW_VERSION_MISMATCH`, `REVIEW_BLOCKING`, `REVIEW_BELOW_REQUIRED`, `REVIEWER_NOT_DISTINCT`, `APPROVAL_REQUIRED`, `APPROVAL_VERSION_MISMATCH`) in `packages/domain/src/evidence/acceptance.ts`; verifier-tampering detection in `packages/domain/src/evidence/integrity.ts` (protected paths: package manifests, lock files, workspace file, tsconfig*, biome.json, .github/**, vitest/jest configs; test source files are not protected); integration decision logic in `packages/domain/src/integration/decide.ts` and `packages/domain/src/integration/manifest.ts`; runtime enforceability in `packages/domain/src/authority/runtime.ts` — `deploy` boundary returns `DEPLOY_NOT_SUPPORTED` (not yet implemented; only `artifact` and `merge` are supported).*

## Version repair

| Change | Transition |
| --- | --- |
| Output needs correction; contract valid | New Attempt under the same contract once the prior run is final. A Failure record for the superseded attempt is committed in the same transaction before the new attempt is inserted. |
| Inputs, scope, or criteria change | Supersede the StepContract; new version, new Attempt; prior Attempt's generation revoked. |
| Evidence may carry forward | Link prior Artifacts with provenance. Reuse a VerificationResult only when criteria, profile, inputs, and revision match exactly; otherwise rerun. |

No instance is rebound in place. No Approval or Review transfers to a changed
subject version. Superseded Attempts may complete their run and their output is
stored as history, but their generation cannot advance state. Their worktrees
are retained until the retention policy removes them.

## State-transition rule

Every policy-relevant transition is validated in `packages/domain`, committed
to Postgres with actor, causation, and an idempotency key, and only then
followed by a DispatchIntent. Trigger runs are consumed as observations with
the run id and attempt generation as the dedupe identity.

*Implementation: failure classification table over 13 Trigger statuses in `packages/domain/src/failure/classify.ts`; dispatch selection in `packages/domain/src/dispatch/`.*
