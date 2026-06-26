import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAgentRelevanceCardEvidenceInputs,
  buildChannelTeamAttentionPlan,
} from "../dist/index.js";

test("channel team attention plan is inert unless feature flag is enabled", () => {
  const plan = buildChannelTeamAttentionPlan({
    id: "attention_plan_disabled",
    channelId: "channel_demo",
    turnId: "turn_demo",
    turnMode: "deep_review",
    now: "2026-06-26T00:00:00.000Z",
    flags: { attentionPlanEnabled: false },
    candidates: [
      {
        agentId: "teammate_builtin_security",
        participationMode: "reviewer",
        capabilityManifest: {
          agentId: "teammate_builtin_security",
          capabilityScopes: ["security"],
        },
      },
    ],
    signals: [{ kind: "risk", scope: "security", weight: 1 }],
  });

  assert.equal(plan.id, "attention_plan_disabled");
  assert.equal(plan.observers.length, 0);
  assert.deepEqual(plan.riskSignals, []);
  assert.deepEqual(buildAgentRelevanceCardEvidenceInputs({
    attentionPlan: plan,
    now: "2026-06-26T00:01:00.000Z",
    flags: { agentRelevanceCardsEnabled: false },
  }), []);
});

test("channel team attention plan selects passive matching observers only", () => {
  const plan = buildChannelTeamAttentionPlan({
    id: "attention_plan_enabled",
    channelId: "channel_demo",
    turnId: "turn_demo",
    turnMode: "deep_review",
    now: "2026-06-26T00:00:00.000Z",
    flags: { attentionPlanEnabled: true },
    maxObservers: 2,
    signals: [
      {
        kind: "risk",
        scope: "security",
        weight: 2,
        sourceRefs: [{ type: "message", id: "msg_demo" }],
      },
      {
        kind: "topic",
        scope: "frontend",
        weight: 1,
      },
    ],
    candidates: [
      {
        agentId: "teammate_builtin_security",
        participationMode: "reviewer",
        qualityState: "trusted",
        availabilityState: "healthy",
        capabilityManifest: {
          agentId: "teammate_builtin_security",
          summary: "Security reviewer",
          capabilityScopes: ["security"],
          preferredTurnModes: ["deep_review"],
          maxLeaseLevel: "L0",
        },
      },
      {
        agentId: "teammate_builtin_designer",
        participationMode: "specialist",
        qualityState: "active",
        availabilityState: "slow",
        capabilityManifest: {
          agentId: "teammate_builtin_designer",
          summary: "Frontend reviewer",
          capabilityScopes: ["frontend"],
        },
      },
      {
        agentId: "teammate_builtin_engineer",
        participationMode: "executor",
        capabilityManifest: {
          agentId: "teammate_builtin_engineer",
          capabilityScopes: ["security"],
        },
      },
      {
        agentId: "teammate_builtin_docs",
        participationMode: "observer",
        qualityState: "quarantined",
        capabilityManifest: {
          agentId: "teammate_builtin_docs",
          capabilityScopes: ["frontend"],
        },
      },
      {
        agentId: "teammate_builtin_release",
        participationMode: "observer",
        availabilityState: "offline",
        capabilityManifest: {
          agentId: "teammate_builtin_release",
          capabilityScopes: ["security"],
        },
      },
    ],
  });

  assert.equal(plan.observers.length, 2);
  assert.deepEqual(plan.riskSignals, ["security"]);
  assert.deepEqual(plan.observers.map((observer) => observer.agentId), [
    "teammate_builtin_security",
    "teammate_builtin_designer",
  ]);
  assert.deepEqual(plan.observers[0].matchedScopes, ["security"]);
  assert.deepEqual(plan.observers[0].sourceRefs, [{ type: "message", id: "msg_demo" }]);
  assert.match(plan.observers[0].reason, /Security reviewer/);
  assert.equal(plan.observers.some((observer) => observer.agentId === "teammate_builtin_engineer"), false);
});

test("agent relevance card evidence inputs require their own feature flag", () => {
  const plan = buildChannelTeamAttentionPlan({
    id: "attention_plan_relevance_cards",
    channelId: "channel_demo",
    turnId: "turn_demo",
    turnMode: "quick_answer",
    now: "2026-06-26T00:00:00.000Z",
    flags: { attentionPlanEnabled: true },
    candidates: [
      {
        agentId: "teammate_builtin_architect",
        participationMode: "observer",
        availabilityState: "rate_limited",
        qualityState: "watchlisted",
        capabilityManifest: {
          agentId: "teammate_builtin_architect",
          summary: "Architect reviewer",
          capabilityScopes: ["architecture"],
        },
      },
    ],
    signals: [{ kind: "topic", scope: "architecture", weight: 1 }],
  });

  assert.equal(
    buildAgentRelevanceCardEvidenceInputs({
      attentionPlan: plan,
      now: "2026-06-26T00:01:00.000Z",
      flags: { agentRelevanceCardsEnabled: false },
    }).length,
    0,
  );

  const evidenceInputs = buildAgentRelevanceCardEvidenceInputs({
    attentionPlan: plan,
    now: "2026-06-26T00:01:00.000Z",
    flags: { agentRelevanceCardsEnabled: true },
  });
  assert.equal(evidenceInputs.length, 1);
  assert.equal(evidenceInputs[0].kind, "agent_relevance_card");
  assert.equal(evidenceInputs[0].status, "completed");
  assert.equal(evidenceInputs[0].visibility, "internal");
  assert.equal(evidenceInputs[0].evidenceGrade, "inferred");
  assert.equal(evidenceInputs[0].payload?.attentionPlanId, "attention_plan_relevance_cards");
  assert.equal(evidenceInputs[0].payload?.availabilityState, "rate_limited");
  assert.ok(evidenceInputs[0].confidence < 0.7);
});
