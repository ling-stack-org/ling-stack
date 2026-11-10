import assert from "node:assert/strict";
import test from "node:test";
import { coordinatorWorkflowCheckingBody, coordinatorWorkflowFailedBody, projectCoordinatorWorkflowNarration } from "../dist/features/channels/coordinator-workflow-narration.js";

function fixture() {
  const workflow = { id: "workflow_current", channelId: "channel_current" };
  const steps = ["Engineer", "QA"].map((label, index) => ({
    id: `step_${index}`, workflowId: workflow.id, channelId: workflow.channelId,
    taskId: `task_${index}`, runId: `run_${index}`, toParticipantId: `agent_${index}`, toParticipantLabel: label,
  }));
  const runs = steps.map((step) => ({
    id: step.runId, workflowStepId: step.id, channelId: step.channelId,
    taskId: step.taskId, teammateId: step.toParticipantId, status: "running", startedAt: "2026-09-06T00:00:00.000Z",
  }));
  const input = {
    workflow, proposal: { channelId: workflow.channelId, responseLanguage: "follow_user" },
    sourceMessage: { body: "Please inspect the project." },
    store: { getRun: (id) => runs.find((run) => run.id === id), getChannelWorkflowStep: (id) => steps.find((step) => step.id === id) },
  };
  const startedSteps = steps.map((workflowStep) => ({ workflowStep, taskId: workflowStep.taskId, runId: workflowStep.runId }));
  return { input, steps, runs, startedSteps };
}

test("pending coordinator acknowledgement never promises execution", () => {
  const { input } = fixture();
  assert.equal(coordinatorWorkflowCheckingBody(input), "Checking status");
  assert.doesNotMatch(coordinatorWorkflowCheckingBody(input), /Starting now|Started/u);
});

test("thrown dispatch failure respects follow-user language without promising startup", () => {
  const { input } = fixture();
  assert.equal(coordinatorWorkflowFailedBody(input, new Error("runner unavailable")), "Failed: runner unavailable");
  input.sourceMessage.body = "请读取当前项目";
  assert.equal(coordinatorWorkflowFailedBody(input, "runner unavailable"), "失败：runner unavailable");
});

for (const [state, status] of [["blocked", "blocked"], ["failed", "failed"], ["waiting_for_approval", "blocked"], ["idle", "ready"], ["completed", "ready"]]) {
  test(`coordinator ${state} is not rewritten as started`, () => {
    const { input, steps } = fixture();
    const result = projectCoordinatorWorkflowNarration({
      ...input, orchestration: { workflow: input.workflow, workflowStep: steps[0], status: state, blocker: "write is not allowed", reason: "No eligible step", approval: { id: "approval_current" } },
    });
    assert.equal(result.state, state);
    assert.equal(result.status, status);
    assert.deepEqual(result.verifiedRunIds, []);
    assert.doesNotMatch(result.body, /Starting now|Run started|现在开始处理|workflow_start\./u);
    if (state === "blocked" || state === "failed") assert.match(result.body, /write is not allowed/u);
    if (state === "idle") assert.match(result.body, /No eligible step/u);
    if (state === "completed") assert.equal(result.body, "Workflow: Completed");
  });
}

test("missing orchestration does not invent startup evidence", () => {
  const { input } = fixture();
  const result = projectCoordinatorWorkflowNarration(input);
  assert.equal(result.body, "Not started");
  assert.deepEqual(result.verifiedRunIds, []);
});

test("partial startup names only the participant with verified durable Run evidence", () => {
  const { input, startedSteps } = fixture();
  const result = projectCoordinatorWorkflowNarration({
    ...input, orchestration: { workflow: input.workflow, status: "started", ...startedSteps[0], startedSteps: [startedSteps[0]] },
  });
  assert.equal(result.body, "Run started: Engineer");
  assert.deepEqual(result.verifiedRunIds, ["run_0"]);
  assert.doesNotMatch(result.body, /QA|all|completed/u);
});

test("a queued Run ID is acceptance, not proof the runner has begun", () => {
  const { input, runs, startedSteps } = fixture();
  runs[0].status = "queued";
  runs[0].startedAt = undefined;
  const result = projectCoordinatorWorkflowNarration({
    ...input, orchestration: { workflow: input.workflow, status: "started", ...startedSteps[0] },
  });
  assert.equal(result.state, "queued");
  assert.equal(result.body, "Queued: Engineer");
  assert.deepEqual(result.verifiedRunIds, ["run_0"]);
});

test("mixed startup does not describe queued participants as started", () => {
  const { input, runs, startedSteps } = fixture();
  runs[1].status = "queued";
  runs[1].startedAt = undefined;
  const result = projectCoordinatorWorkflowNarration({ ...input, orchestration: {
    workflow: input.workflow, status: "started", ...startedSteps[0], startedSteps,
  } });
  assert.equal(result.body, "Run started: Engineer\n\nQueued: QA");
  assert.deepEqual(result.verifiedRunIds, ["run_0", "run_1"]);
});

test("all started participants retain exact Run identities without implying completion", () => {
  const { input, startedSteps } = fixture();
  const result = projectCoordinatorWorkflowNarration({ ...input, orchestration: {
    workflow: input.workflow, status: "started", ...startedSteps[0], startedSteps: [...startedSteps, startedSteps[0]],
  } });
  assert.equal(result.body, "Run started: Engineer, QA");
  assert.deepEqual(result.verifiedRunIds, ["run_0", "run_1"]);
});

for (const [runStatus, state, replyStatus, body] of [
  ["failed", "failed", "failed", "Failed: Engineer"],
  ["cancelled", "cancelled", "blocked", "Cancelled: Engineer"],
  ["waiting_for_approval", "waiting_for_approval", "blocked", "Waiting for approval: Engineer"],
  ["succeeded", "completed", "ready", "Run completed: Engineer"],
]) {
  test(`durable ${runStatus} Run overrides the earlier started dispatch envelope`, () => {
    for (const startedAt of [undefined, "2026-09-06T00:00:00.000Z"]) {
      const { input, runs, startedSteps } = fixture();
      runs[0].status = runStatus;
      runs[0].startedAt = startedAt;
      const result = projectCoordinatorWorkflowNarration({ ...input, orchestration: {
        workflow: input.workflow, status: "started", ...startedSteps[0],
      } });
      assert.equal(result.state, state);
      assert.equal(result.status, replyStatus);
      assert.equal(result.body, body);
      assert.deepEqual(result.verifiedRunIds, ["run_0"]);
      assert.doesNotMatch(result.body, /Queued|Run started/u);
    }
  });
}

test("one running participant does not hide another participant waiting for approval", () => {
  const { input, runs, startedSteps } = fixture();
  runs[1].status = "waiting_for_approval";
  const result = projectCoordinatorWorkflowNarration({ ...input, orchestration: {
    workflow: input.workflow, status: "started", ...startedSteps[0], startedSteps,
  } });
  assert.equal(result.state, "waiting_for_approval");
  assert.equal(result.status, "blocked");
  assert.equal(result.body, "Run started: Engineer\n\nWaiting for approval: QA");
  assert.deepEqual(result.verifiedRunIds, ["run_0", "run_1"]);
});

test("missing runtime status or running timestamp cannot invent queued or started evidence", () => {
  for (const field of ["status", "startedAt"]) {
    const { input, runs, startedSteps } = fixture();
    delete runs[0][field];
    const result = projectCoordinatorWorkflowNarration({ ...input, orchestration: {
      workflow: input.workflow, status: "started", ...startedSteps[0],
    } });
    assert.equal(result.status, "blocked");
    assert.doesNotMatch(result.body, /Queued|Run started/u);
  }
});

for (const field of ["workflowStepId", "channelId", "taskId", "teammateId"]) {
  test(`startup rejects mismatched Run ${field}`, () => {
    const { input, runs, startedSteps } = fixture();
    runs[0][field] = "foreign";
    const result = projectCoordinatorWorkflowNarration({ ...input, orchestration: { workflow: input.workflow, status: "started", ...startedSteps[0] } });
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.verifiedRunIds, []);
    assert.doesNotMatch(result.body, /Engineer|foreign|Started|Run started/u);
  });
}

test("startup rejects missing and stale Run/step links even with a started envelope", () => {
  for (const variant of ["missing-run-id", "empty-started-steps", "missing-run", "step-run", "step-workflow", "step-task", "response-workflow"]) {
    const { input, steps, runs, startedSteps } = fixture();
    const orchestration = { workflow: input.workflow, status: "started", ...startedSteps[0] };
    if (variant === "missing-run-id") delete orchestration.runId;
    if (variant === "empty-started-steps") orchestration.startedSteps = [];
    if (variant === "missing-run") runs.length = 0;
    if (variant === "step-run") steps[0].runId = "different_run";
    if (variant === "step-workflow") steps[0].workflowId = "different_workflow";
    if (variant === "step-task") steps[0].taskId = "different_task";
    if (variant === "response-workflow") orchestration.workflow = { ...input.workflow, id: "different_workflow" };
    const result = projectCoordinatorWorkflowNarration({ ...input, orchestration });
    assert.equal(result.status, "blocked", variant);
    assert.deepEqual(result.verifiedRunIds, [], variant);
  }
});

test("follow-user coordinator status respects Chinese input and escapes participant Markdown", () => {
  const { input, steps, startedSteps } = fixture();
  input.sourceMessage.body = "请读取当前项目";
  const pending = coordinatorWorkflowCheckingBody(input);
  assert.match(pending, /[\u3400-\u9fff]/u);
  steps[0].toParticipantLabel = "[Engineer](https://example.test)\nQA";
  const result = projectCoordinatorWorkflowNarration({ ...input, orchestration: { workflow: input.workflow, status: "started", ...startedSteps[0] } });
  assert.match(result.body, /[\u3400-\u9fff]/u);
  assert.match(result.body, /\\\[Engineer\\\]\\\(/u);
  assert.doesNotMatch(result.body, /\nQA/u);
});
