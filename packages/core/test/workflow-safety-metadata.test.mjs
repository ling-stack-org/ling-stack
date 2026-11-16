import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSqliteRunStore,
  parseWorkflowStepExecutionSafety,
  workflowStepSafetyPlanDigest,
  WorkflowSafetyValidationError,
} from "../dist/index.js";
import { createSqliteRunStoreFixture } from "./support/sqlite-run-store-fixture.mjs";
import { parseWorkflowStepExecutionSafety as parseContractSafety, workflowGraphFingerprintV1 } from "@ling-stack/contracts";

const now = "2026-11-02T00:00:00.000Z";
const safety = {
  sideEffectClass: "analysis_readonly",
  parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: ["port:2", "port:1"],
    requiresArtifactOnly: true, cancelSiblingsOnFailure: true },
};
const invalidSafety = [
  { sideEffectClass: "unknown", parallelPolicy: { autoParallel: true } },
  { parallelPolicy: { autoParallel: true } },
  { sideEffectClass: "analysis_readonly", parallelPolicy: null },
  { sideEffectClass: "analysis_readonly", parallelPolicy: { autoParallel: "true" } },
  { sideEffectClass: "analysis_readonly", parallelPolicy: { autoParallel: true, maxParallelSiblings: 0 } },
  { sideEffectClass: "analysis_readonly", parallelPolicy: { autoParallel: true, resourceKeys: ["port:1", "port:1"] } },
  { sideEffectClass: "analysis_readonly", parallelPolicy: { autoParallel: true, resourceKeys: [""] } },
  { sideEffectClass: "analysis_readonly", parallelPolicy: { autoParallel: true, resourceKeys: Array.from({ length: 33 }, (_, i) => `port:${i}`) } },
  { sideEffectClass: "test_artifact_only", parallelPolicy: { autoParallel: true } },
  { sideEffectClass: "external_mutation", parallelPolicy: { autoParallel: true } },
  { sideEffectClass: "release", parallelPolicy: { autoParallel: true } },
];
const validationError = (error) => error instanceof WorkflowSafetyValidationError && error.code === "workflow_safety_invalid";

function graph(nodeSafety = safety) {
  return { schemaVersion: 1, id: "safety-graph", name: "Safety graph", entryNodeId: "review",
    nodes: [{ id: "review", kind: "step", name: "Review", prompt: "Read evidence", ...nodeSafety }], edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "fail_workflow", onApprovalDenied: "block_for_user" } };
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-workflow-safety-"));
  const f = { cwd, store: createSqliteRunStoreFixture(cwd) };
  t.after(async () => {
    try { f.store.close(); } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  f.channel = f.store.createChannel({ name: "Safety", boundPath: cwd }, now);
  f.input = { channelId: f.channel.id, title: "Safety workflow", objective: "Preserve declarations", createdBy: "local-user" };
  f.workflow = f.store.createChannelWorkflow(f.input, now);
  f.stepInput = { workflowId: f.workflow.id, title: "Review", prompt: "Read evidence",
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer" };
  f.reopen = () => { f.store.close(); f.store = createSqliteRunStore(cwd); };
  return f;
}

test("Core re-exports the canonical parser instead of implementing a second contract", () => {
  assert.equal(parseWorkflowStepExecutionSafety, parseContractSafety);
});

test("safety metadata and graph snapshots survive create, update, JSON DTO and SQLite reopen", async (t) => {
  const f = await fixture(t);
  const workflowGraph = graph();
  const metadata = { workflowGraph, workflowGraphFingerprint: workflowGraphFingerprintV1(workflowGraph), maxParallelSteps: 2 };
  const workflow = f.store.createChannelWorkflow({ ...f.input, metadata }, now);
  const stepMetadata = { ...safety, graphId: workflowGraph.id, graphNodeId: "review", templateStepId: "review", skillId: "review" };
  const step = f.store.createChannelWorkflowStep({ ...f.stepInput, workflowId: workflow.id, metadata: stepMetadata }, now);
  assert.deepEqual(workflow.metadata, metadata);
  assert.deepEqual(step.metadata, stepMetadata);
  assert.deepEqual(JSON.parse(JSON.stringify(step)).metadata, stepMetadata);
  f.reopen();
  assert.deepEqual(f.store.getChannelWorkflow(workflow.id).metadata, metadata);
  assert.deepEqual(f.store.getChannelWorkflowStep(step.id).metadata, stepMetadata);

  const updatedSafety = { sideEffectClass: "test_artifact_only", parallelPolicy: { autoParallel: true, requiresArtifactOnly: true,
    maxParallelSiblings: 1, resourceKeys: ["scratch:attempt"], cancelSiblingsOnFailure: false } };
  const updatedGraph = graph(updatedSafety);
  const updatedMetadata = { workflowGraph: updatedGraph, workflowGraphFingerprint: workflowGraphFingerprintV1(updatedGraph) };
  assert.deepEqual(f.store.updateChannelWorkflow(workflow.id, { metadata: updatedMetadata }, now).metadata, updatedMetadata);
  assert.deepEqual(f.store.updateChannelWorkflowStep(step.id, { metadata: updatedSafety }, now).metadata, updatedSafety);
  f.reopen();
  assert.deepEqual(f.store.getChannelWorkflowStep(step.id).metadata, updatedSafety);
  assert.deepEqual(f.store.getChannelWorkflow(workflow.id).metadata, updatedMetadata);
});

test("legacy metadata remains readable and unclassified despite review/test names or legacy limits", async (t) => {
  const f = await fixture(t);
  const legacy = { skillId: "test-review", workflowTemplateId: "autoplan-lite", templateStepId: "qa", maxParallelSiblings: 2, autoStart: true };
  const step = f.store.createChannelWorkflowStep({ ...f.stepInput, metadata: legacy }, now);
  const absent = f.store.createChannelWorkflowStep(f.stepInput, now);
  const workflow = f.store.createChannelWorkflow({ ...f.input, metadata: { workflowGraph: graph({}) } }, now);
  f.reopen();
  assert.deepEqual(f.store.getChannelWorkflowStep(step.id).metadata, legacy);
  assert.equal(parseContractSafety(f.store.getChannelWorkflowStep(step.id).metadata), undefined);
  assert.equal(parseContractSafety(f.store.getChannelWorkflowStep(absent.id).metadata), undefined);
  assert.equal(parseContractSafety(f.store.getChannelWorkflow(workflow.id).metadata.workflowGraph.nodes[0]), undefined);
});

test("Host safety plans survive reopen and malformed persisted plans fail closed", async (t) => {
  const f = await fixture(t);
  const step = f.store.createChannelWorkflowStep({ ...f.stepInput, metadata: safety }, now);
  const plan = {
    schemaVersion: 1, profile: "pi_host_readonly_v1", workflowId: f.workflow.id, workflowStepId: step.id,
    workspaceRoot: f.cwd, executionRoot: f.cwd, safety, tools: ["read", "grep", "find", "ls"],
    runnerId: "pi", networkAccess: false, writeRoots: [],
  };
  const safetyPlan = { ...plan, digest: workflowStepSafetyPlanDigest(plan) };
  const metadata = { ...safety, safetyPlan };
  f.store.updateChannelWorkflowStep(step.id, { metadata }, now);
  f.reopen();
  assert.deepEqual(f.store.getChannelWorkflowStep(step.id).metadata, metadata);
  for (const invalid of [null, {}, { ...safetyPlan, digest: "tampered" },
    { ...safetyPlan, executionRoot: `${f.cwd}/different` },
    { ...safetyPlan, tools: [...safetyPlan.tools, "bash"] }]) {
    assert.throws(() => f.store.updateChannelWorkflowStep(step.id,
      { metadata: { ...safety, safetyPlan: invalid } }, now), validationError);
    f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...safety, safetyPlan: invalid }), step.id);
    f.reopen();
    assert.throws(() => f.store.getChannelWorkflowStep(step.id), validationError);
    assert.throws(() => f.store.listChannelWorkflowSteps({ workflowId: f.workflow.id, complete: true }), validationError);
  }
});

test("missing autoParallel is explicitly false on disk, after reopen and in historical graph nodes", async (t) => {
  const f = await fixture(t);
  const request = { sideEffectClass: "analysis_readonly", parallelPolicy: { resourceKeys: [] } };
  const expected = { ...request, parallelPolicy: { autoParallel: false, resourceKeys: [] } };
  const step = f.store.createChannelWorkflowStep({ ...f.stepInput, metadata: request }, now);
  const workflow = f.store.createChannelWorkflow({ ...f.input, metadata: { workflowGraph: graph(request) } }, now);
  const row = f.store.database.prepare("SELECT metadata_json FROM channel_workflow_steps WHERE id = ?").get(step.id);
  assert.equal(JSON.parse(row.metadata_json).parallelPolicy.autoParallel, false);
  assert.deepEqual(request.parallelPolicy, { resourceKeys: [] });
  f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?").run(JSON.stringify(request), step.id);
  f.store.database.prepare("UPDATE channel_workflows SET metadata_json = ? WHERE id = ?").run(JSON.stringify({ workflowGraph: graph(request) }), workflow.id);
  f.reopen();
  assert.deepEqual(f.store.getChannelWorkflowStep(step.id).metadata, expected);
  assert.deepEqual(parseContractSafety(f.store.getChannelWorkflow(workflow.id).metadata.workflowGraph.nodes[0]), expected);
});

test("invalid safety is rejected before step or graph insert/update and leaves previous metadata intact", async (t) => {
  const f = await fixture(t);
  const step = f.store.createChannelWorkflowStep({ ...f.stepInput, metadata: safety }, now);
  const stepCount = () => f.store.listChannelWorkflowSteps({ workflowId: f.workflow.id, complete: true }).length;
  const workflowCount = () => f.store.listChannelWorkflows({ channelId: f.channel.id }).length;
  for (const invalid of invalidSafety) {
    assert.throws(() => f.store.createChannelWorkflowStep({ ...f.stepInput, metadata: invalid }, now), validationError);
    assert.throws(() => f.store.updateChannelWorkflowStep(step.id, { metadata: invalid }, now), validationError);
    assert.throws(() => f.store.createChannelWorkflow({ ...f.input, metadata: { workflowGraph: graph(invalid) } }, now), validationError);
    assert.throws(() => f.store.updateChannelWorkflow(f.workflow.id, { metadata: { workflowGraph: graph(invalid) } }, now), validationError);
    assert.equal(stepCount(), 1);
    assert.equal(workflowCount(), 1);
    assert.deepEqual(f.store.getChannelWorkflowStep(step.id).metadata, safety);
    assert.equal(f.store.getChannelWorkflow(f.workflow.id).metadata, undefined);
  }
});

test("corrupt persisted safety fails closed across reopen rather than being repaired into a safe declaration", async (t) => {
  const f = await fixture(t);
  const step = f.store.createChannelWorkflowStep({ ...f.stepInput, metadata: safety }, now);
  for (const invalid of invalidSafety) {
    f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?").run(JSON.stringify(invalid), step.id);
    f.store.database.prepare("UPDATE channel_workflows SET metadata_json = ? WHERE id = ?").run(JSON.stringify({ workflowGraph: graph(invalid) }), f.workflow.id);
    f.reopen();
    assert.throws(() => f.store.getChannelWorkflowStep(step.id), validationError);
    assert.throws(() => f.store.listChannelWorkflowSteps({ workflowId: f.workflow.id, complete: true }), validationError);
    assert.throws(() => f.store.getChannelWorkflow(f.workflow.id), validationError);
  }
  for (const brokenJson of ["{not json", "null", "[]"]) {
    f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?").run(brokenJson, step.id);
    assert.equal(f.store.getChannelWorkflowStep(step.id).metadata, undefined);
  }
});
