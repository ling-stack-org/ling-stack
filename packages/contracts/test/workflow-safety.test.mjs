import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkflowStepExecutionSafety,
  WorkflowSafetyValidationError,
  workflowGraphFingerprintV1,
  workflowStepSideEffectClasses,
} from "../dist/index.js";

const declaration = (parallelPolicy = {}) => ({ sideEffectClass: "analysis_readonly", parallelPolicy });
const invalid = (value) => assert.throws(() => parseWorkflowStepExecutionSafety(value), (error) =>
  error instanceof WorkflowSafetyValidationError && error.code === "workflow_safety_invalid");

test("safety extraction leaves legacy records unclassified and never parses unrelated step fields", () => {
  for (const value of [undefined, {}, { skillId: "test-review", autoStart: true },
    { sideEffectClass: undefined, parallelPolicy: undefined }]) {
    assert.equal(parseWorkflowStepExecutionSafety(value), undefined);
  }
  assert.deepEqual(workflowStepSideEffectClasses, [
    "analysis_readonly", "test_artifact_only", "workspace_write", "external_mutation", "release",
  ]);
  for (const sideEffectClass of workflowStepSideEffectClasses) {
    assert.deepEqual(parseWorkflowStepExecutionSafety({ sideEffectClass, id: 123 }), { sideEffectClass });
  }
  for (const value of [null, [], true, 1, "analysis_readonly"]) invalid(value);
  invalid({ parallelPolicy: { autoParallel: false } });
});

test("policy defaults remain conservative and parsing a write request grants no authority", () => {
  assert.deepEqual(parseWorkflowStepExecutionSafety(declaration()), declaration({ autoParallel: false }));
  const input = declaration({ maxParallelSiblings: 2, resourceKeys: ["port:2", "port:1"],
    requiresArtifactOnly: false, cancelSiblingsOnFailure: true });
  const original = structuredClone(input);
  const parsed = parseWorkflowStepExecutionSafety(input);
  assert.deepEqual(parsed, { ...input, parallelPolicy: { ...input.parallelPolicy, autoParallel: false } });
  assert.deepEqual(input, original);
  assert.notEqual(parsed.parallelPolicy, input.parallelPolicy);
  assert.notEqual(parsed.parallelPolicy.resourceKeys, input.parallelPolicy.resourceKeys);
  for (const sideEffectClass of ["analysis_readonly", "workspace_write"]) {
    const request = { sideEffectClass, parallelPolicy: { autoParallel: true } };
    assert.deepEqual(parseWorkflowStepExecutionSafety(request), request);
  }
  const artifactOnly = { sideEffectClass: "test_artifact_only",
    parallelPolicy: { autoParallel: true, requiresArtifactOnly: true } };
  assert.deepEqual(parseWorkflowStepExecutionSafety(artifactOnly), artifactOnly);
  for (const sideEffectClass of ["external_mutation", "release"]) {
    invalid({ sideEffectClass, parallelPolicy: { autoParallel: true } });
    assert.equal(parseWorkflowStepExecutionSafety({ sideEffectClass, parallelPolicy: {} }).parallelPolicy.autoParallel, false);
  }
  invalid({ sideEffectClass: "test_artifact_only", parallelPolicy: { autoParallel: true } });
  invalid({ sideEffectClass: "test_artifact_only", parallelPolicy: { autoParallel: true, requiresArtifactOnly: false } });
});

test("explicit unknown classes, malformed policies and non-boolean flags are rejected", () => {
  for (const sideEffectClass of ["unknown", "", "analysis-readonly", null, 1, false, {}, []]) invalid({ sideEffectClass });
  for (const policy of [null, false, "auto", 2, [], { unknownConstraint: true }]) invalid(declaration(policy));
  for (const field of ["autoParallel", "requiresArtifactOnly", "cancelSiblingsOnFailure"]) {
    for (const value of [null, "true", 1, [], {}]) invalid(declaration({ [field]: value }));
  }
});

test("parallel counts are positive safe integers without imposing Host capacity at parse time", () => {
  for (const value of [0, -1, 1.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null, true]) {
    invalid(declaration({ maxParallelSiblings: value }));
  }
  for (const maxParallelSiblings of [1, 2, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseWorkflowStepExecutionSafety(declaration({ maxParallelSiblings })).parallelPolicy.maxParallelSiblings,
      maxParallelSiblings);
  }
});

test("resource declarations have bounded, unique, exact keys without whitespace repair", () => {
  for (const resourceKeys of [null, {}, "port:1", [null], [1], [""], [" "], [" port:1"], ["port:1 "],
    ["port:\n1"], ["port:\u00001"], ["port:\u007f1"], ["port:\u00851"], ["x".repeat(257)],
    ["port:1", "port:1"], Array.from({ length: 33 }, (_, i) => `resource:${i}`), new Array(1)]) {
    invalid(declaration({ resourceKeys }));
  }
  for (const resourceKeys of [[], ["x".repeat(256)], Array.from({ length: 32 }, (_, i) => `resource:${i}`)]) {
    assert.deepEqual(parseWorkflowStepExecutionSafety(declaration({ resourceKeys })).parallelPolicy.resourceKeys, resourceKeys);
  }
});

function graph(safety = {}) {
  return {
    schemaVersion: 1, id: "safety-graph", name: "Safety graph", entryNodeId: "review",
    nodes: [{ id: "review", kind: "step", name: "Review", prompt: "Read evidence", requiredTools: ["read"], ...safety }],
    edges: [], termination: { success: "all_required_succeeded", onFailedRequiredNode: "fail_workflow", onApprovalDenied: "block_for_user" },
  };
}

test("graph fingerprints bind every safety constraint and preserve fingerprints of legacy graphs", () => {
  assert.equal(workflowGraphFingerprintV1(graph()), "wgfv1_47763cf8cbf732dd");
  const safety = declaration({ autoParallel: true, maxParallelSiblings: 2, resourceKeys: ["port:2", "port:1"],
    requiresArtifactOnly: true, cancelSiblingsOnFailure: false });
  const baseline = workflowGraphFingerprintV1(graph(safety));
  assert.notEqual(baseline, workflowGraphFingerprintV1(graph()));
  assert.notEqual(baseline, workflowGraphFingerprintV1(graph({ ...safety, sideEffectClass: "test_artifact_only" })));
  for (const patch of [{ autoParallel: false }, { maxParallelSiblings: 1 }, { resourceKeys: ["port:1"] },
    { requiresArtifactOnly: false }, { cancelSiblingsOnFailure: true }]) {
    assert.notEqual(baseline, workflowGraphFingerprintV1(graph({ ...safety, parallelPolicy: { ...safety.parallelPolicy, ...patch } })));
  }
  assert.notEqual(baseline, workflowGraphFingerprintV1(graph({ sideEffectClass: safety.sideEffectClass })));
  const reordered = graph({ ...safety, parallelPolicy: { cancelSiblingsOnFailure: false, requiresArtifactOnly: true,
    resourceKeys: ["port:1", "port:2"], maxParallelSiblings: 2, autoParallel: true } });
  assert.equal(workflowGraphFingerprintV1(reordered), baseline);
  assert.deepEqual(safety.parallelPolicy.resourceKeys, ["port:2", "port:1"]);
});
