# Product design baseline

## Operator mental model

AgencyHQ should feel like a mission-control surface for engineering work, not a
chat transcript viewer. The stable objects are Campaigns, Projects, Initiatives,
Goals, processes, allocations, and evidence. Agent conversations and Trigger.dev
runs are inspectable implementation details attached to those objects.

## Primary workspace

Lead with changed outcomes, decisions needed, and work that continues. The
following views support those jobs rather than requiring the operator to browse
every domain object:

- a Campaign overview with linked Projects, Goals, ranked Initiatives, and the
  currently declared main effort;
- a process view that separates contract state, execution state, process state,
  and acceptance state;
- a capacity view showing current ProviderCapacity observations, active
  WorkerAllocations, queued work, and recorded allocation reasons;
- an evidence view joining Git revisions/diffs, Artifacts, VerificationResults,
  Findings, and exact-version Approvals;
- explicit operator actions for scope changes, reruns, cancellation, approval,
  rejection, and process-definition repair.

## Return after interruption

The first executable slice needs a minimal view for this journey:

1. On return, show changes since the operator's last acknowledged visit: accepted
   results, failed or blocked work, and newly required decisions. The declared
   main effort remains visible even while supporting work receives capacity.
2. Each decision names the obstacle, the supervisor's recommended action, its
   scope/budget impact, and the consequence of taking no action. Routine work
   already within authority continues without requesting another approval.
3. Each completion summary names the criterion met, completion boundary, review
   outcome, and evidence link. If a claim was reopened, show the new reason next
   to its historical acceptance.
4. Show what continues while the operator is away and whether observations are
   fresh. Missing contact reads as uncertain, never idle or stopped.
5. Pause explains that no new steps start and the current step may finish. Stop
   shows requested/stopping until termination is confirmed; isolation is labeled
   separately. Existing side effects remain visible and are not implied undone.

The acceptance scenario is an operator who can correctly identify what advanced,
what needs them, what continues, and why completion is justified without opening
worker logs. Keep the initial view small; add full campaign navigation later.

## Interaction principles

1. Show observation freshness with each status; make authoritative identities,
   versions, and timestamps inspectable without filling summaries with raw IDs.
2. Never render “done” from a worker message or Trigger.dev run alone.
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
Potentially destructive actions identify the exact Campaign, Project, worktree,
contract version, and consequence, and require the coordinator to revalidate
authority at command time.
