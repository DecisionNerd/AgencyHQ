/**
 * Unit tests for the slice-5 view builders.
 * All tests use plain objects — no database access required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import { buildAuthorityView } from "../src/views/authority-view.ts";
import { buildDecisionsView } from "../src/views/decisions-view.ts";
import { buildEvidenceView } from "../src/views/evidence-view.ts";
import { buildOverviewView } from "../src/views/overview-view.ts";

// ---------------------------------------------------------------------------
// buildOverviewView tests
// ---------------------------------------------------------------------------

describe("buildOverviewView", () => {
  it("returns empty campaigns and projects when input is empty", () => {
    const view = buildOverviewView({
      campaigns: [],
      projects: [],
      workItems: [],
      decisions: [],
    });
    assert.deepEqual(view, { campaigns: [], projects: [], capacity: [] });
  });

  it("groups work items by project and sorts by rank", () => {
    const view = buildOverviewView({
      campaigns: [],
      projects: [{ id: "prj-1" }],
      workItems: [
        {
          id: "wi-b",
          projectId: "prj-1",
          intent: "B intent",
          rank: 2,
          mainEffort: false,
          lifecycle: "proposed",
          condition: "healthy",
          boundary: "artifact",
          campaignId: null,
        },
        {
          id: "wi-a",
          projectId: "prj-1",
          intent: "A intent",
          rank: 1,
          mainEffort: true,
          lifecycle: "admitted",
          condition: "healthy",
          boundary: "merge",
          campaignId: null,
        },
      ],
      decisions: [],
    });

    assert.equal(view.projects.length, 1);
    const project = view.projects[0];
    assert.ok(project);
    assert.equal(project.id, "prj-1");
    assert.equal(project.workItems.length, 2);
    assert.equal(project.workItems[0]?.id, "wi-a"); // rank 1 first
    assert.equal(project.workItems[1]?.id, "wi-b"); // rank 2 second
  });

  it("counts pending_human decisions per work item", () => {
    const view = buildOverviewView({
      campaigns: [],
      projects: [{ id: "prj-1" }],
      workItems: [
        {
          id: "wi-1",
          projectId: "prj-1",
          intent: "test",
          rank: 1,
          mainEffort: true,
          lifecycle: "proposed",
          condition: "healthy",
          boundary: "artifact",
          campaignId: null,
        },
      ],
      decisions: [
        { workItemId: "wi-1", outcome: "pending_human" },
        { workItemId: "wi-1", outcome: "pending_human" },
        { workItemId: "wi-1", outcome: "approved" }, // not counted
      ],
    });

    const wi = view.projects[0]?.workItems[0];
    assert.ok(wi);
    assert.equal(wi.pendingDecisionCount, 2);
  });

  it("includes campaign fields in the output", () => {
    const view = buildOverviewView({
      campaigns: [{ id: "cmp-1", name: "MVP Campaign", mainEffortWorkItemId: "wi-1" }],
      projects: [{ id: "prj-1" }],
      workItems: [
        {
          id: "wi-1",
          projectId: "prj-1",
          intent: "test",
          rank: 1,
          mainEffort: true,
          lifecycle: "proposed",
          condition: "healthy",
          boundary: "artifact",
          campaignId: "cmp-1",
        },
      ],
      decisions: [],
    });

    assert.equal(view.campaigns.length, 1);
    assert.equal(view.campaigns[0]?.id, "cmp-1");
    assert.equal(view.campaigns[0]?.mainEffortWorkItemId, "wi-1");
    assert.equal(view.projects[0]?.workItems[0]?.campaignId, "cmp-1");
  });
});

// ---------------------------------------------------------------------------
// buildDecisionsView tests
// ---------------------------------------------------------------------------

describe("buildDecisionsView", () => {
  it("returns empty decisions when none are pending_human", () => {
    const view = buildDecisionsView({
      decisions: [
        {
          id: "d-1",
          workItemId: "wi-1",
          kind: "accept",
          outcome: "approved",
          at: "2026-01-01T00:00:00Z",
        },
      ],
      attempts: [],
      contracts: [],
      findings: [],
    });
    assert.equal(view.decisions.length, 0);
  });

  it("includes pending_human decisions with obstacle and noActionConsequence", () => {
    const view = buildDecisionsView({
      decisions: [
        {
          id: "d-1",
          workItemId: "wi-1",
          kind: "accept",
          outcome: "pending_human",
          at: "2026-01-01T00:00:00Z",
          contractVersion: 1,
          attemptId: "att-1",
        },
      ],
      attempts: [{ id: "att-1", contractId: "ct-1", status: "completed" }],
      contracts: [{ id: "ct-1", workItemId: "wi-1", version: 1, status: "active" }],
      findings: [],
    });

    assert.equal(view.decisions.length, 1);
    const d = view.decisions[0];
    assert.ok(d);
    assert.equal(d.id, "d-1");
    assert.equal(d.noActionConsequence, "stays pending; no dispatch");
    assert.equal(d.obstacle, "accept");
    assert.ok(d.actions.includes("approve"));
    assert.ok(d.actions.includes("reject"));
    // contractId and attemptRevision should be populated from the attempt
    assert.equal(d.impact.contractId, "ct-1");
    assert.equal(d.impact.attemptRevision, null); // no artifact in this test
  });

  it("uses finding kinds as obstacle when findings exist for the attempt", () => {
    const view = buildDecisionsView({
      decisions: [
        {
          id: "d-1",
          workItemId: "wi-1",
          kind: "accept",
          outcome: "pending_human",
          at: "2026-01-01T00:00:00Z",
          attemptId: "att-1",
        },
      ],
      attempts: [{ id: "att-1", contractId: "ct-1", status: "completed" }],
      contracts: [{ id: "ct-1", workItemId: "wi-1", version: 1, status: "active" }],
      findings: [
        { id: "f-1", attemptId: "att-1", kind: "security_violation", severity: "high" },
        { id: "f-2", attemptId: "att-1", kind: "security_violation", severity: "medium" },
      ],
    });

    const d = view.decisions[0];
    assert.ok(d);
    assert.equal(d.obstacle, "security_violation"); // deduplicated
  });

  it("exposes contractId and attemptRevision from attempt in impact", () => {
    const view = buildDecisionsView({
      decisions: [
        {
          id: "d-1",
          workItemId: "wi-1",
          kind: "accept",
          outcome: "pending_human",
          at: "2026-01-01T00:00:00Z",
          attemptId: "att-1",
        },
      ],
      attempts: [
        {
          id: "att-1",
          contractId: "ct-1",
          status: "completed",
          artifactRevision: "aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000",
        },
      ],
      contracts: [{ id: "ct-1", workItemId: "wi-1", version: 1, status: "active" }],
      findings: [],
    });

    const d = view.decisions[0];
    assert.ok(d);
    assert.equal(d.impact.contractId, "ct-1");
    assert.equal(d.impact.attemptRevision, "aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000");
  });

  it("includes rationale as recommendation when provided", () => {
    const view = buildDecisionsView({
      decisions: [
        {
          id: "d-1",
          workItemId: "wi-1",
          kind: "accept",
          outcome: "pending_human",
          at: "2026-01-01T00:00:00Z",
          rationale: "Fix looks correct; recommend approval",
        },
      ],
      attempts: [],
      contracts: [],
      findings: [],
    });

    const d = view.decisions[0];
    assert.ok(d);
    assert.equal(d.recommendation, "Fix looks correct; recommend approval");
  });

  it("includes null recommendation when no rationale", () => {
    const view = buildDecisionsView({
      decisions: [
        {
          id: "d-1",
          workItemId: "wi-1",
          kind: "accept",
          outcome: "pending_human",
          at: "2026-01-01T00:00:00Z",
        },
      ],
      attempts: [],
      contracts: [],
      findings: [],
    });

    const d = view.decisions[0];
    assert.ok(d);
    assert.equal(d.recommendation, null);
  });
});

// ---------------------------------------------------------------------------
// buildEvidenceView tests
// ---------------------------------------------------------------------------

describe("buildEvidenceView", () => {
  it("passes through all evidence fields untransformed", () => {
    const input = {
      workItemId: "wi-1",
      artifacts: [
        {
          id: "art-1",
          attemptId: "att-1",
          revision: "abc123",
          diffDigest: "sha256:abc",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verificationResults: [],
      reviews: [],
      findings: [],
      decisions: [
        {
          id: "d-1",
          kind: "accept",
          actor: "coordinator",
          outcome: "approved",
          at: "2026-01-01T00:00:00Z",
        },
      ],
      approvals: [
        {
          id: "appr-1",
          decisionId: "d-1",
          contractId: "ct-1",
          contractVersion: 1,
          attemptRevision: "abc123",
          humanActor: "operator",
          at: "2026-01-01T00:00:00Z",
        },
      ],
      integrations: [],
      manifestRows: [],
      attempts: [
        {
          id: "att-1",
          contractId: "ct-1",
          status: "completed",
          runId: "run-abc",
          checkpointCommit: null,
          commitSha: "abc123",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };

    const view = buildEvidenceView(input);
    assert.equal(view.workItemId, "wi-1");
    assert.equal(view.artifacts.length, 1);
    assert.equal(view.artifacts[0]?.id, "art-1");
    assert.equal(view.decisions[0]?.outcome, "approved");
    assert.equal(view.approvals[0]?.humanActor, "operator");
    assert.equal(view.attempts[0]?.runId, "run-abc");
  });

  it("returns empty arrays when no evidence exists", () => {
    const view = buildEvidenceView({
      workItemId: "wi-empty",
      artifacts: [],
      verificationResults: [],
      reviews: [],
      findings: [],
      decisions: [],
      approvals: [],
      integrations: [],
      manifestRows: [],
      attempts: [],
    });

    assert.equal(view.workItemId, "wi-empty");
    assert.deepEqual(view.artifacts, []);
    assert.deepEqual(view.attempts, []);
  });
});

// ---------------------------------------------------------------------------
// buildAuthorityView tests
// ---------------------------------------------------------------------------

describe("buildAuthorityView", () => {
  it("returns current version and authority with history", () => {
    const authority2 = { ...HOST_TRIAL_AUTHORITY, version: "2" };
    const view = buildAuthorityView({
      projectId: "prj-1",
      currentVersion: "2",
      currentAuthority: authority2,
      history: [
        {
          version: "1",
          authority: HOST_TRIAL_AUTHORITY,
          actor: "operator",
          at: "2026-01-01T00:00:00Z",
        },
        {
          version: "2",
          authority: authority2,
          actor: "operator",
          at: "2026-06-01T00:00:00Z",
        },
      ],
    });

    assert.equal(view.projectId, "prj-1");
    assert.equal(view.currentVersion, "2");
    assert.equal(view.authority.version, "2");
    assert.equal(view.history.length, 2);
    assert.equal(view.history[0]?.version, "1");
    assert.equal(view.history[1]?.version, "2");
  });

  it("returns empty history when no previous versions exist", () => {
    const view = buildAuthorityView({
      projectId: "prj-new",
      currentVersion: "1",
      currentAuthority: HOST_TRIAL_AUTHORITY,
      history: [],
    });

    assert.equal(view.history.length, 0);
  });
});

describe("open pending decisions (resolved rows are history)", () => {
  it("decisions view drops a pending decision once a later approved decision exists for the attempt", () => {
    const view = buildDecisionsView({
      decisions: [
        {
          id: "d1",
          workItemId: "wi1",
          kind: "accept",
          outcome: "pending_human",
          at: "2026-09-08T10:00:00Z",
          attemptId: "a1",
          contractVersion: 1,
        },
        {
          id: "d2",
          workItemId: "wi1",
          kind: "accept",
          outcome: "approved",
          at: "2026-09-08T10:05:00Z",
          attemptId: "a1",
          contractVersion: 1,
        },
        {
          id: "d3",
          workItemId: "wi2",
          kind: "accept",
          outcome: "pending_human",
          at: "2026-09-08T10:06:00Z",
          attemptId: "a2",
          contractVersion: 1,
        },
      ],
      attempts: [],
      contracts: [],
      findings: [],
    } as never);
    const ids = view.decisions.map((d) => d.id);
    assert.deepEqual(ids, ["d3"]);
  });

  it("overview counts only open pending decisions", () => {
    const view = buildOverviewView({
      campaigns: [],
      projects: [{ id: "p1", authorityVersion: "1" }],
      workItems: [
        {
          id: "wi1",
          projectId: "p1",
          intent: "x",
          rank: 1,
          mainEffort: false,
          lifecycle: "active",
          condition: "healthy",
          boundary: "artifact",
          campaignId: null,
        },
      ],
      decisions: [
        {
          id: "d1",
          workItemId: "wi1",
          kind: "accept",
          outcome: "pending_human",
          attemptId: "a1",
          at: "2026-09-08T10:00:00Z",
        },
        {
          id: "d2",
          workItemId: "wi1",
          kind: "accept",
          outcome: "rejected",
          attemptId: "a1",
          at: "2026-09-08T10:01:00Z",
        },
      ],
    } as never);
    const item = view.projects[0]?.workItems[0];
    assert.ok(item);
    assert.equal(item.pendingDecisionCount, 0);
  });
});
