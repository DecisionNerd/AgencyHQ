/**
 * Authority subset checks for AgencyHQ delegated-authority model.
 *
 * Implements R-009 and R-020: any widening of scope, capability, boundary,
 * budget, or review depth is rejected. Proposals from Lead are untrusted;
 * the check is conservative (false negatives acceptable, false positives never).
 *
 * See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md
 * See: docs/REQUIREMENTS.md R-009, R-020
 */

import type {
  Authority,
  AuthorityNarrowing,
  ChangeClass,
  ContractBounds,
  LeadProposal,
} from "@agencyhq/contracts";
import {
  denySetCovers,
  parsePathPattern,
  pathSetSubset,
  patternSubset,
  reviewProfileAtLeast,
} from "@agencyhq/contracts";

import { requiresApproval } from "./human-required.ts";

// ---------------------------------------------------------------------------
// ViolationCode
// ---------------------------------------------------------------------------

export type ViolationCode =
  | "PATH_ALLOW_WIDER"
  | "PATH_DENY_DROPPED"
  | "BASH_ALLOW_WIDER"
  | "BASH_DENY_DROPPED"
  | "TOOL_NOT_GRANTED"
  | "BOUNDARY_NOT_DELEGATED"
  | "BUDGET_ATTEMPTS"
  | "BUDGET_DURATION"
  | "BUDGET_SPEND"
  | "BUDGET_MACHINE"
  | "REVIEW_BELOW_MINIMUM"
  | "MODEL_NOT_ALLOWED"
  | "REVIEWER_SAME_AS_WORKER"
  | "NO_OPERATOR_CRITERION"
  | "INVALID_PATTERN";

// ---------------------------------------------------------------------------
// AuthorityViolation
// ---------------------------------------------------------------------------

export type AuthorityViolation = {
  code: ViolationCode;
  path: string;
  detail: string;
};

// ---------------------------------------------------------------------------
// bashPatternSubset
//
// Returns true iff every bash command matched by `narrow` is also matched
// by `wide`. Patterns are OpenCode command-glob strings:
//   "*"      — matches any command
//   "prefix*" — matches any command starting with prefix
//   "literal" — matches exactly that command
//
// Rules (conservative — false negatives acceptable, false positives never):
//   1. wide === "*"     → always true (wide covers everything)
//   2. narrow === wide  → true (identical)
//   3. wide ends with "*":
//      let prefix = wide without trailing "*"
//      narrow must start with prefix
//      the rest of narrow after the prefix must contain at most one trailing
//      "*" with no other wildcards (conservative: complex narrows rejected)
//   4. all other cases  → false
// ---------------------------------------------------------------------------

export function bashPatternSubset(narrow: string, wide: string): boolean {
  if (wide === "*") return true;
  if (narrow === wide) return true;
  if (wide.endsWith("*")) {
    const prefix = wide.slice(0, -1);
    if (narrow.startsWith(prefix)) {
      const rest = narrow.slice(prefix.length);
      // Suffix has no wildcards: narrow is a more specific literal — subset.
      if (!rest.includes("*")) return true;
      // Suffix has exactly one trailing "*" with nothing else: subset.
      if (rest.endsWith("*") && !rest.slice(0, -1).includes("*")) return true;
      // More complex wildcard arrangements: conservative reject.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// effectiveAuthority
//
// Applies a per-WorkItem narrowing to a project Authority schema.
// A narrowing can only narrow:
//   paths.allow    ⊆ schema.allow   (fewer or more specific allow patterns)
//   paths.deny     ⊇ schema.deny    (deny set must cover all schema denies)
//   bash.allow     ⊆ schema.allow   (bashPatternSubset)
//   bash.deny      ⊇ schema.deny    (all schema denies must be present)
//   tools          only false-ward  (cannot grant a denied tool)
//   boundaries     ⊆ schema.boundaries
//   budget         ≤ schema per field
//   review.minimum ≥ schema per class  (stronger or equal)
//   models         ⊆ schema lists
//   humanRequired  ⊇ schema        (more paths/classes/boundaries trigger approval)
//
// If a narrowing field would widen the schema, that field is silently ignored.
// Narrowing is coordinator-authored (trusted), but we never widen.
// ---------------------------------------------------------------------------

export function effectiveAuthority(schema: Authority, narrowing?: AuthorityNarrowing): Authority {
  if (!narrowing) return schema;

  let result: Authority = schema;

  // paths: allow ⊆ schema.allow AND deny ⊇ schema.deny
  if (narrowing.paths) {
    const np = narrowing.paths;
    const parseAll = (patterns: string[]) => {
      const out: ReturnType<typeof parsePathPattern>[] = [];
      for (const p of patterns) {
        try {
          out.push(parsePathPattern(p));
        } catch {
          return null; // invalid pattern — ignore the whole field
        }
      }
      return out;
    };

    const naValid = parseAll(np.allow);
    const ndValid = parseAll(np.deny);
    const saValid = parseAll(schema.paths.allow);
    const sdValid = parseAll(schema.paths.deny);

    if (naValid && ndValid && saValid && sdValid) {
      const allowOk = pathSetSubset(naValid, saValid);
      const denyOk = denySetCovers(ndValid, sdValid);
      if (allowOk && denyOk) {
        result = { ...result, paths: np };
      }
    }
  }

  // capabilities
  if (narrowing.capabilities) {
    const nc = narrowing.capabilities;
    const sc = schema.capabilities;

    // bash.allow: narrowing allow ⊆ schema allow
    const bashAllowOk = nc.bash.allow.every((np) =>
      sc.bash.allow.some((wp) => bashPatternSubset(np, wp)),
    );
    // bash.deny: all schema denies must be present in narrowing deny
    const bashDenyOk = sc.bash.deny.every((wd) => nc.bash.deny.includes(wd));
    // tools: narrowing can only set true→false (never false→true)
    const toolsOk = (Object.keys(nc.tools) as (keyof typeof nc.tools)[]).every((k) => {
      const narrowVal = nc.tools[k];
      const schemaVal = sc.tools[k];
      return narrowVal !== true || schemaVal === true;
    });

    if (bashAllowOk && bashDenyOk && toolsOk) {
      result = { ...result, capabilities: nc };
    }
  }

  // boundaries: ⊆ schema.boundaries
  if (narrowing.boundaries) {
    const nb = narrowing.boundaries;
    if (nb.every((b) => schema.boundaries.includes(b))) {
      result = { ...result, boundaries: nb };
    }
  }

  // budget: each field ≤ schema
  if (narrowing.budget) {
    const nb = narrowing.budget;
    const sb = schema.budget;
    const attemptsOk = nb.maxAttempts <= sb.maxAttempts;
    const durationOk = nb.maxDurationSeconds <= sb.maxDurationSeconds;
    const spendOk = nb.estimatedSpendUsd <= sb.estimatedSpendUsd;
    // machine: narrowing may only keep same machine or omit; cannot add new machine
    const machineOk =
      nb.machine === undefined || (sb.machine !== undefined && nb.machine === sb.machine);

    if (attemptsOk && durationOk && spendOk && machineOk) {
      result = { ...result, budget: nb };
    }
  }

  // review.minimum: each change-class minimum ≥ schema (stronger or equal)
  if (narrowing.review) {
    const nr = narrowing.review;
    const sr = schema.review;
    const reviewOk = (Object.keys(nr.minimum) as ChangeClass[]).every((cls) => {
      const schemaMin = sr.minimum[cls];
      const narrowMin = nr.minimum[cls];
      if (!schemaMin || !narrowMin) return true; // missing entries are not violations
      return reviewProfileAtLeast(narrowMin, schemaMin);
    });
    if (reviewOk) {
      result = { ...result, review: nr };
    }
  }

  // models: worker/reviewer/lead lists ⊆ schema lists; reviewerMustDiffer only true-ward
  if (narrowing.models) {
    const nm = narrowing.models;
    const sm = schema.models;
    const workerOk = nm.worker.every((m) => sm.worker.includes(m));
    const leadOk = nm.lead.every((m) => sm.lead.includes(m));
    const reviewerOk = nm.reviewer.every((m) => sm.reviewer.includes(m));
    const differOk = !sm.reviewerMustDiffer || nm.reviewerMustDiffer;

    if (workerOk && leadOk && reviewerOk && differOk) {
      result = { ...result, models: nm };
    }
  }

  // humanRequired: ⊇ (more things may require approval; never remove a requirement)
  if (narrowing.humanRequired) {
    const nh = narrowing.humanRequired;
    const sh = schema.humanRequired;
    const pathsOk = sh.paths.every((sp) => nh.paths.includes(sp));
    const classesOk = sh.changeClasses.every((sc) => nh.changeClasses.includes(sc));
    const boundariesOk = sh.boundaries.every((sb) => nh.boundaries.includes(sb));

    if (pathsOk && classesOk && boundariesOk) {
      result = { ...result, humanRequired: nh };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// checkProposal
//
// Validates a LeadProposal against a project Authority schema (after optional
// narrowing). Collects ALL violations (not just the first).
//
// On success, returns ok:true with:
//   bounds       — assembled FROM THE PROPOSAL (never from the schema)
//   humanRequired — determined by human-required.ts from the assembled bounds
//
// See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md
// See: docs/REQUIREMENTS.md R-009, R-020
// ---------------------------------------------------------------------------

export function checkProposal(
  schema: Authority,
  proposal: LeadProposal,
  opts?: { narrowing?: AuthorityNarrowing },
):
  | { ok: true; bounds: ContractBounds; humanRequired: boolean }
  | { ok: false; violations: AuthorityViolation[] } {
  const effective = effectiveAuthority(schema, opts?.narrowing);
  const violations: AuthorityViolation[] = [];

  // ----------------------------------------------------------------
  // INVALID_PATTERN: parse proposal and schema patterns for validity
  // ----------------------------------------------------------------
  const parseTracked = (patterns: string[], fieldLabel: string) => {
    const valid: ReturnType<typeof parsePathPattern>[] = [];
    for (const p of patterns) {
      try {
        valid.push(parsePathPattern(p));
      } catch (e) {
        violations.push({
          code: "INVALID_PATTERN",
          path: fieldLabel,
          detail: `Pattern "${p}" is invalid: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    return valid;
  };

  const proposalAllowParsed = parseTracked(proposal.paths.allow, "paths.allow");
  const proposalDenyParsed = parseTracked(proposal.paths.deny, "paths.deny");
  const schemaAllowParsed = parseTracked(effective.paths.allow, "schema.paths.allow");
  const schemaDenyParsed = parseTracked(effective.paths.deny, "schema.paths.deny");

  // ----------------------------------------------------------------
  // PATH_ALLOW_WIDER: every proposal allow pattern must be ⊆ some schema allow
  // ----------------------------------------------------------------
  for (const np of proposalAllowParsed) {
    if (!schemaAllowParsed.some((wp) => patternSubset(np, wp))) {
      violations.push({
        code: "PATH_ALLOW_WIDER",
        path: "paths.allow",
        detail: `Proposal allow pattern "${np}" is not covered by any schema allow pattern`,
      });
    }
  }

  // ----------------------------------------------------------------
  // PATH_DENY_DROPPED: every schema deny must be covered by a proposal deny
  // ----------------------------------------------------------------
  for (const wp of schemaDenyParsed) {
    if (!proposalDenyParsed.some((np) => patternSubset(wp, np))) {
      violations.push({
        code: "PATH_DENY_DROPPED",
        path: "paths.deny",
        detail: `Schema deny pattern "${wp}" is not covered by any proposal deny pattern`,
      });
    }
  }

  // ----------------------------------------------------------------
  // BASH_ALLOW_WIDER: every proposal bash allow must be ⊆ some schema bash allow
  // ----------------------------------------------------------------
  for (const proposalBash of proposal.capabilities.bash.allow) {
    if (
      !effective.capabilities.bash.allow.some((schemaBash) =>
        bashPatternSubset(proposalBash, schemaBash),
      )
    ) {
      violations.push({
        code: "BASH_ALLOW_WIDER",
        path: "capabilities.bash.allow",
        detail: `Proposal bash allow pattern "${proposalBash}" is not covered by any schema bash allow pattern`,
      });
    }
  }

  // ----------------------------------------------------------------
  // BASH_DENY_DROPPED: every schema bash deny must be present in proposal deny
  // ----------------------------------------------------------------
  for (const schemaBash of effective.capabilities.bash.deny) {
    if (!proposal.capabilities.bash.deny.includes(schemaBash)) {
      violations.push({
        code: "BASH_DENY_DROPPED",
        path: "capabilities.bash.deny",
        detail: `Schema bash deny pattern "${schemaBash}" is missing from proposal bash deny`,
      });
    }
  }

  // ----------------------------------------------------------------
  // TOOL_NOT_GRANTED: proposal tool true requires schema tool true
  // ----------------------------------------------------------------
  for (const [tool, proposalVal] of Object.entries(proposal.capabilities.tools)) {
    if (proposalVal === true) {
      const schemaVal =
        effective.capabilities.tools[tool as keyof typeof effective.capabilities.tools];
      if (schemaVal !== true) {
        violations.push({
          code: "TOOL_NOT_GRANTED",
          path: `capabilities.tools.${tool}`,
          detail: `Tool "${tool}" is enabled in proposal but not granted in schema`,
        });
      }
    }
  }

  // ----------------------------------------------------------------
  // BOUNDARY_NOT_DELEGATED: proposal boundary must be in schema.boundaries
  // ----------------------------------------------------------------
  if (!effective.boundaries.includes(proposal.boundary)) {
    violations.push({
      code: "BOUNDARY_NOT_DELEGATED",
      path: "boundary",
      detail: `Boundary "${proposal.boundary}" is not in the schema's delegated boundaries: [${effective.boundaries.join(", ")}]`,
    });
  }

  // ----------------------------------------------------------------
  // BUDGET_ATTEMPTS / BUDGET_DURATION / BUDGET_SPEND / BUDGET_MACHINE
  // ----------------------------------------------------------------
  if (proposal.budget.maxAttempts > effective.budget.maxAttempts) {
    violations.push({
      code: "BUDGET_ATTEMPTS",
      path: "budget.maxAttempts",
      detail: `Proposal maxAttempts ${proposal.budget.maxAttempts} exceeds schema limit ${effective.budget.maxAttempts}`,
    });
  }

  if (proposal.budget.maxDurationSeconds > effective.budget.maxDurationSeconds) {
    violations.push({
      code: "BUDGET_DURATION",
      path: "budget.maxDurationSeconds",
      detail: `Proposal maxDurationSeconds ${proposal.budget.maxDurationSeconds} exceeds schema limit ${effective.budget.maxDurationSeconds}`,
    });
  }

  if (proposal.budget.estimatedSpendUsd > effective.budget.estimatedSpendUsd) {
    violations.push({
      code: "BUDGET_SPEND",
      path: "budget.estimatedSpendUsd",
      detail: `Proposal estimatedSpendUsd ${proposal.budget.estimatedSpendUsd} exceeds schema limit ${effective.budget.estimatedSpendUsd}`,
    });
  }

  if (proposal.budget.machine !== undefined) {
    if (
      effective.budget.machine === undefined ||
      proposal.budget.machine !== effective.budget.machine
    ) {
      violations.push({
        code: "BUDGET_MACHINE",
        path: "budget.machine",
        detail: `Proposal machine "${proposal.budget.machine}" is not allowed (schema machine: ${effective.budget.machine ?? "unset"})`,
      });
    }
  }

  // ----------------------------------------------------------------
  // REVIEW_BELOW_MINIMUM: proposal review must meet schema minimum for the change class
  // ----------------------------------------------------------------
  const minimumProfile = effective.review.minimum[proposal.changeClass];
  if (minimumProfile !== undefined && !reviewProfileAtLeast(proposal.review, minimumProfile)) {
    violations.push({
      code: "REVIEW_BELOW_MINIMUM",
      path: "review",
      detail: `Proposal review "${proposal.review}" is below schema minimum "${minimumProfile}" for change class "${proposal.changeClass}"`,
    });
  }

  // ----------------------------------------------------------------
  // MODEL_NOT_ALLOWED: proposal worker/reviewer must be in schema model lists
  // ----------------------------------------------------------------
  if (!effective.models.worker.includes(proposal.models.worker)) {
    violations.push({
      code: "MODEL_NOT_ALLOWED",
      path: "models.worker",
      detail: `Worker model "${proposal.models.worker}" is not in schema's allowed worker models: [${effective.models.worker.join(", ")}]`,
    });
  }

  if (!effective.models.reviewer.includes(proposal.models.reviewer)) {
    violations.push({
      code: "MODEL_NOT_ALLOWED",
      path: "models.reviewer",
      detail: `Reviewer model "${proposal.models.reviewer}" is not in schema's allowed reviewer models: [${effective.models.reviewer.join(", ")}]`,
    });
  }

  // ----------------------------------------------------------------
  // REVIEWER_SAME_AS_WORKER
  // ----------------------------------------------------------------
  if (effective.models.reviewerMustDiffer && proposal.models.worker === proposal.models.reviewer) {
    violations.push({
      code: "REVIEWER_SAME_AS_WORKER",
      path: "models",
      detail: `Schema requires reviewer to differ from worker, but both are "${proposal.models.worker}"`,
    });
  }

  // ----------------------------------------------------------------
  // NO_OPERATOR_CRITERION: at least one criterion with source "operator"
  // ----------------------------------------------------------------
  if (!proposal.criteria.some((c) => c.source === "operator")) {
    violations.push({
      code: "NO_OPERATOR_CRITERION",
      path: "criteria",
      detail: `Proposal must include at least one criterion with source "operator"`,
    });
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // ----------------------------------------------------------------
  // Assemble bounds FROM THE PROPOSAL (never from the schema)
  // ----------------------------------------------------------------
  const bounds: ContractBounds = {
    paths: proposal.paths,
    capabilities: proposal.capabilities,
    boundary: proposal.boundary,
    budget: proposal.budget,
    review: proposal.review,
    changeClass: proposal.changeClass,
    models: proposal.models,
  };

  const { required: humanRequired } = requiresApproval(effective, bounds);

  return { ok: true, bounds, humanRequired };
}
