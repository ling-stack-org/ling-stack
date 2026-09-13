import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSessionRunPolicy } from "../../core/dist/index.js";
import {
  executeHarnessedBashTool,
  prepareHarnessBashApproval,
  resolveHarnessBashApproval,
} from "../dist/features/harness/tool-execution/broker.js";
import { listExecutionActions } from "../dist/features/runs/execution-actions.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

async function fixture(t, name) {
  const cwd = await mkdtemp(join(tmpdir(), `ling-harness-tool-broker-${name}-`));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: `task-${name}`, title: "Harness broker", prompt: "Isolated broker fixture" };
  const f = createUnifiedExecFixture(t, cwd, task, `run-${name}`);
  const effectivePolicySnapshot = resolveSessionRunPolicy({
    workspacePolicy: f.store.getApprovalPolicy(),
    authorizationMode: "always",
    workspaceAccessMode: "workspace_write",
  }).snapshot;
  const events = [];
  return {
    ...f,
    cwd,
    task,
    effectivePolicySnapshot,
    events,
    request(command, toolCallId = `call-${name}`, extra = {}) {
      return {
        toolCallId,
        toolName: "bash",
        cwd,
        task,
        input: { command, timeoutMs: 5000, ...extra },
      };
    },
    execute(request, extra = {}) {
      return executeHarnessedBashTool({
        mode: "enforce",
        store: f.store,
        run: f.run,
        sourceFence: f.sourceFence,
        request,
        effectivePolicySnapshot,
        appendAndMaybeStream(type, data) {
          events.push({ type, data });
          return f.store.appendEvent(f.run.id, type, data);
        },
        ...extra,
      });
    },
  };
}

test("enforced broker commits successful command evidence under one durable identity", async t => {
  const f = await fixture(t, "success");
  const handled = await f.execute(f.request("printf 'broker-ok'"));
  assert.equal(handled.isError, false);
  assert.equal(handled.details.unifiedExec.status, "succeeded");
  const executions = f.store.listHarnessToolExecutions(f.run.id);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].state, "succeeded");
  assert.equal(executions[0].failureCode, undefined);
  assert.ok(executions[0].executionStartedAt);
  assert.ok(executions[0].executionFinishedAt);
  assert.ok(executions[0].evidenceArtifactIds.length >= 2);
  assert.ok(executions[0].evidenceArtifactIds.every(id => f.store.getArtifact(id)?.runId === f.run.id));
  assert.ok(f.store.getArtifact(executions[0].policySnapshotArtifactId));
  const [action] = listExecutionActions(f.store, { runId: f.run.id, complete: true });
  assert.equal(action.status, "succeeded");
  assert.deepEqual(action.resultArtifactIds, executions[0].evidenceArtifactIds);
  assert.ok(action.sourceRefs.some(ref => ref.kind === "harness_tool_execution" && ref.id === executions[0].id));
});

test("enforced broker records a known non-zero exit as failed, not unknown", async t => {
  const f = await fixture(t, "failure");
  const handled = await f.execute(f.request("printf 'expected failure' >&2; exit 7"));
  assert.equal(handled.isError, true);
  assert.equal(handled.details.unifiedExec.exitCode, 7);
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.state, "failed");
  assert.equal(execution.failureCode, "tool.executor_failed");
  assert.ok(execution.evidenceArtifactIds.length >= 2);
});

test("approval pending, approval resolution, and execution reuse the same ToolExecution", async t => {
  const f = await fixture(t, "approval");
  const request = f.request("printf 'approved'", "call-approval");
  const approval = f.store.createApprovalRequest({
    runId: f.run.id,
    taskId: f.run.taskId,
    toolCallId: request.toolCallId,
    actionType: "bash",
    risk: "medium",
    title: "Run isolated command",
    description: "Harness broker approval fixture",
    payload: { type: "bash", cwd: f.cwd, command: request.input.command, riskFlags: [] },
  }, new Date().toISOString());
  const context = {
    mode: "enforce",
    store: f.store,
    sourceFence: f.sourceFence,
    run: f.run,
    request,
    approvalId: approval.id,
    effectivePolicySnapshot: f.effectivePolicySnapshot,
  };
  const pending = prepareHarnessBashApproval({ ...context, approvalState: "approval_pending" });
  assert.equal(pending.state, "approval_pending");
  f.store.approveApprovalRequest(approval.id, { reason: "Approved fixture" }, new Date().toISOString());
  const approved = resolveHarnessBashApproval({ ...context, nextState: "approved" });
  assert.equal(approved.id, pending.id);
  assert.equal(approved.state, "approved");
  const handled = await f.execute(request, { approvalId: approval.id });
  assert.equal(handled.isError, false);
  const executions = f.store.listHarnessToolExecutions(f.run.id);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].id, pending.id);
  assert.equal(executions[0].state, "succeeded");
});

test("approval restart creates a fenced successor and supersedes the old pre-effect execution", async t => {
  const f = await fixture(t, "approval-restart");
  const request = f.request("printf 'recovered'", "call-approval-restart");
  const approval = f.store.createApprovalRequest({
    runId: f.run.id,
    taskId: f.run.taskId,
    toolCallId: request.toolCallId,
    actionType: "bash",
    risk: "medium",
    title: "Run recovered command",
    description: "Harness broker restart fixture",
    payload: { type: "bash", cwd: f.cwd, command: request.input.command, riskFlags: [] },
  }, new Date().toISOString());
  const oldExecution = prepareHarnessBashApproval({
    mode: "enforce",
    store: f.store,
    sourceFence: f.sourceFence,
    run: f.run,
    request,
    approvalId: approval.id,
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    approvalState: "approval_pending",
  });
  f.store.approveApprovalRequest(approval.id, { reason: "Approved after daemon restart" }, new Date().toISOString());
  const successorAttempt = f.store.createWorkUnitAttempt({
    workUnitId: f.sourceFence.workUnitId,
    attemptNumber: 2,
    runtimeInstanceId: "exec-runtime-recovered",
    runnerId: "pi",
    status: "started",
    now: new Date().toISOString(),
  });
  const sourceFence = {
    workUnitId: successorAttempt.workUnitId,
    attemptId: successorAttempt.id,
    runtimeInstanceId: successorAttempt.runtimeInstanceId,
    fencingToken: successorAttempt.fencingToken,
  };
  const handled = await executeHarnessedBashTool({
    mode: "enforce",
    store: f.store,
    sourceFence,
    run: f.run,
    request,
    approvalId: approval.id,
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data),
  });
  assert.equal(handled.isError, false);
  const executions = f.store.listHarnessToolExecutions(f.run.id);
  assert.equal(executions.length, 2);
  assert.equal(f.store.getHarnessToolExecution(oldExecution.id).state, "superseded");
  const successor = executions.find(execution => execution.id !== oldExecution.id);
  assert.equal(successor.state, "succeeded");
  assert.equal(successor.supersedesExecutionId, oldExecution.id);
});

test("timeout with an unverified stop is persisted as unknown_outcome and cannot be retried", { timeout: 6000 }, async t => {
  const f = await fixture(t, "timeout");
  const request = f.request("sleep 2", "call-timeout", { timeoutMs: 50 });
  const handled = await f.execute(request);
  assert.equal(handled.isError, true);
  assert.equal(handled.details.unifiedExec.status, "timed_out");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.state, "unknown_outcome");
  assert.equal(execution.failureCode, "tool.unknown_side_effect_outcome");
  const [action] = listExecutionActions(f.store, { runId: f.run.id, complete: true });
  assert.equal(action.status, "failed");
  assert.match(action.summary, /could not be confirmed/u);
  assert.ok(action.sourceRefs.some(ref => ref.kind === "harness_tool_execution" && ref.id === execution.id));
  const replay = await f.execute(request);
  assert.equal(replay.isError, true);
  assert.match(replay.content[0].text, /already_terminal: unknown_outcome/u);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 1);
  assert.equal(f.store.listEvents(f.run.id).filter(event => event.type === "host_command_prepared").length, 1);
});

test("cancellation durably closes the broker claim before AbortError escapes", { timeout: 6000 }, async t => {
  const f = await fixture(t, "cancel");
  const controller = new AbortController();
  const request = f.request("printf 'ready%0512d' 1; sleep 2", "call-cancel");
  await assert.rejects(f.execute(request, {
    signal: controller.signal,
    appendAndMaybeStream(type, data) {
      f.events.push({ type, data });
      const event = f.store.appendEvent(f.run.id, type, data);
      if (type === "tool_update") controller.abort();
      return event;
    },
  }), { name: "AbortError" });
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.state, "unknown_outcome");
  assert.equal(execution.failureCode, "tool.unknown_side_effect_outcome");
  assert.ok(execution.executionFinishedAt);
});
