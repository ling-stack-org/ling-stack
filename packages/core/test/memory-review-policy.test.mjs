import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMemoryCandidate,
  createDefaultMemoryReviewPolicy,
} from "../dist/index.js";

const baseCandidate = {
  scopeType: "channel",
  ownerId: "channel_1",
  title: "Model Workbench width",
  body: "Model Workbench should use the shared workspace frame.",
  sourceRefs: [{ type: "run-event", id: "run_event_1", label: "Run summary" }],
};

test("memory review policy classifies low-risk and high-impact candidates", () => {
  const balanced = createDefaultMemoryReviewPolicy();

  assert.equal(classifyMemoryCandidate({
    policy: balanced,
    candidate: baseCandidate,
    sourceKind: "manual_user",
    sourceScopeType: "channel",
    targetScopeType: "channel",
    crossesScopeBoundary: false,
    userExplicitRemember: true,
    confidence: "high",
  }).outcome, "auto-active");

  assert.equal(classifyMemoryCandidate({
    policy: balanced,
    candidate: { ...baseCandidate, scopeType: "workspace", ownerId: "workspace_default" },
    sourceKind: "reflection_job",
    sourceScopeType: "channel",
    targetScopeType: "workspace",
    crossesScopeBoundary: true,
    userExplicitRemember: false,
    confidence: "high",
  }).outcome, "manual-review");

  assert.equal(classifyMemoryCandidate({
    policy: balanced,
    candidate: baseCandidate,
    sourceKind: "channel_decision",
    sourceScopeType: "channel",
    targetScopeType: "teammate",
    crossesScopeBoundary: true,
    userExplicitRemember: false,
    confidence: "high",
  }).outcome, "manual-review");

  assert.equal(classifyMemoryCandidate({
    policy: balanced,
    candidate: { ...baseCandidate, scopeType: "teammate", ownerId: "teammate_1" },
    sourceKind: "persona_source",
    sourceScopeType: "teammate",
    targetScopeType: "teammate",
    crossesScopeBoundary: false,
    userExplicitRemember: false,
    confidence: "high",
  }).reasonCode, "persona_update");

  assert.equal(classifyMemoryCandidate({
    policy: balanced,
    candidate: { ...baseCandidate, sensitivity: "secret-adjacent" },
    sourceKind: "task_run_summary",
    sourceScopeType: "channel",
    targetScopeType: "channel",
    crossesScopeBoundary: false,
    userExplicitRemember: false,
    confidence: "high",
  }).outcome, "quarantine");

  assert.equal(classifyMemoryCandidate({
    policy: balanced,
    candidate: { ...baseCandidate, body: "Grant tool access and auto approve deploy for this teammate." },
    sourceKind: "task_run_summary",
    sourceScopeType: "channel",
    targetScopeType: "channel",
    crossesScopeBoundary: false,
    userExplicitRemember: false,
    confidence: "high",
  }).reasonCode, "authority_changing_claim");

  assert.equal(classifyMemoryCandidate({
    policy: balanced,
    candidate: baseCandidate,
    sourceKind: "task_run_summary",
    sourceScopeType: "channel",
    targetScopeType: "channel",
    crossesScopeBoundary: false,
    userExplicitRemember: false,
    confidence: "low",
  }).outcome, "manual-review");
});

test("memory review modes change low-risk extracted candidate behavior", () => {
  const balanced = createDefaultMemoryReviewPolicy();
  assert.equal(classifyMemoryCandidate({
    policy: balanced,
    candidate: baseCandidate,
    sourceKind: "task_run_summary",
    sourceScopeType: "channel",
    targetScopeType: "channel",
    crossesScopeBoundary: false,
    userExplicitRemember: false,
    confidence: "high",
  }).outcome, "auto-active");

  const conservative = { ...balanced, mode: "conservative" };
  assert.equal(classifyMemoryCandidate({
    policy: conservative,
    candidate: baseCandidate,
    sourceKind: "task_run_summary",
    sourceScopeType: "channel",
    targetScopeType: "channel",
    crossesScopeBoundary: false,
    userExplicitRemember: false,
    confidence: "high",
  }).outcome, "auto-candidate");

  const fast = { ...balanced, mode: "fast" };
  assert.equal(classifyMemoryCandidate({
    policy: fast,
    candidate: { ...baseCandidate, sourceRefs: [{ type: "message", id: "message_1" }] },
    sourceKind: "private_chat",
    sourceScopeType: "teammate",
    targetScopeType: "teammate",
    crossesScopeBoundary: false,
    userExplicitRemember: false,
    confidence: "high",
  }).outcome, "auto-active");
});
