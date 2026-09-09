# Architecture Decision Records

Accepted ADRs are immutable. A changed decision gets a new record that names
the decision it supersedes. Create the next record with `docslime add adr
<short-slug>` and update this index.

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-authority-boundaries.md) | Preserve authority boundaries | Accepted; runtime authority named by ADR-0005 | 2026-09-06 |
| [0002](0002-modular-monolith.md) | Start as a modular monolith | Accepted; amended by ADR-0005 | 2026-09-06 |
| [0003](0003-evidence-first-completion.md) | Completion is evidence-first | Acceptance semantics superseded by ADR-0004; state separation and failure taxonomy retained | 2026-09-06 |
| [0004](0004-supervised-completion-and-safe-recovery.md) | Supervised completion of recoverable work | Accepted; "supervisor" renamed Lead by ADR-0006; effect reconciliation narrowed by ADR-0007 | 2026-09-06 |
| [0005](0005-trigger-as-execution-runtime.md) | Adopt self-hosted Trigger.dev as the execution runtime | Host-first deployment and API-key-only container choice superseded by ADR-0008; runtime authority retained | 2026-09-07 |
| [0006](0006-lead-role-and-delegated-authority.md) | The Lead role and the delegated-authority schema | Accepted | 2026-09-07 |
| [0007](0007-worker-effect-model.md) | Workers produce proposals, not effects | Host-only storage/auth placement superseded by ADR-0008; effect boundaries retained | 2026-09-07 |
| [0008](0008-compose-first-container-runtime.md) | Make Compose and disposable task containers the default runtime | Accepted; implementation pending | 2026-09-08 |
