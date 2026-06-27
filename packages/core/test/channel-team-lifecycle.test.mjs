import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAgentLifecycleState } from "../dist/index.js";

test("agent lifecycle keeps provider availability separate from agent quality", () => {
  const lifecycle = deriveAgentLifecycleState({
    agentId: "teammate_builtin_security",
    capabilityScope: "security",
    now: "2026-06-26T00:10:00.000Z",
    reliabilityIncidents: [],
    availabilityIncidents: [
      {
        id: "availability_rate_limit",
        agentId: "teammate_builtin_security",
        state: "rate_limited",
        kind: "quota",
        summary: "Provider is temporarily rate limited.",
        observedAt: "2026-06-26T00:00:00.000Z",
      },
    ],
  });

  assert.equal(lifecycle.qualityState, "active");
  assert.equal(lifecycle.availabilityState, "rate_limited");
  assert.equal(lifecycle.reviewerEligible, true);
  assert.equal(lifecycle.highRiskReviewerEligible, true);
  assert.deepEqual(lifecycle.activeAvailabilityIncidentIds, ["availability_rate_limit"]);
  assert.deepEqual(lifecycle.activeReliabilityIncidentIds, []);
});

test("agent lifecycle applies provider-level availability without degrading quality", () => {
  const lifecycle = deriveAgentLifecycleState({
    agentId: "teammate_builtin_engineer",
    capabilityScope: "code",
    now: "2026-06-26T00:10:00.000Z",
    reliabilityIncidents: [],
    availabilityIncidents: [
      {
        id: "availability_provider_overload",
        providerPresetId: "provider_static",
        state: "overloaded",
        kind: "overload",
        severity: "medium",
        summary: "Provider is overloaded.",
        observedAt: "2026-06-26T00:00:00.000Z",
        expiresAt: "2026-06-26T00:30:00.000Z",
      },
      {
        id: "availability_provider_expired",
        providerPresetId: "provider_static",
        state: "offline",
        kind: "network",
        severity: "medium",
        summary: "Expired provider outage.",
        observedAt: "2026-06-25T00:00:00.000Z",
        expiresAt: "2026-06-25T00:05:00.000Z",
      },
    ],
  });

  assert.equal(lifecycle.qualityState, "active");
  assert.equal(lifecycle.availabilityState, "overloaded");
  assert.equal(lifecycle.reviewerEligible, false);
  assert.equal(lifecycle.highRiskReviewerEligible, false);
  assert.deepEqual(lifecycle.activeAvailabilityIncidentIds, ["availability_provider_overload"]);
  assert.deepEqual(lifecycle.activeReliabilityIncidentIds, []);
});

test("agent lifecycle ignores expired provider availability incidents", () => {
  const lifecycle = deriveAgentLifecycleState({
    agentId: "teammate_builtin_engineer",
    capabilityScope: "code",
    now: "2026-06-26T00:10:00.000Z",
    reliabilityIncidents: [],
    availabilityIncidents: [
      {
        id: "availability_provider_expired",
        providerPresetId: "provider_static",
        state: "offline",
        kind: "network",
        severity: "medium",
        summary: "Expired provider outage.",
        observedAt: "2026-06-25T00:00:00.000Z",
        expiresAt: "2026-06-25T00:05:00.000Z",
      },
    ],
  });

  assert.equal(lifecycle.qualityState, "active");
  assert.equal(lifecycle.availabilityState, "healthy");
  assert.deepEqual(lifecycle.activeAvailabilityIncidentIds, []);
});

test("agent lifecycle degrades scoped quality from active reliability incidents", () => {
  const lifecycle = deriveAgentLifecycleState({
    agentId: "teammate_builtin_security",
    capabilityScope: "security",
    now: "2026-06-26T00:10:00.000Z",
    reliabilityIncidents: [
      {
        id: "unsafe_advice",
        agentId: "teammate_builtin_security",
        capabilityScope: "security",
        kind: "unsafe_suggestion",
        severity: "critical",
        summary: "Suggested bypassing approval policy.",
        recoveryRequired: true,
        sourceRefs: [{ type: "approval", id: "approval_demo" }],
        createdAt: "2026-06-26T00:00:00.000Z",
      },
      {
        id: "other_scope",
        agentId: "teammate_builtin_security",
        capabilityScope: "frontend",
        kind: "low_quality",
        severity: "low",
        summary: "Unrelated scope should not affect security.",
        sourceRefs: [],
        createdAt: "2026-06-26T00:00:00.000Z",
      },
    ],
  });

  assert.equal(lifecycle.qualityState, "quarantined");
  assert.equal(lifecycle.availabilityState, "healthy");
  assert.equal(lifecycle.reviewerEligible, false);
  assert.equal(lifecycle.highRiskReviewerEligible, false);
  assert.equal(lifecycle.recoveryRequired, true);
  assert.deepEqual(lifecycle.activeReliabilityIncidentIds, ["unsafe_advice"]);
});

test("model signature changes warm only the affected lifecycle scope", () => {
  const lifecycle = deriveAgentLifecycleState({
    agentId: "teammate_builtin_architect",
    capabilityScope: "architecture",
    now: "2026-06-26T00:10:00.000Z",
    previousModelSignature: {
      providerPresetId: "provider_old",
      providerId: "openai",
      model: "gpt-5",
      promptHash: "old",
    },
    currentModelSignature: {
      providerPresetId: "provider_old",
      providerId: "openai",
      model: "gpt-5",
      promptHash: "new",
    },
  });

  assert.equal(lifecycle.qualityState, "warming_up");
  assert.equal(lifecycle.modelSignatureChanged, true);
  assert.equal(lifecycle.highRiskReviewerEligible, false);
  assert.deepEqual(lifecycle.reasons, ["model_signature_changed"]);
});
