import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("health includes the configured default workspace cwd", async () => {
  const defaultWorkspaceCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-health-cwd-"));
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd,
  }, {
    runner: new ApprovalProbeRunner({
      toolCallId: "tool_health",
      toolName: "bash",
      input: { command: "echo unused" },
    }),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");

  try {
    const health = await getJson(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.ok, true);
    assert.equal(health.service, "ling-stack-daemon");
    assert.equal(health.defaultWorkspaceCwd, defaultWorkspaceCwd);
  } finally {
    await daemon.stop();
    await rm(defaultWorkspaceCwd, { recursive: true, force: true });
  }
});

test("runtime runner settings api seeds Pi defaults and explicit runner requests fail closed", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runner-settings-"));
  const runner = new ThreadResumeRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const runners = await getJson(`${daemon.url}/runners?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runners.cwd, cwd);
    assert.equal(runners.runners.some((item) => item.id === "pi" && item.status === "enabled"), true);

    const seeded = await getJson(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(seeded.settings, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      defaultRunnerId: "pi",
      allowedRunnerIds: ["pi"],
      explicitRunnerFallback: "disabled",
      implicitRunnerFallback: "allow_to_default",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });

    const patched = await patchJson(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`, {
      explicitRunnerFallback: "allow_to_default",
    });
    assert.equal(patched.settings.explicitRunnerFallback, "allow_to_default");
    assert.ok(Date.parse(patched.settings.updatedAt));

    const invalid = await patchJsonExpectError(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`, {
      defaultRunnerId: "codex-app-server",
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "bad_request");

    await patchJson(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`, {
      explicitRunnerFallback: "disabled",
    });
    const explicit = await postRunExpectError(daemon.url, {
      ...runBody(cwd, "task_explicit_unknown_runner"),
      runnerId: "codex-app-server",
    });
    assert.equal(explicit.status, 400);
    assert.equal(explicit.body.error, "unsupported_runner");

    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_workspace_default_runner"));
    assert.ok(runId);
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.requestSnapshot.runnerResolution.requestSource, "workspace_default");
    assert.equal(run.requestSnapshot.runnerResolution.fallbackAllowed, true);
    assert.equal(run.requestSnapshot.runnerResolution.effectiveRunnerId, "pi");
    assert.equal(run.requestSnapshot.runtimeSettings.defaultRunnerId, "pi");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bash=allow lets the runner continue without creating an approval request", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_allow",
    toolName: "bash",
    input: { command: "echo ok" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_bash_allow"));

    assert.equal(runner.decisions.length, 1);
    assert.deepEqual(runner.decisions[0], {
      approved: true,
      reason: "Ling Stack policy allowed bash.",
    });
    assert.equal(events.some((event) => event.event === "approval_requested"), false);
    assert.deepEqual(await listApprovals(daemon.url, cwd, runId), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("assignee approval profile tightens workspace approval policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-profile-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_profile",
    toolName: "bash",
    input: { command: "echo profile-gated" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const response = await postRunStream(daemon.url, {
      ...runBody(cwd, "task_bash_profile"),
      approvalProfile: {
        mode: "standard",
        risk: "medium",
        requiredForTools: ["bash"],
      },
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;

    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;
    const approval = await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "profile approval",
    });
    assert.equal(approval.approval.status, "approved");

    const remaining = await sse.collectRemaining();
    assert.deepEqual(runner.decisions, [{
      approved: true,
      approvalId,
      reason: "profile approval",
    }]);
    assert.equal(remaining.some((event) => event.event === "approval_approved"), true);
    assert.equal((await listApprovals(daemon.url, cwd, runId)).length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session permission mode snapshots the effective run policy without relaxing deny rules", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-session-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_session_policy",
    toolName: "write",
    input: { path: "notes/session.md", content: "mode snapshot" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, {
      toolDecisions: {
        bash: "deny",
        write: "deny",
      },
      allowedWritePaths: ["docs"],
    });
    const { runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_session_policy_snapshot"),
      permissionMode: "full_access",
      permissionConfirmation: {
        mode: "full_access",
        confirmed: true,
        confirmedAt: "2026-06-04T00:00:00.000Z",
        reason: "test_confirmed_full_access",
      },
    });

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.requestSnapshot.permissionMode, "full_access");
    assert.equal(run.requestSnapshot.permissionConfirmation.reason, "test_confirmed_full_access");
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.mode, "full_access");
    assert.equal(typeof run.requestSnapshot.effectivePolicySnapshot.workspacePolicyUpdatedAt, "string");
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.toolDecisions.bash, "deny");
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.toolDecisions.write, "deny");
    assert.deepEqual(run.requestSnapshot.effectivePolicySnapshot.allowedWritePaths, ["/"]);
    assert.ok(run.requestSnapshot.effectivePolicySnapshot.riskNotes.some((note) =>
      note.code === "session_mode_denied_by_workspace_policy" && /workspace policy denied/.test(note.message)
    ));
    assert.equal(runner.decisions[0].approved, false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("full access permission mode requires explicit confirmation before creating a run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-session-policy-confirm-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_full_access_confirm",
    toolName: "write",
    input: { path: "notes/session.md", content: "mode snapshot" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const rejected = await postRunExpectError(daemon.url, {
      ...runBody(cwd, "task_full_access_missing_confirmation"),
      permissionMode: "full_access",
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "full_access_confirmation_required");

    const runs = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runs.runs.length, 0);
    assert.equal(runner.decisions.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bash=deny records an immediately denied approval request", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_deny",
    toolName: "bash",
    input: { command: "echo blocked" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "deny" } });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_bash_deny"));
    const approvals = await listApprovals(daemon.url, cwd, runId);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /policy denied bash/);
    assert.deepEqual(events.filter((event) => event.event.startsWith("approval_")).map((event) => event.event), [
      "approval_requested",
      "approval_denied",
    ]);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].actionType, "bash");
    assert.match(approvals[0].decisionReason, /policy denied bash/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bash=ask pauses the run until the approval is resolved", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_ask",
    toolName: "bash",
    input: { command: "echo approve-me" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_bash_ask"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;

    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;
    const waitingRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(waitingRun.status, "waiting_for_approval");
    assert.ok(waitingRun.threadId);

    const waitingThread = await getJson(`${daemon.url}/threads/${encodeURIComponent(waitingRun.threadId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(waitingThread.thread.kind, "task");
    assert.equal(waitingThread.thread.taskId, "task_bash_ask");
    assert.equal(waitingThread.thread.status, "waiting_for_approval");
    assert.equal(waitingThread.thread.activeRunId, runId);

    const pendingActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(pendingActions.actions.length, 1);
    assert.equal(pendingActions.actions[0].approvalId, approvalId);
    assert.equal(pendingActions.actions[0].threadId, waitingRun.threadId);
    assert.equal(pendingActions.actions[0].workUnitId, waitingRun.workUnitId);
    assert.equal(pendingActions.actions[0].actionType, "bash");
    assert.equal(pendingActions.actions[0].status, "waiting_for_approval");
    assert.equal(pendingActions.actions[0].targetRefs.some((ref) => ref.type === "command" && ref.label === "echo approve-me"), true);
    assert.equal(pendingActions.actions[0].policySnapshot.toolDecisions.bash, "ask");

    const resolved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "test approval",
    });
    assert.equal(resolved.approval.status, "approved");

    const remaining = await sse.collectRemaining();
    assert.equal(runner.decisions.length, 1);
    assert.deepEqual(runner.decisions[0], {
      approved: true,
      approvalId,
      reason: "test approval",
    });
    assert.equal(remaining.some((event) => event.event === "approval_approved"), true);
    assert.equal(remaining.some((event) => event.event === "result"), true);
    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "succeeded");
    const finalThread = await getJson(`${daemon.url}/threads/${encodeURIComponent(waitingRun.threadId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalThread.thread.status, "succeeded");
    assert.equal(finalThread.thread.activeRunId, undefined);
    assert.equal(finalThread.thread.lastRunId, runId);

    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const second = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_bash_ask"));
    const secondRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(second.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(secondRun.threadId, waitingRun.threadId);
    const runsForThread = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}&threadId=${encodeURIComponent(waitingRun.threadId)}`);
    assert.deepEqual(runsForThread.runs.map((run) => run.id), [second.runId, runId]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval execution actions expose preview and result artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-action-artifacts-"));
  const runner = new ApprovalArtifactRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, {
      ...runBody(cwd, "task_action_artifacts"),
      tools: ["bash"],
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;
    assert.equal(requested.data.data.previewArtifactIds.length, 1);

    const waitingActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(waitingActions.actions.length, 1);
    assert.deepEqual(waitingActions.actions[0].previewArtifactIds, requested.data.data.previewArtifactIds);
    assert.deepEqual(waitingActions.actions[0].resultArtifactIds, []);

    const previewContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(waitingActions.actions[0].previewArtifactIds[0])}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(previewContent.status, 200);
    const previewText = await previewContent.text();
    assert.match(previewText, /\[REDACTED\]/);
    assert.doesNotMatch(previewText, /sk-test_action_preview_secret/);

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "artifact approval",
    });
    await sse.collectRemaining();

    const completedActions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(completedActions.actions.length, 1);
    assert.equal(completedActions.actions[0].status, "approved");
    assert.equal(completedActions.actions[0].resultArtifactIds.length, 1);
    const resultContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(completedActions.actions[0].resultArtifactIds[0])}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(resultContent.status, 200);
    assert.match(await resultContent.text(), /approved stdout artifact/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread evidence and manual resume preserve Ling-owned lineage", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-thread-resume-"));
  const runner = new ThreadResumeRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const first = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_thread_resume"));
    assert.ok(first.runId);

    const threads = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&taskId=task_thread_resume`);
    assert.equal(threads.threads.length, 1);
    const thread = threads.threads[0];
    assert.equal(thread.lastRunId, first.runId);
    assert.equal(thread.status, "succeeded");

    const evidence = await getJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(evidence.thread.id, thread.id);
    assert.equal(evidence.runs.length, 1);
    assert.equal(evidence.runs[0].run.id, first.runId);
    assert.equal(evidence.runs[0].events.some((event) => event.type === "run_created"), true);
    assert.equal(evidence.runs[0].runtimeEvents.some((event) => event.type === "work_unit_started"), true);

    const preview = await postJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/resume-preview?cwd=${encodeURIComponent(cwd)}`, {
      sourceRunId: first.runId,
      instruction: "Continue after manual resume.",
      includeArtifacts: true,
    });
    assert.equal(preview.sourceRun.id, first.runId);
    assert.equal(preview.context.sourceRunId, first.runId);
    assert.deepEqual(preview.context.priorRunIds, [first.runId]);
    assert.equal(preview.context.includedEventCount > 0, true);
    assert.match(preview.context.contextText, /Continue after manual resume/);

    const resumed = await postJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/resume?cwd=${encodeURIComponent(cwd)}`, {
      instruction: "Continue after manual resume.",
      idempotencyKey: "thread-resume-test",
    });
    assert.equal(resumed.continuationReason, "manual_resume");
    assert.equal(resumed.sourceRun.id, first.runId);
    assert.ok(resumed.runId);
    assert.notEqual(resumed.runId, first.runId);

    await waitForCondition(async () => {
      const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(resumed.runId)}?cwd=${encodeURIComponent(cwd)}`);
      return run.status === "succeeded";
    }, "manual resume run should finish");

    const continuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(resumed.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(continuation.threadId, thread.id);
    assert.equal(continuation.parentRunId, first.runId);
    assert.equal(continuation.continuationReason, "manual_resume");
    assert.match(continuation.taskSnapshot.prompt, /not a native runner session resume/);

    const updatedThread = await getJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(updatedThread.thread.lastRunId, resumed.runId);
    assert.equal(updatedThread.thread.status, "succeeded");

    const resumedEvidence = await getJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(resumedEvidence.runs.map((entry) => entry.run.id), [first.runId, resumed.runId]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write=deny blocks file writes through the run approval chain", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_deny",
    toolName: "write",
    input: { path: "docs/out.txt", content: "blocked" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { write: "deny" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_write_deny"));
    const approvals = await listApprovals(daemon.url, cwd, runId);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /policy denied write/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].actionType, "write");
    assert.equal(approvals[0].payload.path, "docs/out.txt");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write outside allowed paths is denied even when write is allowed", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_outside",
    toolName: "write",
    input: { path: "src/out.txt", content: "outside" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, {
      toolDecisions: { write: "allow" },
      allowedWritePaths: ["docs"],
    });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_write_outside"));
    const approvals = await listApprovals(daemon.url, cwd, runId);
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&runId=${encodeURIComponent(runId)}`);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /outside allowed write paths/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].payload.path, "src/out.txt");
    assert.deepEqual(pending.approvals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval listing lazily expires stale pending requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-approval-expiry-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_expiry",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  const runId = "run_stale_approval";
  const approvalCreatedAt = "2000-01-01T00:00:00.000Z";
  let approvalId = "";
  try {
    const store = createSqliteRunStore(cwd);
    try {
      store.createRun({
        id: runId,
        cwd,
        taskId: "task_stale_approval",
        providerName: "test-provider",
        providerModel: "test-model",
        taskSnapshot: { id: "task_stale_approval", title: "Stale approval" },
        providerSnapshot: { provider: "test-provider", model: "test-model" },
        requestSnapshot: { cwd },
        createdAt: approvalCreatedAt,
      });
      const approval = store.createApprovalRequest(
        {
          runId,
          taskId: "task_stale_approval",
          actionType: "bash",
          risk: "medium",
          title: "Approve shell command",
          description: "echo stale",
          payload: { type: "bash", cwd, command: "echo stale", riskFlags: [] },
          expiresAt: "2000-01-01T00:01:00.000Z",
        },
        approvalCreatedAt,
      );
      approvalId = approval.id;
    } finally {
      store.close();
    }

    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&runId=${encodeURIComponent(runId)}`);
    assert.deepEqual(pending.approvals, []);

    const expired = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=expired&runId=${encodeURIComponent(runId)}`);
    assert.equal(expired.approvals.length, 1);
    assert.equal(expired.approvals[0].id, approvalId);
    assert.equal(expired.approvals[0].status, "expired");
    assert.equal(expired.approvals[0].resolvedBy, undefined);

    const events = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/events?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(events.events.some((event) => event.type === "approval_expired" && event.data.approvalId === approvalId), true);

    const lateApprove = await fetch(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "too late" }),
    });
    assert.equal(lateApprove.status, 400);
    assert.equal((await lateApprove.json()).error, "approval_not_pending");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider check persists last check result", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "jimeng",
      displayName: "Jimeng Image",
      providerId: "jimeng",
      model: "jimeng-image",
      api: "media-job",
      baseUrl: "https://visual.volcengineapi.com",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      capabilities: ["image_generate"],
      input: ["text", "image"],
      authHeader: false,
      enabled: true,
    });
    const providerId = created.provider.id;

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, false);
    assert.equal(checkResult.code, "unsupported_live_probe");
    assert.match(checkResult.message, /does not support a real check yet/);

    const fetched = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(fetched.provider.lastCheck.ok, false);
    assert.equal(fetched.provider.lastCheck.code, "unsupported_live_probe");
    assert.equal(fetched.provider.lastCheck.checkedAt, checkResult.checkedAt);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("secret status reports configured, missing, unavailable, and invalid refs without values", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-secret-status-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_secret_status",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_SECRET_STATUS_KEY = "status-secret-value";
  try {
    const configured = await getJson(`${daemon.url}/secrets/status?ref=env%3ALING_STACK_SECRET_STATUS_KEY&purpose=provider_api_key`);
    assert.equal(configured.status.configured, true);
    assert.equal(configured.status.kind, "env");
    assert.doesNotMatch(JSON.stringify(configured), /status-secret-value/);
    assert.equal("value" in configured.status, false);

    const missing = await getJson(`${daemon.url}/secrets/status?ref=env%3ALING_STACK_SECRET_STATUS_MISSING`);
    assert.equal(missing.status.configured, false);
    assert.equal(missing.status.errorCode, "secret_missing");
    assert.equal("value" in missing.status, false);

    const unavailable = await getJson(`${daemon.url}/secrets/status?ref=keychain%3Aprovider_local&purpose=provider_api_key`);
    assert.equal(unavailable.status.configured, false);
    assert.equal(unavailable.status.kind, "keychain");
    assert.match(unavailable.status.errorCode, /^(secret_missing|secret_store_unavailable)$/);
    assert.equal("value" in unavailable.status, false);

    const invalid = await getJson(`${daemon.url}/secrets/status?ref=sk-test_123456789&purpose=provider_api_key`);
    assert.equal(invalid.status.configured, false);
    assert.equal(invalid.status.errorCode, "invalid_secret_ref");
    assert.equal("value" in invalid.status, false);

    const unsupportedPurpose = await fetch(`${daemon.url}/secrets/status?ref=env%3ALING_STACK_SECRET_STATUS_KEY&purpose=unknown`);
    assert.equal(unsupportedPurpose.status, 400);
  } finally {
    delete process.env.LING_STACK_SECRET_STATUS_KEY;
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider create and update accept keychain refs and reject raw or unknown secret schemes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-secret-ref-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_provider_secret_ref",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      authHeader: true,
      apiKeyRef: "keychain:provider_local",
    });
    assert.equal(created.provider.apiKeyRef, "keychain:provider_local");
    assert.equal(created.provider.apiKeyStatus.configured, false);
    assert.match(created.provider.apiKeyStatus.errorCode, /^(secret_missing|secret_store_unavailable)$/);
    assert.equal("value" in created.provider.apiKeyStatus, false);

    const updated = await patchJson(`${daemon.url}/providers/${encodeURIComponent(created.provider.id)}?cwd=${encodeURIComponent(cwd)}`, {
      apiKeyRef: "env:LING_STACK_TEST_PROVIDER_KEY",
    });
    assert.equal(updated.provider.apiKeyRef, "env:LING_STACK_TEST_PROVIDER_KEY");

    const rawRejected = await postJsonExpectError(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "glm",
      displayName: "Raw Secret",
      providerId: "raw-secret",
      model: "static-model",
      api: "google-generative-ai",
      capabilities: ["chat"],
      input: ["text"],
      authHeader: true,
      enabled: true,
      apiKeyRef: "sk-test_123456789",
    });
    assert.equal(rawRejected.status, 400);
    assert.match(rawRejected.body.message, /env:NAME or keychain:NAME/);

    const unknownRejected = await postJsonExpectError(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "glm",
      displayName: "Unknown Scheme",
      providerId: "unknown-secret",
      model: "static-model",
      api: "google-generative-ai",
      capabilities: ["chat"],
      input: ["text"],
      authHeader: true,
      enabled: true,
      apiKeyRef: "file:secret",
    });
    assert.equal(unknownRejected.status, 400);
    assert.match(unknownRejected.body.message, /env:NAME or keychain:NAME/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider check and run startup use the injected secret resolver without leaking resolved values", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-secret-resolver-"));
  const secretValue = "resolved-keychain-secret";
  const runner = new SecretEchoRunner(secretValue);
  const daemon = await startDaemonForTest(runner, {
    secretResolver: createTestSecretResolver("keychain:provider_ready", secretValue),
  });
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      displayName: "Keychain Ready",
      providerId: "keychain-ready",
      authHeader: true,
      apiKeyRef: "keychain:provider_ready",
    });
    const providerId = created.provider.id;

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, true);

    const { runId } = await postRunAndCollectEvents(daemon.url, providerRunBody(cwd, "task_provider_secret_resolver", providerId));
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.runs[0].apiKey, secretValue);

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    const events = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/events?cwd=${encodeURIComponent(cwd)}`);
    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.doesNotMatch(JSON.stringify({ run, events, artifacts }), new RegExp(secretValue));

    for (const artifact of artifacts.artifacts) {
      const content = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(artifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(content.status, 200);
      assert.doesNotMatch(await content.text(), new RegExp(secretValue));
    }
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider local API keys are edited from sqlite without leaking in provider responses", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-local-secret-"));
  const openai = await startMockOpenAICompatibleServer();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_local_secret",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "Local Secret Relay",
      providerId: "local-secret-relay",
      api: "openai-completions",
      baseUrl: `${openai.url}/v1`,
      authHeader: true,
      apiKey: "local-secret-one",
    });
    const providerId = created.provider.id;
    assert.equal(created.provider.apiKeyRef, `local:${providerId}`);
    assert.equal(created.provider.apiKeyConfigured, true);
    assert.equal(created.provider.apiKeyStatus.kind, "local");
    assert.doesNotMatch(JSON.stringify(created), /local-secret-one/);

    const firstSecret = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/secret?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(firstSecret.providerId, providerId);
    assert.equal(firstSecret.apiKey, "local-secret-one");
    assert.equal(firstSecret.apiKeyRef, `local:${providerId}`);
    assert.equal(firstSecret.configured, true);

    const firstCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstCheck.ok, true);
    assert.equal(openai.requests[0].authorization, "Bearer local-secret-one");
    assert.equal(openai.requests[0].body.model, "static-model");

    const updated = await patchJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`, {
      baseUrl: `${openai.url}/custom`,
      model: "updated-model",
      apiKey: "local-secret-two",
      enabled: true,
    });
    assert.equal(updated.provider.baseUrl, `${openai.url}/custom`);
    assert.equal(updated.provider.model, "updated-model");
    assert.equal(updated.provider.apiKeyRef, `local:${providerId}`);
    assert.doesNotMatch(JSON.stringify(updated), /local-secret-two/);
    const listedAfterUpdate = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    assert.doesNotMatch(JSON.stringify(listedAfterUpdate), /local-secret-two/);
    const updatedSecret = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/secret?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(updatedSecret.apiKey, "local-secret-two");

    const secondCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(secondCheck.ok, true);
    assert.equal(openai.requests[1].path, "/custom/chat/completions");
    assert.equal(openai.requests[1].authorization, "Bearer local-secret-two");
    assert.equal(openai.requests[1].body.model, "updated-model");

    const cleared = await patchJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`, {
      clearApiKey: true,
    });
    assert.equal(cleared.provider.apiKeyRef, undefined);
    assert.equal(cleared.provider.apiKeyConfigured, false);
    const clearedSecret = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/secret?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(clearedSecret.apiKey, "");
    assert.equal(clearedSecret.configured, false);

    const missingCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(missingCheck.ok, false);
    assert.equal(missingCheck.code, "secret_missing");
    assert.match(missingCheck.message, /API key missing/);

    const recreated = await patchJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`, {
      apiKey: "local-secret-three",
    });
    assert.equal(recreated.provider.apiKeyRef, `local:${providerId}`);
    const deleted = await fetch(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    await deleted.arrayBuffer();
    const store = createSqliteRunStore(cwd);
    try {
      assert.equal(store.hasProviderSecret(providerId), false);
    } finally {
      store.close();
    }
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
  });

  test("provider draft check validates direct API keys without persisting providers", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-draft-check-"));
    const openai = await startMockOpenAICompatibleServer();
    const daemon = await startDaemonForTest(new ApprovalProbeRunner({
      toolCallId: "tool_unused_draft_check",
      toolName: "bash",
      input: { command: "echo unused" },
    }));
    try {
      const missingCheck = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
        kind: "openai-compatible",
        displayName: "Draft Gateway",
        providerId: "draft-gateway",
        model: "draft-model",
        api: "openai-completions",
        baseUrl: `${openai.url}/v1`,
        authHeader: true,
        capabilities: ["chat", "tool_call"],
        enabled: true,
      });
      assert.equal(missingCheck.ok, false);
      assert.equal(missingCheck.code, "secret_missing");
      assert.match(missingCheck.message, /API key missing/);
      const listedAfterMissing = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(listedAfterMissing.providers.length, 0);

      const readyCheck = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
        kind: "openai-compatible",
        displayName: "Draft Gateway",
        providerId: "draft-gateway",
        model: "draft-model",
        api: "openai-completions",
        baseUrl: `${openai.url}/v1`,
        authHeader: true,
        apiKey: "draft-secret",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      });
      assert.equal(readyCheck.ok, true);
      assert.equal(openai.requests[0].path, "/v1/chat/completions");
      assert.equal(openai.requests[0].authorization, "Bearer draft-secret");
      assert.equal(openai.requests[0].body.model, "draft-model");
      assert.doesNotMatch(JSON.stringify(readyCheck), /draft-secret/);
      const listedAfterReady = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(listedAfterReady.providers.length, 0);
    } finally {
      await daemon.close();
      await openai.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("provider draft check blocks media models selected with chat protocols", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-draft-media-mismatch-"));
    const openai = await startMockOpenAICompatibleServer();
    const daemon = await startDaemonForTest(new ApprovalProbeRunner({
      toolCallId: "tool_unused_media_mismatch",
      toolName: "bash",
      input: { command: "echo unused" },
    }));
    try {
      const mismatch = await postJsonExpectError(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
        kind: "doubao",
        displayName: "Doubao Ark",
        providerId: "doubao",
        model: "doubao-seedream-5-0-260128",
        api: "openai-completions",
        baseUrl: `${openai.url}/v1`,
        authHeader: false,
        capabilities: ["chat", "tool_call"],
        enabled: true,
      });

      assert.equal(mismatch.status, 400);
      assert.equal(mismatch.body.error, "bad_request");
      assert.match(mismatch.body.message, /media model/);
      assert.equal(openai.requests.length, 0);

      const chatModel = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
        kind: "doubao",
        displayName: "Doubao Ark",
        providerId: "doubao",
        model: "doubao-1-5-pro-32k-250115",
        api: "openai-completions",
        baseUrl: `${openai.url}/v1`,
        authHeader: false,
        capabilities: ["chat", "tool_call"],
        enabled: true,
      });

      assert.equal(chatModel.ok, true);
      assert.equal(openai.requests.length, 1);
    } finally {
      await daemon.close();
      await openai.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

test("provider model listing probes the endpoint with the provided API key", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-models-"));
  const openai = await startMockOpenAICompatibleServer();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_model_list",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const result = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      providerId: "cliproxy",
      api: "openai-completions",
      baseUrl: `${openai.url}/v1`,
      authHeader: true,
      apiKey: "model-list-secret",
    });

    assert.equal(openai.requests[0].method, "GET");
    assert.equal(openai.requests[0].path, "/v1/models");
    assert.equal(openai.requests[0].authorization, "Bearer model-list-secret");
    assert.deepEqual(result.models.map((model) => model.id), ["cliproxy-gpt-4o", "cliproxy-claude-sonnet"], JSON.stringify({ result, requests: openai.requests }));
    assert.equal(result.source, `${openai.url}/v1/models`);
    assert.doesNotMatch(JSON.stringify(result), /model-list-secret/);
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider model listing normalizes OpenAI-compatible endpoint paths", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-models-normalize-"));
  const openai = await startMockOpenAICompatibleServer();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_model_list_normalize",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const result = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "doubao",
      providerId: "doubao",
      api: "openai-completions",
      baseUrl: `${openai.url}/api/v3/chat/completions`,
      authHeader: true,
      apiKey: "ark-secret",
    });

    assert.equal(openai.requests[0].method, "GET");
    assert.equal(openai.requests[0].path, "/api/v3/models");
    assert.equal(openai.requests[0].authorization, "Bearer ark-secret");
    assert.equal(result.source, `${openai.url}/api/v3/models`);
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media provider model listing returns media-only candidates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-media-models-"));
  const openai = await startMockOpenAICompatibleServer({
    models: [
      { id: "doubao-seed-2-0-lite-260215", object: "model", owned_by: "volcengine" },
      { id: "doubao-seedream-5-0-260128", object: "model", owned_by: "volcengine" },
      { id: "doubao-seedance-1-0-pro-250528", object: "model", owned_by: "volcengine" },
    ],
  });
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_model_list",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const seedreamResult = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "seedream",
      providerId: "seedream",
      api: "media-job",
      baseUrl: `${openai.url}/api/v3/models`,
      authHeader: true,
      apiKey: "ark-media-secret",
    });

    assert.equal(openai.requests[0].method, "GET");
    assert.equal(openai.requests[0].path, "/api/v3/models");
    assert.deepEqual(seedreamResult.models.map((model) => model.id), ["doubao-seedream-5-0-260128"]);

    const seedanceResult = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "seedance",
      providerId: "seedance",
      api: "media-job",
      baseUrl: `${openai.url}/api/v3/models`,
      authHeader: true,
      apiKey: "ark-media-secret",
    });
    assert.deepEqual(seedanceResult.models.map((model) => model.id), ["doubao-seedance-1-0-pro-250528"]);

    const jimengResult = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "jimeng",
      providerId: "jimeng",
      api: "media-job",
      baseUrl: "https://visual.volcengineapi.com",
      authHeader: false,
    });
    assert.deepEqual(jimengResult.models.map((model) => model.id), ["jimeng-image"]);
    assert.equal(jimengResult.source, "builtin:media-models");
  } finally {
    await daemon.close();
    await openai.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media provider check runs a real Seedream image probe", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-media-check-"));
  const seedream = await startMockSeedreamServer();
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_check",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const draftCheck = await postJson(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
      kind: "seedream",
      displayName: "Seedream Draft",
      providerId: "seedream",
      model: "seedream",
      api: "media-job",
      capabilities: ["image_generate"],
      input: ["text", "image"],
      baseUrl: `${seedream.url}/api/v3/images/generations`,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
    });
    assert.equal(draftCheck.ok, true);
    assert.equal(draftCheck.code, "static_check");
    assert.equal(seedream.requests.length, 0);

    const live = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Check",
      capabilities: ["image_generate"],
      baseUrl: `${seedream.url}/api/v3/images/generations`,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const liveCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(live.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(liveCheck.ok, true);
    assert.equal(liveCheck.code, "live_image_probe_ready");
    assert.equal(liveCheck.message, "生成真实图片成功");
    assert.equal(seedream.requests.length, 2);
    assert.equal(seedream.requests[0].method, "POST");
    assert.equal(seedream.requests[0].path, "/api/v3/images/generations");
    assert.equal(seedream.requests[0].authorization, "Bearer test-key");
    assert.equal(seedream.requests[0].body.model, "seedream");
    assert.equal(seedream.requests[0].body.response_format, "url");
    assert.equal(seedream.requests[1].method, "GET");
    assert.equal(seedream.requests[1].path, "/generated/image-1.png");

    const missingSecret = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Missing Secret",
      capabilities: ["image_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY_MISSING",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const missingSecretCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(missingSecret.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(missingSecretCheck.ok, false);
    assert.equal(missingSecretCheck.code, "secret_missing");
    assert.match(missingSecretCheck.message, /env:LING_STACK_TEST_MEDIA_KEY_MISSING/);

    const seedance = await createMediaProvider(daemon.url, cwd, {
      kind: "seedance",
      displayName: "Seedance Live Check",
      providerId: "seedance",
      model: "seedance",
      capabilities: ["video_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const seedanceCheck = await postJson(`${daemon.url}/providers/${encodeURIComponent(seedance.provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(seedanceCheck.ok, false);
    assert.equal(seedanceCheck.code, "unsupported_live_probe");
    assert.match(seedanceCheck.message, /does not support a real check yet/);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedream.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job API creates, lists, and shows queued jobs without running on creation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-jobs-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      capabilities: ["image_generate", "image_edit"],
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const providerId = createdProvider.provider.id;

    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: providerId,
      operation: "image_generate",
      prompt: "Create a launch card mockup.",
      input: { size: "1024x1024" },
    });

    assert.ok(createdJob.mediaJob.id.startsWith("media_job_"));
    assert.equal(createdJob.mediaJob.providerPresetId, providerId);
    assert.equal(createdJob.mediaJob.operation, "image_generate");
    assert.equal(createdJob.mediaJob.status, "queued");
    assert.deepEqual(createdJob.mediaJob.artifactIds, []);

    const listed = await getJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}&status=queued`);
    assert.equal(listed.mediaJobs.length, 1);
    assert.equal(listed.mediaJobs[0].id, createdJob.mediaJob.id);

    const fetched = await getJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(fetched.mediaJob.id, createdJob.mediaJob.id);
    assert.equal(fetched.mediaJob.prompt, "Create a launch card mockup.");
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job run blocks static media providers from reporting fake success", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-run-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_run",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Static",
      capabilities: ["image_generate"],
    });
    const providerId = createdProvider.provider.id;
    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: providerId,
      operation: "image_generate",
      prompt: "Create a local static artifact.",
      input: { size: "1024x1024", apiKey: "sk-test_123456789" },
    });

    const executed = await postJsonExpectError(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(executed.status, 400);
    assert.equal(executed.body.error, "live_media_transport_required");
    assert.match(executed.body.message, /当前没有可真实生成的媒体模型/);
    assert.equal(executed.body.mediaJob.status, "failed");
    assert.deepEqual(executed.body.mediaJob.artifactIds, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job live transport fails when the vendor response has no media artifact", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-run-failure-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_run_failure",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  const seedream = await startMockSeedreamServer({ imageUrls: [] });
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live No Artifact",
      capabilities: ["image_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a live artifact with a malformed vendor response.",
      input: { size: "1024x1024" },
    });

    const gated = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(gated.mediaJob.status, "waiting_for_approval");
    const approved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(gated.approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "approved for malformed vendor response smoke",
    });
    assert.equal(approved.approval.status, "approved");
    assert.ok(["queued", "running", "failed"].includes(approved.mediaJob.status));

    const executed = await waitForMediaJobStatus(daemon.url, cwd, createdJob.mediaJob.id, "failed");
    assert.equal(executed.mediaJob.status, "failed");
    assert.match(executed.mediaJob.errorMessage, /did not include image URL data/);
    assert.deepEqual(executed.mediaJob.artifactIds, []);

    const rerun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(rerun.mediaJob.status, "failed");
    assert.match(rerun.mediaJob.errorMessage, /did not include image URL data/);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedream.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job live transport calls Seedream image_generate through HTTP and links artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-live-gate-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_live_gate",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  const seedream = await startMockSeedreamServer();
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Gate",
      capabilities: ["image_generate"],
      baseUrl: seedream.url,
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });
    const createdJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a live gated artifact.",
      input: { size: "2K" },
    });

    const firstRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstRun.mediaJob.status, "waiting_for_approval");
    assert.equal(firstRun.approval.actionType, "media_cost");
    assert.equal(firstRun.approval.mediaJobId, createdJob.mediaJob.id);
    assert.equal(firstRun.approval.status, "pending");
    assert.equal(firstRun.approval.payload.type, "media_cost");
    assert.equal(firstRun.approval.payload.providerPresetId, createdProvider.provider.id);
    assert.equal(firstRun.approval.payload.operation, "image_generate");
    assert.equal(firstRun.approval.payload.promptPreview, "Create a live gated artifact.");
    assert.deepEqual(firstRun.artifacts, []);

    const repeatRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(repeatRun.mediaJob.status, "waiting_for_approval");
    assert.equal(repeatRun.approval.id, firstRun.approval.id);
    const pendingApprovals = await listApprovals(daemon.url, cwd, { mediaJobId: createdJob.mediaJob.id, status: "pending" });
    assert.equal(pendingApprovals.length, 1);

    const approved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(firstRun.approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "approved for live gate smoke",
    });
    assert.equal(approved.approval.status, "approved");
    assert.ok(["queued", "running", "succeeded"].includes(approved.mediaJob.status));

    const executed = await waitForMediaJobStatus(daemon.url, cwd, createdJob.mediaJob.id, "succeeded");
    const executedArtifacts = await getJson(`${daemon.url}/media-jobs/${encodeURIComponent(createdJob.mediaJob.id)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(executed.mediaJob.status, "succeeded");
    assert.equal(executedArtifacts.artifacts.length, 3);
    assert.equal(seedream.requests.length, 2);
    assert.equal(seedream.requests[0].path, "/images/generations");
    assert.equal(seedream.requests[0].authorization, "Bearer test-key");
    assert.deepEqual(seedream.requests[0].body, {
      model: "seedream",
      prompt: "Create a live gated artifact.",
      response_format: "url",
      size: "2K",
    });
    assert.equal(seedream.requests[1].method, "GET");
    assert.equal(seedream.requests[1].path, "/generated/image-1.png");
    assert.equal(seedream.requests[1].authorization, undefined);
    assert.deepEqual(new Set(executed.mediaJob.artifactIds), new Set(executedArtifacts.artifacts.map((artifact) => artifact.id)));
    const markdownArtifact = executedArtifacts.artifacts.find((artifact) => artifact.type === "markdown");
    const jsonArtifact = executedArtifacts.artifacts.find((artifact) => artifact.type === "json");
    const imageArtifactRecord = executedArtifacts.artifacts.find((artifact) => artifact.type === "image");
    assert.ok(markdownArtifact);
    assert.ok(jsonArtifact);
    assert.ok(imageArtifactRecord);
    assert.equal(imageArtifactRecord.contentType, "image/png");
    assert.equal(imageArtifactRecord.sizeBytes, 8);

    const liveArtifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(jsonArtifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(liveArtifact.status, 200);
    const text = await liveArtifact.text();
    assert.match(text, /live_seedream_image_generate/);
    assert.match(text, /image-1\.png/);
    assert.doesNotMatch(text, /test-key/);

    const imageArtifact = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(imageArtifactRecord.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(imageArtifact.status, 200);
    assert.equal(imageArtifact.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await imageArtifact.arrayBuffer()), Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await seedream.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job live transport gate fails denied or expired media approvals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-live-approval-fail-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_approval_fail",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  process.env.LING_STACK_TEST_MEDIA_KEY = "test-key";
  try {
    const createdProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedream Live Gate",
      capabilities: ["image_generate"],
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:LING_STACK_TEST_MEDIA_KEY",
      compat: { mediaVendorTransport: { mode: "live" } },
    });

    const deniedJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create a denied live artifact.",
    });
    const deniedGate = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(deniedJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    const deniedDecision = await postJson(`${daemon.url}/approvals/${encodeURIComponent(deniedGate.approval.id)}/deny?cwd=${encodeURIComponent(cwd)}`, {
      reason: "too expensive for this smoke",
    });
    assert.equal(deniedDecision.mediaJob.status, "failed");
    assert.match(deniedDecision.mediaJob.errorMessage, /approval denied/);

    const expiredJob = await postJson(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: createdProvider.provider.id,
      operation: "image_generate",
      prompt: "Create an expired live artifact.",
    });
    const expiredGate = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(expiredJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    const store = createSqliteRunStore(cwd);
    try {
      const expired = store.expireApprovalRequest(
        expiredGate.approval.id,
        { reason: "Approval request expired before a decision was received." },
        "2026-05-24T00:30:00.000Z",
      );
      assert.ok(expired);
      assert.equal(expired.status, "expired");
    } finally {
      store.close();
    }
    const expiredRun = await postJson(`${daemon.url}/media-jobs/${encodeURIComponent(expiredJob.mediaJob.id)}/run?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(expiredRun.mediaJob.status, "failed");
    assert.match(expiredRun.mediaJob.errorMessage, /approval expired/);
    assert.equal(expiredRun.approval.id, expiredGate.approval.id);
    assert.deepEqual(expiredRun.artifacts, []);
  } finally {
    delete process.env.LING_STACK_TEST_MEDIA_KEY;
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media job API rejects chat providers and unsupported media operations", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-jobs-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused_media_job_reject",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const chatProvider = await createStaticChatProvider(daemon.url, cwd, {
      displayName: "Chat Only",
      providerId: "chat-only",
    });
    const mediaProvider = await createMediaProvider(daemon.url, cwd, {
      displayName: "Seedance Video",
      providerId: "seedance",
      model: "seedance",
      capabilities: ["video_generate"],
    });

    const chatRejected = await postJsonExpectError(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: chatProvider.provider.id,
      operation: "image_generate",
      prompt: "Create an image.",
    });
    assert.equal(chatRejected.status, 400);
    assert.equal(chatRejected.body.error, "unsupported_capability");

    const operationRejected = await postJsonExpectError(`${daemon.url}/media-jobs?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: mediaProvider.provider.id,
      operation: "image_generate",
      prompt: "Create an image.",
    });
    assert.equal(operationRejected.status, 400);
    assert.equal(operationRejected.body.error, "unsupported_capability");
    assert.equal(await mediaJobCount(daemon.url, cwd), 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media provider presets remain blocked from coding task runs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-media-run-block-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_media_run_block",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const created = await createMediaProvider(daemon.url, cwd);
    const blocked = await postRunExpectError(daemon.url, providerRunBody(cwd, "task_media_provider_run", created.provider.id));

    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, "unsupported_capability");
    assert.match(blocked.body.message, /Media provider presets cannot run pi coding tasks/);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider preset run requires successful daemon preflight", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-run-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_preflight_ready",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      displayName: "GLM Static",
      providerId: "glm-static",
    });
    const providerId = created.provider.id;

    const blocked = await postRunExpectError(daemon.url, providerRunBody(cwd, "task_provider_unchecked", providerId));
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, "provider_preflight_failed");
    assert.match(blocked.body.message, /provider has not been checked/);
    assert.equal(runner.runs.length, 0);

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, true);

    const { runId } = await postRunAndCollectEvents(daemon.url, providerRunBody(cwd, "task_provider_ready", providerId));
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed provider checks block daemon preset runs unless skipped", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-run-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_preflight_failed",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "Broken Relay",
      providerId: "broken-relay",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
    });
    const providerId = created.provider.id;
    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, false);

    const blocked = await postRunExpectError(daemon.url, providerRunBody(cwd, "task_provider_failed", providerId));
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, "provider_preflight_failed");
    assert.match(blocked.body.message, /provider check failed/);
    assert.equal(runner.runs.length, 0);

    const { runId } = await postRunAndCollectEvents(
      daemon.url,
      providerRunBody(cwd, "task_provider_skip_preflight", providerId, { skipProviderPreflight: true }),
    );
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run endpoint rejects paused channels before runner start", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-paused-channel-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_paused_channel",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Paused Engineering",
      status: "paused",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Paused task",
      prompt: "This task must not start while paused.",
    });

    const blocked = await postJsonExpectError(
      `${daemon.url}/tasks/${encodeURIComponent(task.task.id)}/run?cwd=${encodeURIComponent(cwd)}`,
      {
        providerPresetId: provider.provider.id,
        skipProviderPreflight: true,
        tools: ["read", "write"],
        idempotencyKey: "paused-channel-key",
      },
    );

    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "channel_paused");
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("same idempotency key returns the original task run without starting a duplicate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-idempotent-run-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Idempotent task",
      prompt: "Start once even if the browser retries.",
    });

    const body = {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "client-retry-key",
    };
    const firstResponse = await postTaskRunStream(daemon.url, cwd, task.task.id, body);
    const firstSse = createSseReader(firstResponse);
    const firstReady = await firstSse.nextEvent();
    assert.equal(firstReady.event, "ready");
    const runId = firstReady.data.runId;
    await runner.waitUntilStarted();

    const duplicateResponse = await postTaskRunStream(daemon.url, cwd, task.task.id, body);
    const duplicateEvents = parseSseText(await duplicateResponse.text());
    assert.equal(duplicateEvents[0].event, "ready");
    assert.equal(duplicateEvents[0].data.runId, runId);
    assert.equal(duplicateEvents[0].data.duplicate, true);
    assert.equal(runner.runs.length, 1);

    runner.release();
    await firstSse.collectRemaining();
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write runs in channels sharing a bound path conflict through resource leases", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-bound-path-lock-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const firstChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering A",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
      runtimePolicy: { queueOnConflict: false },
    });
    const secondChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering B",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
      runtimePolicy: { queueOnConflict: false },
    });
    const firstTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: firstChannel.channel.id,
      title: "First writer",
      prompt: "Hold the path lock.",
    });
    const secondTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: secondChannel.channel.id,
      title: "Second writer",
      prompt: "Wait for the path lock.",
    });

    const firstResponse = await postTaskRunStream(daemon.url, cwd, firstTask.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["write"],
      idempotencyKey: "first-writer",
    });
    const firstSse = createSseReader(firstResponse);
    const firstReady = await firstSse.nextEvent();
    const runId = firstReady.data.runId;
    await runner.waitUntilStarted();

    const activeLeases = await getJson(`${daemon.url}/runtime/leases?cwd=${encodeURIComponent(cwd)}&status=active`);
    assert.equal(activeLeases.leases.some((lease) => lease.ownerId === runId && lease.resourceType === "bound_path"), true);
    assert.equal(activeLeases.leases.some((lease) => lease.ownerId === runId && lease.resourceType === "task"), true);

    const blocked = await postJsonExpectError(
      `${daemon.url}/tasks/${encodeURIComponent(secondTask.task.id)}/run?cwd=${encodeURIComponent(cwd)}`,
      {
        providerPresetId: provider.provider.id,
        skipProviderPreflight: true,
        tools: ["write"],
        idempotencyKey: "second-writer",
      },
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "resource_conflict");
    assert.match(blocked.body.message, /bound_path/);

    const transitions = await getJson(
      `${daemon.url}/state-transitions?cwd=${encodeURIComponent(cwd)}&entityType=task&entityId=${encodeURIComponent(firstTask.task.id)}`,
    );
    assert.equal(transitions.transitions.some((event) => event.event === "claim" && event.toStatus === "claimed"), true);
    assert.equal(transitions.transitions.some((event) => event.event === "start_run" && event.toStatus === "running"), true);

    runner.release();
    await firstSse.collectRemaining();

    const remainingLeases = await getJson(`${daemon.url}/runtime/leases?cwd=${encodeURIComponent(cwd)}&status=active`);
    assert.equal(remainingLeases.leases.some((lease) => lease.ownerId === runId), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queueOnConflict persists a queued run and work unit instead of starting another runner", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-bound-path-queue-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const firstChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering A",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
      runtimePolicy: { queueOnConflict: true },
    });
    const secondChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering B",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
      runtimePolicy: { queueOnConflict: true },
    });
    const firstTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: firstChannel.channel.id,
      title: "First writer",
      prompt: "Hold the path lock.",
    });
    const secondTask = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: secondChannel.channel.id,
      title: "Second writer",
      prompt: "Queue for the path lock.",
    });

    const firstResponse = await postTaskRunStream(daemon.url, cwd, firstTask.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["write"],
      idempotencyKey: "first-queued-writer",
    });
    const firstSse = createSseReader(firstResponse);
    const firstReady = await firstSse.nextEvent();
    assert.equal(firstReady.event, "ready");
    await runner.waitUntilStarted();

    const queuedResponse = await postTaskRunStream(daemon.url, cwd, secondTask.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["write"],
      idempotencyKey: "second-queued-writer",
    });
    const queuedEvents = parseSseText(await queuedResponse.text());
    assert.equal(queuedEvents[0].event, "ready");
    assert.equal(queuedEvents[0].data.queued, true);
    assert.equal(queuedEvents[0].data.queueReason, "resource_conflict");
    assert.equal(runner.runs.length, 1);

    const queuedRunId = queuedEvents[0].data.runId;
    const queuedWorkUnitId = queuedEvents[0].data.workUnitId;
    const queuedRuns = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}&status=queued&limit=20`);
    assert.equal(queuedRuns.runs.some((run) => run.id === queuedRunId && run.workUnitId === queuedWorkUnitId), true);

    const supervisor = await getJson(`${daemon.url}/runtime/supervisor?cwd=${encodeURIComponent(cwd)}`);
    const queuedWorkUnit = supervisor.queued.find((workUnit) => workUnit.id === queuedWorkUnitId);
    assert.ok(queuedWorkUnit);
    assert.equal(queuedWorkUnit.linkedRunId, queuedRunId);
    assert.equal(queuedWorkUnit.status, "queued");

    const detail = await getJson(`${daemon.url}/work-units/${encodeURIComponent(queuedWorkUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.run.status, "queued");
    assert.equal(detail.events.some((event) => event.type === "work_unit_queued"), true);
    assert.equal(detail.leases.some((lease) => lease.status === "active"), false);
    assert.equal(detail.semaphoreSlots.some((slot) => slot.status === "active"), false);

    runner.release();
    await firstSse.collectRemaining();
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime diagnostics expose the same daemon-owned work unit to web and desktop-style clients", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-runtime-diagnostics-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Shared runtime task",
      prompt: "Hold active runtime state.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "shared-runtime-client-key",
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const runId = ready.data.runId;
    await runner.waitUntilStarted();

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(run.workUnitId);
    const webRuntime = await getJson(`${daemon.url}/runtime?cwd=${encodeURIComponent(cwd)}`);
    const desktopRuntime = await getJson(`${daemon.url}/runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(webRuntime.runtime.runtimeInstanceId, desktopRuntime.runtime.runtimeInstanceId);

    const listed = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&linkedRunId=${encodeURIComponent(runId)}`);
    assert.equal(listed.workUnits.length, 1);
    assert.equal(listed.workUnits[0].id, run.workUnitId);
    assert.equal(listed.workUnits[0].status, "running");

    const detail = await getJson(`${daemon.url}/work-units/${encodeURIComponent(run.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.run.id, runId);
    assert.equal(detail.workUnit.linkedRunId, runId);
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.events.some((event) => event.type === "work_unit_started"), true);
    assert.equal(detail.leases.some((lease) => lease.workUnitId === run.workUnitId), true);

    const eventReplay = await getJson(`${daemon.url}/work-units/${encodeURIComponent(run.workUnitId)}/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0`);
    assert.equal(eventReplay.workUnitId, run.workUnitId);
    assert.ok(eventReplay.events.length >= 1);

    const diagnostics = await getJson(`${daemon.url}/runtime/supervisor?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(diagnostics.runtime.runtimeInstanceId, webRuntime.runtime.runtimeInstanceId);
    assert.equal(diagnostics.active.some((unit) => unit.id === run.workUnitId), true);
    assert.equal(diagnostics.leases.some((lease) => lease.workUnitId === run.workUnitId), true);

    const active = await getJson(`${daemon.url}/runtime/active?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(active.workUnits.some((unit) => unit.id === run.workUnitId), true);
    const leases = await getJson(`${daemon.url}/runtime/leases?cwd=${encodeURIComponent(cwd)}&status=active&workUnitId=${encodeURIComponent(run.workUnitId)}`);
    assert.equal(leases.leases.every((lease) => lease.workUnitId === run.workUnitId), true);
    const semaphores = await getJson(`${daemon.url}/runtime/semaphores?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(Array.isArray(semaphores.semaphoreSlots));

    runner.release();
    await sse.collectRemaining();
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("work unit cancel cancels a linked active run without late success overwrite", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-work-unit-cancel-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Cancel by work unit",
      prompt: "Cancel through the runtime supervisor.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "work-unit-cancel-key",
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const runId = ready.data.runId;
    await runner.waitUntilStarted();
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(run.workUnitId);

    const cancelled = await postJson(`${daemon.url}/work-units/${encodeURIComponent(run.workUnitId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.workUnit.status, "cancelled");
    const cancelledRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(cancelledRun.status, "cancelled");

    runner.release();
    await sse.collectRemaining();
    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "cancelled");
    const detail = await getJson(`${daemon.url}/work-units/${encodeURIComponent(run.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.events.some((event) => event.type === "work_unit_cancelled"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run cancel cancels pending approvals for a waiting run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-run-cancel-approval-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_cancel_waiting_approval",
    toolName: "bash",
    input: { command: "echo waiting" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_cancel_waiting_approval"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;
    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;

    const cancelled = await postJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.run.status, "cancelled");

    const approvals = await listApprovals(daemon.url, cwd, runId);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, approvalId);
    assert.equal(approvals[0].status, "cancelled");
    assert.match(approvals[0].decisionReason, /cancelled/i);

    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&runId=${encodeURIComponent(runId)}`);
    assert.deepEqual(pending.approvals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queued run guidance starts FIFO continuation after the source run finishes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-run-guidance-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  let sse;
  let sseDrained = false;
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Guided task",
      prompt: "Build the initial result.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      permissionMode: "balanced",
      idempotencyKey: "guidance-source",
    });
    sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const sourceRunId = ready.data.runId;
    await runner.waitUntilStarted();

    const first = await postJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "After that, verify the memory audit UI.",
      idempotencyKey: "guidance-1",
    });
    const second = await postJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "Then summarize remaining risk.",
      idempotencyKey: "guidance-2",
    });
    assert.equal(first.intervention.status, "queued");
    assert.equal(second.intervention.status, "queued");

    const listed = await getJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listed.interventions.map((item) => item.id), [first.intervention.id, second.intervention.id]);
    assert.equal(runner.runs.length, 1);

    runner.release();
    await sse.collectRemaining();
    sseDrained = true;
    await runner.waitUntilStarted(3);

    const updatedFirst = await getJson(`${daemon.url}/run-interventions/${encodeURIComponent(first.intervention.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(updatedFirst.intervention.status, "started");
    assert.ok(updatedFirst.intervention.continuationRunId);

    const continuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(updatedFirst.intervention.continuationRunId)}?cwd=${encodeURIComponent(cwd)}`);
    const source = await getJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(source.threadId);
    assert.equal(continuation.parentRunId, sourceRunId);
    assert.equal(continuation.interventionId, first.intervention.id);
    assert.equal(continuation.threadId, source.threadId);
    assert.equal(continuation.requestSnapshot.permissionMode, "balanced");
    assert.match(continuation.requestSnapshot.task.prompt, /After that, verify the memory audit UI/);

    const updatedSecond = await getJson(`${daemon.url}/run-interventions/${encodeURIComponent(second.intervention.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(updatedSecond.intervention.status, "started");
    assert.ok(updatedSecond.intervention.continuationRunId);
    const secondContinuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(updatedSecond.intervention.continuationRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(secondContinuation.parentRunId, sourceRunId);
    assert.equal(secondContinuation.interventionId, second.intervention.id);
    assert.equal(secondContinuation.threadId, source.threadId);
    assert.match(secondContinuation.requestSnapshot.task.prompt, /Then summarize remaining risk/);
  } finally {
    runner.release();
    if (sse && !sseDrained) {
      await sse.collectRemaining().catch(() => {});
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interrupt redirect cancels the source run and starts a linked continuation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-run-redirect-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  let sse;
  let sseDrained = false;
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Redirect task",
      prompt: "Start in the wrong direction.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "redirect-source",
    });
    sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const sourceRunId = ready.data.runId;
    await runner.waitUntilStarted();

    const redirect = await postJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}/interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "interrupt_redirect",
      instruction: "Stop and use the daemon API path instead.",
      idempotencyKey: "redirect-1",
    });
    assert.equal(redirect.intervention.mode, "interrupt_redirect");
    assert.equal(redirect.run.status, "cancelled");
    assert.equal(redirect.intervention.status, "cancelling_source");

    runner.release();
    await sse.collectRemaining();
    sseDrained = true;
    await runner.waitUntilStarted(2);

    const source = await getJson(`${daemon.url}/runs/${encodeURIComponent(sourceRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(source.status, "cancelled");
    assert.ok(source.threadId);
    const intervention = await getJson(`${daemon.url}/run-interventions/${encodeURIComponent(redirect.intervention.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(intervention.intervention.status, "started");
    assert.ok(intervention.intervention.continuationRunId);

    const continuation = await getJson(`${daemon.url}/runs/${encodeURIComponent(intervention.intervention.continuationRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(continuation.parentRunId, sourceRunId);
    assert.equal(continuation.interventionId, redirect.intervention.id);
    assert.equal(continuation.continuationReason, "interrupt_redirect");
    assert.equal(continuation.threadId, source.threadId);
    assert.match(continuation.requestSnapshot.task.prompt, /Stop and use the daemon API path instead/);
  } finally {
    runner.release();
    if (sse && !sseDrained) {
      await sse.collectRemaining().catch(() => {});
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("work unit retry and reconcile APIs operate on durable supervisor state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-work-unit-controls-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused",
    toolName: "read",
    input: { path: "README.md" },
  }));
  try {
    await getJson(`${daemon.url}/runtime?cwd=${encodeURIComponent(cwd)}`);

    let store = createSqliteRunStore(cwd);
    try {
      store.createWorkUnit({
        id: "wu_failed_retry",
        workspaceId: DEFAULT_WORKSPACE_ID,
        kind: "task_run",
        ownerType: "task",
        ownerId: "task_failed_retry",
        idempotencyKey: "failed-retry-key",
        status: "failed",
        createdByActor: "system",
        request: { prompt: "retry" },
        now: "2026-06-04T01:00:00.000Z",
      });
      const running = store.createWorkUnit({
        id: "wu_running_reconcile",
        workspaceId: DEFAULT_WORKSPACE_ID,
        kind: "task_run",
        ownerType: "task",
        ownerId: "task_running_reconcile",
        idempotencyKey: "running-reconcile-key",
        status: "running",
        createdByActor: "system",
        request: { prompt: "reconcile" },
        now: "2026-06-04T01:01:00.000Z",
      });
      const attempt = store.createWorkUnitAttempt({
        id: "attempt_running_reconcile",
        workUnitId: running.id,
        attemptNumber: 1,
        runtimeInstanceId: "runtime_test",
        runnerId: "runner_pi_embedded",
        now: "2026-06-04T01:01:01.000Z",
      });
      store.acquireResourceLease({
        workspaceId: DEFAULT_WORKSPACE_ID,
        resourceType: "provider",
        resourceKey: "provider_reconcile",
        ownerType: "work_unit_attempt",
        ownerId: attempt.id,
        workUnitId: running.id,
        attemptId: attempt.id,
        acquiredAt: "2026-06-04T01:01:02.000Z",
        expiresAt: "2026-06-04T01:11:02.000Z",
      });
      store.acquireRuntimeSemaphoreSlot({
        workspaceId: DEFAULT_WORKSPACE_ID,
        resourceType: "provider",
        resourceKey: "provider_reconcile",
        limit: 1,
        ownerType: "work_unit_attempt",
        ownerId: attempt.id,
        workUnitId: running.id,
        attemptId: attempt.id,
        acquiredAt: "2026-06-04T01:01:03.000Z",
        expiresAt: "2026-06-04T01:11:03.000Z",
      });
    } finally {
      store.close();
    }

    const retried = await postJson(`${daemon.url}/work-units/wu_failed_retry/retry?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(retried.workUnit.status, "queued");
    assert.equal(retried.event.type, "work_unit_queued");

    const reconciled = await postJson(`${daemon.url}/work-units/wu_running_reconcile/reconcile?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(reconciled.workUnit.status, "stale");
    const detail = await getJson(`${daemon.url}/work-units/wu_running_reconcile?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.attempts[0].status, "lost");
    assert.equal(detail.leases.some((lease) => lease.status === "active"), false);
    assert.equal(detail.semaphoreSlots.some((slot) => slot.status === "active"), false);
    assert.equal(detail.events.some((event) => event.type === "work_unit_stale"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancelled runs are not overwritten when a late runner reports success", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-cancel-race-"));
  const runner = new BlockingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read", "write"],
      defaultProviderPresetId: provider.provider.id,
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Cancelable task",
      prompt: "Cancel while runner is still active.",
    });

    const response = await postTaskRunStream(daemon.url, cwd, task.task.id, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "cancel-race",
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    const runId = ready.data.runId;
    await runner.waitUntilStarted();
    const activeRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(activeRun.workUnitId);

    const cancel = await postJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancel.cancelled, true);
    assert.equal(cancel.run.status, "cancelled");

    runner.release();
    await sse.collectRemaining();

    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "cancelled");
    assert.equal(runner.runs.length, 1);

    const events = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/events?cwd=${encodeURIComponent(cwd)}&limit=1000`);
    const ignoredCompletions = events.events.filter((event) => event.type === "stale_runner_completion_ignored");
    assert.equal(ignoredCompletions.length, 1);
    assert.equal(ignoredCompletions[0].data.reportedStatus, "succeeded");
    assert.equal(ignoredCompletions[0].data.currentRunStatus, "cancelled");
    assert.equal(ignoredCompletions[0].data.currentWorkUnitStatus, "cancelled");
    assert.equal(ignoredCompletions[0].data.reason, "run_cancelled");

    const detail = await getJson(`${daemon.url}/work-units/${encodeURIComponent(activeRun.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    const runtimeIgnoredCompletions = detail.events.filter((event) => event.type === "stale_runner_completion_ignored");
    assert.equal(runtimeIgnoredCompletions.length, 1);
    assert.equal(runtimeIgnoredCompletions[0].data.runEventId, ignoredCompletions[0].id);
    assert.equal(runtimeIgnoredCompletions[0].data.reportedStatus, "succeeded");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("artifact APIs list metadata and serve content from the artifacts root", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-artifacts-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_artifact_read",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_artifact_api"));
    assert.ok(runId);

    const store = createSqliteRunStore(cwd);
    try {
      const artifactDir = resolve(store.paths.artifactsDir, runId);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(resolve(artifactDir, "evidence.md"), "# Evidence\n\nRun artifact content.\n", "utf8");
      store.createArtifact({
        id: "artifact_api_markdown",
        runId,
        type: "markdown",
        path: `${runId}/evidence.md`,
        title: "Evidence Markdown",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 33,
        createdAt: "2026-05-22T00:00:00.000Z",
      });
      store.createArtifact({
        id: "artifact_api_outside",
        runId,
        type: "log",
        path: resolve(cwd, "outside.log"),
        title: "Outside log",
        createdAt: "2026-05-22T00:00:01.000Z",
      });
    } finally {
      store.close();
    }

    const listed = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.runId, runId);
    assert.equal(listed.artifacts.length, 2);
    assert.equal(listed.artifacts[0].id, "artifact_api_markdown");
    assert.equal(listed.artifacts[0].title, "Evidence Markdown");

    const metadata = await getJson(`${daemon.url}/artifacts/artifact_api_markdown?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(metadata.artifact.runId, runId);
    assert.equal(metadata.artifact.type, "markdown");

    const content = await fetch(`${daemon.url}/artifacts/artifact_api_markdown/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await content.text(), "# Evidence\n\nRun artifact content.\n");

    const outside = await fetch(`${daemon.url}/artifacts/artifact_api_outside/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(outside.status, 403);
    assert.equal((await outside.json()).error, "artifact_outside_root");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon extracts artifacts from tool outputs and generated file paths", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-extract-artifacts-"));
  const runner = new ArtifactExtractionRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_artifact_extraction"));
    assert.ok(runId);

    const listed = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.runId, runId);
    assert.ok(listed.artifacts.length >= 4);
    assert.ok(events.some((event) => event.event === "artifact_created"));

    const generatedMarkdown = listed.artifacts.find((artifact) => artifact.title.startsWith("Generated file content:"));
    assert.ok(generatedMarkdown);
    assert.equal(generatedMarkdown.type, "markdown");
    assert.ok(generatedMarkdown.path.startsWith(`${runId}/`));
    const markdownContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(generatedMarkdown.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(markdownContent.status, 200);
    const markdownText = await markdownContent.text();
    assert.match(markdownText, /# Generated report/);
    assert.doesNotMatch(markdownText, /sk-test_123456789/);
    assert.match(markdownText, /\[REDACTED\]/);

    const diffArtifact = listed.artifacts.find((artifact) => artifact.type === "diff");
    assert.ok(diffArtifact);
    const diffContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(diffArtifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(diffContent.status, 200);
    assert.match(await diffContent.text(), /diff --git/);

    const fileMetadata = listed.artifacts.find((artifact) => artifact.type === "file" && artifact.title.includes("notes/result.md"));
    assert.ok(fileMetadata);
    const metadataContent = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(fileMetadata.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(metadataContent.status, 200);
    assert.match(await metadataContent.text(), /Content was not copied/);

    for (const artifact of listed.artifacts) {
      const content = await fetch(`${daemon.url}/artifacts/${encodeURIComponent(artifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(content.status, 200, `${artifact.id} should be served from the artifact root`);
    }
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class ThreadResumeRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      taskId: options.task.id,
      title: options.task.title,
      prompt: options.task.prompt,
      parentRunId: options.task.parentRunId,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

class ApprovalArtifactRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    const decision = await options.onApprovalRequired?.({
      toolCallId: "tool_action_artifacts",
      toolName: "bash",
      input: { command: "echo sk-test_action_preview_secret" },
      task: options.task,
      cwd: options.cwd,
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_action_artifacts",
      toolName: "bash",
      result: {
        stdout: `approved stdout artifact: ${decision?.approved ? "yes" : "no"}`,
      },
      isError: !decision?.approved,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

class ApprovalProbeRunner {
  constructor(request) {
    this.request = request;
    this.decisions = [];
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
      apiKey: options.provider.apiKey,
      taskId: options.task.id,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });

    const decision = await options.onApprovalRequired?.({
      ...this.request,
      task: options.task,
      cwd: options.cwd,
    });
    if (decision) {
      this.decisions.push(decision);
      options.onEvent?.({
        type: "tool_end",
        toolCallId: this.request.toolCallId,
        toolName: this.request.toolName,
        result: { approved: decision.approved, reason: decision.reason },
        isError: !decision.approved,
      });
    }

    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

class SecretEchoRunner {
  constructor(secretValue) {
    this.secretValue = secretValue;
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
      apiKey: options.provider.apiKey,
      taskId: options.task.id,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "tool_start",
      toolCallId: "tool_secret_echo",
      toolName: "write",
      args: {
        path: "secret-output.txt",
        content: `secret=${this.secretValue}`,
      },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_secret_echo",
      toolName: "write",
      result: {
        content: `runner observed ${this.secretValue}`,
        path: "secret-output.txt",
      },
      isError: false,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: `done ${this.secretValue}` }],
    };
  }
}

class ArtifactExtractionRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });

    options.onEvent?.({
      type: "tool_start",
      toolCallId: "tool_write_artifact",
      toolName: "write",
      args: {
        path: "notes/result.md",
        content: "# Generated report\n\nCreated with sk-test_123456789.\n",
      },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_write_artifact",
      toolName: "write",
      result: { path: "notes/result.md", content: [{ type: "text", text: "wrote notes/result.md\n" }] },
      isError: false,
    });

    options.onEvent?.({
      type: "tool_start",
      toolCallId: "tool_edit_artifact",
      toolName: "edit",
      args: { path: "src/app.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_edit_artifact",
      toolName: "edit",
      result: { diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-const value = 1;\n+const value = 2;\n" },
      isError: false,
    });

    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

class BlockingRunner {
  constructor() {
    this.runs = [];
    this._startedCount = 0;
    this._startedResolvers = [];
    this._releasePromise = new Promise((resolveRelease) => {
      this._release = resolveRelease;
    });
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
      taskId: options.task.id,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    this._startedCount += 1;
    for (const resolveStarted of this._startedResolvers.splice(0)) {
      resolveStarted();
    }

    await this._releasePromise;

    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }

  async waitUntilStarted(count = 1) {
    if (this._startedCount >= count) {
      return;
    }
    await withTimeout(
      new Promise((resolveStarted) => {
        this._startedResolvers.push(resolveStarted);
      }),
      5_000,
      "Timed out waiting for blocking runner to start.",
    );
  }

  release() {
    this._release?.();
  }
}

async function startDaemonForTest(runner, dependencies = {}) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, { runner, ...dependencies });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function createTestSecretResolver(expectedRef, value) {
  return {
    status(ref) {
      if (ref !== expectedRef) {
        return {
          ref,
          kind: ref.startsWith("keychain:") ? "keychain" : "env",
          configured: false,
          errorCode: "secret_missing",
          message: `Secret is not configured: ${ref}`,
        };
      }
      return {
        ref,
        kind: ref.startsWith("keychain:") ? "keychain" : "env",
        configured: true,
      };
    },
    resolve(ref) {
      const status = this.status(ref);
      return status.configured ? { ref, configured: true, value, status } : { ref, configured: false, status };
    },
  };
}

function runBody(cwd, taskId) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Trigger approval probe.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["bash", "write"],
    thinkingLevel: "off",
  };
}

function providerRunBody(cwd, taskId, providerPresetId, overrides = {}) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Trigger provider preset run.",
    },
    providerPresetId,
    tools: ["read"],
    thinkingLevel: "off",
    ...overrides,
  };
}

async function createStaticChatProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

async function createMediaProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "seedream",
    displayName: "Seedream Image",
    providerId: "seedream",
    model: "seedream",
    api: "media-job",
    capabilities: ["image_generate", "image_edit"],
    input: ["text", "image"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

async function startMockSeedreamServer(options = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/generated/image-1.png") {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: {},
      });
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    if (request.method === "POST" && request.url?.endsWith("/contents/generations/tasks")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "seedance-task-1",
        status: "queued",
        debug: { echo: request.headers.authorization },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    const imageUrls = options.imageUrls ?? [`http://${request.headers.host}/generated/image-1.png`];
    response.end(JSON.stringify({
      created: 1779537600,
      data: imageUrls.map((url) => ({ url })),
      debug: { echo: request.headers.authorization },
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function startMockOpenAICompatibleServer(options = {}) {
  const requests = [];
  const models = options.models ?? [
    { id: "cliproxy-gpt-4o", object: "model", owned_by: "cliproxy" },
    { id: "cliproxy-claude-sonnet", object: "model", owned_by: "cliproxy" },
  ];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    if (request.method === "GET" && new URL(request.url ?? "/", "http://127.0.0.1").pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: models,
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-local-secret-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function mediaJobCount(baseUrl, cwd) {
  const response = await getJson(`${baseUrl}/media-jobs?cwd=${encodeURIComponent(cwd)}`);
  return response.mediaJobs.length;
}

async function patchPolicy(baseUrl, cwd, body) {
  return await patchJson(`${baseUrl}/approval-policy?cwd=${encodeURIComponent(cwd)}`, body);
}

async function listApprovals(baseUrl, cwd, filters) {
  const url = new URL(`${baseUrl}/approvals`);
  url.searchParams.set("cwd", cwd);
  if (typeof filters === "string") {
    url.searchParams.set("runId", filters);
  } else {
    if (filters.runId) {
      url.searchParams.set("runId", filters.runId);
    }
    if (filters.mediaJobId) {
      url.searchParams.set("mediaJobId", filters.mediaJobId);
    }
    if (filters.status) {
      url.searchParams.set("status", filters.status);
    }
  }
  const response = await getJson(url.toString());
  return response.approvals;
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await postRunStream(baseUrl, body);
  const text = await response.text();
  const events = parseSseText(text);
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

async function postRunStream(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  assert.ok(response.body);
  return response;
}

async function postTaskRunStream(baseUrl, cwd, taskId, body) {
  const response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/run?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  assert.ok(response.body);
  return response;
}

async function postRunExpectError(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.notEqual(response.status, 200, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function patchJsonExpectError(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, false, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function postJsonExpectError(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, false, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  assert.ok(response.ok, text);
  return text.trim() ? JSON.parse(text) : {};
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextEvent() {
      for (;;) {
        const block = takeNextSseBlock();
        if (block !== undefined) {
          const event = parseSseBlock(block);
          if (event) {
            return event;
          }
          continue;
        }

        const { done, value } = await withTimeout(reader.read(), 5_000, "Timed out waiting for SSE event.");
        if (done) {
          buffer += decoder.decode();
          const finalBlock = buffer.trim() ? buffer : undefined;
          buffer = "";
          return finalBlock ? parseSseBlock(finalBlock) : undefined;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },

    async collectRemaining() {
      const events = [];
      for (;;) {
        const event = await this.nextEvent();
        if (!event) {
          return events;
        }
        events.push(event);
      }
    },
  };

  function takeNextSseBlock() {
    const match = /\r?\n\r?\n/.exec(buffer);
    if (!match) {
      return undefined;
    }
    const block = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    return block;
  }
}

async function waitForSseEvent(reader, eventName) {
  for (;;) {
    const event = await reader.nextEvent();
    assert.ok(event, `SSE stream ended before ${eventName}`);
    if (event.event === eventName) {
      return event;
    }
  }
}

async function waitForMediaJobStatus(baseUrl, cwd, mediaJobId, expectedStatus, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  for (;;) {
    latest = await getJson(`${baseUrl}/media-jobs/${encodeURIComponent(mediaJobId)}?cwd=${encodeURIComponent(cwd)}`);
    if (latest.mediaJob.status === expectedStatus) {
      return latest;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for media job ${mediaJobId} to become ${expectedStatus}; latest=${latest.mediaJob.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function parseSseText(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(parseSseBlock)
    .filter(Boolean);
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith("event:")) {
      event = rawLine.slice("event:".length).trim();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  return {
    event,
    data: JSON.parse(dataLines.join("\n")),
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise.finally(() => {
      clearTimeout(timeout);
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function waitForCondition(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw lastError ?? new Error(message);
}
