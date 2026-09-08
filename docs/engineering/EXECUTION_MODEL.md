# Durable execution model

Trigger.dev supplies durability, isolation, limits, retries, cancellation, and
observation (ADR-0005). This document defines what the coordinator adds and how
the two compose. Anything Trigger already does is referenced, not reimplemented.

## Lifecycle of one step

1. **Plan.** The coordinator dispatches `lead.plan` for the WorkItem. The Lead
   proposal is checked against delegated authority; the result is a Decision
   and a frozen StepContract (or a pending human decision). The proposed
   `profileId` must come from the project's verification profile catalog; a
   proposal naming an unlisted profile becomes a `pending_human` decision with
   `PROFILE_NOT_IN_CATALOG` and is not retried automatically.
2. **Admit.** The coordinator confirms rank, budget, and that every bound the
   contract requires is enforceable by the runtime. It records an Attempt with
   a new authority generation and a DispatchIntent, in one transaction.
3. **Dispatch.** It triggers `worker.attempt` with `idempotencyKey` = intent id
   (global scope, TTL covering the retry window), `concurrencyKey` =
   repository id, `machine` and `maxDuration` from the contract, and tags for
   Project, WorkItem, contract version, and attempt. The run id is stored on
   the intent. A lost response is retried with the same key and returns the
   same run.
4. **Execute.** The adapter process creates the attempt worktree at the base
   revision, spawns OpenCode as a child process group with a scrubbed
   environment and the contract's permission rules, publishes progress to run
   metadata, and on exit diffs, path-checks, commits
   `agencyhq/attempts/<attempt-id>` locally, and returns the report as run
   output. (Container profile: fresh clone, then push with a generation-bound
   token.)
5. **Observe.** The coordinator polls open DispatchIntents and retrieves each
   run by id; tags are used by the operator view's realtime subscription. On a
   final status it stores the report and classifies the outcome (below).
   A worker output with a null commit id (nothing changed) is classified as a
   failure; no Artifact is created (untested: no test covers this path yet).
   A completed run with a valid commit id has its Artifact stored. Status
   updates (completion, quarantine, failure) are guarded by the attempt's
   expected prior status (`WHERE status IN ('admitted','dispatched','running')`);
   a stop that lands between `applyObservation` and the update wins
   (`stale_status`): the observation is skipped, the intent stays open, and
   the reconciler routes the `stopping` attempt to confirmation at its next
   poll — any final run status, COMPLETED included, triggers that route with
   the same evidence order and deadline. Duplicate deliveries are no-ops keyed
   by run id and attempt generation; a delivery for a revoked generation is
   stored as history-only (stale) and does not advance state.
6. **Verify.** `verify.run` is dispatched against the attempt revision with the
   approved profile; results are stored as VerificationResults.
7. **Review.** `lead.review` is dispatched with the diff, criteria, and results;
   the output is a Review record.
8. **Accept.** `lead.accept` proposes acceptance; the coordinator checks the
   proposal names every criterion, cites passing results, and has no blocking
   Review finding, then records the acceptance Decision. If the authority
   schema requires it (`humanRequired` is true), the work item is parked as
   `pending_human` until a matching Approval exists (untested: no test covers
   this parking path yet). No Approval write path (command or API) exists yet;
   this is Slice 4 scope.
9. **Integrate** (merge or deploy boundaries only). `integrate.merge` runs with
   an operation-scoped credential, serialized per repository, idempotent by
   attempt and target revision.

Lead and human decisions happen between runs. No run waits on a human; a
waiting self-hosted run holds its process or container and a concurrency slot.

## Idempotency

| Operation | Identity | Mechanism |
| --- | --- | --- |
| Dispatch | DispatchIntent id | Trigger `idempotencyKey`, global scope. Keys clear on run failure, so a retried failed run needs a new intent, which needs a Decision. |
| Run observation | Trigger run id + attempt generation | Coordinator upsert; stale generation stored as history only. |
| Attempt commit | `agencyhq/attempts/<attempt-id>` | Adapter commits to the attempt's own branch; a retried adapter step finds the branch and re-reads it. |
| Token issuance (container profile) | Attempt id + generation + purpose | Coordinator rejects stale generation; tokens expire in minutes. |
| Integration | Attempt id + target ref + expected base revision | Compare-and-set on the target ref; a replay finds the ref already advanced and records completion. |
| Operator command | Command id from the UI | Coordinator idempotency table. |

## Failure taxonomy

| Class | Trigger observation | Coordinator response |
| --- | --- | --- |
| Execution failure | Run `crashed`, `timed_out`, `system_failure`, `expired`, OOM, or `canceled` by policy; provider outage reported by the adapter. | Trigger's retry policy handles transient attempts within the task's `maxAttempts`; once the run is final, the coordinator may create a new Attempt within the step budget. When a new Attempt is admitted, a Failure record for the superseded attempt is committed to Postgres in the same transaction before the new attempt row is inserted. No Decision needed unless budget is exhausted. |
| Contract failure | Run `completed` with unmet criteria, failed VerificationResult, path violation, or `failed` via `AbortTaskRunError`. | Lead disposition: bounded remediation under the same contract or a replacement contract. Never automatic retry. |
| Process failure | Coordinator cannot compute a valid next state: contradictory authority, missing gate, impossible dependency. | Halt the WorkItem; repair the authority schema or process code; human decision. |

Failures are domain records with class, phase, attempt, run id, cause, and
evidence. Trigger status is the observation that supports the class.

## Stop, cancel, and replacement

Because workers cannot cause external effects (ADR-0007), replacement is short:

1. **Revoke.** Advance the attempt's authority generation in Postgres. From
   this instant observations for the old generation are history-only.
2. **Cancel.** Call `runs.cancel`. If the run is already in a final state
   and the cancel call throws, the attempt's generation is already revoked; the
   stop command completes with `cancelSkipped: true` and the attempt proceeds
   normally through stop confirmation. The adapter's `onCancel` gets a bounded
   grace period: it commits the worktree to `agencyhq/checkpoints/<attempt-id>`,
   sends SIGTERM then SIGKILL to the OpenCode process group, and records
   whether any process survived. `runs.cancel` also cancels child runs.
3. **Confirm.** The reconciler always routes CANCELED/TIMED_OUT worker
   observations to stop confirmation; no such observation is skipped. If the
   attempt is `dispatched` or `running` at that point (externally cancelled or
   hard-timed-out by Trigger), the coordinator first calls `stopAttempt` with
   actor `"coordinator"` to transition it to `stopping`, then calls
   `confirmStop`. Evidence is read in priority order: (1) run metadata
   (`survivors`, `checkpointCommit`) from the observation, (2) the run
   directory's `stop.ndjson` file — `readStopEvidence` parses the adapter's
   `step` and `checkpointCommit` NDJSON fields (with legacy `event`/`commit`
   keys accepted for compatibility) — when metadata has no `survivors` field,
   (3) pending — no evidence yet. The checkpoint commit is recorded on the
   attempt row. On the host profile, the Trigger API reports a final status
   before adapter cleanup completes (observed 22–38 ms after `runs.cancel` in
   the Slice 1 trial); `stop.ndjson` is the fallback evidence source for that
   gap. `AGENCYHQ_UNCERTAIN_AFTER_MS` (default 120 000 ms) applies on the
   reconciler's confirmation route; if the deadline passes with no evidence,
   the attempt becomes `uncertain` and the work item condition `uncertain`;
   no replacement runs on that repository while uncertain. The adapter also applies a soft deadline (`maxDuration` minus 15 s,
   minimum 5 s) to stop the worker before the CLI delivers SIGTERM on
   `maxDuration`, returning outcome `timed_out` with the run COMPLETED; the
   hard `maxDuration` remains the backstop. See the
   [Slice 1 execution trial](../engineering/trials/2026-09-slice1.md). The UI
   shows *stopping* until confirmation and *stopped* after. The cancelled
   observation is recorded as history-only (stale) so it does not advance state
   on a later delivery. Stop command replay returns `replayed: true`.
4. **Operator-stop: no replacement.** On an operator-initiated stop the
   coordinator records the final status and checkpoint revision but does not
   admit a new Attempt. The work item stays at its pre-stop lifecycle state
   (no auto-replacement). A new Attempt requires an explicit operator or Lead
   decision. For *automatic* retry on execution failure (not an operator stop),
   the coordinator may admit a new Attempt under the remaining step budget,
   starting from the base revision or a Lead-selected checkpoint. The old
   worktree is retained for inspection, never reused.

Integration tasks are the one place an effect can be in flight. They are
serialized per repository and compare-and-set on the target ref; an unknown
outcome is resolved by reading the ref, never by retrying blindly.

## Contact loss

If the coordinator cannot reach the Trigger API, or Trigger cannot reach the
`trigger dev` process on the host, observations are marked stale, dispatch
stops, and no decisions are made. `maxDuration` still bounds running work, so
the worst case is a bounded run finishing without an observer; its output is
retrieved when contact returns. Lost contact is displayed as *uncertain*,
never *stopped* or *idle*. If the host process dies, Trigger reports the run
as crashed or system failure and the worktree remains on disk for inspection.

## Pause

Pause stops new dispatch. Running attempts continue to their bounded end. The
UI names which run may still finish and links to it. Pause does not cancel.

## Budgets

A StepContract's budget is: attempts, `maxDuration` per attempt, and an
estimated-spend ceiling (machine preset on the container profile). Trigger
enforces attempts and duration per run. Spend is an estimate from token usage reported by OpenCode; it is never
represented as a hard limit until a model gateway exists.

## Basis

Fencing by generation follows [Kleppmann's analysis of distributed locks](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html);
idempotent operation identities follow [Amazon's guidance on idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).
Trigger behaviors cited here come from its documentation as read on 2026-09-07
and must be re-verified when the pinned version changes. The
[execution trial](TESTING.md#required-execution-trial) is the proof.
