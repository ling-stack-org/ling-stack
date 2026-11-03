import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowGraph } from "../../../packages/conversation-ui-core/src/workflow-graph-model.ts";
import { layoutWorkflowGraph, workflowGraphNodeSize } from "../src/features/workspace/workflow-graph/workflow-graph-layout.ts";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { workflow, steps, progressInput } from "./support/workflow-isolation-evidence-fixture.mjs";

const { buildWorkflowProgressModel, workflowProgressToConversationWorkCell } = await import("../src/lib/workflow-progress.ts");

async function fixture(t, overrides = {}, { stepStatus = "failed" } = {}) {
  let mount;
  const invoke = () => undefined;
  const h = await catalogConsumerHarness(t, {
    exports: { "features/workspace/ChannelMessageRenderers.tsx": ["createChannelMessageRenderers"],
      "features/workspace/workflow-graph/WorkflowGraphDetail.tsx": ["WorkflowGraphDetail"],
      "shared/conversation/timeline/ConversationTimelineProtocolRenderer.tsx": ["ConversationTimelineProtocolRenderer"] },
    ports: { mount: input => { mount = input; return { node: null }; } },
    transforms: { "features/workspace/ChannelMessageRenderers.tsx": [
      { anchor: "return mountConversationTimeline({", replace: key => `return globalThis[${JSON.stringify(key)}].ports.mount({` },
    ] },
  });
  const owner = workflow({ status: "failed" });
  const tasks = steps(owner).map((step, index) => ({ ...step, status: index ? "cancelled" : stepStatus,
    metadata: { dependsOnStepIds: index ? ["step-1"] : [] } }));
  const progress = buildWorkflowProgressModel(progressInput({ workflow: owner, steps: tasks }));
  const input = { cwd: "/qa", workspaceId: owner.workspaceId, selectedChannelId: owner.channelId, selectedChannelThreadId: "thread-qa",
    allLocalTeammateById: new Map(), composerGateApprovals: [], channelConversationItems: [], channelReasoningSummaries: [],
    channelContextCompactions: [], channelUserInputs: [], channelWorkflows: [owner], terminalReports: [], workflowErrors: {},
    auditActivityVisible: false, conversationWorkCellByThreadId: new Map(), runLifecycles: [], contextSegmentIdByItemId: new Map(),
    workflowProgressByWorkflowId: new Map([[owner.id, progress]]),
    conversationWorkCellByWorkflowId: new Map([[owner.id, workflowProgressToConversationWorkCell(progress)]]),
    daemonHealthy: true, workflowObservationReady: true, onInvokeProtocolAction: invoke, t: h.state.t, ...overrides };
  h.module.createChannelMessageRenderers(input).renderUnifiedTimeline([{ kind: "activity", item: { id: `workflow:${owner.id}`,
    kind: "workflow", record: owner, createdAt: owner.updatedAt, category: "runtime", attention: "none", searchText: "" } }]);
  const item = mount.snapshot.items.find(item => item.protocolKind === "workflow");
  return { ...h, input, owner, tasks, item, mount, detail: mount.renderProtocolDetail(item) };
}

test("the actual channel renderer keeps a graph entrance beside terminal execution facts and existing actions", async t => {
  const f = await fixture(t);
  assert.ok(f.mount.snapshot.items.some(item => item.kind === "subAgentActivity"));
  assert.equal(f.detail.type, f.module.WorkflowGraphDetail);
  assert.equal(f.detail.props.steps, f.input.workflowProgressByWorkflowId.get(f.owner.id).steps);
  assert.equal(f.detail.props.timelineItems.some(item => item.kind === "subAgentActivity"), true);
  assert.equal(f.detail.props.onInvokeProtocolAction, f.input.onInvokeProtocolAction);
  assert.equal(f.detail.props.observationReady, true);
  assert.equal(f.mount.renderProtocolDetail({ protocolKind: "workflow-step", sourceRefs: [] }), null);
  assert.equal(f.mount.renderProtocolDetail({ protocolKind: "workflow", sourceRefs: [{ kind: "channel_workflow", id: "foreign" }] }), null);
  const html = f.render(f.module.ConversationTimelineProtocolRenderer, { item: f.item, depth: 0,
    renderProtocolDetail: f.mount.renderProtocolDetail, onInvokeProtocolAction: f.input.onInvokeProtocolAction });
  assert.match(html, /data-workflow-graph="workflow-qa"/u);
  assert.match(html, /data-workflow-view="list"/u);
  assert.match(html, /aria-label="Workflow view"/u);
  assert.match(html, /data-workflow-step-id="step-1"/u);
  assert.doesNotMatch(html, />Retry</u, "failed is not retryable under the existing step policy");
  assert.match(html, /Participant 1/u);
});

test("step detail reuses the existing P3 busy/error action gating and durable source identity", async t => {
  const f = await fixture(t, { runningWorkflowStepId: "step-1", workflowErrors: { "step-1": "Retry was rejected" } }, { stepStatus: "blocked" });
  const stepItem = f.detail.props.stepProtocolItems.get("step-1");
  assert.equal(stepItem.availableActions.includes("retry_step"), false);
  assert.match(stepItem.description, /Retry was rejected/u);
  assert.ok(stepItem.sourceRefs.some(ref => ref.kind === "channel_workflow-step" && ref.id === "step-1"));
  const html = f.render(f.module.WorkflowGraphDetail, f.detail.props);
  assert.doesNotMatch(html, />Retry</u);
  assert.match(html, /data-selected-step-id="step-1"/u);
  const ready = await fixture(t, {}, { stepStatus: "blocked" });
  assert.ok(ready.detail.props.stepProtocolItems.get("step-1").availableActions.includes("retry_step"));
  assert.match(ready.render(ready.module.WorkflowGraphDetail, ready.detail.props), />Retry</u);
});

test("stale and unknown observations never render a succeeded node while retaining the reported lifecycle", async t => {
  const f = await fixture(t);
  const tasks = f.tasks.map(step => ({ ...step, status: "succeeded" }));
  for (const ready of [false, undefined]) {
    const html = f.render(f.module.WorkflowGraphDetail, { ...f.detail.props, steps: tasks, observationReady: ready });
    assert.match(html, /data-observation="(?:stale|unknown)"/u);
    assert.match(html, /data-status="unknown"/u);
    assert.match(html, /Last observed/u);
  }
});

test("keyboard-focusable graph nodes announce their actual projected status", async t => {
  const h = await catalogConsumerHarness(t, {
    exports: { "features/workspace/workflow-graph/WorkflowGraphCanvas.tsx": ["default as WorkflowGraphCanvas"] },
  });
  const labels = { queued: "Pending", running: "Working", waiting_for_approval: "Waiting", blocked: "Blocked",
    failed: "Failed", cancelled: "Cancelled", succeeded: "Succeeded", skipped: "Skipped", nonsense: "Unknown" };
  const model = projectWorkflowGraph({ workflowId: "one", observation: "current", steps: Object.keys(labels).map(status => ({
    id: `step-${status}`, workflowId: "one", title: `step-${status}`, position: 1, status, metadata: { dependsOnStepIds: [] },
  })) });
  const html = h.render(h.module.WorkflowGraphCanvas, { model, onSelect: () => {} });
  for (const [status, label] of Object.entries(labels)) {
    assert.match(html, new RegExp(`aria-label="step-${status} [^"]* ${label}"`, "u"));
  }
});

test("layout is finite, stable and non-overlapping for a bounded branch/join graph and cyclic unknowns", () => {
  const step = (id, dependencies = []) => ({ id, workflowId: "one", title: id, position: 1, status: "queued", metadata: { dependsOnStepIds: dependencies } });
  const model = projectWorkflowGraph({ workflowId: "one", observation: "current", steps: [step("root"), step("left", ["root"]),
    step("right", ["root"]), step("join", ["left", "right"]), step("cycle-a", ["cycle-b"]), step("cycle-b", ["cycle-a"])] });
  const positions = layoutWorkflowGraph(model);
  assert.deepEqual(layoutWorkflowGraph(structuredClone(model)), positions);
  assert.ok(positions.get("join").x > positions.get("left").x);
  assert.ok(positions.get("left").x > positions.get("root").x);
  const all = [...positions.values()];
  for (let i = 0; i < all.length; i++) {
    assert.ok(Number.isFinite(all[i].x) && Number.isFinite(all[i].y));
    for (let j = i + 1; j < all.length; j++) assert.ok(Math.abs(all[i].x - all[j].x) >= workflowGraphNodeSize.width
      || Math.abs(all[i].y - all[j].y) >= workflowGraphNodeSize.height);
  }
});
