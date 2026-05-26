import assert from "node:assert/strict";
import { test } from "node:test";
import {
  transitionApproval,
  transitionMediaJob,
  transitionRun,
  transitionTask,
  transitionWorkflow,
  transitionWorkflowStep,
} from "../dist/index.js";

test("task transitions follow the normal todo to done path", () => {
  const claim = transitionTask({
    entityId: "task_1",
    currentStatus: "todo",
    event: "claim",
    actor: "system",
  });
  assert.deepEqual(claim, { ok: true, from: "todo", to: "claimed" });

  const start = transitionTask({
    entityId: "task_1",
    currentStatus: claim.to,
    expectedStatus: "claimed",
    event: "start_run",
    actor: "runner",
  });
  assert.deepEqual(start, { ok: true, from: "claimed", to: "running" });

  const done = transitionTask({
    entityId: "task_1",
    currentStatus: start.to,
    expectedStatus: "running",
    event: "run_succeeded",
    actor: "runner",
  });
  assert.deepEqual(done, { ok: true, from: "running", to: "done" });
});

test("terminal task states cannot return to active execution", () => {
  const result = transitionTask({
    entityId: "task_done",
    currentStatus: "done",
    event: "start_run",
    actor: "runner",
  });

  assert.deepEqual(result, {
    ok: false,
    code: "terminal_state",
    currentStatus: "done",
  });
});

test("stale expected status is rejected before applying a transition", () => {
  const result = transitionTask({
    entityId: "task_cancelled",
    currentStatus: "cancelled",
    expectedStatus: "running",
    event: "run_succeeded",
    actor: "runner",
  });

  assert.deepEqual(result, {
    ok: false,
    code: "stale_transition",
    currentStatus: "cancelled",
  });
});

test("run approval round trip returns to running only after approval", () => {
  const waiting = transitionRun({
    entityId: "run_1",
    currentStatus: "running",
    event: "approval_requested",
    actor: "system",
  });
  assert.deepEqual(waiting, { ok: true, from: "running", to: "waiting_for_approval" });

  const approved = transitionRun({
    entityId: "run_1",
    currentStatus: waiting.to,
    expectedStatus: "waiting_for_approval",
    event: "approval_approved",
    actor: "local-user",
  });
  assert.deepEqual(approved, { ok: true, from: "waiting_for_approval", to: "running" });
});

test("approval states are terminal after a decision", () => {
  const approved = transitionApproval({
    entityId: "approval_1",
    currentStatus: "pending",
    event: "approve",
    actor: "local-user",
  });
  assert.deepEqual(approved, { ok: true, from: "pending", to: "approved" });

  const approveAgain = transitionApproval({
    entityId: "approval_1",
    currentStatus: "approved",
    event: "approve",
    actor: "local-user",
  });
  assert.deepEqual(approveAgain, {
    ok: false,
    code: "terminal_state",
    currentStatus: "approved",
  });
});

test("media job and workflow transitions require state machine events", () => {
  assert.deepEqual(
    transitionMediaJob({
      entityId: "media_job_1",
      currentStatus: "queued",
      event: "cost_approval_required",
      actor: "provider",
    }),
    { ok: true, from: "queued", to: "waiting_for_approval" },
  );

  assert.deepEqual(
    transitionWorkflow({
      entityId: "workflow_1",
      currentStatus: "ready",
      event: "start",
      actor: "system",
    }),
    { ok: true, from: "ready", to: "running" },
  );

  assert.deepEqual(
    transitionWorkflowStep({
      entityId: "workflow_step_1",
      currentStatus: "queued",
      event: "claim",
      actor: "ai-teammate",
    }),
    { ok: true, from: "queued", to: "claimed" },
  );
});
