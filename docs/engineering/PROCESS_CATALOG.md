# Initial process catalog

One process exists and it is code, not data. A ProcessDefinition type is
introduced when the second process shows what varies.

## Selection

`lead.plan` maps operator intent and project context to a supported process.
If necessary facts are missing it asks for them (a pending decision naming the
gap). If no process fits it records a mapping alert with the nearest candidate
and the failed entry condition. It never invents an unbounded process.

## Bounded repair v1

| Contract part | Definition |
| --- | --- |
| Input | One Project, exact base revision, an observed defect with reproduction or a testable expected behavior, and operator intent. |
| Entry | Lead proposal within delegated authority: criteria, verification profile, review depth, completion boundary, allowed paths, capabilities, budget. Coordinator confirms runtime enforcement and admits. |
| Allowed work | Implement the repair and a relevant regression test inside allowed paths and capabilities. Existing project rules apply. |
| Output | Attempt ref revision, diff digest, worker report, VerificationResults, Review, Finding dispositions. |
| Completion | Every criterion holds on the attempt revision, required checks pass, Review has no blocking finding, acceptance Decision recorded at the declared boundary. |
| Failure | Execution failure → new Attempt within budget. Contract failure → Lead disposition. Process failure → halt and human decision. |
| Escalation | Out-of-authority proposal, unsupported enforcement, exhausted budget, blocking Finding, integration conflict. |

### Worked example

An operator asks for a repair: the parser accepts a known-invalid input.

1. `lead.plan` proposes: the exact input must be rejected; representative valid
   inputs stay accepted; unrelated parsing is out of scope; paths limited to
   the parser module and its tests; `pnpm test` and typecheck as checks;
   behavior-change review profile; `artifact` boundary; 2 attempts,
   `maxDuration` 20 minutes. The coordinator verifies each bound
   is inside the Project's authority and freezes the StepContract.
2. `worker.attempt` runs. The worker fixes the parser and adds a regression
   test. It notices an unrelated diagnostic improvement and reports it as a
   Finding. The adapter commits `agencyhq/attempts/<id>` in the attempt
   worktree and returns the report.
3. The Lead classifies the Finding as unrelated; the coordinator creates a
   backlog WorkItem and does not widen the contract.
4. `verify.run` executes the pinned checks on the attempt revision.
   `lead.review`, with a different model where the schema requires it,
   challenges the claim against the diff and results. A failing criterion goes
   back as a new Attempt under the same contract; the criterion is not weakened.
5. `lead.accept` proposes acceptance; the coordinator confirms every criterion
   cites passing evidence and records the Decision. For a one-step WorkItem
   the same Decision completes the WorkItem. No human Approval is requested
   because the authority schema did not require one for this change class.

If the operator had asked for a merge, step 5 is followed by `integrate.merge`
and completion waits for the resulting target revision.

See [DOMAIN_MODEL.md](DOMAIN_MODEL.md), [EXECUTION_MODEL.md](EXECUTION_MODEL.md),
and [TESTING.md](TESTING.md).
