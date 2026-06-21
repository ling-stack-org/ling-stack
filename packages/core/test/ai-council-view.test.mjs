import assert from "node:assert/strict";
import test from "node:test";
import {
  aiCouncilHealthViewMatchesState,
  buildAiCouncilHealthOverviewView,
  buildAiCouncilHealthView,
  countAiCouncilHealthFindings,
  listAiCouncilHealthFindings,
} from "../dist/index.js";

const baseCouncil = {
  id: "council_builtin_development",
  workspaceId: "workspace_default",
  source: "builtin",
  templateId: "development",
  displayName: "Development Council",
  description: "Development specialists",
  routingPolicy: { defaultMode: "advisory", notes: [] },
  governanceProfile: {
    permissionBoundary: "restrict_only",
    approvalBoundary: "cannot_bypass",
    toolGrantBoundary: "cannot_grant",
    credentialBoundary: "cannot_grant",
    notes: [],
  },
  status: "active",
  pinned: true,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
};

const clearCouncil = {
  ...baseCouncil,
  id: "council_clear",
  source: "user",
  templateId: undefined,
  displayName: "Clear Council",
  pinned: false,
};

const report = {
  workspaceId: "workspace_default",
  generatedAt: "2026-06-21T00:00:00.000Z",
  summary: {
    totalCouncils: 2,
    activeCouncils: 2,
    totalMembers: 3,
    availableMembers: 1,
    blockedMembers: 2,
    findings: { info: 1, warning: 1, critical: 1 },
  },
  findings: [
    createFinding("critical", "teammate_missing", "teammate_engineer", "Engineer"),
    createFinding("warning", "member_disabled", "teammate_qa", "QA"),
    createFinding("info", "member_disabled", "teammate_docs", "Docs"),
  ],
};

test("AI council health view model summarizes findings for client surfaces", () => {
  assert.equal(listAiCouncilHealthFindings(report, baseCouncil.id).length, 3);
  assert.deepEqual(countAiCouncilHealthFindings(report, baseCouncil.id), {
    critical: 1,
    warning: 1,
    info: 1,
  });

  const view = buildAiCouncilHealthView(report, baseCouncil.id);
  assert.equal(view.state, "critical");
  assert.equal(view.needsAttention, true);
  assert.equal(view.totalFindings, 3);
  assert.deepEqual(view.badges, [
    { state: "critical", count: 1 },
    { state: "warning", count: 1 },
    { state: "info", count: 1 },
  ]);
  assert.equal(aiCouncilHealthViewMatchesState(view, "needs_attention"), true);
  assert.equal(aiCouncilHealthViewMatchesState(view, "critical"), true);
  assert.equal(aiCouncilHealthViewMatchesState(view, "clear"), false);
});

test("AI council health view model keeps unknown and clear states distinct", () => {
  const unknownView = buildAiCouncilHealthView(undefined, baseCouncil.id);
  assert.equal(unknownView.state, "unknown");
  assert.equal(unknownView.needsAttention, false);
  assert.deepEqual(unknownView.badges, []);

  const clearView = buildAiCouncilHealthView(report, clearCouncil.id);
  assert.equal(clearView.state, "clear");
  assert.equal(clearView.needsAttention, false);
  assert.deepEqual(clearView.badges, [{ state: "clear", count: 0 }]);
});

test("AI council health overview is client-neutral for Web and future desktop", () => {
  assert.deepEqual(buildAiCouncilHealthOverviewView([baseCouncil, clearCouncil], report), {
    total: 2,
    needsAttention: 1,
    healthy: 1,
    critical: 1,
    warning: 1,
    info: 1,
  });

  assert.deepEqual(buildAiCouncilHealthOverviewView([baseCouncil, clearCouncil], undefined), {
    total: 2,
    needsAttention: 0,
    healthy: 0,
    critical: 0,
    warning: 0,
    info: 0,
  });
});

function createFinding(severity, kind, teammateId, label) {
  return {
    id: `finding:${severity}:${teammateId}`,
    kind,
    severity,
    councilId: baseCouncil.id,
    councilDisplayName: baseCouncil.displayName,
    teammateId,
    slotKey: label.toLowerCase(),
    label,
    title: `${label} blocked`,
    message: `${label} is blocked.`,
  };
}
