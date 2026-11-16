import assert from "node:assert/strict";
import test from "node:test";
import { formatCatalogMessage, loadCatalog } from "@ling-stack/localization";
import { evidence, observed, progressInput, round, steps, t, workflow } from "./support/workflow-isolation-evidence-fixture.mjs";

const { buildWorkflowIsolationPresentation, shouldPollWorkflowIsolation, workflowIntegrationDisplayState, workflowHasIsolationPlan }
  = await import("../src/lib/workflow-isolation-evidence.ts");
const { buildWorkflowProgressModel, workflowProgressToConversationWorkCell } = await import("../src/lib/workflow-progress.ts");
const { conversationTimelineItemsForModel } = await import("../src/lib/conversation-work-cell.ts");
const { hasWorkflowTimelineContent } = await import("../src/lib/workflow-timeline-content.ts");

for (const [name, patch, expected, label] of [
  ["preparing", { phase: "preparing" }, "preparing", "Preparing integration"],
  ["collecting", { phase: "collecting" }, "collecting", "Waiting for branch results"],
  ["integrating", { phase: "integrating" }, "integrating", "Integrating branch results"],
  ["verifying", { phase: "verifying" }, "verifying", "Verifying integration candidate"],
  ["candidate-only", { mode: "candidate_only", approval: undefined }, "candidate_only", "Candidate only; target unchanged"],
  ["pending approval", {}, "pending_approval", "Awaiting merge approval"],
  ["approved, no apply receipt", { approval: { approvalId: "approval-qa", status: "approved" } }, "approved_not_applied", "Merge approved; not yet applied"],
  ["applying", { phase: "applying", application: { status: "pending" } }, "applying", "Applying candidate to target"],
  ["applied", { phase: "applied", application: { status: "applied" } }, "applied", "Applied to target"],
  ["conflicted", { phase: "conflicted" }, "conflicted", "Integration conflicted"],
  ["failed", { phase: "failed" }, "failed", "Integration failed"],
  ["blocked", { phase: "blocked" }, "blocked", "Integration blocked"],
  ["effect unknown", { application: { status: "effect_unknown" } }, "unknown", "Integration result unconfirmed"],
  ["invalid apply", { application: { status: "invalid" } }, "unknown", "Integration result unconfirmed"],
  ["unconfirmed applied phase", { phase: "applied", application: { status: "not_started" } }, "unknown", "Integration result unconfirmed"],
  ["missing approval", { approval: undefined }, "unknown", "Integration result unconfirmed"],
]) {
  test(`isolation projection: ${name} remains a distinct observed state`, () => {
    const r = round(patch);
    assert.equal(workflowIntegrationDisplayState(r), expected);
    const model = buildWorkflowIsolationPresentation({ workflow: workflow(), observation: observed(evidence({ rounds: [r] })), t });
    assert.equal(model.items[1].meta, label);
    assert.equal(model.items[1].kind, "protocolEvent");
    assert.equal(model.items[1].actionId, undefined);
    assert.equal(model.items[1].attemptId, undefined, "an integration observation is not a fabricated execution");
    if (!["applied", "candidate_only"].includes(expected)) assert.notEqual(model.items[1].status, "succeeded");
  });
}

test("confirmed Git journals neither complete nor stop observation of running Attempts", () => {
  const input = observed(evidence({ rounds: [round({ phase: "collecting", candidate: undefined, approval: undefined })] }));
  const owner = workflow({ status: "running" });
  const model = buildWorkflowProgressModel(progressInput({ workflow: owner, isolationEvidence: input }));
  assert.equal(model.mode, "active");
  assert.equal(model.isolation.settled, false);
  assert.equal(model.summary, "Waiting for branch results");
  assert.equal(shouldPollWorkflowIsolation(input, owner), true);
  const conflict = observed(evidence({ rounds: [round({ phase: "conflicted" })] }));
  assert.equal(buildWorkflowIsolationPresentation({ workflow: workflow({ status: "blocked" }), observation: conflict, t }).summary, "Integration conflicted");
  assert.equal(shouldPollWorkflowIsolation(conflict, workflow({ status: "blocked" })), false);
});

test("only the latest confirmed pending merge exposes the existing approval detail action", () => {
  const owner = workflow({ status: "running" });
  const project = (observation, workflowOverride = owner) => buildWorkflowIsolationPresentation({ workflow: workflowOverride, observation, t });
  const pending = project(observed(evidence({ rounds: [round()] })));
  assert.equal(pending.items[0].approvalId, "approval-qa");
  assert.equal(pending.items[1].approvalId, "approval-qa");
  assert.deepEqual(pending.items[1].availableActions, ["open_approval"]);
  const generations = project(observed(evidence({ rounds: [round(), round({ generation: 2 })] })));
  assert.equal(generations.items[1].availableActions, undefined);
  assert.deepEqual(generations.items[2].availableActions, ["open_approval"]);
  for (const observation of [observed(evidence(), { status: "error" }), observed(evidence({ hostOperationPending: true })),
    observed(evidence({ gitEffects: "unconfirmed" })), observed(evidence({ rounds: [round({ mode: "candidate_only" })] })),
    observed(evidence({ rounds: [round({ approval: { approvalId: "approval-qa", status: "approved" } })] })),
    observed(evidence({ rounds: [round({ application: { status: "effect_unknown" } })] }))]) {
    assert.equal(project(observation).items[1].availableActions, undefined);
  }
  for (const status of ["cancelled", "failed"]) {
    assert.equal(project(observed(evidence()), workflow({ status })).items[1].availableActions, undefined);
  }
});

test("the existing Composer approval gate owns both pending integration projections", () => {
  const model = buildWorkflowProgressModel(progressInput({ isolationEvidence: observed(evidence()) }));
  const cell = workflowProgressToConversationWorkCell(model);
  const visible = conversationTimelineItemsForModel(cell, "approval-qa");
  assert.equal(visible.some(item => item.id.startsWith("workflow-isolation:")), false);
  assert.equal(visible.filter(item => item.kind === "subAgentActivity").length, 2);
});

test("cancelled lifecycle and unconfirmed effects are independent, including Host drain after confirmed journals", () => {
  const owner = workflow({ status: "cancelled" });
  const before = evidence({ hostOperationPending: true, rounds: [round({ phase: "collecting" })] });
  const model = buildWorkflowProgressModel(progressInput({ workflow: owner, isolationEvidence: observed(before) }));
  assert.equal(model.status, "cancelled");
  assert.equal(model.isolation.items[0].status, "cancelled");
  assert.match(model.summary, /^Workflow cancelled; integration result unconfirmed$/u);
  assert.match(model.isolation.items[0].description, /Host operations still draining/u);
  assert.equal(shouldPollWorkflowIsolation(observed(before), owner), true);
  assert.equal(before.gitEffects, "confirmed");
});

test("cancelled with confirmed journals and no Host drain does not turn blocked completion into unknown effects", () => {
  const owner = workflow({ status: "cancelled" });
  for (const phase of ["collecting", "blocked", "conflicted"]) {
    const observation = observed(evidence({ completion: "blocked", completionBlockerCode: "workflow_integration.round_not_complete",
      rounds: [round({ phase, candidate: undefined, approval: undefined, application: { status: "not_started" } })] }));
    const model = buildWorkflowProgressModel(progressInput({ workflow: owner, isolationEvidence: observation }));
    assert.equal(model.status, "cancelled");
    assert.equal(model.summary, "Workflow cancelled", phase);
    assert.equal(model.isolation.settled, false, "confirmed journals do not prove Attempt stop or successful completion");
    assert.equal(model.isolation.items[0].status, "cancelled");
    assert.match(model.isolation.items[0].description, /Integration completion blocked/u);
    assert.doesNotMatch(JSON.stringify(model.isolation.items), /unconfirmed|still draining/u);
    assert.equal(shouldPollWorkflowIsolation(observation, owner), phase === "collecting");
  }
  const uncertain = observed(evidence({ rounds: [round({ phase: "blocked", application: { status: "effect_unknown" } })] }));
  assert.match(buildWorkflowIsolationPresentation({ workflow: owner, observation: uncertain, t }).summary, /result unconfirmed/u);
  assert.equal(shouldPollWorkflowIsolation(uncertain, owner), true);
});

test("waiting integration evidence cannot hide failed or blocked participant attention", () => {
  for (const status of ["failed", "blocked"]) {
    const input = progressInput({ isolationEvidence: observed(evidence()) });
    input.steps[0].status = status;
    const model = buildWorkflowProgressModel(input);
    assert.equal(model.isolation.attention, "waiting");
    assert.equal(model.attention, status);
  }
});

test("read failure and unavailable evidence cannot turn a succeeded workflow into confirmed completion", () => {
  for (const observation of [observed(undefined, { status: "error", expected: false }), observed(evidence({ status: "unavailable", rounds: [] })),
    observed(evidence({ rounds: [] })), observed(evidence({ schemaVersion: 2 }))]) {
    const model = buildWorkflowProgressModel(progressInput({ isolationEvidence: observation }));
    assert.equal(model.mode, "active");
    assert.equal(model.isolation.settled, false);
    assert.notEqual(model.attention, "none");
    assert.equal(model.isolation.items[0].status, "waiting");
    assert.match(model.summary, /unconfirmed/u);
  }
});

test("target apply and candidate-only completion both require completion confirmation, not approval alone", () => {
  for (const r of [round({ phase: "applied", application: { status: "applied" } }), round({ mode: "candidate_only", approval: undefined })]) {
    const ready = observed(evidence({ completion: "ready", rounds: [r] }));
    const model = buildWorkflowProgressModel(progressInput({ isolationEvidence: ready }));
    assert.equal(model.isolation.settled, true);
    assert.equal(model.mode, "completed");
    assert.equal(shouldPollWorkflowIsolation(ready, workflow()), false);
    const blocked = buildWorkflowProgressModel(progressInput({ isolationEvidence: observed(evidence({ rounds: [r] })) }));
    assert.equal(blocked.isolation.settled, false);
    assert.equal(blocked.mode, "active");
  }
});

test("retained rounds have stable generation identity and preserve participant timelines through actual work-cell projection", () => {
  const rounds = [round({ generation: 2, revision: 5 }), round({ generation: 1, phase: "conflicted" })];
  const input = progressInput({ isolationEvidence: observed(evidence({ rounds })) });
  const before = JSON.stringify(input);
  const baseline = buildWorkflowProgressModel(progressInput());
  const model = buildWorkflowProgressModel(input);
  const cell = workflowProgressToConversationWorkCell(model);
  const items = conversationTimelineItemsForModel(cell);
  const baselineItems = conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(baseline));
  assert.equal(model.agentSpans.length, 2);
  for (const item of baselineItems) assert(items.some(candidate => candidate.id === item.id), `retained original participant ${item.id}`);
  const facts = items.filter(item => item.id.startsWith("workflow-isolation:"));
  assert.equal(facts.length, 3);
  assert.equal(facts[1].id, "workflow-isolation:workflow-qa:round:round-qa:1");
  assert.equal(facts[2].id, "workflow-isolation:workflow-qa:round:round-qa:2");
  assert(facts.every(hasWorkflowTimelineContent));
  assert.equal(hasWorkflowTimelineContent({ ...facts[0], id: "ordinary-plan-skeleton" }), false);
  assert.equal(JSON.stringify(input), before, "view projection does not rewrite DTOs or execution evidence");
  assert.equal(model.updatedAt, "2026-11-03T00:02:00.000Z");
});

test("ordinary workflow observations add no isolation facts and cannot start an automatic polling loop", () => {
  const ordinary = { status: "loaded", expected: false };
  assert.equal(buildWorkflowIsolationPresentation({ workflow: workflow(), observation: ordinary, t }), undefined);
  assert.equal(shouldPollWorkflowIsolation(ordinary, workflow({ status: "running" })), false);
  assert.equal(shouldPollWorkflowIsolation({ ...ordinary, status: "error" }, workflow()), false);
  assert.equal(workflowHasIsolationPlan(steps(workflow(), { pinned: false })), false);
  assert.equal(workflowHasIsolationPlan(steps()), true);
});

test("packaged Chinese catalogs translate isolation states and cancellation evidence", async () => {
  const [chinese, english] = await Promise.all([loadCatalog("zh-CN"), loadCatalog("en-US")]);
  const translate = (key, values) => formatCatalogMessage(chinese.messages, english.messages, key, values);
  for (const [patch, label] of [
    [{ phase: "collecting" }, "等待分支结果"],
    [{ mode: "candidate_only", approval: undefined }, "仅生成候选；目标未变更"],
    [{}, "等待合并审批"],
    [{ approval: { approvalId: "approval-qa", status: "approved" } }, "合并已批准；尚未应用"],
    [{ phase: "applying", application: { status: "pending" } }, "正在将候选应用到目标"],
    [{ phase: "applied", application: { status: "applied" } }, "已应用到目标"],
    [{ phase: "conflicted" }, "集成存在冲突"],
    [{ application: { status: "effect_unknown" } }, "集成结果待确认"],
  ]) {
    const model = buildWorkflowIsolationPresentation({ workflow: workflow(),
      observation: observed(evidence({ rounds: [round(patch)] })), t: translate });
    assert.equal(model.items[1].meta, label);
  }
  const cancelled = buildWorkflowIsolationPresentation({ workflow: workflow({ status: "cancelled" }),
    observation: observed(evidence({ hostOperationPending: true })), t: translate });
  assert.equal(cancelled.summary, "工作流已取消；集成结果待确认");
  assert.equal(cancelled.items[0].title, "工作流已取消");
  assert.match(cancelled.items[0].description, /Host 操作仍在收尾/u);
  assert.match(cancelled.items[1].description, /2 个集成参与步骤/u);
});
