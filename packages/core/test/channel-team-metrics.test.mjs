import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChannelTeamMetricsProjection } from "../dist/index.js";

const now = "2026-06-26T00:10:00.000Z";

test("channel team metrics projection summarizes evidence without ranking agents", () => {
  const projection = buildChannelTeamMetricsProjection({
    channelId: "channel_demo",
    now,
    evidence: [
      evidence({
        id: "evidence_security_note",
        agentId: "teammate_builtin_security",
        kind: "specialist_note",
        status: "completed",
        summary: "Security checked the approval boundary.",
        updatedAt: "2026-06-26T00:02:00.000Z",
      }),
      evidence({
        id: "evidence_security_risk",
        agentId: "teammate_builtin_security",
        kind: "risk_signal",
        status: "pending",
        summary: "Force push needs risk review.",
        recommendations: ["Use the existing approval request."],
        updatedAt: "2026-06-26T00:03:00.000Z",
      }),
      evidence({
        id: "evidence_design_timeout",
        agentId: "teammate_builtin_designer",
        kind: "agent_relevance_card",
        status: "timeout",
        summary: "Designer did not respond before the turn closed.",
        updatedAt: "2026-06-26T00:04:00.000Z",
      }),
      evidence({
        id: "evidence_other_channel",
        channelId: "channel_other",
        agentId: "teammate_builtin_security",
        kind: "specialist_note",
        status: "completed",
        summary: "Different channel evidence is ignored.",
        updatedAt: "2026-06-26T00:05:00.000Z",
      }),
    ],
    reliabilityIncidents: [
      reliabilityIncident({
        id: "incident_security_quality",
        agentId: "teammate_builtin_security",
        severity: "high",
        updatedAt: "2026-06-26T00:06:00.000Z",
      }),
    ],
  });

  assert.equal(projection.channelId, "channel_demo");
  assert.equal(projection.generatedAt, now);
  assert.equal(projection.summary.healthState, "degraded");
  assert.equal(projection.summary.totalEvidenceCount, 3);
  assert.equal(projection.summary.activeEvidenceCount, 1);
  assert.equal(projection.summary.delayedEvidenceCount, 1);
  assert.equal(projection.summary.reliabilityIncidentCount, 1);
  assert.equal(projection.summary.latestUpdatedAt, "2026-06-26T00:06:00.000Z");
  assert.deepEqual(projection.attention.evidenceKindCounts, {
    specialist_note: 1,
    risk_signal: 1,
    agent_relevance_card: 1,
  });
  assert.deepEqual(projection.attention.evidenceStatusCounts, {
    completed: 1,
    pending: 1,
    timeout: 1,
  });
  assert.equal(projection.riskReview.riskSignalCount, 1);
  assert.equal(projection.riskReview.openReliabilityIncidentCount, 1);
  assert.equal(projection.learningQueue.recommendationEvidenceCount, 1);
  assert.deepEqual(
    projection.agents.map((agent) => agent.agentId),
    ["teammate_builtin_security", "teammate_builtin_designer"],
  );
  assert.deepEqual(
    projection.agents.map((agent) => ({
      agentId: agent.agentId,
      evidenceCount: agent.evidenceCount,
      reliabilityIncidentCount: agent.reliabilityIncidentCount,
    })),
    [
      { agentId: "teammate_builtin_security", evidenceCount: 2, reliabilityIncidentCount: 1 },
      { agentId: "teammate_builtin_designer", evidenceCount: 1, reliabilityIncidentCount: 0 },
    ],
  );
});

test("channel team metrics ignores recovered reliability incidents for current health", () => {
  const projection = buildChannelTeamMetricsProjection({
    channelId: "channel_demo",
    now,
    evidence: [
      evidence({
        id: "evidence_done",
        agentId: "teammate_builtin_architect",
        status: "completed",
        summary: "Architect note is complete.",
      }),
    ],
    reliabilityIncidents: [
      reliabilityIncident({
        id: "incident_recovered",
        agentId: "teammate_builtin_architect",
        severity: "critical",
        recoveredAt: "2026-06-26T00:08:00.000Z",
      }),
    ],
    availabilityIncidents: [],
  });

  assert.equal(projection.summary.healthState, "healthy");
  assert.equal(projection.summary.reliabilityIncidentCount, 0);
  assert.equal(projection.riskReview.openReliabilityIncidentCount, 0);
  assert.equal(projection.agents[0].reliabilityIncidentCount, 0);
});

function evidence(overrides = {}) {
  return {
    id: overrides.id ?? "evidence_default",
    workspaceId: "workspace_default",
    channelId: overrides.channelId ?? "channel_demo",
    turnId: overrides.turnId ?? "turn_demo",
    agentId: overrides.agentId,
    kind: overrides.kind ?? "specialist_note",
    status: overrides.status ?? "completed",
    visibility: overrides.visibility ?? "folded_evidence",
    evidenceGrade: overrides.evidenceGrade ?? "observed",
    summary: overrides.summary ?? "Evidence summary.",
    concerns: overrides.concerns ?? [],
    recommendations: overrides.recommendations ?? [],
    confidence: overrides.confidence,
    sourceRefs: overrides.sourceRefs ?? [],
    payload: overrides.payload ?? {},
    expiresAt: overrides.expiresAt,
    createdAt: overrides.createdAt ?? "2026-06-26T00:01:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-26T00:01:00.000Z",
  };
}

function reliabilityIncident(overrides = {}) {
  return {
    id: overrides.id ?? "incident_default",
    workspaceId: "workspace_default",
    agentId: overrides.agentId ?? "teammate_builtin_security",
    capabilityScope: overrides.capabilityScope ?? "security",
    kind: overrides.kind ?? "unsafe_suggestion",
    severity: overrides.severity ?? "medium",
    summary: overrides.summary ?? "Reliability incident summary.",
    sourceRefs: overrides.sourceRefs ?? [],
    recoveryRequired: overrides.recoveryRequired ?? false,
    recoveredAt: overrides.recoveredAt,
    createdAt: overrides.createdAt ?? "2026-06-26T00:01:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-26T00:01:00.000Z",
    expiresAt: overrides.expiresAt,
  };
}
