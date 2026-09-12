import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApprovalAutoReviewEvidence } from "../dist/features/runs/approval-auto-review-evidence.js";

const now = "2026-09-12T08:00:00.000Z";
const fence = {
  workUnitId: "unit-1",
  attemptId: "attempt-2",
  runtimeInstanceId: "runtime-1",
  fencingToken: "2",
};
const run = {
  id: "run-1",
  status: "running",
  cwd: "/workspace/project",
  taskId: "task-1",
  teammateId: "engineer",
  workflowStepId: "step-1",
  providerName: "provider",
  providerModel: "model",
  taskSnapshot: {},
  providerSnapshot: {},
  requestSnapshot: {},
  eventLogPath: "/tmp/events.jsonl",
  threadId: "thread-1",
  workUnitId: fence.workUnitId,
  createdAt: now,
  updatedAt: now,
};
const turn = {
  id: "turn-1",
  workspaceId: "workspace_default",
  threadId: "thread-1",
  kind: "workflow_step",
  status: "running",
  title: "Run the scoped checks",
  userInstruction: "Only run the test command in this workspace.",
  taskId: run.taskId,
  teammateId: run.teammateId,
  workflowStepId: run.workflowStepId,
  activeRunId: run.id,
  lastRunId: run.id,
  createdByActor: "local-user",
  createdAt: now,
  updatedAt: now,
};
const thread = {
  id: "thread-1",
  workspaceId: "workspace_default",
  kind: "workflow_step",
  taskId: run.taskId,
  teammateId: run.teammateId,
  workflowStepId: run.workflowStepId,
  title: "Checks",
  objective: "Run tests safely",
  status: "running",
  activeRunId: run.id,
  lastRunId: run.id,
  conversationMode: { mode: "default", updatedAt: now },
  createdAt: now,
  updatedAt: now,
  surfaceKind: "channel_child",
  relationKind: "workflow_step",
  nextItemSequence: 4,
};
const approval = {
  id: "approval-1",
  runId: run.id,
  taskId: run.taskId,
  workflowStepId: run.workflowStepId,
  toolCallId: "tool-1",
  actionType: "bash",
  risk: "medium",
  title: "Approve shell command",
  description: "pnpm test",
  payload: { type: "bash", cwd: run.cwd, command: "pnpm test", riskFlags: [] },
  status: "pending",
  createdAt: now,
};
const policy = {
  mode: "workspace_write",
  authorizationMode: "smart",
  workspaceAccessMode: "workspace_write",
  toolDecisions: { read: "allow", grep: "allow", find: "allow", ls: "allow", bash: "ask", edit: "ask", write: "ask" },
  allowedWritePaths: [run.cwd],
  workspacePolicyUpdatedAt: now,
  riskNotes: [],
};
const requestItem = {
  id: "item-question",
  workspaceId: "workspace_default",
  threadId: thread.id,
  turnId: turn.id,
  kind: "user_input_request",
  status: "committed",
  actorType: "teammate",
  actorId: run.teammateId,
  visibility: "thread_participants",
  payload: { requestId: "request-1", requestVersion: 1 },
  domainRefs: [],
  sequence: 2,
  createdAt: now,
};
const answerItem = {
  ...requestItem,
  id: "item-answer",
  kind: "user_input_answer",
  actorType: "local_user",
  actorId: undefined,
  payload: { requestId: "request-1", requestVersion: 1, answerId: "answer-1" },
  sequence: 3,
};
const source = {
  workspaceId: "workspace_default",
  threadId: thread.id,
  turnId: turn.id,
  runId: run.id,
  attemptId: "attempt-1",
  workUnitId: fence.workUnitId,
  participantId: run.teammateId,
  sourceItemId: "item-source",
  workflowStepId: run.workflowStepId,
};
const requestTranscript = {
  availability: "available",
  itemId: requestItem.id,
  requestId: "request-1",
  requestVersion: 1,
  source,
  kind: "user_input_request",
  status: "answered",
  statusRevision: 2,
  waitMode: "required",
  questions: [{
    questionId: "scope",
    prompt: "Where may the command run?",
    required: true,
    allowFreeText: false,
    options: [{ optionId: "workspace", label: "Only this workspace" }],
  }],
  createdAt: now,
  updatedAt: now,
};
const answerTranscript = {
  availability: "available",
  itemId: answerItem.id,
  requestId: "request-1",
  requestVersion: 1,
  source,
  kind: "user_input_answer",
  answerId: "answer-1",
  acceptedAt: now,
  answers: [{ questionId: "scope", prompt: "Where may the command run?", kind: "option", optionId: "workspace", label: "Only this workspace" }],
  delivery: { status: "applied", revision: 2, updatedAt: now },
};

function createStore(overrides = {}) {
  const transcript = overrides.transcript ?? [requestTranscript, answerTranscript];
  return {
    getApprovalPolicy: () => ({ updatedAt: policy.workspacePolicyUpdatedAt }),
    getLingTurnForRun: () => turn,
    getLingThread: () => thread,
    isCurrentRunExecutionOwner: () => true,
    listLingTurnRuns: () => [{ turnId: turn.id, runId: run.id, attemptNumber: 1, role: "primary", createdAt: now }],
    listConversationItemsForTurn: () => overrides.items ?? [requestItem, answerItem],
    readUserInputTranscript: () => transcript,
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildApprovalAutoReviewEvidence({
    store: overrides.store ?? createStore(),
    run: overrides.run ?? run,
    approval: overrides.approval ?? approval,
    sourceFence: overrides.sourceFence ?? fence,
    effectivePolicySnapshot: overrides.effectivePolicySnapshot ?? policy,
    extraSecrets: overrides.extraSecrets ?? [],
    maxSnapshotChars: overrides.maxSnapshotChars,
  });
}

test("automatic review evidence keeps a verified question and answer as one complete group", () => {
  const result = build();
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.context.userInstruction, turn.userInstruction);
  assert.equal(result.snapshot.context.participantId, run.teammateId);
  assert.equal(result.snapshot.questionAnswerGroups.length, 1);
  assert.deepEqual(result.snapshot.questionAnswerGroups[0].answers, answerTranscript.answers);
  assert.equal(result.snapshot.action.payload.command, "pnpm test");
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test("automatic review evidence fails closed when a question group is incomplete or not applied", () => {
  const missingAnswer = build({ store: createStore({ items: [requestItem], transcript: [requestTranscript] }) });
  assert.deepEqual(missingAnswer, {
    ok: false,
    code: "question_answer_incomplete",
    reason: "Automatic review requires complete, applied question and answer groups.",
  });
  const pendingDelivery = build({
    store: createStore({ transcript: [requestTranscript, { ...answerTranscript, delivery: { ...answerTranscript.delivery, status: "pending" } }] }),
  });
  assert.equal(pendingDelivery.ok, false);
  assert.equal(pendingDelivery.code, "question_answer_incomplete");
});

test("automatic review evidence rejects unavailable, cross-participant, stale, and redacted authority", () => {
  assert.equal(build({
    store: createStore({ transcript: [{ availability: "unavailable", itemId: requestItem.id, kind: "user_input_request" }] }),
  }).code, "question_answer_unavailable");
  assert.equal(build({
    store: createStore({ transcript: [requestTranscript, { ...answerTranscript, source: { ...source, participantId: "other-agent" } }] }),
  }).code, "question_answer_scope_mismatch");
  assert.equal(build({ store: createStore({ isCurrentRunExecutionOwner: () => false }) }).code, "execution_stale");
  assert.equal(build({ extraSecrets: ["pnpm test"] }).code, "sensitive_evidence");
});

test("automatic review evidence never truncates a question group to fit the budget", () => {
  const result = build({ maxSnapshotChars: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "evidence_over_budget");
});
