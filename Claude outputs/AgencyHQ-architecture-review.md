# AgencyHQ — critical design and architecture review

Reviewed at commit `7cabdd0` (2026-09-07). The repository is documentation only: 33 files, no runtime code, one baseline test. This review therefore judges the *design as written* — its internal consistency, the load-bearing assumptions, and whether the plan de-risks the right things first. Nothing in the repository was changed.

## Summary verdict

The documents are unusually disciplined. The authority-boundary decision (ADR-0001), the separation of execution/contract/process failure, the evidence-first completion rule, the fencing-based replacement gate, and the refusal to represent planned work as current are all well reasoned and better than most systems of this kind ever write down. If the review stopped at "is the thinking sound," the answer would be yes.

The problems are structural, and there are five that matter:

1. **The supervisor — the component everything depends on — is never defined as a thing.** It is a "role" that makes judgment calls no deterministic code can make, yet R-005 and the non-goals forbid the only mechanisms that could implement it. This is the largest hole in the design.
2. **The runtime that provides isolation, egress control, and trusted termination is not a component.** The enforcement table assigns most hard guarantees to "the runtime," and no document says what the runtime is, where worktrees live, or who confirms a process is dead.
3. **Trigger.dev's role has been reduced until it no longer justifies its cost,** and no ADR records why it was chosen over a Postgres-backed queue that the design already half-builds.
4. **The domain model and requirement set are sized for the Slice 6 system, not the Slice 3 one.** The worked example collapses the hierarchy itself ("for this one-step Goal, reuse the acceptance at the Goal level"), which is the design telling you it is overweight.
5. **The roadmap defers the riskiest assumption to Slice 3,** after two slices of domain and persistence work are built around it.

Details follow, roughly in order of consequence.

## 1. The supervisor is undefined

Across DOMAIN_MODEL, PROCESS_CATALOG, TESTING, and ADR-0004, the supervisor is asked to: approve the definition of done from operator intent and repository context; choose the smallest adequate verification profile; pin review depth and completion boundary; select a process version or record a mapping alert with nearest candidates; classify Findings into five dispositions; classify failures into three categories; decide bounded remediation vs. replacement contract; perform adversarial review "asking what could make the completion claim false"; and record acceptance with rationale.

Every one of those is a judgment task over natural-language intent and code. Only three things can perform it: a human, an LLM agent, or an LLM call embedded in the coordinator. The documents rule out or contradict each:

- If the supervisor is **the human operator**, then "automatic progress when evidence is sufficient," "no separate human sign-off," and "human approval is requested only where policy requires it" are hollow — the human is already in every transition. The whole proportionality argument in ADR-0004 collapses.
- If the supervisor is **an OpenCode agent**, then it is a worker with elevated authority, and the worker/supervisor authority split (R-014) depends on prompt discipline — which ARCHITECTURE.md itself says "is not enforcement." It also makes "independent adversarial review by the supervisor" a review of one model's output by the same model.
- If the supervisor is **an LLM call inside the coordinator**, that violates R-005 ("AgencyHQ shall not implement an agent loop or model-provider adapters") and the PRODUCT.md non-goal against custom LLM-provider integrations.

DOMAIN_MODEL.md says only that the supervisor "operates through the coordinator rather than a separate authority or worker agent loop," which describes what it is *not*. The design has to pick one. My reading is that the intended answer is the third option, and that R-005 should be narrowed to "no custom *coding-agent* loop" — but that is a decision that needs an ADR, because it changes what the coordinator is (a policy engine vs. a policy engine plus a reasoning agent) and introduces the very provider dependency the non-goals forbid.

Two related gaps follow from this one:

**"Delegated authority" has no model.** Whether a human ever sees a decision depends on whether the supervisor's choice "exceeds delegated authority." Nothing defines the shape of that authority: is it a budget, a path allowlist, a risk class, a boundary (artifact/merge/deploy), a list of permitted profiles? Without a schema, R-006, R-014, R-017 and the Findings table cannot be tested, and the operator cannot preview "scope and capacity impact before committing a command" (DESIGN principle 4).

**Repository content is trusted for the supervisor but untrusted for workers.** The security baseline says "treat worker output, repository content, and external callbacks as untrusted," while the supervisor approves the definition of done using "repository instructions" and "project context." An `AGENTS.md` or test file in a linked repository can therefore steer the definition of done. This is a prompt-injection surface on the highest-authority component and it is not mentioned.

Finally, the quality of the product rests on supervisor judgment — that is the differentiator, not the fencing. There is no design for how the supervisor gets context, how its decisions are evaluated, or how its error rate is measured. The docs are meticulous about mechanism and silent about the thing that determines whether the mechanism is worth using.

## 2. "The runtime" is a missing component

The enforcement-boundaries table assigns the following to "the runtime": isolating each attempt's writable files; preventing access to other worktrees, shared Git metadata, and host credentials; applying capability and egress controls; enforcing hard duration and process limits; and confirming termination of a worker and all descendants (the replacement gate calls this "the trusted runtime" and says an abort request or lease expiry is insufficient). R-016 says dispatch must *reject* contracts whose required controls the runtime cannot provide.

The runtime does not appear in the system-boundary table, the component list, or the Mermaid diagram. Candidates are implicit and contradictory:

- **Trigger.dev** runs tasks in containers, so it is the closest thing to a runtime in the diagram. But the docs declare its state "observational, not authoritative," so it cannot be the trusted source that confirms termination.
- **OpenCode** is "an agent runtime," but it runs *inside* whatever isolation exists; it cannot enforce boundaries on itself.
- **Docker / Firecracker / a sandbox provider** is never mentioned.

Concretely undecided, with large consequences:

- **Where do worktrees live?** The Git adapter (coordinator-owned) must create worktrees, snapshot them, quarantine disallowed diffs, and commit. OpenCode must write to them. If OpenCode runs in a Trigger task container, the worktree is on that container's filesystem and the coordinator's adapter cannot reach it without a shared volume or a co-located agent. If worktrees live on the coordinator host, workers are not isolated from it. The diagram shows both Coordinator→Git and OpenCode→Git with no topology.
- **Provider credentials.** OpenCode needs model-provider keys in its environment. A worker with shell access can read its own environment; "keep credentials outside prompts and artifacts" does not address that. Only egress control and per-attempt short-lived keys do, and both need the runtime that isn't named.
- **Verification isolation.** TESTING.md requires the verification adapter to run approved checks "against a stable snapshot in an isolated environment" with a recorded environment fingerprint. That is a CI system — repo checkout at a revision, toolchain, sandbox, log capture. It needs the same undefined runtime and is a project on its own.
- **Termination proof.** "Trusted confirmation of termination or effective isolation" for a process tree is only available from something that owns the process namespace or the VM. Nothing in the design owns that.

Until the runtime is a named component with an ADR, R-003, R-013, and R-016 are not requirements; they are hopes, and the recovery gate cannot be implemented.

## 3. Trigger.dev is selected without a recorded reason, and the design has stripped it of the reasons

The docs progressively remove responsibilities from Trigger.dev: it is not domain truth; its run state is telemetry; it cannot create OpenCode sessions or retry a mutating step; its retries may only "reconcile the assigned attempt"; checkpoints are noted as unavailable when self-hosted, so "domain recovery must work without checkpointed process memory"; and the coordinator owns the outbox, idempotency keys, leases, authority generations, effect reconciliation, and capacity reservations.

What remains is "durable invocation, retry, scheduling, waits." A transactional outbox in Postgres plus a poller — which R-002 already mandates — *is* durable invocation. pg-boss or graphile-worker provide retry, scheduling, and delayed jobs in the same database, with no extra services. Self-hosting Trigger.dev v4 means running its webapp, supervisor, Postgres, Redis, ClickHouse, and an OCI registry for one operator and one worker. That is the opposite of "add infrastructure only when a concrete requirement earns it" and sits awkwardly beside ADR-0002's ban on Kafka and Temporal for lack of demonstrated need — Trigger.dev is a heavier deployment than either a queue table or Temporal's dev server.

ADR-0004 says "Trigger.dev remains selected," and ARCHITECTURE.md says to record an ADR *if the trial fails*. There is no ADR for the original selection. The claim should be either justified (what does Trigger provide that the outbox plus a queue library does not, at this scale?) or demoted to "candidate execution backend, to be qualified by the Slice 3 trial against a Postgres-backed alternative."

Two smaller Trigger-related issues: the name "supervisor" collides with Trigger.dev v4's own self-hosted component of the same name, which will cause confusion in code, logs, and ops docs; and ARCHITECTURE.md's "one web deployment, one coordinator deployment" contradicts ADR-0002's "smallest useful shape" — for one operator, a single Node process serving both is the smallest shape.

## 4. The model is sized for the end state

DOMAIN_MODEL lists fourteen aggregates. REQUIREMENTS lists nineteen requirements, including cross-campaign global allocation, compatible-revision manifests across repositories, nested-delegation accounting, deployed-outcome boundaries with live observations, and ProviderCapacity validity windows. PRODUCT.md's first proof is "one repository, one bounded repair process, one active worker."

Specific overweight points:

- **Campaign / Initiative / Goal / StepContract each own some notion of scope or done.** Initiative "owns scope and lifecycle"; Goal owns "definition of done and completion boundary"; StepContract owns "acceptance obligations"; Campaign owns "policy set." Goal↔Initiative is many-to-many ("linked to one or more Initiatives" and "Initiatives are the controlled work used to pursue them"). The worked example resolves this by reusing one step's acceptance at the Goal level — i.e., for the first year of use the hierarchy is a single node. Collapse Goal and Initiative into one work item with rank and a definition of done; introduce Campaign only when there are two of them.
- **ProcessDefinition as immutable versioned data** while the same docs forbid a workflow designer and specify exactly one process. A single process expressed as data is the first step of building the designer you said you wouldn't build. Make "bounded repair v1" code; extract a definition type when the second process exists and you can see what varies.
- **ProviderCapacity** is Slice 6 by the roadmap's own account. It should not be in the Slice 1 aggregate map.
- Requirements R-008, R-015 (multi-repo), and R-016 (nested agents) describe systems that do not exist and are explicitly disabled. Keeping them as "stable IDs" is defensible; giving them equal standing with R-001 to R-007 dilutes the contract and invites building toward them.

The failure taxonomy (execution / contract / process) is the right size. Note only that classification itself is a judgment that the docs assign to no one; it lands on the supervisor, which brings the problem back to section 1.

## 5. The roadmap defers the riskiest assumption

Slice 1 builds the domain kernel in memory; Slice 2 builds Postgres persistence with attempt generations, outbox, and external-operation ledger; Slice 3 is the first time Trigger.dev, OpenCode, worktrees, isolation, and termination are touched, and it is where the docs themselves say the design might fail ("if the trial fails the recovery contract, record an ADR … before changing backend").

Everything in Slices 1–2 is shaped by assumptions about Slice 3: that Trigger can be driven idempotently by dispatch identity, that OpenCode sessions can be looked up and reconnected, that a runtime can confirm termination, that worktrees can be reached by both sides. If any of those is false, the ledger schema, the generation model, and the outbox contract change. The five bullets under "Required first execution trial" in TESTING.md are exactly the right experiments — they should be a throwaway spike *before* Slice 1, with no domain model at all, just to learn whether the mechanisms can meet the contract. That spike also forces the runtime decision in section 2.

## 6. The baseline test protects the wrong ADR

`tests/architecture-baseline.test.mjs` is the only executable thing in the repository. Its `requiredDocs` list includes ADR-0001 through ADR-0003 and omits ADR-0004 — the record that supersedes ADR-0003's acceptance semantics and is the current decision. The link-resolution and "no template guidance" checks therefore never run against ADR-0004, and the "required records exist" check would pass if ADR-0004 were deleted.

Beyond that defect, the "authority ADR preserves the core boundary" test asserts five regexes against prose. That is ceremony of the kind TESTING.md elsewhere rejects — it cannot catch a substantive change ("Trigger.dev is the durable execution mechanism *and domain truth*" still matches) and it will break on harmless rewording. The link check is worth keeping; the prose assertions are not.

There is no CI, which the docs acknowledge. With nothing to run but a doc check, that is fine for now, but the check should be exercised in CI before the first code slice, not after, so that the habit exists.

## 7. Smaller inconsistencies and gaps

- **Worker credentials.** The security baseline says "grant workers repository- and operation-scoped credentials," while ARCHITECTURE says workers "edit assigned files and propose outputs" and the Git adapter owns all shared-ref mutations. If the adapter does every fetch, commit, and push, workers need *no* Git credentials, which is a simpler and stronger statement. Pick one.
- **"An existing qualifying PR review counts"** presupposes a GitHub/GitLab integration that is out of scope, and a way to bind an external review to an exact revision and evidence set. Either scope it in or drop the sentence.
- **Independence of adversarial review** is asserted and then hedged ("review by another agent is useful evidence, not a guarantee"). If the reviewer and author are the same model with different prompts, say so and say what that is worth; if independence means a different model or a human, say that, because it determines cost and latency for every behavior change.
- **Structured worker reports.** The lifecycle requires OpenCode to "report outputs, checks, limitations, unmet criteria, and Findings." OpenCode returns text. A report schema, its validation, and its status as untrusted input are unspecified. (The docs are correct that verification must not depend on the report; the report's only role should be routing the supervisor's attention.)
- **Idempotency replay window** is required ("retain identities through the supported replay window") but never sized.
- **Web ↔ coordinator interface** (REST, tRPC, server actions) and **operator authentication** are absent. Single-operator does not mean unauthenticated if adapter callbacks are also authenticated on the same surface.
- **Pause semantics** ("the current step may finish") interact with budgets and leases: a paused step's lease can expire, which triggers the contact-lost path. Either pause extends the lease or the recovery gate must recognize pause as a non-failure.
- `infra/trigger/` is an empty directory with no README, unlike every other placeholder, and `docslime` is referenced as tooling but is not a dependency of the repo.
- DESIGN.md is a good statement of principles, but "return after interruption" is the only concrete view and it is specified as text rules rather than a sketch. One wireframe would test whether four distinct states plus freshness plus stop status actually fit on a screen.

## What is worth keeping unchanged

The authority table in README/ADR-0001; the transactional persist-before-dispatch rule; the three-way failure taxonomy; the replacement-worker gate's four steps and its explicit rejection of timeout-as-termination; Approval as an exact-version record rather than a boolean; the proportional review profiles and the refusal to add ceremony; "completion records are immutable, current validity is separate"; and the documentation convention of never claiming planned work as done. These are the parts that will be hard to get right later if they are compromised now.

## Recommended order of decisions

1. Write ADR-0005: what the supervisor is, what it may call, and the schema of delegated authority. Amend R-005 accordingly. Address repository content as untrusted supervisor input.
2. Write ADR-0006: the execution runtime — where worktrees live, what provides isolation and egress control, and what confirms termination. Without this, R-003/R-013/R-016 are unimplementable.
3. Run the five-scenario execution trial as a throwaway spike against both Trigger.dev and a Postgres-queue alternative, before Slice 1. Record the backend selection as an ADR with the trial as evidence.
4. Cut the Slice 1 aggregate map to what the bounded-repair walk-through needs: Project, one work item type, StepContract/attempt, the four evidence records, Finding, WorkerAllocation. Defer Campaign, ProcessDefinition-as-data, and ProviderCapacity.
5. Fix the baseline test (add ADR-0004; drop the prose regexes) and put it in CI.
