import assert from "node:assert/strict";
import test from "node:test";
import type { DelegationCompletionEvidenceV1 } from "@ling-stack/core";
import { projectDelegationBudgetEvidence } from "../dist/features/runs/assurance-evidence.js";

const rootRunId = "root-budget";

function evidence(input: {
  budget?: { tokenBudget?: number; costBudgetMicros?: number };
  reservation?: Record<string, unknown>;
  charges?: readonly Record<string, unknown>[];
  issues?: readonly Record<string, unknown>[];
} = {}): DelegationCompletionEvidenceV1 {
  return {
    schemaVersion: 1,
    rootRunIds: [rootRunId],
    roots: [{
      runId: rootRunId,
      budget: input.budget ? {
        schemaVersion: 1,
        rootRunId,
        frozenAt: "2026-11-10T08:00:00.000Z",
        deadlineAt: "2026-11-10T09:00:00.000Z",
        authorityArtifactId: "authority-artifact",
        authorityDigest: "authority-digest",
        createdAt: "2026-11-10T08:00:00.000Z",
        ...input.budget,
      } : undefined,
      charges: [],
    }],
    steps: [{
      step: { id: "step-budget" },
      reservation: input.reservation,
      charges: input.charges ?? [],
    }],
    issues: input.issues ?? [],
    status: "pending",
    fingerprint: "completion-fingerprint",
  } as unknown as DelegationCompletionEvidenceV1;
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: "reservation-budget",
    rootRunId,
    delegationStepId: "step-budget",
    childRunId: "child-budget",
    requestDigest: "request-digest",
    deadlineAt: "2026-11-10T09:00:00.000Z",
    state: "settled",
    settledTokenUsage: 5,
    settledCostMicros: 7,
    idempotencyKey: "reservation-key",
    revision: 1,
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:01:00.000Z",
    settledAt: "2026-11-10T08:02:00.000Z",
    ...overrides,
  };
}

test("settled child usage stays within the root budget", () => {
  const result = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10, costBudgetMicros: 10 },
    reservation: reservation(),
  }), rootRunId);
  assert.equal(result.status, "within");
  assert.equal(result.usage.tokenStatus, "within");
  assert.equal(result.usage.costStatus, "within");
  assert.equal(result.usage.tokens, 5);
  assert.equal(result.usage.costMicros, 7);
});

test("an in-flight reservation is pending and remains visible as reserved capacity", () => {
  const result = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10, costBudgetMicros: 10 },
    reservation: reservation({ state: "reserved", settledTokenUsage: undefined, settledCostMicros: undefined, settledAt: undefined, tokenReserved: 6, costReservedMicros: 8 }),
  }), rootRunId);
  assert.equal(result.status, "pending");
  assert.equal(result.usage.tokenStatus, "pending");
  assert.equal(result.usage.tokens, 6);
  assert.deepEqual(result.reservations[0], {
    reservationId: "reservation-budget",
    stepId: "step-budget",
    state: "reserved",
    tokenReserved: 6,
    costReservedMicros: 8,
    settledTokenUsage: null,
    settledCostMicros: null,
    failureCode: null,
  });
});

test("unknown usage blocks the budget even when a conservative reservation exists", () => {
  const result = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10, costBudgetMicros: 10 },
    charges: [{
      id: "charge-unknown",
      rootRunId,
      runId: rootRunId,
      attemptId: "attempt-budget",
      invocationId: "invocation-budget",
      state: "unresolved",
      reservedTokens: 4,
      reservedCostMicros: 5,
    }],
  }), rootRunId);
  assert.equal(result.status, "unknown");
  assert.equal(result.usage.tokenStatus, "unknown");
  assert.equal(result.usage.tokens, null);
  assert.ok(result.blockers.includes("delegation.usage_unknown"));
});

test("a settled reservation over the root cap is over, without double-counting nested allocation", () => {
  const result = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10, costBudgetMicros: 20 },
    reservation: reservation({ settledTokenUsage: 12, settledCostMicros: 9 }),
  }), rootRunId);
  assert.equal(result.status, "over");
  assert.equal(result.usage.tokenStatus, "over");
  assert.equal(result.usage.tokens, 12);
  assert.equal(result.usage.costMicros, 9);
});

test("missing root authority and corrupt usage remain distinct admission blockers", () => {
  const missing = projectDelegationBudgetEvidence(evidence({ reservation: reservation() }), rootRunId);
  assert.equal(missing.status, "missing");
  assert.equal(missing.usage.tokenStatus, "missing");

  const invalid = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10 },
    reservation: reservation(),
    issues: [{ code: "delegation.completion_usage_invalid" }],
  }), rootRunId);
  assert.equal(invalid.status, "invalid");
  assert.ok(invalid.blockers.includes("delegation.completion_usage_invalid"));
});
