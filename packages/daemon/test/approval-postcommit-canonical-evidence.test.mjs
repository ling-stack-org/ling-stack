import assert from "node:assert/strict";
import { test } from "node:test";
import { configureTerminalReportStore } from "../dist/features/channels/terminal-report-coordinator.js";
import { reconcileApprovalPostCommitEffects } from "../dist/features/runs/approval-postcommit-effects.js";
import { recoverApprovalPostCommitStore } from "../dist/features/runs/approval-postcommit-recovery.js";
import { expireStaleApproval, waitForApprovalDecision } from "../dist/features/runs/approvals.js";

const cwd = "/approval-postcommit-canonical-evidence";
const createdAt = "2026-10-17T00:00:00.000Z";
const expiredAt = "2026-10-17T00:01:00.000Z";
const recoveryAt = "2026-10-17T00:02:00.000Z";

function effect(approvalId, effectKind, input = {}) {
  return {
    approvalId,
    effectKind,
    status: "pending",
    revision: 0,
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
    ...input,
  };
}

function createLedgerStore(input = {}) {
  const state = {
    approval: input.approval,
    effects: [...(input.effects ?? [])],
    events: [],
    run: input.run,
    checkpoint: input.checkpoint,
    step: input.step,
    workflow: input.workflow,
    turn: input.turn,
    reports: [...(input.reports ?? [])],
    items: new Map(input.items ?? []),
  };
  const store = {
    paths: { cwd },
    getApprovalRequest: (id) => state.approval?.id === id ? state.approval : undefined,
    expireApprovalRequest: (id, decision, now) => {
      if (state.approval?.id !== id || state.approval.status !== "pending") return undefined;
      state.approval = { ...state.approval, status: "expired", resolvedAt: now, decisionReason: decision.reason };
      if (state.effects.length === 0) state.effects.push(effect(id, "decision_event"));
      return state.approval;
    },
    listApprovalPostCommitEffects: (options = {}) => state.effects.filter((candidate) =>
      (!options.approvalId || candidate.approvalId === options.approvalId)
      && (!options.status || candidate.status === options.status)),
    claimApprovalPostCommitEffect: (approvalId, effectKind, claim, now) => {
      const current = state.effects.find((candidate) => candidate.approvalId === approvalId && candidate.effectKind === effectKind);
      if (!current || current.status !== "pending") return undefined;
      Object.assign(current, { status: "claimed", claimToken: claim.token, claimExpiresAt: claim.claimExpiresAt,
        attempts: current.attempts + 1, revision: current.revision + 1, updatedAt: now });
      return { ...current };
    },
    settleApprovalPostCommitEffect: (approvalId, effectKind, settlement, now) => {
      const current = state.effects.find((candidate) => candidate.approvalId === approvalId && candidate.effectKind === effectKind);
      if (!current || current.status !== "claimed" || current.claimToken !== settlement.token) return undefined;
      Object.assign(current, { status: settlement.status, lastErrorCode: settlement.errorCode,
        claimToken: undefined, claimExpiresAt: undefined, revision: current.revision + 1, updatedAt: now });
      return { ...current };
    },
    recoverExpiredApprovalPostCommitClaim: (approvalId, effectKind, settlement, now) => {
      const current = state.effects.find((candidate) => candidate.approvalId === approvalId && candidate.effectKind === effectKind);
      if (!current || current.status !== "claimed" || current.revision !== settlement.expectedRevision
        || !current.claimExpiresAt || current.claimExpiresAt >= now) return undefined;
      Object.assign(current, { status: settlement.status, lastErrorCode: settlement.errorCode,
        claimToken: undefined, claimExpiresAt: undefined, revision: current.revision + 1, updatedAt: now });
      return { ...current };
    },
    getRun: (id) => state.run?.id === id ? state.run : undefined,
    getApprovalCheckpointForApproval: (id) => state.checkpoint?.approvalId === id ? state.checkpoint : undefined,
    getChannelWorkflowStep: (id) => state.step?.id === id ? state.step : undefined,
    getChannelWorkflow: (id) => state.workflow?.id === id ? state.workflow : undefined,
    listChannelWorkflowSteps: ({ workflowId }) => state.step?.workflowId === workflowId ? [state.step] : [],
    getLingTurn: (id) => state.turn?.id === id ? state.turn : undefined,
    listTerminalReports: ({ sourceKind, sourceId }) => state.reports.filter((record) =>
      record.sourceKind === sourceKind && record.sourceId === sourceId),
    getConversationItem: (id) => state.items.get(id),
    listEvents: () => state.events,
    appendEvent: (runId, type, data) => {
      const envelope = { seq: state.events.length + 1, runId, type, data, ts: new Date().toISOString() };
      state.events.push(envelope);
      return envelope;
    },
    appendApprovalDecisionEvent: (runId, approvalId, type, data) => {
      const existing = state.events.find((event) => event.runId === runId
        && event.data?.approvalId === approvalId
        && ["approval_approved", "approval_denied", "approval_expired", "approval_cancelled"].includes(event.type));
      if (existing) {
        assert.equal(existing.type, type);
        return existing;
      }
      const envelope = { id: `evt_approval_decision_${approvalId}`, seq: state.events.length + 1,
        runId, type, data, ts: new Date().toISOString() };
      state.events.push(envelope);
      return envelope;
    },
    getExternalWorkAction: () => undefined,
  };
  return { store, state };
}

function workflowApproval() {
  return {
    id: "approval-workflow-post",
    workflowStepId: "step-workflow-post",
    channelId: "channel-workflow-post",
    actionType: "workflow_step",
    risk: "medium",
    title: "Review result",
    description: "Review the completed delegated result.",
    payload: {
      type: "workflow_step",
      gateStage: "post",
      workflowId: "workflow-post",
      workflowStepId: "step-workflow-post",
      runId: "run-workflow-post",
      title: "Implement",
      approvalMode: "standard",
      requiredForTools: [],
      requiredForActions: [],
    },
    status: "approved",
    createdAt,
    resolvedAt: expiredAt,
  };
}

function incompleteWorkflowFacts() {
  const approval = workflowApproval();
  return {
    approval,
    run: {
      id: approval.payload.runId,
      taskId: "task-workflow-post",
      channelId: approval.channelId,
      workflowStepId: approval.workflowStepId,
      status: "succeeded",
    },
    checkpoint: {
      approvalId: approval.id,
      workflowStepId: approval.workflowStepId,
      channelId: approval.channelId,
      status: "approved",
      sideEffect: approval.payload,
    },
    step: {
      id: approval.workflowStepId,
      channelId: approval.channelId,
      workflowId: approval.payload.workflowId,
      taskId: "task-workflow-post",
      runId: approval.payload.runId,
      status: "waiting_for_approval",
      metadata: { activeGateStage: "post", postStepApprovalId: approval.id },
    },
    workflow: {
      id: approval.payload.workflowId,
      channelId: approval.channelId,
      status: "waiting_for_approval",
      metadata: { sourceTurnId: "turn-workflow-post" },
    },
    turn: { id: "turn-workflow-post", status: "waiting_for_approval" },
  };
}

test("expired Workflow Step owner is retried when Workflow evidence is still waiting", () => {
  const facts = incompleteWorkflowFacts();
  const claimed = effect(facts.approval.id, "owner", {
    ownerKind: "workflow_step",
    ownerId: facts.approval.workflowStepId,
    status: "claimed",
    revision: 1,
    attempts: 1,
    claimToken: "crashed-after-run-resume",
    claimExpiresAt: expiredAt,
  });
  const { store, state } = createLedgerStore({ ...facts, effects: [claimed] });
  let ownerCalls = 0;
  const result = recoverApprovalPostCommitStore({
    store,
    cwd,
    now: recoveryAt,
    onOwnerResolved: () => {
      ownerCalls += 1;
      state.step = { ...state.step, status: "succeeded", metadata: { ...state.step.metadata, activeGateStage: undefined } };
      state.workflow = { ...state.workflow, status: "succeeded" };
      state.turn = { ...state.turn, status: "succeeded" };
      return undefined;
    },
  });
  assert.equal(ownerCalls, 1, "recovery must execute the missing Workflow projection instead of trusting Run status alone");
  assert.equal(state.effects[0].status, "completed");
  assert.equal(result.deferred, 0);
});

test("a swallowed stale Workflow callback cannot complete owner evidence while aggregate state is incomplete", () => {
  const facts = incompleteWorkflowFacts();
  facts.step = { ...facts.step, status: "succeeded", metadata: { ...facts.step.metadata, activeGateStage: undefined } };
  facts.workflow = { ...facts.workflow, status: "running" };
  facts.turn = { ...facts.turn, status: "running" };
  const owner = effect(facts.approval.id, "owner", {
    ownerKind: "workflow_step",
    ownerId: facts.approval.workflowStepId,
  });
  const { store, state } = createLedgerStore({ ...facts, effects: [owner] });
  const result = reconcileApprovalPostCommitEffects({
    store,
    approval: facts.approval,
    cwd,
    now: recoveryAt,
    onOwnerResolved: () => undefined,
  });
  assert.equal(result.deferred, true);
  assert.equal(state.effects[0].status, "pending");
});

test("terminal Workflow owner remains pending until enabled TerminalReport publication has a result item", () => {
  const facts = incompleteWorkflowFacts();
  facts.step = { ...facts.step, status: "succeeded", metadata: { ...facts.step.metadata, activeGateStage: undefined } };
  facts.workflow = { ...facts.workflow, status: "succeeded" };
  facts.turn = { ...facts.turn, status: "running" };
  const owner = effect(facts.approval.id, "owner", {
    ownerKind: "workflow_step",
    ownerId: facts.approval.workflowStepId,
  });
  const { store, state } = createLedgerStore({ ...facts, effects: [owner] });
  configureTerminalReportStore(store, { enabled: true });
  const incomplete = reconcileApprovalPostCommitEffects({ store, approval: facts.approval, cwd, now: recoveryAt,
    onOwnerResolved: () => undefined });
  assert.equal(incomplete.deferred, true);
  assert.equal(state.effects[0].status, "pending");

  state.turn = { ...state.turn, status: "succeeded" };
  state.reports.push({ id: "report-workflow-post", sourceKind: "workflow", sourceId: facts.workflow.id,
    status: "committed", generation: 1, resultItemId: "item-report-workflow-post" });
  state.items.set("item-report-workflow-post", { id: "item-report-workflow-post", kind: "terminal_report" });
  const complete = reconcileApprovalPostCommitEffects({ store, approval: facts.approval, cwd, now: recoveryAt,
    onOwnerResolved: () => undefined });
  assert.equal(complete.deferred, false);
  assert.equal(state.effects[0].status, "completed");
});

test("route expiry and recovery forced interleaving append one decision event", () => {
  const approval = {
    id: "approval-expiry-race",
    runId: "run-expiry-race",
    taskId: "task-expiry-race",
    actionType: "bash",
    risk: "medium",
    title: "Expire",
    description: "Expire once",
    payload: { type: "bash", cwd, command: "echo once", riskFlags: [] },
    status: "pending",
    createdAt,
    expiresAt: "2000-01-01T00:00:00.000Z",
  };
  const { store, state } = createLedgerStore({ approval,
    run: { id: approval.runId, taskId: approval.taskId, status: "waiting_for_approval" },
    checkpoint: { approvalId: approval.id, runId: approval.runId, status: "expired" } });
  let reentered = false;
  const appendDecision = store.appendApprovalDecisionEvent;
  store.appendApprovalDecisionEvent = (runId, approvalId, type, data) => {
    if (!reentered) {
      reentered = true;
      recoverApprovalPostCommitStore({ store, cwd, now: recoveryAt, onOwnerResolved: () => undefined });
      recoverApprovalPostCommitStore({ store, cwd, now: "2026-10-17T00:02:30.000Z", onOwnerResolved: () => undefined });
    }
    return appendDecision(runId, approvalId, type, data);
  };
  expireStaleApproval(store, approval.id, undefined, cwd);
  assert.equal(state.approval.status, "expired");
  assert.equal(state.events.filter((event) => event.type === "approval_expired").length, 1);
  recoverApprovalPostCommitStore({ store, cwd, now: "2026-10-17T00:03:00.000Z", onOwnerResolved: () => undefined });
  assert.equal(state.events.filter((event) => event.type === "approval_expired").length, 1);
  assert.equal(state.effects.find((candidate) => candidate.effectKind === "decision_event")?.status, "completed");
});

test("timeout keeps the committed expired decision when decision-event publication fails", async () => {
  const approval = {
    id: "approval-timeout-publication-fault",
    runId: "run-timeout-publication-fault",
    taskId: "task-timeout-publication-fault",
    actionType: "bash",
    risk: "medium",
    title: "Timeout",
    description: "Timeout once",
    payload: { type: "bash", cwd, command: "echo timeout", riskFlags: [] },
    status: "pending",
    createdAt,
  };
  const { store, state } = createLedgerStore({ approval,
    run: { id: approval.runId, taskId: approval.taskId, status: "waiting_for_approval" },
    checkpoint: { approvalId: approval.id, runId: approval.runId, status: "expired" } });
  store.appendApprovalDecisionEvent = () => { throw new Error("injected_decision_event_failure"); };
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => reads++ === 0 ? 0 : 30 * 60 * 1000 + 1;
  try {
    const resolved = await waitForApprovalDecision(store, approval.id);
    assert.equal(resolved.status, "expired");
    assert.equal(state.approval.status, "expired");
    assert.equal(state.effects[0].status, "pending");
  } finally {
    Date.now = originalNow;
  }
});
