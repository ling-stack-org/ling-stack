import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultDeliberationTriggerPolicy,
  evaluateDeliberationTrigger,
} from "../dist/index.js";

test("deliberation trigger policy opens the right review paths", () => {
  const policy = defaultDeliberationTriggerPolicy();
  assert.equal(policy.enabled, true);
  assert.equal(evaluateDeliberationTrigger({ kind: "plan_formation", workItemRevision: 2 }, policy).shouldOpen, true);
  assert.equal(evaluateDeliberationTrigger({ kind: "material_requirement_change", workItemRevision: 2, materiality: "low" }, policy).shouldOpen, false);
  const conflict = evaluateDeliberationTrigger({ kind: "conflicting_recommendations", workItemRevision: 2, conflictCount: 2 }, policy);
  assert.equal(conflict.shouldOpen, true);
  assert.equal(conflict.requiresHumanDecision, true);
});

test("disabled policy suppresses automatic triggers while preserving manual intent", () => {
  const policy = { ...defaultDeliberationTriggerPolicy(), enabled: false };
  assert.equal(evaluateDeliberationTrigger({ kind: "declared_decision_point", workItemRevision: 1 }, policy).shouldOpen, false);
  const manual = evaluateDeliberationTrigger({ kind: "manual_request", workItemRevision: 1 }, policy);
  assert.equal(manual.shouldOpen, false);
  assert.equal(manual.requiresHumanDecision, true);
});
