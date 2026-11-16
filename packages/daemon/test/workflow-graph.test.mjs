import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { b013OwnedStore, b013FactCounts, b013ParticipantId } from "../../core/test/support/b013-pre-gate-fixture.mjs";
import { projectWorkflowGraph } from "../../conversation-ui-core/src/workflow-graph-model.ts";
import { compileWorkflowGraph } from "../dist/features/channels/workflow-graph.js";
import { projectWorkflowStepNarration } from "../dist/features/channels/workflow-step-narration.js";

const now = "2026-11-03T00:00:00.000Z";
const edge = (fromNodeId, toNodeId) => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId,
  condition: { kind: "all_succeeded" } });
const graph = (fork = false) => ({ schemaVersion: 1, id: "root-dependencies", name: "Prepare workflow", entryNodeId: "prepare",
  nodes: (fork ? ["join", "right", "prepare", "left"] : ["prepare"]).map(id => ({ id, kind: id === "join" ? "join" : "step",
    name: id === "prepare" ? "Architect" : id, prompt: `Read evidence for ${id}`,
    teammateId: id === "prepare" ? "teammate_builtin_architect" : b013ParticipantId })),
  edges: fork ? [edge("prepare", "left"), edge("prepare", "right"), edge("left", "join"), edge("right", "join")] : [],
  termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } });

for (const fork of [false, true]) test(`compiled ${fork ? "fork/fan-in" : "single-entry"} roots project succeeded after SQLite reload`, async t => {
  const f = await b013OwnedStore(t), definition = graph(fork);
  const compiled = compileWorkflowGraph(f.store, { channelId: f.channel.id, workflowGraph: definition,
    objective: "Read the accepted workflow evidence" }, now);
  const root = compiled.workflowSteps.find(step => step.metadata.graphNodeId === "prepare");
  f.store.updateChannelWorkflowStep(root.id, { status: "succeeded", resultSummary: "Preparation complete" }, now);
  const steps = f.store.listChannelWorkflowSteps({ workflowId: compiled.workflow.id, complete: true });
  const model = projectWorkflowGraph({ workflowId: compiled.workflow.id,
    steps: steps.map(step => projectWorkflowStepNarration(f.store, step)), observation: "current" });
  const node = model.nodes.find(node => node.id === root.id);
  assert.equal(node.reportedStatus, "succeeded");
  assert.equal(node.status, "succeeded");
  assert.deepEqual(node.issues, []);
  assert.deepEqual(root.metadata.dependsOnStepIds, []);
  const byNodeId = new Map(steps.map(step => [step.metadata.graphNodeId, step]));
  for (const step of steps) {
    assert.deepEqual(step.metadata, compiled.workflowSteps.find(compiled => compiled.id === step.id).metadata);
    assert.deepEqual(step.metadata.dependsOnStepIds,
      definition.edges.filter(edge => edge.toNodeId === step.metadata.graphNodeId).map(edge => byNodeId.get(edge.fromNodeId).id));
  }
  assert.deepEqual(model.edges.map(({ source, target }) => [source, target]).sort(),
    definition.edges.map(edge => [byNodeId.get(edge.fromNodeId).id, byNodeId.get(edge.toNodeId).id]).sort());
  assert.equal(node.branches, fork);
  if (fork) assert.equal(model.nodes.find(node => node.id === byNodeId.get("join").id).joins, true);
  const jsonReload = projectWorkflowGraph({ workflowId: compiled.workflow.id, steps: JSON.parse(JSON.stringify(steps)), observation: "current" });
  assert.deepEqual(jsonReload, model);
  f.store.close();
  const reopened = createSqliteRunStore(f.cwd, f.paths);
  try {
    assert.deepEqual(projectWorkflowGraph({ workflowId: compiled.workflow.id,
      steps: reopened.listChannelWorkflowSteps({ workflowId: compiled.workflow.id, complete: true }), observation: "current" }), model);
  } finally { reopened.close(); }
});

test("daemon step projection uses current persisted metadata ahead of a stale caller snapshot", async t => {
  const f = await b013OwnedStore(t);
  const compiled = compileWorkflowGraph(f.store, { channelId: f.channel.id, workflowGraph: graph(),
    objective: "Read the current accepted step" }, now);
  const [root] = compiled.workflowSteps;
  const current = f.store.updateChannelWorkflowStep(root.id, { status: "succeeded" }, now);
  const projected = projectWorkflowStepNarration(f.store, { ...root, status: "running",
    metadata: { ...root.metadata, dependsOnStepIds: ["stale-dependency"] } });
  assert.deepEqual(projected.metadata, current.metadata);
  assert.deepEqual(projected.metadata.dependsOnStepIds, []);
  assert.equal(projected.status, "succeeded");
  assert.equal(projectWorkflowGraph({ workflowId: compiled.workflow.id, steps: [projected], observation: "current" }).nodes[0].status, "succeeded");
});

test("graph dependency validation rejects cycles and missing endpoints before persisting steps", async t => {
  const f = await b013OwnedStore(t), before = b013FactCounts(f.store);
  for (const [extra, code] of [[edge("join", "prepare"), "workflow_graph_cycle"],
    [edge("missing", "left"), "workflow_graph_invalid"]]) {
    const definition = graph(true);
    definition.edges.push(extra);
    assert.throws(() => compileWorkflowGraph(f.store, { channelId: f.channel.id, workflowGraph: definition,
      objective: "Reject invalid dependencies" }, now), { code });
    assert.deepEqual(b013FactCounts(f.store), before);
  }
});
