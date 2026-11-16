import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowGraph } from "../../../packages/conversation-ui-core/src/workflow-graph-model.ts";
import type {
  WorkflowGraphInput,
  WorkflowGraphReadModel,
  WorkflowGraphStatus,
  WorkflowGraphStepInput,
} from "../../../packages/conversation-ui-core/src/workflow-graph-types.ts";
import { layoutWorkflowGraph, workflowGraphNarrowNodeSize, workflowGraphNodeSize } from "../src/features/workspace/workflow-graph/workflow-graph-layout.ts";
import { workflowGraphEdgeStates } from "../src/features/workspace/workflow-graph/workflow-graph-presentation.ts";

function step(id: string, status: string, dependencies: readonly string[] = []): WorkflowGraphStepInput {
  return { id, workflowId: "workflow", position: 1, title: id, status, metadata: { dependsOnStepIds: dependencies } };
}

function project(
  steps: readonly WorkflowGraphStepInput[],
  observation: WorkflowGraphInput["observation"] = "current",
): WorkflowGraphReadModel {
  return projectWorkflowGraph({ workflowId: "workflow", steps, observation });
}

function expectEdgeStates(
  model: WorkflowGraphReadModel,
  expected: readonly (readonly [source: string, target: string, status: WorkflowGraphStatus])[],
): void {
  const states: ReadonlyMap<string, WorkflowGraphStatus> = workflowGraphEdgeStates(model);
  const expectedStates = new Map(expected.map(([source, target, status]) => {
    const edge = model.edges.find(edge => edge.source === source && edge.target === target);
    assert.ok(edge, `Expected a projected edge from ${source} to ${target}`);
    return [edge.id, status] as const;
  }));
  assert.equal(expectedStates.size, model.edges.length, "every projected edge has an explicit expectation");
  assert.deepEqual(new Map(states), expectedStates,
    `${model.observation}: ${model.nodes.map(node => `${node.id}=${node.reportedStatus}`).join(", ")}`);
}

test("an empty accepted graph has no edge presentation states", () => {
  expectEdgeStates(project([]), []);
});

test("only the dependency-ready running branch has a running incoming edge", () => {
  const model = project([
    step("root", "succeeded"),
    step("active", "running", ["root"]),
    step("queued", "queued", ["root"]),
    step("gate", "queued"),
    step("unready", "running", ["root", "gate"]),
  ]);

  expectEdgeStates(model, [
    ["root", "active", "running"],
    ["root", "queued", "pending"],
    ["root", "unready", "pending"],
    ["gate", "unready", "pending"],
  ]);
  assert.equal(model.nodes.find(node => node.id === "unready")?.status, "running");
});

test("a running join waits for every dependency, including on edges from completed siblings", () => {
  const pending = project([
    step("left", "succeeded"),
    step("right", "running"),
    step("join", "running", ["left", "right"]),
  ]);
  expectEdgeStates(pending, [["left", "join", "pending"], ["right", "join", "pending"]]);

  const ready = project([
    step("left", "succeeded"),
    step("right", "succeeded"),
    step("join", "running", ["left", "right"]),
  ]);
  expectEdgeStates(ready, [["left", "join", "running"], ["right", "join", "running"]]);
});

const staticTargets: readonly (readonly [reportedStatus: string, projectedStatus: WorkflowGraphStatus])[] = [
  ["queued", "pending"],
  ["pending", "pending"],
  ["blocked", "blocked"],
  ["waiting", "waiting"],
  ["waiting_for_approval", "waiting"],
  ["waiting_for_input", "waiting"],
  ["failed", "failed"],
  ["cancelled", "cancelled"],
  ["succeeded", "succeeded"],
  ["skipped", "skipped"],
  ["completed", "unknown"],
];

for (const [reportedStatus, projectedStatus] of staticTargets) {
  test(`a ready ${reportedStatus} target keeps its static projected edge status`, () => {
    const model = project([step("source", "succeeded"), step("target", reportedStatus, ["source"])]);
    expectEdgeStates(model, [["source", "target", projectedStatus]]);
  });
}

test("unfinished predecessors cannot animate a running target or imply completed transfer", () => {
  for (const sourceStatus of ["queued", "pending", "running", "claimed", "waiting", "waiting_for_approval",
    "waiting_for_input", "blocked", "failed", "cancelled"]) {
    for (const targetStatus of ["running", "succeeded"]) {
      const model = project([step("source", sourceStatus), step("target", targetStatus, ["source"])]);
      expectEdgeStates(model, [["source", "target", "pending"]]);
    }
  }
});

test("skipped predecessors satisfy both branch and join dependencies without changing node statuses", () => {
  const model = project([
    step("root", "skipped"),
    step("left", "skipped", ["root"]),
    step("right", "succeeded", ["root"]),
    step("join", "running", ["left", "right"]),
  ]);
  expectEdgeStates(model, [
    ["root", "left", "skipped"],
    ["root", "right", "succeeded"],
    ["left", "join", "running"],
    ["right", "join", "running"],
  ]);
  assert.equal(model.nodes.find(node => node.id === "root")?.status, "skipped");
  assert.equal(model.nodes.find(node => node.id === "left")?.status, "skipped");
});

test("a fully completed branch and join graph has only static completion edges", () => {
  const model = project([
    step("root", "succeeded"),
    step("left", "succeeded", ["root"]),
    step("right", "skipped", ["root"]),
    step("join", "succeeded", ["left", "right"]),
  ]);
  expectEdgeStates(model, [
    ["root", "left", "succeeded"],
    ["root", "right", "skipped"],
    ["left", "join", "succeeded"],
    ["right", "join", "succeeded"],
  ]);
});

test("stale and unknown observations cannot animate or report completed edges", () => {
  for (const observation of ["stale", "unknown"] as const) {
    const model = project([
      step("root", "succeeded"),
      step("active", "running", ["root"]),
      step("done", "succeeded", ["root"]),
    ], observation);
    expectEdgeStates(model, [["root", "active", "unknown"], ["root", "done", "unknown"]]);
  }
});

test("unknown source or target projections keep the connecting edge unknown", () => {
  expectEdgeStates(project([
    step("source", "unrecognized"), step("target", "running", ["source"]),
  ]), [["source", "target", "unknown"]]);
  expectEdgeStates(project([
    step("source", "succeeded"), step("target", "unrecognized", ["source"]),
  ]), [["source", "target", "unknown"]]);
  expectEdgeStates(project([
    { ...step("source", "succeeded"), metadata: undefined }, step("target", "running", ["source"]),
  ]), [["source", "target", "unknown"]]);
});

test("an unknown sibling dependency prevents a valid completed source from animating a join", () => {
  const model = project([
    step("ready", "succeeded"),
    step("opaque", "unrecognized"),
    step("join", "running", ["ready", "opaque"]),
  ]);
  assert.equal(model.nodes.find(node => node.id === "join")?.status, "running");
  expectEdgeStates(model, [["ready", "join", "pending"], ["opaque", "join", "unknown"]]);
});

test("missing and invalid dependencies stay unknown without fabricating missing edges", () => {
  for (const dependencies of [["source", "missing"], ["source", "target"], ["source", "source"]]) {
    const model = project([step("source", "succeeded"), step("target", "running", dependencies)]);
    assert.equal(model.nodes.find(node => node.id === "target")?.status, "unknown");
    expectEdgeStates(model, [["source", "target", "unknown"]]);
  }
  expectEdgeStates(project([step("target", "running", ["missing"])]), []);
});

test("presentation reads a frozen projection without rewriting lifecycle or accepted structure", () => {
  const model = project([
    step("source", "succeeded"),
    step("active", "running", ["source"]),
    step("waiting", "waiting_for_approval", ["source"]),
  ]);
  const before = structuredClone(model);
  for (const node of model.nodes) {
    Object.freeze(node.dependencyIds);
    Object.freeze(node.missingDependencyIds);
    Object.freeze(node.issues);
    Object.freeze(node.factIds);
    Object.freeze(node.approvals);
    Object.freeze(node);
  }
  for (const edge of model.edges) Object.freeze(edge);
  Object.freeze(model.nodes);
  Object.freeze(model.edges);
  Object.freeze(model.overlay);
  Object.freeze(model);

  expectEdgeStates(model, [["source", "active", "running"], ["source", "waiting", "waiting"]]);
  layoutWorkflowGraph(model);
  assert.deepEqual(model, before);
});

test("single root and join nodes share the vertical centerline of two branch nodes", () => {
  const model = project([
    step("root", "succeeded"),
    step("left", "running", ["root"]),
    step("right", "queued", ["root"]),
    step("join", "queued", ["left", "right"]),
  ]);
  const positions = layoutWorkflowGraph(model);
  const position = (id: string) => {
    const value = positions.get(id);
    assert.ok(value, `Expected a layout position for ${id}`);
    return value;
  };
  const centerY = (id: string) => position(id).y + workflowGraphNodeSize.height / 2;
  const branchCenterY = (centerY("left") + centerY("right")) / 2;

  assert.equal(centerY("root"), branchCenterY);
  assert.equal(centerY("join"), branchCenterY);
  assert.ok(Math.min(centerY("left"), centerY("right")) < branchCenterY);
  assert.ok(Math.max(centerY("left"), centerY("right")) > branchCenterY);
  assert.equal(position("left").x, position("right").x);
  assert.ok(position("root").x < position("left").x);
  assert.ok(position("left").x < position("join").x);
});

test("status refreshes and unavailable observations leave every layout position unchanged", () => {
  const steps = [
    step("root", "queued"),
    step("left", "queued", ["root"]),
    step("right", "queued", ["root"]),
    step("join", "queued", ["left", "right"]),
  ];
  const positions = layoutWorkflowGraph(project(steps));
  const updates: readonly Readonly<Record<string, string>>[] = [
    { root: "succeeded", left: "running", right: "queued", join: "queued" },
    { root: "succeeded", left: "succeeded", right: "running", join: "queued" },
    { root: "succeeded", left: "succeeded", right: "skipped", join: "running" },
    { root: "succeeded", left: "succeeded", right: "skipped", join: "succeeded" },
    { root: "succeeded", left: "failed", right: "cancelled", join: "cancelled" },
  ];
  for (const statuses of updates) {
    for (const observation of ["current", "stale", "unknown"] as const) {
      const refreshed = project(steps.map(step => ({ ...step, status: statuses[step.id] })).reverse(), observation);
      assert.deepEqual(layoutWorkflowGraph(refreshed), positions);
    }
  }
});

test("narrow graphs flow downwards with centered root and join and separated sibling nodes", () => {
  const model = project([
    step("root", "succeeded"),
    step("left", "running", ["root"]),
    step("right", "running", ["root"]),
    step("join", "queued", ["left", "right"]),
  ]);
  const positions = layoutWorkflowGraph(model, true);
  const root = positions.get("root")!, left = positions.get("left")!;
  const right = positions.get("right")!, join = positions.get("join")!;

  assert.equal(root.x, join.x);
  assert.equal(root.x, (left.x + right.x) / 2);
  assert.equal(left.y, right.y);
  assert.ok(root.y + workflowGraphNarrowNodeSize.height < left.y);
  assert.ok(left.y + workflowGraphNarrowNodeSize.height < join.y);
  assert.ok(left.x + workflowGraphNarrowNodeSize.width < right.x);
  assert.deepEqual(layoutWorkflowGraph({ ...model, observation: "stale" }, true), positions);
});
