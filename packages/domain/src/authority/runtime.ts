/**
 * Runtime enforceability checks for AgencyHQ authority model.
 *
 * Implements R-016: dispatch rejects a contract requiring a boundary the
 * active runtime profile declares advisory.
 *
 * See: docs/engineering/ARCHITECTURE.md lines 105-127 (enforcement boundaries table)
 * See: docs/REQUIREMENTS.md R-016, R-015
 */

import type { BoundaryKind, ContractBounds, RuntimeProfile } from "@agencyhq/contracts";
import { enforceableBoundaries } from "@agencyhq/contracts";

// ---------------------------------------------------------------------------
// RuntimeViolationCode table
//
// Violations produced by runtime boundary checks (distinct from authority
// subset ViolationCodes in subset.ts).
//
// | Code                  | Condition                                      |
// |-----------------------|------------------------------------------------|
// | DEPLOY_NOT_SUPPORTED  | boundary = "deploy"; not yet implemented       |
//
// Keep this table exhaustive — add a row for every new code.
// ---------------------------------------------------------------------------

export type RuntimeViolationCode = "DEPLOY_NOT_SUPPORTED";

export type RuntimeViolation = {
  readonly code: RuntimeViolationCode;
  readonly reason: string;
};

// ---------------------------------------------------------------------------
// requiredBoundariesFor
//
// Maps ContractBounds to the set of BoundaryKinds the runtime profile MUST
// enforce (non-advisory). Any boundary in this list that the profile marks
// advisory causes dispatch to reject the contract.
//
// Boundary mapping (from ARCHITECTURE.md enforcement boundaries table):
//
// | BoundaryKind    | Always required | Conditional trigger                          |
// |-----------------|-----------------|----------------------------------------------|
// | worktree        | yes             | —                                            |
// | output_paths    | yes             | —                                            |
// | push            | yes             | —                                            |
// | termination     | yes             | —                                            |
// | capability      | yes             | —                                            |
// | duration        | yes             | —                                            |
// | fs_isolation    | conditional     | webfetch || websearch tool enabled           |
// | egress_spend    | conditional     | webfetch || websearch tool enabled           |
// | cpu_memory      | no              | machine preset (not yet tracked)             |
// | nested_agents   | no              | task tool (enforced via capability)          |
// | integrate       | conditional     | boundary = merge or deploy                   |
//
// Rationale for fs_isolation: when a worker can fetch external URLs or search
// the web, filesystem isolation becomes a meaningful security boundary because
// the external content could instruct the worker to read host files.
//
// Rationale for egress_spend: when a spend ceiling is set and external network
// calls are possible, egress enforcement is needed to honour the ceiling.
// Without external network (no webfetch/websearch) and a spend ceiling, the
// estimate is advisory (no gateway exists on the host profile).
//
// Rationale for integrate: a merge or deploy boundary requires the runtime to
// enforce the compare-and-set integration step; artifact boundaries do not
// push to a shared ref and therefore do not need this boundary.
// ---------------------------------------------------------------------------

export function requiredBoundariesFor(bounds: ContractBounds): BoundaryKind[] {
  const required: BoundaryKind[] = [
    "worktree",
    "output_paths",
    "push",
    "termination",
    "capability",
    "duration",
  ];

  const hasExternalNetwork =
    bounds.capabilities.tools.webfetch === true || bounds.capabilities.tools.websearch === true;

  if (hasExternalNetwork) {
    required.push("fs_isolation");
    required.push("egress_spend");
  }
  // A spend estimate alone does not require egress enforcement: on the host
  // profile the estimate is advisory (ARCHITECTURE.md enforcement table) and
  // every trial contract carries one, so treating it as a required boundary
  // would make R-016 reject all host-profile dispatches. Enforcement of a
  // spend ceiling arrives with the container profile's model gateway.

  if (bounds.boundary !== "artifact") {
    required.push("integrate");
  }

  return required;
}

// ---------------------------------------------------------------------------
// checkBoundarySupport
//
// Checks whether the contract's completion boundary is supported for
// execution.  Returns a RuntimeViolation when the boundary cannot be executed
// (e.g. deploy is declared but not yet implemented), or null when the
// boundary is supported.
//
// This is a separate gate from `requiredBoundariesFor` / `enforceable`
// because it represents a categorical "not implemented" rather than an
// advisory enforcement gap.
// ---------------------------------------------------------------------------

export function checkBoundarySupport(bounds: ContractBounds): RuntimeViolation | null {
  if (bounds.boundary === "deploy") {
    return {
      code: "DEPLOY_NOT_SUPPORTED",
      reason: "deploy boundary is not yet implemented; only artifact and merge are supported",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// enforceable
//
// Checks whether a runtime profile can enforce the required boundaries.
// Returns ok:true if all required boundaries are non-advisory in the profile.
// Returns ok:false with the list of advisory (unenforced) boundary kinds.
//
// Per R-016: dispatch must reject a contract requiring a boundary the profile
// marks advisory. The HOST_PROFILE marks fs_isolation, cpu_memory, and
// egress_spend as advisory — contracts requiring those boundaries must run in
// a container profile.
// ---------------------------------------------------------------------------

export function enforceable(
  profile: RuntimeProfile,
  requiredBoundaries: BoundaryKind[],
): { ok: true } | { ok: false; advisory: BoundaryKind[] } {
  const enforceable = new Set(enforceableBoundaries(profile));
  const advisory: BoundaryKind[] = [];

  for (const boundary of requiredBoundaries) {
    if (!enforceable.has(boundary)) {
      advisory.push(boundary);
    }
  }

  if (advisory.length > 0) {
    return { ok: false, advisory };
  }

  return { ok: true };
}
