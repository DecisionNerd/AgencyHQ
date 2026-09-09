# Product design baseline

## Operator mental model

AgencyHQ should feel like a mission-control surface for engineering work, not a
chat transcript viewer. The stable objects are Projects, WorkItems,
StepContracts, Attempts, Decisions, and evidence. Agent conversations and Trigger.dev runs are inspectable
implementation details attached to those objects; live run state comes from
Trigger Realtime and raw logs live in the Trigger dashboard, linked, not copied.

## Primary workspace

Lead with changed outcomes, decisions needed, and work that continues. The
following views support those jobs rather than requiring the operator to browse
every domain object:

- a work overview with linked Projects, ranked WorkItems, and the declared
  main effort;
- a WorkItem view that separates contract state, execution state (live from
  Trigger), verification state, and acceptance state;
- a decisions view listing Lead proposals that exceeded authority, each with
  the obstacle, recommendation, impact, and consequence of no action;
- an evidence view joining attempt revisions/diffs, VerificationResults,
  Reviews, Findings, Decisions, and exact-version Approvals;
- explicit operator actions for scope changes, new attempts, stop, pause,
  approval, rejection, and authority-schema edits.

## Return after interruption

The first executable slice needs a minimal view for this journey:

1. On return, show changes since the operator's last acknowledged visit: accepted
   results, failed or blocked work, and newly required decisions. The declared
   main effort remains visible even while supporting work receives capacity.
2. Each decision names the obstacle, the Lead's recommended action, its
   scope/budget impact, and the consequence of taking no action. Routine work
   already within authority continues without requesting another approval.
3. Each completion summary names the criterion met, completion boundary, review
   outcome, and evidence link. If a claim was reopened, show the new reason next
   to its historical acceptance.
4. Show what continues while the operator is away and whether observations are
   fresh. Missing contact reads as uncertain, never idle or stopped.
5. Pause explains that no new steps start and the current step may finish. Stop
   shows requested/stopping until Trigger reports a final run status, then
   stopped. A stopped worker cannot have touched a shared ref; any checkpoint
   ref it committed remains visible and is not implied discarded.

The acceptance scenario is an operator who can correctly identify what advanced,
what needs them, what continues, and why completion is justified without opening
worker logs. The initial view is small; Campaign navigation was added in Slice 5.

## Interaction principles

1. Show observation freshness with each status; make authoritative identities,
   versions, and timestamps inspectable without filling summaries with raw IDs.
2. Never render “done” from a worker message or Trigger.dev run status alone.
3. Make blocked, awaiting approval, retryable execution failure, failed
   contract, and failed process visually and semantically distinct.
4. Preview scope and capacity impact before an operator commits a command.
5. Preserve history: correction creates a new version or transition rather than
   rewriting the record that justified an earlier decision.
6. Default summaries to evidence and exceptions; keep raw logs available for
   diagnosis without making them the primary interface.
7. Scale review and approval to risk. Do not add a confirmation screen or another
   review round for routine work already authorized by the current contract.

## Accessibility and safety

All state distinctions require text and iconography rather than color alone.
Potentially destructive actions identify the exact Project, WorkItem, attempt
(where applicable), contract version, and consequence, and require the coordinator
to revalidate authority and generation at command time.
