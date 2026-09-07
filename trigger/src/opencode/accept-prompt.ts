// Builds the system + user prompts for a lead.accept session (Packet 3.D).
//
// The acceptance proposer cites each criterion against exact evidence refs.
// Outputs are proposals — the coordinator validates them deterministically.

import type { LeadAcceptPayload, VerificationResult } from "@agencyhq/contracts";

/** Stable string identifier for a VerificationResult (mirrors domain/evidence/match.ts). */
function verificationResultRef(r: VerificationResult): string {
  return `${r.verifier.name}:${r.checkId}:${r.attemptRevision}`;
}

// ---------------------------------------------------------------------------
// buildAcceptPrompt
// ---------------------------------------------------------------------------

export function buildAcceptPrompt(payload: LeadAcceptPayload): {
  systemContext: string;
  userPrompt: string;
} {
  const availableRefs = payload.verificationResults.map(verificationResultRef);
  const systemContext = buildSystemContext(availableRefs);
  const userPrompt = buildUserPrompt(payload);
  return { systemContext, userPrompt };
}

function buildSystemContext(availableRefs: string[]): string {
  const refsBlock =
    availableRefs.length > 0 ? availableRefs.map((r) => `  - "${r}"`).join("\n") : "  (none)";

  return `You are the AgencyHQ acceptance proposer.

## Role

Your task is to produce a structured JSON acceptance proposal for a completed attempt.
You evaluate whether the attempt satisfies all acceptance criteria, citing evidence refs.

## Evidence references

You may only cite evidence refs that exist in this run. The available verification_result refs are:

${refsBlock}

Any cited ref MUST appear verbatim in the list above. Citing an unknown ref causes the proposal
to be rejected as invalid.

## Rules

1. For every criterion, record whether it is satisfied and list the evidence refs that support that claim.
2. A criterion is satisfied only when a cited verification_result ref has result "pass".
3. \`accept\` may be true ONLY IF: (a) every criterion is marked satisfied, AND (b) there are no
   blocking review findings.
4. For every non-blocking review finding, provide a disposition and a brief reason.
5. Provide an overall rationale explaining the decision.

## Evidence kinds

| kind | ref format | when to use |
|---|---|---|
| verification_result | \`<verifier>:<checkId>:<attemptRevision>\` | A passing check result proves the criterion |
| diff | any description of the diff hunk | Direct inspection of the diff proves the criterion |
| review_finding | a finding id from the review (e.g. "F001") | A review finding is the basis for the disposition |

## Dispositions for non-blocking findings

| disposition | meaning |
|---|---|
| backlog | Record for later; does not affect this acceptance |
| remediate | Should be fixed in a subsequent attempt |
| scope_decision | Defer to a human decision on scope |
| block | Treat as blocking (use only if you decide to override non-blocking severity) |
| dismiss | Finding is not applicable or is a false positive |

## Output format

You MUST respond with a single JSON object (no extra keys):

\`\`\`json
{
  "accept": true | false,
  "criteria": [
    {
      "criterionId": "<id>",
      "satisfied": true | false,
      "evidence": [
        { "kind": "verification_result", "ref": "<exact ref from the list above>" }
      ]
    }
  ],
  "findingDispositions": [
    {
      "findingId": "<finding id from the review>",
      "disposition": "backlog" | "remediate" | "scope_decision" | "block" | "dismiss",
      "reason": "<brief explanation>"
    }
  ],
  "rationale": "<overall explanation of the accept/reject decision>"
}
\`\`\`

Do not include any text outside the JSON object.`;
}

function buildUserPrompt(payload: LeadAcceptPayload): string {
  const criteriaSection = buildCriteriaSection(payload);
  const resultsSection = buildResultsSection(payload.verificationResults);
  const reviewSection = buildReviewSection(payload);

  return `${criteriaSection}

${resultsSection}

${reviewSection}

Based on the above, produce your acceptance proposal as a JSON object.`;
}

function buildCriteriaSection(payload: LeadAcceptPayload): string {
  const lines: string[] = [
    "## ACCEPTANCE CRITERIA",
    "",
    `Contract: ${payload.contractId}`,
    `Criteria digest: ${payload.criteriaDigest}`,
    `Profile digest: ${payload.profileDigest}`,
    `Attempt revision: ${payload.attemptRevision}`,
    `Diff digest: ${payload.diffDigest}`,
    "",
  ];

  for (const criterion of payload.criteria) {
    lines.push(`### Criterion ${criterion.id}`);
    lines.push(criterion.text);
    if (criterion.citation !== undefined && criterion.citation !== "") {
      lines.push(`Citation: ${criterion.citation}`);
    }
    lines.push(`Source: ${criterion.source}`);
    lines.push("");
  }

  return lines.join("\n");
}

function buildResultsSection(results: VerificationResult[]): string {
  const lines: string[] = [
    "## VERIFICATION RESULTS",
    "",
    "These are the available evidence refs and their pass/fail status.",
    "",
  ];

  if (results.length === 0) {
    lines.push("(no verification results)");
    return lines.join("\n");
  }

  for (const r of results) {
    const ref = verificationResultRef(r);
    lines.push(`### ${ref}`);
    lines.push(`- result: ${r.result}`);
    lines.push(`- exitStatus: ${r.exitStatus ?? "(null)"}`);
    lines.push(`- checkId: ${r.checkId}`);
    lines.push(`- verifier: ${r.verifier.name}@${r.verifier.version}`);
    lines.push("");
  }

  return lines.join("\n");
}

function buildReviewSection(payload: LeadAcceptPayload): string {
  const blockingFindings = payload.review.findings.filter((f) => f.severity === "blocking");
  const nonBlockingFindings = payload.review.findings.filter((f) => f.severity === "non_blocking");

  const lines: string[] = [
    "## REVIEW FINDINGS",
    "",
    `Reviewer model: ${payload.review.reviewer.model}`,
    `Blocking findings: ${blockingFindings.length}`,
    `Non-blocking findings: ${nonBlockingFindings.length}`,
    "",
  ];

  if (payload.review.findings.length === 0) {
    lines.push("(no findings)");
    return lines.join("\n");
  }

  lines.push("```json");
  lines.push(JSON.stringify(payload.review.findings, null, 2));
  lines.push("```");

  if (blockingFindings.length > 0) {
    lines.push("");
    lines.push(
      `NOTE: There are ${blockingFindings.length} blocking finding(s). ` +
        `\`accept\` must be false unless you determine these findings are incorrect.`,
    );
  }

  return lines.join("\n");
}
