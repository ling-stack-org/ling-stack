import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowGraph } from "../../../packages/conversation-ui-core/src/workflow-graph-model.ts";
import { layoutWorkflowGraph, workflowGraphNodeSize } from "../src/features/workspace/workflow-graph/workflow-graph-layout.ts";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { workflow, steps, progressInput } from "./support/workflow-isolation-evidence-fixture.mjs";

const { buildWorkflowProgressModel, workflowProgressToConversationWorkCell } = await import("../src/lib/workflow-progress.ts");

async function fixture(t, overrides = {}, { stepStatus = "failed", ownerStatus = "failed", transformSteps = tasks => tasks, expandRows = false } = {}) {
  let mount;
  let selected;
  const invoke = () => undefined;
  const h = await catalogConsumerHarness(t, {
    exports: { "features/workspace/ChannelMessageRenderers.tsx": ["createChannelMessageRenderers"],
      "features/workspace/workflow-graph/WorkflowGraphDetail.tsx": ["WorkflowGraphDetail"],
      "shared/conversation/timeline/ConversationTimelineProtocolRenderer.tsx": ["ConversationTimelineProtocolRenderer"] },
    ports: { mount: input => { mount = input; return { node: null }; }, selection: () => [selected, value => { selected = value; }] },
    transforms: { "features/workspace/ChannelMessageRenderers.tsx": [
      { anchor: "return mountConversationRunFeedbackTimeline({", replace: key => `return globalThis[${JSON.stringify(key)}].ports.mount({` },
    ], "features/workspace/workflow-graph/WorkflowGraphDetail.tsx": [
      { anchor: "const [selected, setSelected] = useState<string>();", replace: key => `const [selected, setSelected] = globalThis[${JSON.stringify(key)}].ports.selection();` },
    ], ...(expandRows ? { "shared/conversation/timeline/TimelineFactRow.tsx": [
      { anchor: "const expanded = hasDetail && disclosure.expanded;", replace: () => "const expanded = true;" },
    ] } : {}) },
  });
  const owner = workflow({ status: ownerStatus });
  const tasks = transformSteps(steps(owner).map((step, index) => ({ ...step, status: index ? "cancelled" : stepStatus,
    metadata: { dependsOnStepIds: index ? ["step-1"] : [] } })));
  const progress = buildWorkflowProgressModel(progressInput({ workflow: owner, steps: tasks }));
  const input = { cwd: "/qa", workspaceId: owner.workspaceId, selectedChannelId: owner.channelId, selectedChannelThreadId: "thread-qa",
    allLocalTeammateById: new Map(), composerGateApprovals: [], channelConversationItems: [], channelReasoningSummaries: [],
    channelContextCompactions: [], channelUserInputs: [], channelWorkflows: [owner], terminalReports: [], workflowErrors: {},
    auditActivityVisible: false, conversationWorkCellByThreadId: new Map(), runLifecycles: [], contextSegmentIdByItemId: new Map(),
    workflowProgressByWorkflowId: new Map([[owner.id, progress]]),
    conversationWorkCellByWorkflowId: new Map([[owner.id, workflowProgressToConversationWorkCell(progress)]]),
    daemonHealthy: true, workflowObservationReady: true, onInvokeProtocolAction: invoke, t: h.state.t, ...overrides };
  const renderers = h.module.createChannelMessageRenderers(input);
  renderers.renderUnifiedTimeline([{ kind: "activity", item: { id: `workflow:${owner.id}`,
    kind: "workflow", record: owner, createdAt: owner.updatedAt, category: "runtime", attention: "none", searchText: "" } }]);
  const item = mount.snapshot.items.find(item => item.protocolKind === "workflow");
  return { ...h, input, owner, tasks, item, get mount() { return mount; }, detail: item ? mount.renderProtocolDetail(item) : null, renderers,
    selectStep: id => { selected = id; } };
}

test("the actual channel renderer keeps the inline graph folded beside ordinary execution facts", async t => {
  const f = await fixture(t);
  assert.ok(f.mount.snapshot.items.some(item => item.kind === "subAgentActivity"));
  assert.equal(f.detail.type, f.module.WorkflowGraphDetail);
  assert.equal(f.detail.props.steps, f.input.workflowProgressByWorkflowId.get(f.owner.id).steps);
  assert.equal(f.detail.props.timelineItems.some(item => item.kind === "subAgentActivity"), true);
  assert.equal("onInvokeProtocolAction" in f.detail.props, false);
  assert.equal("stepProtocolItems" in f.detail.props, false);
  assert.equal(f.detail.props.observationReady, true);
  assert.equal(f.mount.renderProtocolDetail({ protocolKind: "workflow-step", sourceRefs: [] }), null);
  assert.equal(f.mount.renderProtocolDetail({ protocolKind: "workflow", sourceRefs: [{ kind: "channel_workflow", id: "foreign" }] }), null);
  const html = f.render(f.module.ConversationTimelineProtocolRenderer, { item: f.item, depth: 0,
    renderProtocolDetail: f.mount.renderProtocolDetail, onInvokeProtocolAction: f.input.onInvokeProtocolAction });
  assert.match(html, /Graph · Review two branch results/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.doesNotMatch(html, /data-workflow-graph=|data-workflow-step-id=|aria-label="Workflow view"/u);
  assert.doesNotMatch(html, />Retry</u, "the failed workflow has no retry action in this fixture");
  assert.equal("renderWorkflowDetail" in f.renderers, false, "the graph does not replace the conversation with another page");
  const detail = f.render(f.module.WorkflowGraphDetail, f.detail.props);
  assert.match(detail, /data-workflow-graph="workflow-qa"/u);
  assert.match(detail, /data-workflow-view="graph"/u);
  assert.match(detail, /aria-label="Workflow view"/u);
  assert.match(detail, /data-workflow-step-id="step-1"/u);
  assert.match(detail, /Participant 1/u);
  assert.doesNotMatch(detail, /data-selected-step-id=|Selected step/u);
  assert.doesNotMatch(detail, /Graph requires a wider view/u);
});

test("collaborative graph rows retain workflow lifecycle controls in the normal conversation feed", async t => {
  const f = await fixture(t, {}, { ownerStatus: "ready", stepStatus: "queued" });
  assert.ok(f.item);
  assert.deepEqual(f.item.availableActions, ["advance_workflow", "cancel_workflow", "open_source", "open_details"]);
});

test("a ready single workflow keeps lifecycle controls without rendering a graph", async t => {
  const f = await fixture(t, {}, { ownerStatus: "ready", stepStatus: "queued",
    transformSteps: tasks => tasks.slice(0, 1).map(task => ({ ...task, runId: undefined, taskId: undefined })) });
  assert.ok(f.item);
  assert.equal(f.detail, null);
  assert.deepEqual(f.item.availableActions, ["advance_workflow", "cancel_workflow", "open_source", "open_details"]);
});

test("single-agent work leaves the native conversation facts without graph or duplicate controls", async t => {
  for (const transformSteps of [tasks => tasks.slice(0, 1), tasks => tasks.map(task => ({ ...task, toParticipantId: "participant-1" }))]) {
    const f = await fixture(t, {}, { stepStatus: "blocked", ownerStatus: "running", transformSteps });
    assert.equal(f.detail, null);
    assert.equal(f.item, undefined);
    assert.ok(f.mount.snapshot.items.some(item => item.kind === "subAgentActivity"));
    assert.equal(f.mount.snapshot.items.some(item => item.availableActions?.some(action => ["retry_step", "cancel_workflow", "advance_workflow"].includes(action))), false);
  }
});

test("successful single-agent execution does not retain a duplicate workflow summary", async t => {
  const f = await fixture(t, {}, { ownerStatus: "succeeded", stepStatus: "succeeded",
    transformSteps: tasks => tasks.slice(0, 1) });
  assert.equal(f.item, undefined);
  assert.equal(f.detail, null);
  assert.ok(f.mount.snapshot.items.some(item => item.kind === "subAgentActivity"));
});

test("standalone workflow step activities do not duplicate native participant failures or controls", async t => {
  const f = await fixture(t, {}, { ownerStatus: "blocked", stepStatus: "blocked" });
  f.renderers.renderUnifiedTimeline([
    { kind: "activity", item: { id: `workflow:${f.owner.id}`, kind: "workflow", record: f.owner,
      createdAt: f.owner.updatedAt, category: "runtime", attention: "blocked", searchText: "" } },
    { kind: "activity", item: { id: `workflow-step:${f.tasks[0].id}`, kind: "workflow-step",
      record: { ...f.tasks[0], blocker: "The original run failed" }, createdAt: f.owner.updatedAt,
      category: "runtime", attention: "blocked", searchText: "" } },
  ]);
  assert.equal(f.mount.snapshot.items.some(item => item.protocolKind === "workflow-step"), false);
  assert.ok(f.mount.snapshot.items.some(item => item.kind === "subAgentActivity" && item.status === "blocked"));
});

test("graph nodes remain read-only without repeating failures, results or approval controls", async t => {
  const f = await fixture(t);
  f.selectStep("step-1");
  const html = f.render(f.module.WorkflowGraphDetail, { ...f.detail.props,
    steps: f.tasks.map(task => ({ ...task, status: "succeeded", resultSummary: "Recorded child result" })) });
  assert.match(html, /data-workflow-step-id="step-1" aria-pressed="true"/u);
  assert.doesNotMatch(html, /data-selected-step-id=|Selected step|<details|>Details<|Review source|Show step facts|Step ID|Recorded child result|Dependencies|None/u);
  const approval = { id: "approval", kind: "approval", workflowStepId: "step-1", title: "Approve write",
    sourceRefs: [], availableActions: ["open_approval"] };
  const blocked = f.render(f.module.WorkflowGraphDetail, { ...f.detail.props,
    steps: f.tasks.map(task => ({ ...task, status: "blocked", blocker: "Write requires approval", resultSummary: "Branch request failed" })),
    timelineItems: [...f.detail.props.timelineItems, approval] });
  assert.match(blocked, /data-status="blocked"/u);
  assert.doesNotMatch(blocked, /data-selected-step-id=|Selected step/u);
  assert.doesNotMatch(blocked, /Write requires approval|Branch request failed|Approve write|Open approval|>Retry<|Cancel workflow|<details|>Details</u);
});

test("workflow audit-only actions do not create empty disclosures or remove recovery commands", async t => {
  const f = await fixture(t);
  for (const protocolKind of ["workflow", "workflow-step"]) {
    const item = { ...f.item, protocolKind, description: undefined, detailLines: undefined,
      availableActions: ["open_source", "open_details"] };
    const auditOnly = f.render(f.module.ConversationTimelineProtocolRenderer, { item, depth: 0,
      onInvokeProtocolAction: f.input.onInvokeProtocolAction });
    assert.doesNotMatch(auditOnly, /aria-expanded|<details|>Details<|Review source/u);
    const recovery = f.render(f.module.ConversationTimelineProtocolRenderer, { item: { ...item,
      availableActions: [...item.availableActions, "retry_step", "cancel_workflow", "open_approval"] },
      depth: 0, onInvokeProtocolAction: f.input.onInvokeProtocolAction });
    assert.match(recovery, />Retry</u);
    assert.match(recovery, />Cancel workflow</u);
    assert.match(recovery, />Open approval</u);
    assert.doesNotMatch(recovery, /<details|>Details<|Review source/u);
  }
});

test("the inline graph never reports stale or unavailable completion counts as current", async t => {
  const f = await fixture(t);
  for (const observationReady of [false, undefined]) {
    const html = f.render(f.module.WorkflowGraphDetail, { ...f.detail.props,
      steps: f.tasks.map(step => ({ ...step, status: "succeeded" })), observationReady });
    assert.match(html, /data-observation="(?:stale|unknown)"/u);
    assert.match(html, /\?\/2/u);
    assert.doesNotMatch(html, />2\/2</u);
  }
});

test("busy and rejected recovery commands do not acquire a second owner in the graph", async t => {
  const f = await fixture(t, { runningWorkflowStepId: "step-1", workflowErrors: { "step-1": "Retry was rejected" } }, { stepStatus: "blocked" });
  assert.equal("stepProtocolItems" in f.detail.props, false);
  f.selectStep("step-1");
  const html = f.render(f.module.WorkflowGraphDetail, f.detail.props);
  assert.doesNotMatch(html, />Retry<|Retry was rejected|Open approval|Cancel workflow/u);
  assert.match(html, /data-workflow-step-id="step-1" aria-pressed="true"/u);
  assert.doesNotMatch(html, /data-selected-step-id=|Selected step/u);
  const ready = await fixture(t, {}, { stepStatus: "blocked" });
  ready.selectStep("step-1");
  assert.doesNotMatch(ready.render(ready.module.WorkflowGraphDetail, ready.detail.props), />Retry</u);
});

test("the owning graph disclosure keeps lifecycle actions while hiding audit actions", async t => {
  const f = await fixture(t, {}, { expandRows: true });
  const html = f.render(f.module.ConversationTimelineProtocolRenderer, { item: { ...f.item,
    availableActions: ["advance_workflow", "cancel_workflow", "retry_step", "open_approval", "open_source", "open_details"] }, depth: 0,
    renderProtocolDetail: f.mount.renderProtocolDetail, onInvokeProtocolAction: f.input.onInvokeProtocolAction });
  assert.match(html, /Graph ·/u);
  assert.match(html, />Advance workflow</u);
  assert.match(html, />Cancel workflow</u);
  assert.match(html, />Retry</u);
  assert.match(html, />Open approval</u);
  assert.doesNotMatch(html, />Details<|Review source/u);
});

test("stale and unknown observations never render a succeeded node or open a detail panel", async t => {
  const f = await fixture(t);
  f.selectStep("step-1");
  const tasks = f.tasks.map(step => ({ ...step, status: "succeeded" }));
  for (const ready of [false, undefined]) {
    const html = f.render(f.module.WorkflowGraphDetail, { ...f.detail.props, steps: tasks, observationReady: ready });
    assert.match(html, /data-observation="(?:stale|unknown)"/u);
    assert.match(html, /data-status="unknown"/u);
    assert.doesNotMatch(html, /data-status="succeeded"|data-selected-step-id=|Selected step/u);
  }
});

test("only the owning graph gets the compact disclosure; ordinary protocol attention remains expanded", async t => {
  const f = await fixture(t);
  const graph = f.render(f.module.ConversationTimelineProtocolRenderer, { item: { ...f.item, status: "running" }, depth: 0,
    renderProtocolDetail: f.mount.renderProtocolDetail, onInvokeProtocolAction: f.input.onInvokeProtocolAction });
  assert.match(graph, /aria-expanded="false"/u);
  const ordinary = f.render(f.module.ConversationTimelineProtocolRenderer, { item: { ...f.item, protocolKind: "run" }, depth: 0,
    renderProtocolDetail: f.mount.renderProtocolDetail, onInvokeProtocolAction: f.input.onInvokeProtocolAction });
  assert.match(ordinary, /aria-expanded="true"/u);
  assert.doesNotMatch(ordinary, /Graph ·/u);
});

test("keyboard-focusable graph nodes announce their actual projected status", async t => {
  const snapshots = [];
  const h = await catalogConsumerHarness(t, {
    exports: { "features/workspace/workflow-graph/WorkflowGraphCanvas.tsx": ["default as WorkflowGraphCanvas"] },
    ports: { capture: nodes => snapshots.push(nodes) },
    transforms: { "features/workspace/workflow-graph/WorkflowGraphCanvas.tsx": [{
      anchor: 'return <div className="workflow-graph-canvas"',
      replace: key => `globalThis[${JSON.stringify(key)}].ports.capture(nodes); return <div className="workflow-graph-canvas"`,
    }] },
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
  h.render(h.module.WorkflowGraphCanvas, { model: structuredClone(model), selectedStepId: "step-running", onSelect: () => {} });
  for (const nodes of snapshots) for (const node of nodes) {
    assert.deepEqual(node.measured, workflowGraphNodeSize, "polling and selection updates must retain fixed measurements and handle bounds");
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
