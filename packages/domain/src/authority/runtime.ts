/**
 * Runtime enforceability checks for AgencyHQ authority model.
 *
 * Implements R-016: dispatch rejects a contract requiring a boundary the
 * active runtime profile declares advisory.
 *
 * See: docs/engineering/ARCHITECTURE.md lines 105-127 (enforcement boundaries table)
 * See: docs/REQUIREMENTS.md R-016
 */

import type { BoundaryKind, ContractBounds, RuntimeProfile } from "@agencyhq/contracts";
import { enforceableBoundaries } from "@agencyhq/contracts";

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
// | integrate       | no              | boundary=merge/deploy (enforced separately)  |
//
// Rationale for fs_isolation: when a worker can fetch external URLs or search
// the web, filesystem isolation becomes a meaningful security boundary because
// the external content could instruct the worker to read host files.
//
// Rationale for egress_spend: when a spend ceiling is set and external network
// calls are possible, egress enforcement is needed to honour the ceiling.
// Without external network (no webfetch/websearch) and a spend ceiling, the
// estimate is advisory (no gateway exists on the host profile).
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

  return required;
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
