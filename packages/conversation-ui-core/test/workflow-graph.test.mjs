import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowGraph, reconcileWorkflowGraphSelection, workflowGraphLimits } from "../src/workflow-graph-model.ts";

const step = (id, deps = [], extra = {}) => ({ id, workflowId: "workflow", position: 1, title: id, status: "queued", metadata: { dependsOnStepIds: deps }, ...extra });
const project = (steps, extra = {}) => projectWorkflowGraph({ workflowId: "workflow", steps, observation: "current", ...extra });

test("accepted step ids and dependencies produce real branches and fan-in, not positional edges", () => {
  const model = project([step("join", ["left", "right"], { position: 0, metadata: { dependsOnStepIds: ["left", "right"], joinGroupId: "results" } }),
    step("root", [], { position: 5 }), step("left", ["root"]), step("right", ["root"]), step("independent")]);
  assert.deepEqual(model.edges.map(({ source, target }) => [source, target]), [["left", "join"], ["right", "join"], ["root", "left"], ["root", "right"]]);
  assert.equal(model.nodes.find(node => node.id === "join").joins, true);
  assert.equal(model.nodes.find(node => node.id === "join").joinGroupId, "results");
  assert.equal(model.nodes.find(node => node.id === "root").branches, true);
  assert.equal(model.edges.some(edge => edge.source === "independent" || edge.target === "independent"), false);
});

test("missing metadata/dependencies, duplicates, cycles and invalid dependencies stay explicitly unknown", () => {
  const model = project([step("missing", ["gone"], { status: "succeeded" }), step("legacy", [], { metadata: undefined }),
    step("a", ["b"]), step("b", ["a"]), step("child", ["a"]), step("duplicate"), step("duplicate"), step("bad", ["bad", "", 7])]);
  for (const id of ["missing", "legacy", "a", "b", "duplicate", "bad"]) assert.equal(model.nodes.find(node => node.id === id).status, "unknown");
  assert.deepEqual(model.nodes.find(node => node.id === "missing").missingDependencyIds, ["gone"]);
  assert.equal(model.nodes.find(node => node.id === "child").issues.includes("cycle"), false);
  assert.equal(model.nodes.filter(node => node.id === "duplicate").length, 1);
  assert.equal(model.edges.some(edge => edge.source === "gone" || edge.source === "bad"), false);
});

test("store lifecycle remains distinct, including cancelled, skipped and absent results", () => {
  const statuses = ["running", "claimed", "blocked", "cancelled", "succeeded", "skipped", "failed", "waiting_for_input", "waiting_for_approval", "nonsense"];
  assert.deepEqual(project(statuses.map(status => step(status, [], { status }))).nodes.map(node => [node.reportedStatus, node.status]),
    [...statuses].sort().map(status => [status, ({ claimed: "running", waiting_for_input: "waiting", waiting_for_approval: "waiting", nonsense: "unknown" })[status] ?? status]));
  for (const observation of ["stale", "unknown"]) {
    const node = project([step("done", [], { status: "succeeded" })], { observation }).nodes[0];
    assert.equal(node.status, "unknown"); assert.equal(node.reportedStatus, "succeeded");
    assert(node.issues.includes("observation_unavailable"));
  }
});

test("dynamic collaboration is a scoped read-only overlay and never edits the accepted graph", () => {
  const steps = [step("one", [], { runId: "run-one" })];
  const fact = { id: "delegation", kind: "collabAgentToolCall", workflowStepId: "one", title: "Ask reviewer", toolName: "delegate", status: "running" };
  const before = project(steps), after = project(steps, { timelineItems: [fact, { ...fact, id: "foreign", workflowStepId: "other", runId: "run-one" }] });
  assert.deepEqual(after.edges, before.edges);
  assert.deepEqual(after.nodes.map(node => node.id), before.nodes.map(node => node.id));
  assert.deepEqual(after.overlay, [{ id: "overlay:delegation", factId: "delegation", stepId: "one", title: "Ask reviewer", status: "running" }]);
  assert.deepEqual(after.nodes[0].factIds, ["delegation"]);
});

test("approval facts retain their original identity and explicit null/foreign scope cannot inherit run ownership", () => {
  const approval = { id: "approval:one", kind: "approval", workflowStepId: "one", approvalId: "original", availableActions: ["open_approval"] };
  const facts = [approval, { ...approval, id: "approval:null", workflowStepId: null, runId: "run-one" },
    { ...approval, id: "approval:foreign", workflowStepId: "foreign", runId: "run-one" },
    { id: "nested", kind: "subAgentActivity", workflowStepId: "one", childItems: [
      { id: "null-overlay", kind: "collabAgentToolCall", workflowStepId: null, toolName: "delegate" },
      { id: "nested-fact", kind: "toolCall", title: "Observed read" },
    ] }];
  const model = project([step("one", [], { runId: "run-one" })], { timelineItems: facts });
  assert.deepEqual(model.nodes[0].factIds, ["approval:one", "nested", "nested-fact"]);
  assert.equal(model.nodes[0].approvals[0], approval);
  assert.equal(model.overlay.length, 0);
});

test("reload and SSE refresh converge with stable selection, edge ids and no sticky optimistic status", () => {
  const pending = [step("one"), step("two", ["one"])];
  const refreshed = pending.map(step => ({ ...step, status: "cancelled" }));
  const sse = project(refreshed), reload = project(JSON.parse(JSON.stringify(refreshed)).reverse());
  assert.deepEqual(sse, reload);
  assert.deepEqual(sse.edges, project(pending).edges);
  assert.equal(reconcileWorkflowGraphSelection(sse, "two"), "two");
  assert.equal(reconcileWorkflowGraphSelection(sse, "gone"), "one");
  assert.equal(reconcileWorkflowGraphSelection(project([]), "one"), undefined);
});

test("bounded graphs filter and sort before truncation so refreshes preserve nodes and selection", () => {
  const steps = Array.from({ length: workflowGraphLimits.steps + 1 }, (_, index) =>
    step(`step-${index}`, index ? [`step-${index - 1}`] : [], { position: index }));
  const model = project(steps);
  assert.deepEqual(project([...steps].reverse()), model);
  assert.equal(reconcileWorkflowGraphSelection(model, "step-0"), "step-0");
  assert.equal(model.nodes.find(node => node.id === "step-1").status, "pending");
  assert.equal(model.omittedStepCount, 1);
  const foreign = steps.map(step => ({ ...step, workflowId: "foreign" }));
  assert.deepEqual(project([...foreign, ...steps].reverse()), model);
});

test("step/dependency/fact/text bounds are explicit and do not fabricate omitted nodes", () => {
  const steps = Array.from({ length: 300 }, (_, n) => step(`step-${n}`, [], { title: "x".repeat(10_000), position: n }));
  steps[0].metadata.dependsOnStepIds = Array.from({ length: 300 }, (_, n) => `step-${n + 1}`);
  const model = project(steps);
  assert.equal(model.nodes.length, workflowGraphLimits.steps);
  assert.equal(model.omittedStepCount, 172);
  assert.equal(model.nodes[0].title.length, workflowGraphLimits.text);
  assert(model.nodes[0].issues.includes("truncated"));
  assert(model.nodes[0].missingDependencyIds.includes("step-128"));
  const facts = Array.from({ length: 3000 }, (_, n) => ({ kind: "collabAgentToolCall", id: `fact-${n}`, workflowStepId: "step-0", title: "Delegate", toolName: "delegate" }));
  const bounded = project(steps, { timelineItems: facts });
  assert.equal(bounded.overlay.length, workflowGraphLimits.overlay);
  assert.equal(bounded.factsTruncated, true);
  assert.equal(project([step("foreign", [], { workflowId: "other" })]).nodes.length, 0);
});
