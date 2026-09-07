# Initial process catalog

This is a planned contract example, not an executable workflow. Start with one
process and derive reusable structures from its use; do not build a general
workflow designer first. Every process names its inputs, authority, outputs,
gates, remediation budget, and escalation conditions.

## Selection

The supervisor maps intent and project context to a supported process version.
If necessary facts are missing, request those facts or authorize a separately
bounded investigation. If no process fits, record a mapping alert with the
nearest candidates and failed entry conditions. Do not invent an unbounded
execution process to avoid the alert.

## Bounded repair v1

| Contract part | Definition |
| --- | --- |
| Input | One Project, exact base revision, observed defect with reproduction or a testable expected behavior, allowed scope, and operator authority. |
| Entry | Supervisor approves the definition of done, verification profile, completion boundary, review depth, attempt/time budget, and integration owner; coordinator validates runtime controls and capacity. |
| Allowed work | Implement the repair and relevant regression test inside allowed paths/capabilities. Existing project rules apply. The worker cannot change acceptance criteria or publish independently. |
| Output | Exact diff/commit and artifact identities, honest worker report, verification results, review evidence, and dispositions for discovered Findings. |
| Completion | The approved behavior holds, relevant regression checks pass, required review has no unresolved blockers, and the supervisor accepts at the declared boundary. |
| Failure | Execution uncertainty uses the recovery gate; unmet criteria use bounded remediation; contradictory process requirements require a replacement process decision. |
| Escalation | Missing authority, unsupported enforcement, changed scope/criteria, exhausted budget, or an external effect that cannot be reconciled. |

### Worked example

An operator requests a repair for a parser that accepts a known-invalid input.
The supervisor records that the exact bad input must be rejected, representative
valid inputs must remain accepted, and unrelated parsing behavior is out of
scope. It pins the relevant Project checks and chooses an accepted-artifact
boundary unless the request requires merge or deployment. As a behavior change,
the work needs targeted tests and one independent adversarial review.

1. Coordinator reserves the single worker slot and dispatches the approved
   StepContract in an isolated attempt worktree.
2. Worker changes the parser and adds a regression test. An unrelated diagnostic
   improvement is reported as a Finding; the supervisor records it in the
   backlog without expanding the repair.
3. On interruption, the coordinator reconnects the known session or satisfies
   the replacement gate before dispatching a fresh attempt. It retains the
   original budget and any explicitly selected, stable prior output.
4. Verification runs the approved checks on exact outputs. The non-authoring
   supervisor or a separate reviewer challenges the completion claim. A failing
   criterion returns for bounded remediation under the same contract; it is
   not resolved by weakening the criterion.
5. Supervisor accepts the evidence once the gates pass. For this one-step Goal,
   reuse that acceptance at the Goal level. If the approved boundary is merge
   or deployment, obtain the corresponding integration/live evidence first.

No separate human sign-off is added unless required by policy. An editorial
repair can use the lighter profile in [TESTING.md](TESTING.md); a migration needs
a suitable process and compatibility checks rather than stretching this example.

See [scope, Findings, and version repair](DOMAIN_MODEL.md),
[execution and recovery](EXECUTION_MODEL.md), and [completion](TESTING.md).
