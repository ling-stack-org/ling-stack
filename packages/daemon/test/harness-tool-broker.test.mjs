import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSessionRunPolicy } from "../../core/dist/index.js";
import {
  executeHarnessedBashTool,
  executeHarnessedFileMutationTool,
  prepareHarnessBashApproval,
  prepareHarnessToolApproval,
  resolveHarnessBashApproval,
  resolveHarnessToolApproval,
} from "../dist/features/harness/tool-execution/broker.js";
import {
  createFileMutationActionDraft,
  createFileMutationRecoveryBasis,
} from "../dist/features/harness/tool-execution/executors/file-mutation.js";
import { reconcileHarnessToolExecutionsAtStartup } from "../dist/features/harness/tool-execution/recovery.js";
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

test("enforced broker owns native write effects and commits patch evidence", async t => {
  const f = await fixture(t, "file-write");
  const request = {
    toolCallId: "call-file-write",
    toolName: "write",
    cwd: f.cwd,
    task: f.task,
    input: { path: "result.txt", content: "daemon-owned\n" },
  };
  const draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });

  const handled = await executeHarnessedFileMutationTool({
    mode: "enforce",
    store: f.store,
    sourceFence: f.sourceFence,
    run: f.run,
    request,
    draft,
    allowedWritePaths: [f.cwd],
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data),
  });

  assert.equal(handled.isError, undefined);
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "daemon-owned\n");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.executorKind, "write");
  assert.equal(execution.state, "succeeded");
  assert.equal(execution.evidenceArtifactIds.length, 3);
  assert.ok(execution.evidenceArtifactIds.every(id => f.store.getArtifact(id)?.runId === f.run.id));
  const policy = f.store.getArtifact(execution.policySnapshotArtifactId);
  assert.deepEqual(policy.sealedPayload.fileMutationRecovery.touchedPaths, ["result.txt"]);
  assert.equal(JSON.stringify(policy.sealedPayload).includes("daemon-owned"), false);
});

test("enforced broker applies multi-file patch under one execution identity", async t => {
  const f = await fixture(t, "file-patch");
  await writeFile(join(f.cwd, "existing.txt"), "old\n", "utf8");
  const patchText = `*** Begin Patch
*** Update File: existing.txt
@@
-old
+new
*** Add File: added.txt
+added
*** End Patch`;
  const request = {
    toolCallId: "call-file-patch",
    toolName: "edit",
    cwd: f.cwd,
    task: f.task,
    input: { patchText },
  };
  const draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });

  const handled = await executeHarnessedFileMutationTool({
    mode: "enforce",
    store: f.store,
    sourceFence: f.sourceFence,
    run: f.run,
    request,
    draft,
    allowedWritePaths: [f.cwd],
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data),
  });

  assert.equal(handled.isError, undefined);
  assert.equal(await readFile(join(f.cwd, "existing.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(f.cwd, "added.txt"), "utf8"), "added\n");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.executorKind, "apply_patch");
  assert.equal(execution.state, "succeeded");
});

test("file approval restart creates a fenced successor before applying the mutation", async t => {
  const f = await fixture(t, "file-approval-restart");
  const request = {
    toolCallId: "call-file-approval-restart",
    toolName: "write",
    cwd: f.cwd,
    task: f.task,
    input: { path: "recovered.txt", content: "recovered\n" },
  };
  const draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });
  const approval = f.store.createApprovalRequest({
    runId: f.run.id,
    taskId: f.run.taskId,
    toolCallId: request.toolCallId,
    actionType: "write",
    risk: "medium",
    title: "Recover approved file mutation",
    description: "Harness file approval restart fixture",
    payload: draft.payload,
  }, new Date().toISOString());
  const oldExecution = prepareHarnessToolApproval({
    mode: "enforce",
    store: f.store,
    sourceFence: f.sourceFence,
    run: f.run,
    request,
    approvalId: approval.id,
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    executorKind: draft.executorKind,
    recoveryBasis: createFileMutationRecoveryBasis(draft),
    approvalState: "approval_pending",
  });
  f.store.approveApprovalRequest(approval.id, { reason: "Approved after daemon restart" }, new Date().toISOString());
  const successorAttempt = f.store.createWorkUnitAttempt({
    workUnitId: f.sourceFence.workUnitId,
    attemptNumber: 2,
    runtimeInstanceId: "file-runtime-recovered",
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

  const handled = await executeHarnessedFileMutationTool({
    mode: "enforce",
    store: f.store,
    sourceFence,
    run: f.run,
    request,
    draft,
    allowedWritePaths: [f.cwd],
    approvalId: approval.id,
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data),
  });

  assert.equal(handled.isError, undefined);
  assert.equal(await readFile(join(f.cwd, "recovered.txt"), "utf8"), "recovered\n");
  const executions = f.store.listHarnessToolExecutions(f.run.id);
  assert.equal(executions.length, 2);
  assert.equal(f.store.getHarnessToolExecution(oldExecution.id).state, "superseded");
  const successor = executions.find(execution => execution.id !== oldExecution.id);
  assert.equal(successor.state, "succeeded");
  assert.equal(successor.supersedesExecutionId, oldExecution.id);
});

test("a stale Attempt cannot apply a file mutation", async t => {
  const f = await fixture(t, "file-stale-attempt");
  const request = {
    toolCallId: "call-file-stale-attempt",
    toolName: "write",
    cwd: f.cwd,
    task: f.task,
    input: { path: "stale.txt", content: "must not exist\n" },
  };
  const draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });
  f.store.createWorkUnitAttempt({
    workUnitId: f.sourceFence.workUnitId,
    attemptNumber: 2,
    runtimeInstanceId: "file-runtime-current",
    runnerId: "pi",
    status: "started",
    now: new Date().toISOString(),
  });

  const handled = await executeHarnessedFileMutationTool({
    mode: "enforce",
    store: f.store,
    sourceFence: f.sourceFence,
    run: f.run,
    request,
    draft,
    allowedWritePaths: [f.cwd],
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data),
  });

  assert.equal(handled.isError, true);
  assert.match(handled.content[0].text, /tool_broker_prepare_failed: tool\.lineage_mismatch/u);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 0);
  await assert.rejects(readFile(join(f.cwd, "stale.txt"), "utf8"), /ENOENT/);
});

test("file cancellation is durably recorded after the atomic effect is rolled back", async t => {
  const f = await fixture(t, "file-cancel");
  const request = {
    toolCallId: "call-file-cancel",
    toolName: "write",
    cwd: f.cwd,
    task: f.task,
    input: { path: "cancelled.txt", content: "temporary\n" },
  };
  const draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });
  let checks = 0;
  const signal = {
    get aborted() { checks += 1; return checks >= 3; },
    reason: Object.assign(new Error("cancel-after-create"), { name: "AbortError" }),
  };

  const handled = await executeHarnessedFileMutationTool({
    mode: "enforce",
    store: f.store,
    sourceFence: f.sourceFence,
    run: f.run,
    request,
    draft,
    allowedWritePaths: [f.cwd],
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data),
    signal,
  });

  assert.equal(handled.isError, true);
  assert.equal(handled.details.cancelled, true);
  assert.equal(handled.details.outcome, "rolled_back");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.state, "cancelled");
  assert.equal(execution.failureCode, "tool.execution_cancelled");
  await assert.rejects(readFile(join(f.cwd, "cancelled.txt"), "utf8"), /ENOENT/);
});

test("policy drift after Run capture fails the file execution before mutation", async t => {
  const f = await fixture(t, "file-policy-drift");
  const request = {
    toolCallId: "call-file-policy-drift",
    toolName: "write",
    cwd: f.cwd,
    task: f.task,
    input: { path: "blocked.txt", content: "must not exist" },
  };
  const draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });
  f.store.updateApprovalPolicy({ allowedWritePaths: ["revoked"] }, new Date(Date.now() + 1000).toISOString());

  const handled = await executeHarnessedFileMutationTool({
    mode: "enforce",
    store: f.store,
    sourceFence: f.sourceFence,
    run: f.run,
    request,
    draft,
    allowedWritePaths: [f.cwd],
    effectivePolicySnapshot: f.effectivePolicySnapshot,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data),
  });

  assert.equal(handled.isError, true);
  assert.match(handled.content[0].text, /tool_policy_changed/);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id)[0].state, "failed");
  await assert.rejects(readFile(join(f.cwd, "blocked.txt"), "utf8"), /ENOENT/);
});

for (const [name, observedContent, expectedState, expectedFailure] of [
  ["not-applied", undefined, "failed", "tool.executor_failed"],
  ["applied", "after\n", "succeeded", undefined],
  ["diverged", "someone-else\n", "unknown_outcome", "tool.unknown_side_effect_outcome"],
]) {
  test(`startup recovery classifies an expired file mutation as ${name}`, async t => {
    const f = await fixture(t, `file-recovery-${name}`);
    await writeFile(join(f.cwd, "recover.txt"), "before\n", "utf8");
    const request = {
      toolCallId: `call-file-recovery-${name}`,
      toolName: "write",
      cwd: f.cwd,
      task: f.task,
      input: { path: "recover.txt", content: "after\n" },
    };
    const draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });
    const approval = f.store.createApprovalRequest({
      runId: f.run.id,
      taskId: f.run.taskId,
      toolCallId: request.toolCallId,
      actionType: "write",
      risk: "medium",
      title: "Recover file mutation",
      description: "Harness file recovery fixture",
      payload: draft.payload,
    }, new Date().toISOString());
    const context = {
      mode: "enforce",
      store: f.store,
      sourceFence: f.sourceFence,
      run: f.run,
      request,
      approvalId: approval.id,
      effectivePolicySnapshot: f.effectivePolicySnapshot,
      executorKind: draft.executorKind,
      recoveryBasis: createFileMutationRecoveryBasis(draft),
    };
    const pending = prepareHarnessToolApproval({ ...context, approvalState: "approval_pending" });
    f.store.approveApprovalRequest(approval.id, { reason: "approved before crash" }, new Date().toISOString());
    const approved = resolveHarnessToolApproval({ ...context, nextState: "approved" });
    assert.equal(approved.id, pending.id);
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + 1000).toISOString();
    const claim = f.store.claimHarnessToolExecution({
      executionId: approved.id,
      expectedRevision: approved.revision,
      claimOwner: "daemon:crashed",
      claimToken: `claim-${name}`,
      claimExpiresAt: expiresAt,
      sourceFence: f.sourceFence,
      now: startedAt.toISOString(),
    });
    assert.equal(claim.ok, true);
    const started = f.store.startHarnessToolExecution({
      executionId: approved.id,
      expectedRevision: claim.value.revision,
      claimOwner: claim.value.claimOwner,
      claimToken: claim.value.claimToken,
      sourceFence: f.sourceFence,
      now: startedAt.toISOString(),
    });
    assert.equal(started.ok, true);
    if (observedContent !== undefined) await writeFile(join(f.cwd, "recover.txt"), observedContent, "utf8");

    const recovered = reconcileHarnessToolExecutionsAtStartup({
      cwd: f.cwd,
      store: f.store,
      now: new Date(startedAt.getTime() + 2000).toISOString(),
    });

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].state, expectedState);
    assert.equal(recovered[0].failureCode, expectedFailure);
    assert.equal(recovered[0].resultSummary.outcome, name.replace("-", "_"));
    assert.ok(recovered[0].evidenceArtifactIds.includes(recovered[0].policySnapshotArtifactId));
  });
}
