import assert from "node:assert/strict";
import test from "node:test";
import { workflowStepStartAuthorityBasis, createWorkflowPreGateExecutionPermit } from "../../core/dist/index.js";
import { b013OwnedStore, b013FactCounts, b013ParticipantId, b013Gate } from "../../core/test/support/b013-pre-gate-fixture.mjs";
import { compileWorkflowTemplate, parseWorkflowTemplateCompileRequest } from "../dist/features/channels/workflow-templates.js";
import { compileWorkflowStepSafety } from "../dist/features/channels/workflow-step-safety.js";
import { createWorkflowSafetyPlan } from "../dist/features/runs/workflow-safety.js";

const readonlySafety = {
  sideEffectClass: "analysis_readonly",
  parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: ["review:shared-index"] },
};

function request(kind, safety = readonlySafety) {
  const step = { id: "inspect", name: "Inspect", prompt: "Inspect owned inputs", teammateId: b013ParticipantId, ...safety };
  return {
    objective: "Compile safety without executing a model or a tool",
    ...(kind === "custom" ? {
      customTemplate: { schemaVersion: 1, id: "safety-custom", name: "Safety", maxParallelSteps: 2, steps: [step] },
    } : {
      workflowGraph: { schemaVersion: 1, id: "safety-graph", name: "Safety", entryNodeId: "inspect", maxParallelSteps: 2,
        nodes: [{ ...step, kind: "step", requiredTools: ["read"] }], edges: [],
        termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } },
    }),
  };
}

function compile(f, value) {
  return compileWorkflowTemplate(f.store, parseWorkflowTemplateCompileRequest(value, f.channel.id));
}

async function fixture(t) {
  const f = await b013OwnedStore(t);
  f.channel = f.store.updateChannel(f.channel.id, {
    runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 3, allowReadOnlyParallel: true },
  }, new Date().toISOString());
  return f;
}

for (const kind of ["custom", "graph"]) {
  test(`${kind} compile retains explicit safety and does not start execution`, async t => {
    const f = await fixture(t), { workflowSteps } = compile(f, request(kind));
    const metadata = workflowSteps[0].metadata;
    assert.equal(metadata.sideEffectClass, readonlySafety.sideEffectClass);
    assert.deepEqual(metadata.parallelPolicy, readonlySafety.parallelPolicy);
    assert.equal(metadata.maxParallelSiblings, 2);
    assert.equal(metadata.autoStart, false);
    assert.equal(b013FactCounts(f.store).tasks, 0);
    assert.equal(b013FactCounts(f.store).run_sessions, 0);
  });

  test(`${kind} missing safety compiles conservatively, never by step name or read tool`, async t => {
    const f = await fixture(t), { workflowSteps } = compile(f, request(kind, {}));
    assert.equal(workflowSteps[0].metadata.sideEffectClass, "workspace_write");
    assert.equal(workflowSteps[0].metadata.parallelPolicy.autoParallel, false);
  });

  for (const [label, safety] of [
    ["unknown class", { sideEffectClass: "looks_readonly" }],
    ["unclassified policy", { parallelPolicy: { autoParallel: true } }],
    ["fractional limit", { ...readonlySafety, parallelPolicy: { autoParallel: true, maxParallelSiblings: 1.5 } }],
    ["channel overflow", { ...readonlySafety, parallelPolicy: { autoParallel: true, maxParallelSiblings: 4 } }],
    ["duplicate resources", { ...readonlySafety, parallelPolicy: { autoParallel: true, resourceKeys: ["cache:a", "cache:a"] } }],
    ["unconfined QA", { sideEffectClass: "test_artifact_only", parallelPolicy: { autoParallel: true } }],
    ["parallel release", { sideEffectClass: "release", parallelPolicy: { autoParallel: true } }],
  ]) {
    test(`${kind} rejects ${label} before persisting workflow facts`, async t => {
      const f = await fixture(t), before = b013FactCounts(f.store);
      assert.throws(() => compile(f, request(kind, safety)), error => error.statusCode === 400 && error.code.startsWith("workflow_safety_"));
      assert.deepEqual(b013FactCounts(f.store), before);
    });
  }
}

test("custom rejects conflicting legacy and explicit sibling limits", async t => {
  const f = await fixture(t), body = request("custom");
  body.customTemplate.steps[0].maxParallelSiblings = 1;
  const before = b013FactCounts(f.store);
  assert.throws(() => compile(f, body), { code: "workflow_safety_parallel_limit_conflict" });
  assert.deepEqual(b013FactCounts(f.store), before);
});

test("workflow and sibling constraints take the minimum without widening a group", () => {
  assert.equal(compileWorkflowStepSafety({ ...readonlySafety, parallelPolicy: { autoParallel: true, maxParallelSiblings: 3 } }, {
    maxConcurrentRuns: 4, maxParallelSteps: 2,
  }).parallelPolicy.maxParallelSiblings, 2);
});

test("builtin manifest declares exact classes, retains strict ship approval and channel limits", async t => {
  const f = await b013OwnedStore(t);
  const compiled = compile(f, { templateId: "autoplan-lite", objective: "Inspect the explicit built-in manifest" });
  const byId = Object.fromEntries(compiled.workflowSteps.map(step => [step.metadata.templateStepId, step.metadata]));
  for (const id of ["product-discovery", "product-review", "design-review", "engineering-review", "code-review"]) {
    assert.equal(byId[id].sideEffectClass, "analysis_readonly");
  }
  assert.equal(byId.implementation.sideEffectClass, "workspace_write");
  assert.equal(byId.implementation.parallelPolicy.autoParallel, false);
  assert.equal(byId.qa.sideEffectClass, "workspace_write");
  assert.equal(byId.qa.parallelPolicy.autoParallel, false);
  assert.equal(byId.qa.parallelPolicy.requiresArtifactOnly, undefined);
  assert.equal(byId.qa.approvalGate.mode, "standard");
  const qa = compiled.workflowSteps.find(step => step.metadata.templateStepId === "qa");
  const plan = createWorkflowSafetyPlan({ store: f.store, step: qa, workspaceCwd: f.cwd, executionCwd: f.cwd });
  assert.equal(plan.profile, "serial_v1");
  assert.equal(plan.safety.sideEffectClass, "workspace_write");
  assert.equal(plan.safety.parallelPolicy.autoParallel, false);
  assert.deepEqual(plan.writeRoots, [f.cwd]);
  assert.ok(plan.tools.includes("bash"));
  assert.throws(() => createWorkflowSafetyPlan({ store: f.store, step: { ...qa, metadata: { ...qa.metadata,
    sideEffectClass: "test_artifact_only", parallelPolicy: { autoParallel: true, requiresArtifactOnly: true } } },
    workspaceCwd: f.cwd, executionCwd: f.cwd }), { code: "workflow_safety_profile_unavailable" });
  assert.equal(byId.ship.sideEffectClass, "release");
  assert.equal(byId.ship.parallelPolicy.autoParallel, false);
  assert.equal(byId.ship.approvalGate.mode, "strict");
  assert.ok(compiled.workflowSteps.every(step => step.metadata.parallelPolicy.maxParallelSiblings <= f.channel.runtimePolicy.maxConcurrentRuns));
});

test("safety and channel policy changes invalidate approved semantic authority", async t => {
  const f = await fixture(t), body = request("custom");
  body.customTemplate.steps[0].gates = [b013Gate()];
  const step = compile(f, body).workflowSteps[0];
  const executionPermit = createWorkflowPreGateExecutionPermit({ mode: "create_and_run_task", taskTitle: step.title,
    taskPrompt: step.prompt, assigneeTeammateId: step.toParticipantId, skipProviderPreflight: false });
  const expected = { status: step.status, updatedAt: step.updatedAt };
  const pending = f.store.requestChannelWorkflowStepPreApproval({ workflowStepId: step.id, expected, executionPermit, now: new Date().toISOString() });
  assert.equal(pending.status, "requested");
  f.store.approveApprovalRequest(pending.approval.id, { resolvedBy: "local-user" }, new Date().toISOString());
  const basis = workflowStepStartAuthorityBasis(f.store, f.store.getChannelWorkflowStep(step.id));
  const changed = f.store.updateChannelWorkflowStep(step.id, { metadata: { ...f.store.getChannelWorkflowStep(step.id).metadata,
    parallelPolicy: { autoParallel: false, maxParallelSiblings: 1 } } }, new Date().toISOString());
  assert.notEqual(workflowStepStartAuthorityBasis(f.store, changed), basis);
  const resolved = f.store.resolveChannelWorkflowStepPreApproval({ workflowStepId: step.id, approvalId: pending.approval.id, now: new Date().toISOString() });
  assert.equal(resolved.status, "stale");
  assert.equal(b013FactCounts(f.store).tasks, 0);
  const beforePolicyChange = workflowStepStartAuthorityBasis(f.store, changed);
  f.channel = f.store.updateChannel(f.channel.id, { runtimePolicy: { ...f.channel.runtimePolicy, allowReadOnlyParallel: false } }, new Date().toISOString());
  assert.notEqual(workflowStepStartAuthorityBasis(f.store, changed), beforePolicyChange);
});
