import assert from "node:assert/strict";
import test from "node:test";
import { LeadPlanOutputSchema } from "../src/lead-proposal.ts";
import { jsonSchemaFor, LEAD_OUTPUT_JSON_SCHEMAS } from "../src/opencode/json-schema.ts";
import { AcceptanceProposalSchema } from "../src/tasks/lead-accept.ts";
import { ReviewOutputSchema } from "../src/tasks/lead-review.ts";

test("jsonSchemaFor: converts LeadPlanOutputSchema without throwing", () => {
  const schema = jsonSchemaFor(LeadPlanOutputSchema);
  assert.ok(typeof schema === "object" && schema !== null);
  // Discriminated union with "kind" as the discriminator
  const schemaStr = JSON.stringify(schema);
  assert.ok(schemaStr.includes("kind"), "JSON schema should reference 'kind' discriminator");
});

test("jsonSchemaFor: converts ReviewOutputSchema without throwing", () => {
  const schema = jsonSchemaFor(ReviewOutputSchema);
  const schemaStr = JSON.stringify(schema);
  assert.ok(schemaStr.includes("findings"), "JSON schema should reference 'findings'");
});

test("jsonSchemaFor: converts AcceptanceProposalSchema without throwing", () => {
  const schema = jsonSchemaFor(AcceptanceProposalSchema);
  const schemaStr = JSON.stringify(schema);
  assert.ok(schemaStr.includes("accept"), "JSON schema should reference 'accept'");
});

test("LEAD_OUTPUT_JSON_SCHEMAS.leadPlanOutput: contains 'kind' key reference", () => {
  const s = LEAD_OUTPUT_JSON_SCHEMAS.leadPlanOutput;
  assert.ok(JSON.stringify(s).includes("kind"));
});

test("LEAD_OUTPUT_JSON_SCHEMAS.reviewOutput: contains 'findings' key reference", () => {
  const s = LEAD_OUTPUT_JSON_SCHEMAS.reviewOutput;
  assert.ok(JSON.stringify(s).includes("findings"));
});

test("LEAD_OUTPUT_JSON_SCHEMAS.acceptanceProposal: contains 'accept' key reference", () => {
  const s = LEAD_OUTPUT_JSON_SCHEMAS.acceptanceProposal;
  assert.ok(JSON.stringify(s).includes("accept"));
});

test("LEAD_OUTPUT_JSON_SCHEMAS: uses draft-2020-12 schema URI", () => {
  const s = LEAD_OUTPUT_JSON_SCHEMAS.leadPlanOutput;
  const schemaStr = JSON.stringify(s);
  assert.ok(schemaStr.includes("2020-12"), "Expected draft-2020-12 $schema in JSON schema output");
});
