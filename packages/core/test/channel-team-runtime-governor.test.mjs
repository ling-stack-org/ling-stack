import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChannelTeamRuntimePlan } from "../dist/index.js";

test("team runtime governor keeps quick answers low latency", () => {
  const plan = buildChannelTeamRuntimePlan({
    id: "runtime_quick",
    attentionPlan: attentionPlan({
      turnMode: "quick_answer",
      observers: [
        observer("teammate_designer", { matchedScopes: ["frontend"] }),
        observer("teammate_security", { matchedScopes: ["security"] }),
      ],
    }),
    now: "2026-06-27T00:00:00.000Z",
  });

  assert.equal(plan.id, "runtime_quick");
  assert.equal(plan.turnMode, "quick_answer");
  assert.equal(plan.maxObservers, 1);
  assert.equal(plan.totalTimeoutMs, 900);
  assert.equal(plan.perAgentTimeoutMs, 700);
  assert.equal(plan.allowLateNotes, false);
  assert.equal(plan.allowFallbackProvider, false);
  assert.equal(plan.maxReadLeases, 0);
  assert.equal(plan.budgetClass, "low");
  assert.deepEqual(plan.observers.map((item) => item.agentId), ["teammate_designer"]);
  assert.deepEqual(plan.skippedObserverIds, ["teammate_security"]);
  assert.deepEqual(plan.constraints, ["observer_skipped_budget:teammate_security"]);
});

test("team runtime governor allows bounded deep review observers and verified fallback", () => {
  const plan = buildChannelTeamRuntimePlan({
    id: "runtime_deep",
    attentionPlan: attentionPlan({
      turnMode: "deep_review",
      observers: [
        observer("teammate_architect", { matchedScopes: ["architecture"] }),
        observer("teammate_qa", { matchedScopes: ["testing"] }),
        observer("teammate_docs", { matchedScopes: ["docs"] }),
      ],
    }),
    maxObservers: 2,
    fallbackProvider: {
      available: true,
      capabilityScopes: ["architecture", "testing"],
    },
    now: "2026-06-27T00:00:00.000Z",
  });

  assert.equal(plan.maxObservers, 2);
  assert.equal(plan.allowLateNotes, true);
  assert.equal(plan.allowFallbackProvider, true);
  assert.equal(plan.maxReadLeases, 3);
  assert.equal(plan.budgetClass, "normal");
  assert.deepEqual(plan.observers.map((item) => item.agentId), ["teammate_architect", "teammate_qa"]);
  assert.deepEqual(plan.skippedObserverIds, ["teammate_docs"]);
  assert.deepEqual(plan.constraints, ["observer_skipped_budget:teammate_docs"]);
});

test("team runtime governor preserves risk reviewers for safe actions", () => {
  const plan = buildChannelTeamRuntimePlan({
    id: "runtime_safe_action",
    attentionPlan: attentionPlan({
      turnMode: "safe_action",
      observers: [
        observer("teammate_designer", { participationMode: "specialist", matchedScopes: ["frontend"] }),
        observer("teammate_security", { participationMode: "reviewer", matchedScopes: ["security"] }),
      ],
    }),
    maxObservers: 1,
    allowFallbackProvider: true,
    riskReviewDecision: {
      status: "required",
      risk: "high",
      reasons: ["Protected-looking branch push requires risk review."],
      triggerCodes: ["protected_branch_push"],
    },
    fallbackProvider: {
      available: true,
      capabilityScopes: ["security"],
      highRiskAllowed: false,
    },
    now: "2026-06-27T00:00:00.000Z",
  });

  assert.equal(plan.budgetClass, "high");
  assert.equal(plan.allowLateNotes, false);
  assert.equal(plan.allowFallbackProvider, false);
  assert.deepEqual(plan.observers.map((item) => item.agentId), ["teammate_security"]);
  assert.deepEqual(plan.skippedObserverIds, ["teammate_designer"]);
  assert.deepEqual(plan.constraints, [
    "risk_review_required",
    "observer_skipped_budget:teammate_designer",
    "fallback_provider_high_risk_scope_denied",
  ]);
});

test("team runtime governor makes slow observers late-note candidates when allowed", () => {
  const plan = buildChannelTeamRuntimePlan({
    id: "runtime_slow_deep",
    attentionPlan: attentionPlan({
      turnMode: "deep_review",
      observers: [
        observer("teammate_designer", { availabilityState: "slow", matchedScopes: ["frontend"] }),
      ],
    }),
    fallbackProvider: { available: true, capabilityScopes: ["frontend"] },
    now: "2026-06-27T00:00:00.000Z",
  });

  assert.deepEqual(plan.observers.map((item) => item.agentId), ["teammate_designer"]);
  assert.deepEqual(plan.lateObserverIds, ["teammate_designer"]);
  assert.deepEqual(plan.skippedObserverIds, []);
  assert.deepEqual(plan.constraints, ["observer_late_note_candidate:teammate_designer"]);
});

test("team runtime governor skips unavailable observers without lowering quality", () => {
  const plan = buildChannelTeamRuntimePlan({
    id: "runtime_unavailable",
    attentionPlan: attentionPlan({
      turnMode: "deep_review",
      observers: [
        observer("teammate_offline", { availabilityState: "offline", qualityState: "trusted" }),
        observer("teammate_overloaded", { availabilityState: "overloaded", qualityState: "active" }),
        observer("teammate_rate_limited", { availabilityState: "rate_limited", qualityState: "active" }),
      ],
    }),
    fallbackProvider: { available: true },
    now: "2026-06-27T00:00:00.000Z",
  });

  assert.deepEqual(plan.observers, []);
  assert.deepEqual(plan.skippedObserverIds, ["teammate_offline", "teammate_overloaded", "teammate_rate_limited"]);
  assert.deepEqual(plan.constraints, [
    "observer_skipped_offline:teammate_offline",
    "observer_skipped_overloaded:teammate_overloaded",
    "observer_skipped_rate_limited:teammate_rate_limited",
  ]);
});

test("team runtime governor blocks unverified and incompatible fallback providers", () => {
  const unverified = buildChannelTeamRuntimePlan({
    id: "runtime_fallback_unverified",
    attentionPlan: attentionPlan({
      turnMode: "deep_review",
      observers: [observer("teammate_architect", { matchedScopes: ["architecture"] })],
    }),
    now: "2026-06-27T00:00:00.000Z",
  });

  assert.equal(unverified.allowFallbackProvider, false);
  assert.deepEqual(unverified.constraints, ["fallback_provider_unverified"]);

  const incompatible = buildChannelTeamRuntimePlan({
    id: "runtime_fallback_incompatible",
    attentionPlan: attentionPlan({
      turnMode: "deep_review",
      observers: [observer("teammate_architect", { matchedScopes: ["architecture"] })],
    }),
    fallbackProvider: {
      available: true,
      capabilityScopes: ["frontend"],
    },
    now: "2026-06-27T00:00:00.000Z",
  });

  assert.equal(incompatible.allowFallbackProvider, false);
  assert.deepEqual(incompatible.constraints, ["fallback_provider_capability_mismatch:architecture"]);
});

function attentionPlan(input) {
  return {
    id: input.id ?? "attention_plan_test",
    channelId: input.channelId ?? "channel_demo",
    turnId: input.turnId ?? "turn_demo",
    turnMode: input.turnMode,
    observers: input.observers ?? [],
    riskSignals: input.riskSignals ?? [],
    createdAt: "2026-06-27T00:00:00.000Z",
  };
}

function observer(agentId, overrides = {}) {
  return {
    agentId,
    participationMode: overrides.participationMode ?? "observer",
    reason: overrides.reason ?? "matched test signal",
    sourceRefs: overrides.sourceRefs ?? [],
    maxLevel: overrides.maxLevel ?? "L0",
    matchedScopes: overrides.matchedScopes ?? [],
    ...(overrides.availabilityState ? { availabilityState: overrides.availabilityState } : {}),
    ...(overrides.qualityState ? { qualityState: overrides.qualityState } : {}),
  };
}
