import assert from "node:assert/strict";
import test from "node:test";

import { LeadPlanOutputSchema, LeadProposalSchema } from "../src/lead-proposal.ts";

const validProposal = {
  criteria: [
    {
      id: "c-1",
      text: "The parser rejects known-invalid input X.",
      source: "operator" as const,
      citation: "ticket-42",
    },
  ],
  profileId: "profile-behavior-v1",
  changeClass: "behavior" as const,
  review: "adversarial" as const,
  boundary: "artifact" as const,
  paths: {
    allow: ["src/parser/**"],
    deny: ["src/parser/generated/**"],
  },
  capabilities: {
    bash: { allow: ["pnpm test"], deny: ["git push*"] },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  budget: {
    maxAttempts: 2,
    maxDurationSeconds: 1200,
    estimatedSpendUsd: 0.5,
  },
  models: { worker: "claude-opus-4", reviewer: "claude-sonnet-4" },
  rationale: "Fix parser rejection bug per operator request.",
  sources: [{ criterionId: "c-1", source: "operator" as const, citation: "ticket-42" }],
};

test("LeadProposalSchema: parses a valid proposal", () => {
  const result = LeadProposalSchema.safeParse(validProposal);
  assert.equal(result.success, true, JSON.stringify(result));
});

test("LeadProposalSchema: rejects empty criteria array", () => {
  const bad = { ...validProposal, criteria: [] };
  const result = LeadProposalSchema.safeParse(bad);
  assert.equal(result.success, false);
});

test("LeadProposalSchema: rejects unknown changeClass", () => {
  const bad = { ...validProposal, changeClass: "unknown" };
  const result = LeadProposalSchema.safeParse(bad);
  assert.equal(result.success, false);
});

test("LeadProposalSchema: rejects unknown review profile", () => {
  const bad = { ...validProposal, review: "full_audit" };
  const result = LeadProposalSchema.safeParse(bad);
  assert.equal(result.success, false);
});

test("LeadProposalSchema: rejects unknown boundary", () => {
  const bad = { ...validProposal, boundary: "hotfix" };
  const result = LeadProposalSchema.safeParse(bad);
  assert.equal(result.success, false);
});

// LeadPlanOutputSchema discriminated union tests

const proposalOutput = { kind: "proposal" as const, proposal: validProposal };
const needsFactsOutput = {
  kind: "needs_facts" as const,
  questions: ["What is the expected behavior?"],
};
const mappingAlertOutput = {
  kind: "mapping_alert" as const,
  nearest: "src/parser.ts",
  failedEntry: "AGENTS.md",
};
const invalidOutput = { kind: "invalid_output" as const, reason: "Missing required field" };

test("LeadPlanOutputSchema: parses 'proposal' kind", () => {
  const result = LeadPlanOutputSchema.safeParse(proposalOutput);
  assert.equal(result.success, true, JSON.stringify(result));
});

test("LeadPlanOutputSchema: parses 'needs_facts' kind", () => {
  const result = LeadPlanOutputSchema.safeParse(needsFactsOutput);
  assert.equal(result.success, true);
});

test("LeadPlanOutputSchema: parses 'mapping_alert' kind", () => {
  const result = LeadPlanOutputSchema.safeParse(mappingAlertOutput);
  assert.equal(result.success, true);
});

test("LeadPlanOutputSchema: parses 'invalid_output' kind", () => {
  const result = LeadPlanOutputSchema.safeParse(invalidOutput);
  assert.equal(result.success, true);
});

test("LeadPlanOutputSchema: rejects unknown kind", () => {
  const bad = { kind: "hallucinated_kind", data: {} };
  const result = LeadPlanOutputSchema.safeParse(bad);
  assert.equal(result.success, false);
});

test("LeadPlanOutputSchema: rejects proposal missing criteria", () => {
  const bad = { kind: "proposal", proposal: { ...validProposal, criteria: [] } };
  const result = LeadPlanOutputSchema.safeParse(bad);
  assert.equal(result.success, false);
});
