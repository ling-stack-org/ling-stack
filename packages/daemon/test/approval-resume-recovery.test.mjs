import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  applyConversationModeToEffectiveRunPolicySnapshot,
  approvalSideEffectFingerprintV1,
  createApprovalResumeBasisV1,
  createCompositeSecretResolver,
  createSqliteRunStore,
  getRunSummaryPath,
  resolveSessionRunPolicy,
  runnerContinuationIdempotencyKey,
  toRuntimeAttemptFence,
} from "../../core/dist/index.js";
import { resolveConfig } from "../dist/config.js";
import { ApprovalResumeCoordinator } from "../dist/features/runs/approval-resume-coordinator.js";
import { ApprovalAutoReviewRecoveryCoordinator } from "../dist/features/runs/approval-auto-review-recovery.js";
import { reviewPendingApprovalAutomatically } from "../dist/features/runs/approval-auto-review-host.js";
import { prepareApprovedToolContinuation } from "../dist/features/runs/approval-continuation-tool.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { createDetachedRunExecutionSink, executeExistingRunContinuation, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { appendApprovalDecisionEvent } from "../dist/features/runs/approvals.js";
import { ensureLingThreadForRun, ensureLingTurnForRun } from "../dist/features/runs/threads.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { PiRunnerAdapter } from "../../runner-pi/dist/index.js";
import { projectConversationActivity, projectConversationTimelineItems, projectDisplayBatches } from "../../conversation-ui-core/dist/index.js";
import { createTypedWorkflowBasis, gateOwner, typedOperation } from "./support/workflow-operation-gate-fixture.mjs";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

// Actual SQLite + production continuation dispatcher + Pi SDK + HTTP/SSE. The
// provider is deterministic, not a live model or packaged-client acceptance.
for (const [phase, exec] of [
  ["approved"], ["approved-with-exec", { timeoutMs: 3_000, idleTimeoutMs: 3_000, pty: false }],
  ["before-tool-start"], ["after-tool-end"],
]) {
  test(`real Pi approval recovery ${phase} sends durable evidence once after SQLite reopen`, { timeout: 15_000 }, async (t) => {
    const provider = await startLoopbackPiProvider(() => ({ text: "Loopback recovered conclusion." }));
    t.after(() => provider.close());
    const fixture = await createResumeFixture(
      `pi-http-${phase}`, "printf x >> real-resume-count.txt", false, true, true, "approve",
      { providerBaseUrl: provider.baseUrl, realSdk: true, exec },
    );
    t.after(() => fixture.close());
    const alreadyApproved = phase.startsWith("approved");
    if (!alreadyApproved) {
      const claimed = claimResume(fixture, `attempt_pi_http_${phase}`);
      if (phase === "after-tool-end") {
        // Seed the crash-after-effect boundary. The other phases exercise the
        // actual Host command; this one proves durable results are not replayed.
        await writeFile(resolve(fixture.cwd, "real-resume-count.txt"), "x", "utf8");
        appendResumeToolStart(fixture, claimed.attempt.id);
        fixture.store.appendEvent(fixture.run.id, "tool_end", {
          type: "tool_end", toolCallId: fixture.approval.toolCallId, toolName: "bash",
          result: { content: [{ type: "text", text: "Persisted approved result." }], isError: false },
          isError: false, resumedFromApprovalId: fixture.approval.id, attemptId: claimed.attempt.id,
        });
      }
    }
    const historicalApprovedToolEvents = matchingToolEvents(fixture);
    fixture.storeRegistry.closeAll();
    fixture.storeRegistry = new RunStoreRegistry(createSqliteRunStore);
    fixture.store = fixture.storeRegistry.getStore(fixture.cwd);
    fixture.approval = fixture.store.getApprovalRequest(fixture.approval.id);
    fixture.checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);

    const activeRuns = new ActiveRunRegistry();
    const coordinator = createCoordinator(activeRuns, fixture);
    assert.ok(fixture.store.getLingTurnForRun(fixture.run.id), "SQLite reopen preserves the Run/Turn link");
    assert.ok(fixture.store.getLingThread(fixture.run.threadId), "SQLite reopen preserves the owning Thread");
    coordinator.registerStore(fixture.store);
    coordinator.registerStore(fixture.store);
    await activeRuns.waitForIdle();
    assert.deepEqual(fixture.dispatchErrors, [], "production dispatcher must accept the stored continuation lineage");
    await waitForCondition(() => ["succeeded", "failed", "cancelled"].includes(
      fixture.store.getRun(fixture.run.id)?.status,
    ), "real Pi recovery did not settle");

    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "succeeded", JSON.stringify({
      errors: fixture.dispatchErrors, reason: fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.resumeFailureReason,
      requestCount: provider.requests.length,
    }));
    assert.equal(fixture.runnerCalls[0]?.approvedToolContinuation?.result.isError, false,
      JSON.stringify(fixture.runnerCalls[0]?.approvedToolContinuation?.result));
    assert.equal(await readFile(resolve(fixture.cwd, "real-resume-count.txt"), "utf8"), "x");
    assert.equal(fixture.runnerCalls.length, 1);
    assert.equal(fixture.runnerResults.length, 1);
    assert.match(JSON.stringify(fixture.runnerResults[0].messages), /Loopback recovered conclusion\./u);
    assert.equal(provider.requests.length, 1, "no original prompt replay or cache warming request");
    const [request] = provider.requests;
    const prepared = fixture.store.getRun(fixture.run.id).requestSnapshot.runnerExecutionInput.preparedInput;
    assert.equal(request.model, prepared.model.id);
    assert.equal(request.messages[0].content, prepared.systemPrompt);
    assert.deepEqual(request.messages.map(message => message.role), ["system", "user", "assistant", "tool"]);
    assert.deepEqual(request.messages[1].content, [{ type: "text", text: prepared.userPrompt }]);
    const evidence = fixture.runnerCalls[0].approvedToolContinuation;
    assert.equal(evidence.approvalId, fixture.approval.id);
    assert.equal(evidence.toolCallId, fixture.approval.toolCallId);
    assert.equal(evidence.sideEffectFingerprint, fixture.checkpoint.resumeBasis.sideEffectFingerprint);
    assert.deepEqual(evidence.args, { command: fixture.command, cwd: fixture.cwd, ...exec });
    assert.equal(request.messages[2].tool_calls.length, 1);
    assert.equal(request.messages[2].tool_calls[0].id, fixture.approval.toolCallId);
    assert.equal(request.messages[2].tool_calls[0].function.name, "bash");
    assert.deepEqual(JSON.parse(request.messages[2].tool_calls[0].function.arguments), evidence.args);
    assert.equal(request.messages[3].tool_call_id, fixture.approval.toolCallId);
    assert.equal(request.messages[3].content, evidence.result.content.map(block => block.text).join("\n"));
    assert.doesNotMatch(JSON.stringify(request), /ling_host_resume/u, "SDK control item must not leak to the provider");
    assert.equal(matchingToolEvents(fixture).filter(event => event.type === "tool_start").length, 1);
    assert.equal(matchingToolEvents(fixture).filter(event => event.type === "tool_end").length, 1);
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resumed");
    assert.deepEqual(evidence.result, matchingToolEvents(fixture).find(event => event.type === "tool_end").data.result,
      "same-process and reopened continuations consume the same canonical durable result");
    assert.equal(fixture.store.listApprovalRequests({ runId: fixture.run.id }).length, 1);
    const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
    assert.equal(attempts.at(-1).status, "succeeded");
    assert.equal(attempts.length, alreadyApproved ? 2 : 3);
    for (const event of matchingToolEvents(fixture)) assert.equal(event.data.attemptId,
      phase === "after-tool-end" ? `attempt_pi_http_${phase}` : attempts.at(-1).id,
      "approved bash replay retains its historical owner; only newly executed tools belong to the target Attempt");
    for (const historical of historicalApprovedToolEvents) assert.deepEqual(
      fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).find(event => event.id === historical.id), historical);
    const continuation = fixture.store.findRunnerContinuationByIdempotencyKey(`${runnerContinuationIdempotencyKey({
      runId: fixture.run.id, sourceAttemptId: alreadyApproved ? fixture.priorAttempt.id : `attempt_pi_http_${phase}`,
      origin: "approval_resume", generation: 0,
    })}:${fixture.approval.id}`);
    assert.equal(continuation?.state, "succeeded");
    assert.equal(continuation?.targetAttemptId, attempts.at(-1).id);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listResourceLeases({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);

    coordinator.registerStore(fixture.store);
    coordinator.registerStore(fixture.store);
    await activeRuns.waitForIdle();
    assert.equal(provider.requests.length, 1, "duplicate recovery must not dispatch again");
    assert.equal(fixture.runnerCalls.length, 1);
    assert.equal(await readFile(resolve(fixture.cwd, "real-resume-count.txt"), "utf8"), "x");
  });
}

test("A12 linked workflow approval recovery rebuilds current ownership after SQLite reopen and executes once", { timeout: 15_000 }, async (t) => {
  const provider = await startLoopbackPiProvider(() => ({ text: "Linked workflow recovery complete." }));
  t.after(() => provider.close());
  const fixture = await createResumeFixture("linked-workflow", "printf x >> linked-workflow-count.txt",
    false, true, true, "approve", { providerBaseUrl: provider.baseUrl, realSdk: true, workflowStartLinked: true });
  t.after(() => fixture.close());
  const { workflowStart } = fixture;
  const linked = fixture.store.getChannelWorkflowStep(workflowStart.step.id);
  const frozenExecution = fixture.store.getRun(fixture.run.id).requestSnapshot.runnerExecutionInput;
  assert.equal(linked.status, "running");
  assert.equal(linked.taskId, fixture.run.taskId);
  assert.equal(linked.runId, fixture.run.id);
  assert.deepEqual(linked.metadata.startOwner, { ...workflowStart.owner, phase: "linked" });
  assert.equal(fixture.store.getTask(fixture.run.taskId).currentRunId, fixture.run.id);
  assert.equal(fixture.store.getLingThread(fixture.run.threadId).kind, "workflow_step");
  assert.equal(fixture.run.requestSnapshot.workflowStartOwner, undefined,
    "continuation must rebuild from the current linked marker, not an injected request owner");
  const originalApproval = fixture.store.getApprovalRequest(fixture.approval.id);
  const originalBasis = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id).resumeBasis;
  assert.equal(originalBasis.workflowStepId, workflowStart.step.id);
  assert.equal(fixture.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: workflowStart.step.id })
    .find(entry => entry.id === workflowStart.lease.id)?.status, "active");

  fixture.runtimeSupervisor.releaseAll();
  fixture.storeRegistry.closeAll();
  fixture.storeRegistry = new RunStoreRegistry(createSqliteRunStore);
  fixture.store = fixture.storeRegistry.getStore(fixture.cwd);
  fixture.runtimeSupervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: fixture.cwd,
    harness: { continuations: { mode: "enforce" } } }));
  fixture.run = fixture.store.getRun(fixture.run.id);
  fixture.approval = fixture.store.getApprovalRequest(fixture.approval.id);
  fixture.checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
  assert.deepEqual(fixture.store.getChannelWorkflowStep(workflowStart.step.id).metadata.startOwner, linked.metadata.startOwner);
  const activeRuns = new ActiveRunRegistry();
  const coordinator = createCoordinator(activeRuns, fixture);
  coordinator.registerStore(fixture.store);
  coordinator.registerStore(fixture.store);
  await activeRuns.waitForIdle();
  await waitForCondition(() => ["succeeded", "failed", "cancelled"].includes(fixture.store.getRun(fixture.run.id)?.status),
    "linked workflow approval recovery did not settle");
  assert.deepEqual(fixture.dispatchErrors, []);
  assert.equal(fixture.store.getRun(fixture.run.id).status, "succeeded",
    fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.resumeFailureReason);
  assert.equal(await readFile(resolve(fixture.cwd, "linked-workflow-count.txt"), "utf8"), "x");
  assert.equal(fixture.runnerCalls.length, 1);
  assert.equal(fixture.runnerResults.length, 1);
  assert.equal(provider.requests.length, 1, "the real SDK continues once without original prompt replay");
  const [request] = provider.requests;
  assert.deepEqual(request.messages.map(message => message.role), ["system", "user", "assistant", "tool"]);
  assert.equal(request.messages[2].tool_calls[0].id, fixture.approval.toolCallId);
  assert.equal(request.messages[3].tool_call_id, fixture.approval.toolCallId);
  const approvedResult = fixture.runnerCalls[0].approvedToolContinuation;
  assert.equal(approvedResult.sideEffectFingerprint, originalBasis.sideEffectFingerprint);
  assert.equal(approvedResult.approvalId, fixture.approval.id);
  assert.deepEqual(approvedResult.args, { command: fixture.command, cwd: fixture.cwd });
  assert.equal(request.messages[3].content, approvedResult.result.content.map(block => block.text).join("\n"));
  assert.doesNotMatch(JSON.stringify(request), /ling_host_resume/u);
  assert.match(JSON.stringify(fixture.runnerResults[0].messages), /Linked workflow recovery complete\./u);
  const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts.at(-1).id, fixture.priorAttempt.id);
  assert.equal(attempts.at(-1).status, "succeeded");
  assert.equal(fixture.runnerCalls[0].runnerAttemptId, attempts.at(-1).id);
  const toolEvents = matchingToolEvents(fixture);
  assert.deepEqual(toolEvents.map(event => event.type), ["tool_start", "tool_end"]);
  assert.ok(toolEvents.every(event => event.data.attemptId === attempts.at(-1).id));
  assert.equal(toolEvents[0].data.args.command, fixture.command);
  assert.equal(toolEvents[1].data.isError, false);
  assert.deepEqual(approvedResult.result, toolEvents[1].data.result);
  const conclusion = fixture.store.getChannelWorkflowStep(workflowStart.step.id);
  assert.equal(conclusion.status, "succeeded");
  assert.equal(conclusion.taskId, fixture.run.taskId);
  assert.equal(conclusion.runId, fixture.run.id);
  assert.deepEqual(conclusion.metadata.startOwner, linked.metadata.startOwner,
    "resume must not replace Task, exact lease or semantic authority");
  assert.equal(fixture.store.getChannelWorkflow(workflowStart.workflow.id).status, "succeeded");
  assert.equal(fixture.store.getTask(fixture.run.taskId).currentRunId, fixture.run.id);
  assert.equal(fixture.store.listTasks({ channelId: workflowStart.channel.id }).length, 1);
  assert.deepEqual(fixture.store.getRun(fixture.run.id).requestSnapshot.runnerExecutionInput, frozenExecution);
  assert.deepEqual(fixture.store.getApprovalRequest(fixture.approval.id), originalApproval);
  assert.deepEqual(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id).resumeBasis, originalBasis);
  assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id).status, "resumed");
  const continuation = fixture.store.findRunnerContinuationByIdempotencyKey(`${runnerContinuationIdempotencyKey({
    runId: fixture.run.id, sourceAttemptId: fixture.priorAttempt.id, origin: "approval_resume", generation: 0,
  })}:${fixture.approval.id}`);
  assert.equal(continuation?.state, "succeeded");
  assert.equal(continuation?.targetAttemptId, attempts.at(-1).id);
  assert.equal(fixture.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: workflowStart.step.id })
    .find(entry => entry.id === workflowStart.lease.id)?.status, "released");
  assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
  assert.equal(fixture.store.listResourceLeases({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
  coordinator.registerStore(fixture.store);
  await activeRuns.waitForIdle();
  assert.equal(provider.requests.length, 1);
  assert.equal(fixture.runnerCalls.length, 1);
  assert.equal(await readFile(resolve(fixture.cwd, "linked-workflow-count.txt"), "utf8"), "x");
});

test("fresh readonly Pi approval recovery assigns the new SDK call to the replacement Attempt", { timeout: 15_000 }, async (t) => {
  let readPath;
  const provider = await startLoopbackPiProvider((_body, count) => count === 1
    ? { tool: "read", input: { path: readPath } }
    : { text: "Fresh readonly recovery complete." });
  t.after(() => provider.close());
  const fixture = await createResumeFixture("fresh-readonly", "printf x >> readonly-resume-count.txt",
    false, true, true, "approve", { providerBaseUrl: provider.baseUrl, realSdk: true,
      tools: ["bash", "read"], conversationAnchor: true });
  t.after(() => fixture.close());
  readPath = resolve(fixture.cwd, "fresh-readonly.txt");
  await writeFile(readPath, "Real readonly evidence after approval.", "utf8");
  const originalApproval = fixture.store.getApprovalRequest(fixture.approval.id);
  const originalBasis = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id).resumeBasis;
  const frozen = fixture.store.getRun(fixture.run.id).requestSnapshot.runnerExecutionInput;
  assert.deepEqual(frozen.input.tools, ["bash", "read"], "read must be legal before the first prepare/capture");
  assert.deepEqual(frozen.preparedInput.tools.map(tool => tool.name).sort(), ["bash", "read"]);
  assert.deepEqual(fixture.store.getRun(fixture.run.id).requestSnapshot.tools, ["bash", "read"]);
  fixture.storeRegistry.closeAll();
  fixture.storeRegistry = new RunStoreRegistry(createSqliteRunStore);
  fixture.store = fixture.storeRegistry.getStore(fixture.cwd);
  fixture.approval = fixture.store.getApprovalRequest(fixture.approval.id);
  fixture.checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
  const activeRuns = new ActiveRunRegistry();
  const coordinator = createCoordinator(activeRuns, fixture);
  coordinator.registerStore(fixture.store);
  await activeRuns.waitForIdle();
  await waitForCondition(() => ["succeeded", "failed", "cancelled"].includes(fixture.store.getRun(fixture.run.id)?.status),
    "fresh readonly recovery did not settle");
  assert.deepEqual(fixture.dispatchErrors, []);
  assert.equal(fixture.store.getRun(fixture.run.id)?.status, "succeeded");
  assert.equal(provider.requests.length, 2, "one new read and one conclusion, with no original tool replay");
  assert.equal(await readFile(resolve(fixture.cwd, "readonly-resume-count.txt"), "utf8"), "x");
  const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
  assert.equal(attempts.length, 2);
  const replacement = attempts.at(-1);
  assert.notEqual(replacement.id, fixture.priorAttempt.id);
  assert.equal(fixture.runnerCalls[0].runnerAttemptId, replacement.id);
  const events = fixture.store.listEvents(fixture.run.id, { limit: 1_000 });
  const readEvents = events.filter(event => ["tool_start", "tool_update", "tool_end"].includes(event.type)
    && event.data.toolName === "read");
  assert.deepEqual(readEvents.map(event => event.type), ["tool_start", "tool_end"],
    "the actual built-in read produces start/end; this is not update coverage");
  const readCallId = readEvents[0].data.toolCallId;
  assert.notEqual(readCallId, fixture.approval.toolCallId, "the provider creates a wholly new SDK call");
  assert.equal(readEvents[0].data.args.path, readPath);
  assert.equal(readEvents[1].data.isError, false);
  assert.match(JSON.stringify(readEvents[1].data.result), /Real readonly evidence after approval\./u);
  for (const event of readEvents) assert.equal(event.data.attemptId, replacement.id,
    `${event.type} must use the captured B fence, not the old Run or approval Attempt`);
  const log = (await readFile(fixture.store.getRun(fixture.run.id).eventLogPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(log.filter(event => ["tool_start", "tool_update", "tool_end"].includes(event.type)
    && event.data.toolCallId === readCallId), readEvents);
  const [request, afterRead] = provider.requests;
  assert.equal(request.messages[2].tool_calls[0].id, fixture.approval.toolCallId);
  assert.equal(request.messages[3].tool_call_id, fixture.approval.toolCallId);
  assert.equal(afterRead.messages.at(-1).tool_call_id, readCallId);
  assert.match(JSON.stringify(afterRead.messages.at(-1)), /Real readonly evidence after approval\./u);
  assert.deepEqual(fixture.store.getApprovalRequest(fixture.approval.id), originalApproval,
    "the source approval is historical A evidence, not a new readonly owner");
  assert.deepEqual(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id).resumeBasis, originalBasis);
  const actions = listAllExecutionActionsForRun(fixture.store, fixture.run.id);
  const readAction = actions.find(action => action.toolCallId === readCallId);
  assert.ok(readAction, "use the real canonical action service, not a fabricated DTO");
  assert.equal(readAction.attemptId, replacement.id);
  assert.equal(readAction.status, "succeeded");
  assert.equal(readAction.sourceEventSequence, readEvents[0].seq);
  assert.ok(readAction.sourceRefs.some(ref => ref.kind === "attempt" && ref.id === replacement.id));
  const owningTurn = fixture.store.getLingTurnForRun(fixture.run.id);
  assert.ok(readAction.sourceRefs.some(ref => ref.kind === "conversation_item"
    && fixture.store.getConversationItem(ref.id)?.turnId === owningTurn.id),
  "shared consumption must use the owning durable input item, never a manufactured source reference");
  for (const event of readEvents) assert.ok(readAction.sourceRefs.some(ref => ref.kind === "run_event" && ref.id === event.id));
  const turnRun = fixture.store.listLingTurnRuns(owningTurn.id).find(link => link.runId === fixture.run.id);
  assert.ok(turnRun);
  const row = readonlyActionRow(readAction, turnRun);
  const activity = projectConversationActivity([row]);
  assert.equal(activity[0].kind, "operation");
  assert.equal(activity[0].row.operationExecution.attemptId, replacement.id);
  const timeline = projectConversationTimelineItems(activity);
  assert.equal(timeline[0].kind, "exploration");
  assert.equal(timeline[0].attemptId, replacement.id);
  const display = projectDisplayBatches(timeline);
  assert.equal(display.items[0].attemptId, replacement.id);
  assert.equal(display.items[0].actionId, readAction.id);
  assert.ok(!display.items.some(item => item.kind === "explorationBatch"),
    "one real read proves lineage preservation, not a three-action cross-Attempt batching scenario");
  coordinator.registerStore(fixture.store);
  await activeRuns.waitForIdle();
  assert.equal(provider.requests.length, 2);
  assert.equal(await readFile(resolve(fixture.cwd, "readonly-resume-count.txt"), "utf8"), "x");
});

test("fresh readonly approval takeover rejects a captured A SDK event re-delivered through its old Host callback", { timeout: 15_000 }, async t => {
  const f = await createLiveReadonlySourceFixture(t);
  await waitForCondition(() => f.observed.sourceOptions && f.observed.sourceReadEnd
    && f.sourceStore.listApprovalRequests({ runId: f.observed.sourceOptions.runId, status: "pending" }).length === 1,
  "the actual source SDK must read its file and reach a durable approval wait").catch(error => {
    const runId = f.observed.sourceOptions?.runId;
    assert.fail(JSON.stringify({ message: error.message, dispatchErrors: f.dispatchErrors,
      sourceFailure: f.sourceFailure?.message, requests: f.provider.requests.length,
      run: runId ? f.sourceStore.getRun(runId) : undefined,
      events: runId ? f.sourceStore.listEvents(runId, { limit: 1_000 }) : undefined }));
  });
  const sourceOptions = f.observed.sourceOptions;
  const sourceRun = f.sourceStore.getRun(sourceOptions.runId);
  const priorAttempt = f.sourceStore.getWorkUnitAttempt(sourceOptions.runnerAttemptId);
  const [pending] = f.sourceStore.listApprovalRequests({ runId: sourceRun.id, status: "pending" });
  const sourceEvents = f.sourceStore.listEvents(sourceRun.id, { limit: 1_000 });
  assert.equal(sourceRun.status, "waiting_for_approval");
  assert.equal(f.observed.sourceReadEnd.isError, false);
  assert.match(JSON.stringify(f.observed.sourceReadEnd.result), /Actual source SDK read\./u);
  assert.equal(sourceOptions.signal.aborted, false);
  // Reopen through an independent real SQLite connection while the original
  // producer remains alive. There is deliberately no cancel/suspend signal:
  // that early return would not exercise the captured A fence in the SQL write.
  f.storeRegistry = new RunStoreRegistry(createSqliteRunStore);
  f.store = f.storeRegistry.getStore(f.cwd);
  f.run = f.store.getRun(sourceRun.id);
  f.workUnit = f.store.getWorkUnit(sourceRun.workUnitId);
  f.priorAttempt = f.store.getWorkUnitAttempt(priorAttempt.id);
  f.approval = f.store.getApprovalRequest(pending.id);
  f.checkpoint = f.store.getApprovalCheckpointForApproval(pending.id);
  f.replacementRuns = new ActiveRunRegistry();
  const coordinator = createCoordinator(f.replacementRuns, f);
  const originalAppend = f.sourceStore.appendExecutionEvent.bind(f.sourceStore);
  const admissions = [];
  f.sourceStore.appendExecutionEvent = (runId, fence, type, data) => {
    try {
      const value = originalAppend(runId, fence, type, data);
      admissions.push({ fence, type, value });
      return value;
    } catch (error) {
      admissions.push({ fence, type, code: error.code });
      throw error;
    }
  };
  // This must remain one synchronous window: claim B, snapshot, then release
  // the captured real A callback before either SDK can advance asynchronously.
  f.approval = f.store.approveApprovalRequest(pending.id, { reason: "test-only takeover" }, new Date().toISOString());
  assert.equal(f.approval.status, "approved");
  const started = coordinator.resumeAfterApproval({ store: f.store, approval: f.approval });
  assert.equal(started.status, "started", JSON.stringify(started));
  const replacement = f.store.getWorkUnitAttempt(f.store.getWorkUnit(f.workUnit.id).activeAttemptId);
  assert.notEqual(replacement.id, priorAttempt.id);
  assert.equal(f.store.isCurrentRunExecutionOwner(sourceRun.id, toRuntimeAttemptFence(replacement)), true);
  const before = { events: f.store.listEvents(sourceRun.id, { limit: 1_000 }),
    log: readFileSync(sourceRun.eventLogPath, "utf8"), stream: [...f.observed.sourceStream],
    actions: listAllExecutionActionsForRun(f.store, sourceRun.id) };
  f.observed.redeliverSourceReadEnd();
  assert.equal(sourceOptions.signal.aborted, false, "stale rejection must not be a cancellation short-circuit");
  assert.equal(admissions.length, 1, "the original Host callback reaches the actual guarded append");
  assert.deepEqual(admissions[0].fence, toRuntimeAttemptFence(priorAttempt));
  assert.equal(admissions[0].type, "tool_end");
  assert.equal(admissions[0].code, "stale_run_execution");
  assert.deepEqual(f.store.listEvents(sourceRun.id, { limit: 1_000 }), before.events);
  assert.equal(readFileSync(sourceRun.eventLogPath, "utf8"), before.log);
  assert.deepEqual(f.observed.sourceStream, before.stream, "the shared SSE writeEvent path receives no stale fact");
  assert.deepEqual(listAllExecutionActionsForRun(f.store, sourceRun.id), before.actions);
  f.sourceStore.appendExecutionEvent = originalAppend;
  // Stop A only after proving the callback reached and lost its original SQL
  // fence. Otherwise its still-live SDK may make another unrelated request.
  f.sourceRuns.requestStop(sourceRun.id, { kind: "runtime_suspend", cause: "daemon_restart",
    runtimeInstanceId: priorAttempt.runtimeInstanceId });
  await waitForCondition(() => ["succeeded", "failed", "cancelled"].includes(f.store.getRun(sourceRun.id)?.status),
    "replacement SDK did not settle after rejecting the old callback");
  assert.equal(f.store.getRun(sourceRun.id).status, "succeeded", JSON.stringify(f.dispatchErrors));
  await f.sourceCompletion;
  assert.equal(await readFile(resolve(f.cwd, "source-resume-marker.txt"), "utf8"), "x",
    "only B may execute the approved Host command");
  assert.equal(f.provider.requests.length, 4, "A read/approval request and B read/conclusion only");
  const finalEvents = f.store.listEvents(sourceRun.id, { limit: 1_000 });
  for (const historical of sourceEvents) {
    assert.deepEqual(finalEvents.find(event => event.id === historical.id), historical,
      "claim/recovery must not restamp the source producer's durable A facts");
  }
  const reads = finalEvents.filter(event => event.type === "tool_end" && event.data.toolName === "read");
  assert.equal(reads.length, 2, "re-delivering the captured A event adds no duplicate historical read result");
  assert.equal(reads[0].data.attemptId, priorAttempt.id);
  assert.equal(reads[1].data.attemptId, replacement.id);
});

test("approval continuation with a missing durable tool_end refuses SDK dispatch and replay", { timeout: 15_000 }, async (t) => {
  const provider = await startLoopbackPiProvider(() => ({ text: "Must not be requested." }));
  t.after(() => provider.close());
  const fixture = await createResumeFixture("pi-end-not-durable", "printf x >> real-resume-count.txt",
    false, true, true, "approve", { providerBaseUrl: provider.baseUrl, realSdk: true });
  t.after(() => fixture.close());
  appendApprovalDecisionEvent(fixture.store, fixture.approval);
  fixture.runtimeSupervisor.getRuntime(fixture.cwd, fixture.store);
  const claimed = claimResume(fixture, "attempt_pi_end_not_durable");
  const sourceFence = toRuntimeAttemptFence(claimed.attempt);
  await assert.rejects(prepareApprovedToolContinuation({
    store: fixture.store, run: fixture.store.getRun(fixture.run.id),
    workUnit: fixture.store.getWorkUnit(fixture.workUnit.id), attempt: claimed.attempt,
    approvalId: fixture.approval.id, runtimeSupervisor: fixture.runtimeSupervisor, signal: new AbortController().signal,
    appendAndMaybeStream(type, data) {
      // Fault injection: the effect finishes but its terminal write is lost.
      if (type === "tool_end") {
        assert.equal(data.result.isError, false, JSON.stringify(data.result));
        return undefined;
      }
      return fixture.store.appendExecutionEvent(fixture.run.id, sourceFence, type, data);
    },
  }), /approval_resume_result_not_durable/u);
  assert.equal(await readFile(resolve(fixture.cwd, "real-resume-count.txt"), "utf8"), "x");
  assert.equal(matchingToolEvents(fixture).filter(event => event.type === "tool_start").length, 1);
  assert.equal(matchingToolEvents(fixture).filter(event => event.type === "tool_end").length, 0);
  assert.equal(fixture.runnerCalls.length, 0);
  assert.equal(provider.requests.length, 0);
  const activeRuns = new ActiveRunRegistry();
  const coordinator = createCoordinator(activeRuns, fixture);
  coordinator.registerStore(fixture.store);
  coordinator.registerStore(fixture.store);
  await activeRuns.waitForIdle();
  assert.equal(fixture.store.getRun(fixture.run.id)?.status, "failed");
  const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
  assert.equal(checkpoint.status, "resume_failed");
  assert.equal(checkpoint.resumeFailureReason, "approval_resume_effect_unknown");
  assert.equal(await readFile(resolve(fixture.cwd, "real-resume-count.txt"), "utf8"), "x");
  assert.equal(fixture.runnerCalls.length, 0);
  assert.equal(provider.requests.length, 0);
});

test("typed bash recovery is blocked before tool_start when isolation is unavailable", async () => {
  const fixture = await createResumeFixture("typed-isolation", "printf x >> must-not-run.txt", true);
  try {
    const activeRuns = new ActiveRunRegistry();
    const coordinator = createCoordinator(activeRuns);
    const started = coordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.equal(started.status, "started", JSON.stringify(started));
    await activeRuns.waitForIdle();
    const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
    assert.equal(checkpoint.status, "resume_failed");
    assert.match(checkpoint.resumeFailureReason, /operation_binding_isolation_unavailable/);
    assert.equal(fixture.store.getRun(fixture.run.id).status, "failed");
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_start").length, 0);
    await assert.rejects(readFile(resolve(fixture.cwd, "must-not-run.txt")), /ENOENT/);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listResourceLeases({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
  } finally { await fixture.close(); }
});

test("enforced approval resume adopts one Harness Attempt and closes its continuation", async () => {
  const fixture = await createResumeFixture("harness-adopt", "printf x >> harness-resume.txt", false, true);
  try {
    const activeRuns = new ActiveRunRegistry();
    const coordinator = createCoordinator(activeRuns, fixture);
    const started = coordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.equal(started.status, "started");
    await activeRuns.waitForIdle();
    await waitForCondition(() => ["succeeded", "failed", "cancelled"].includes(
      fixture.store.getRun(fixture.run.id)?.status,
    ), `approval continuation did not become terminal: ${JSON.stringify(fixture.dispatchErrors)}`);
    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "succeeded");
    assert.equal(await readFile(resolve(fixture.cwd, "harness-resume.txt"), "utf8"), "x");
    const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
    assert.equal(attempts.length, 2, "approval adoption must not create a second replacement Attempt");
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["lost", "succeeded"]);
    const continuation = fixture.store.findRunnerContinuationByIdempotencyKey(`${runnerContinuationIdempotencyKey({
      runId: fixture.run.id,
      sourceAttemptId: fixture.priorAttempt.id,
      origin: "approval_resume",
      generation: 0,
    })}:${fixture.approval.id}`);
    assert.equal(continuation?.state, "succeeded");
    assert.equal(continuation?.targetAttemptId, attempts[1].id);
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resumed");
    assert.equal(fixture.runnerCalls.length, 1);
    assert.equal(fixture.runnerCalls[0].approvedToolContinuation?.approvalId, fixture.approval.id);
    assert.equal(fixture.runnerCalls[0].approvedToolContinuation?.toolCallId, fixture.approval.toolCallId);
    assert.equal(fixture.runnerCalls[0].approvedToolContinuation?.result.isError, false);
    assert.equal(fixture.store.listApprovalRequests({ runId: fixture.run.id }).length, 1,
      "continuation must not request approval for durable approved evidence again");
  } finally {
    await fixture.close();
  }
});

test("restart finalizes a manually denied suspended approval exactly once without executing", async () => {
  const fixture = await createResumeFixture("manual-denied", "printf unsafe > must-not-run.txt", false, false, true, "pending");
  try {
    const now = "2026-08-16T02:01:00.000Z";
    fixture.store.updateWorkUnitAttemptStatus({
      workUnitId: fixture.priorAttempt.workUnitId,
      attemptId: fixture.priorAttempt.id,
      runtimeInstanceId: fixture.priorAttempt.runtimeInstanceId,
      fencingToken: fixture.priorAttempt.fencingToken,
      status: "lost",
      now,
      endedAt: now,
      errorCode: "runtime_suspend",
      errorMessage: "daemon restart before human decision",
    });
    const denied = fixture.store.denyApprovalRequest(fixture.approval.id, {
      reason: "user rejected the command",
      resolvedBy: "local-user",
    }, now);
    assert.equal(denied?.status, "denied");
    const coordinator = createCoordinator(new ActiveRunRegistry(), fixture);
    assert.equal(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id)?.status, "lost");
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "denied");
    coordinator.registerStore(fixture.store);
    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "failed");
    assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "failed");
    assert.equal(fixture.store.getTask(fixture.run.taskId)?.status, "failed");
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "denied");
    assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1000 }).filter((event) =>
      event.type === "approval_denied" && event.data?.approvalId === denied.id).length, 1);
    coordinator.registerStore(fixture.store);
    assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1000 }).filter((event) =>
      event.type === "approval_denied" && event.data?.approvalId === denied.id).length, 1);
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 1);
    await assert.rejects(readFile(resolve(fixture.cwd, "must-not-run.txt")), /ENOENT/);
  } finally {
    await fixture.close();
  }
});

// Regression: P5 — terminal denial recovery must not manufacture recent activity.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/p5-denial-recency-repair-20261026/charter.md
for (const projection of ["settled", "stale", "later-title", "later-goal"]) {
  test(`terminal denial recovery preserves recency and reconciliation: ${projection}`, async t => {
    const fixture = await createResumeFixture(`denial-recency-${projection}`,
      "printf unsafe > must-not-run.txt", false, true, true, "pending");
    t.after(() => fixture.close());
    const terminalAt = "2026-10-26T00:00:00.000Z";
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(terminalAt) });
    fixture.store.updateWorkUnitAttemptStatus({
      workUnitId: fixture.priorAttempt.workUnitId, attemptId: fixture.priorAttempt.id,
      runtimeInstanceId: fixture.priorAttempt.runtimeInstanceId, fencingToken: fixture.priorAttempt.fencingToken,
      status: "lost", now: terminalAt, endedAt: terminalAt, errorCode: "runtime_suspend",
      errorMessage: "daemon restart before human decision",
    });
    const approval = fixture.store.denyApprovalRequest(fixture.approval.id,
      { reason: "user rejected the command", resolvedBy: "local-user" }, terminalAt);
    assert.equal(approval.status, "denied");
    const reconciled = [];
    const coordinator = new ApprovalResumeCoordinator({
      activeRuns: new ActiveRunRegistry(), runnerRegistry: fixture.runnerRegistry,
      runtimeSupervisor: fixture.runtimeSupervisor,
      afterRunTerminal: run => { reconciled.push(run.id); },
    });
    coordinator.registerStore(fixture.store);
    const run = fixture.store.getRun(fixture.run.id);
    assert.equal(run.status, "failed");
    assert.equal(run.endedAt, terminalAt);
    const threadId = run.threadId;
    assert.equal(fixture.store.getLingThread(threadId).status, "failed");
    if (projection === "stale") {
      fixture.store.updateLingThread(threadId, { status: "waiting_for_approval", activeRunId: run.id,
        lastRunId: null }, "2026-08-16T02:00:00.000Z");
    } else if (projection === "later-title") {
      fixture.store.updateLingThread(threadId, { title: "User renamed this conversation" },
        "2026-10-26T00:10:00.000Z");
    }
    const goal = projection === "later-goal" ? fixture.store.createLingThreadGoal({ threadId,
      objective: "A new goal after the denied Run ended" }, "2026-10-26T00:10:00.000Z") : undefined;
    const before = fixture.store.getLingThread(threadId);
    const newer = fixture.store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
      title: "A genuinely newer conversation", objective: "Keep genuine recency order" }, "2026-10-26T00:20:00.000Z");
    const events = fixture.store.listEvents(run.id, { limit: 1000 });
    const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
    const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
    t.mock.timers.tick(60 * 60 * 1000);
    coordinator.registerStore(fixture.store);
    const after = fixture.store.getLingThread(threadId);
    if (goal) {
      const recoveredGoal = fixture.store.getLingThreadGoal(threadId);
      assert.equal(recoveredGoal.updatedAt, new Date().toISOString(), "goal maintenance keeps the current recovery clock");
      assert.ok(recoveredGoal.updatedAt >= goal.createdAt, "goal time must never precede its creation");
    }
    assert.equal(after.status, "failed", "stale status is repaired, not skipped");
    assert.equal(after.activeRunId, undefined);
    assert.equal(after.lastRunId, run.id);
    const expectedActivityAt = projection === "later-title" ? before.updatedAt : terminalAt;
    assert.equal(after.updatedAt, expectedActivityAt, "recovery is not new conversation activity");
    assert.equal(after.metadata.lastActivityAt, expectedActivityAt);
    assert.equal(fixture.store.listLingThreads({ limit: 10 })[0].id, newer.id);
    if (projection !== "stale") assert.deepEqual(after, before);
    t.mock.timers.tick(60 * 60 * 1000);
    coordinator.registerStore(fixture.store);
    assert.deepEqual(fixture.store.getLingThread(threadId), after, "repeated recovery stays stable");
    assert.deepEqual(reconciled, [run.id, run.id, run.id], "terminal reconciliation is never skipped");
    assert.deepEqual(fixture.store.getRun(run.id), run);
    assert.deepEqual(fixture.store.listEvents(run.id, { limit: 1000 }), events);
    assert.deepEqual(fixture.store.getApprovalCheckpoint(checkpoint.id), checkpoint);
    assert.deepEqual(fixture.store.listWorkUnitAttempts(fixture.workUnit.id), attempts);
    assert.equal(fixture.runnerCalls.length, 0);
    await assert.rejects(readFile(resolve(fixture.cwd, "must-not-run.txt")), /ENOENT/);
  });
}

test("restart recovery scans denied checkpoints past the first 500 with tied timestamps", () => {
  const checkpoints = Array.from({ length: 501 }, (_, index) => ({
    id: `checkpoint_${String(index).padStart(4, "0")}`,
    approvalId: `approval_${String(index).padStart(4, "0")}`,
    createdAt: "2026-08-16T02:00:00.000Z",
  })).reverse();
  const recovered = [];
  const coordinator = createCoordinator(new ActiveRunRegistry());
  coordinator.finalizeSuspendedApprovalDenial = ({ approval }) => {
    recovered.push(approval.id);
    return { status: "finalized", runId: "run_test" };
  };
  coordinator.registerStore({
    listApprovalCheckpoints({ status, limit, before }) {
      if (status !== "denied") return [];
      return checkpoints.filter((checkpoint) => !before || checkpoint.id < before.id).slice(0, limit);
    },
    getApprovalRequest(id) { return { id, status: "denied" }; },
  });
  assert.equal(recovered.length, 501);
  assert.deepEqual(new Set(recovered), new Set(checkpoints.map((checkpoint) => checkpoint.approvalId)));
});

test("enforced approval preparation failure atomically closes checkpoint, task, run, attempt, and continuation", async () => {
  const fixture = await createResumeFixture(
    "harness-prepare-failure",
    "printf x >> must-not-run.txt",
    false,
    true,
    true,
  );
  try {
    const acquireRuntimeSemaphoreSlot = fixture.store.acquireRuntimeSemaphoreSlot.bind(fixture.store);
    let injected = false;
    fixture.store.acquireRuntimeSemaphoreSlot = (input) => {
      if (!injected) {
        injected = true;
        throw new Error("FAULT_AFTER_APPROVAL_CONTINUATION_ACTIVATION");
      }
      return acquireRuntimeSemaphoreSlot(input);
    };
    const activeRuns = new ActiveRunRegistry();
    const coordinator = createCoordinator(activeRuns, fixture);
    const started = coordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.equal(started.status, "started", JSON.stringify(started));
    await activeRuns.waitForIdle();
    await waitForCondition(
      () => fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status === "resume_failed",
      `approval preparation failure did not settle: ${JSON.stringify(fixture.dispatchErrors)}`,
    );

    const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
    const continuation = fixture.store.findRunnerContinuationByIdempotencyKey(`${runnerContinuationIdempotencyKey({
      runId: fixture.run.id,
      sourceAttemptId: fixture.priorAttempt.id,
      origin: "approval_resume",
      generation: 0,
    })}:${fixture.approval.id}`);
    assert.equal(fixture.dispatchErrors.at(-1)?.message, "FAULT_AFTER_APPROVAL_CONTINUATION_ACTIVATION");
    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "failed");
    assert.equal(fixture.store.getTask(fixture.run.taskId)?.status, "failed");
    assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "failed");
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["lost", "failed"]);
    assert.equal(continuation?.state, "failed");
    assert.equal(continuation?.targetAttemptId, attempts[1]?.id);
    assert.equal(fixture.runnerCalls.length, 0);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listResourceLeases({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
    await assert.rejects(readFile(resolve(fixture.cwd, "must-not-run.txt")), /ENOENT/u);
  } finally {
    await fixture.close();
  }
});

test("resume_pending before tool_start replaces the lost attempt and executes exactly once", async () => {
  const fixture = await createResumeFixture("before-tool-start", "printf x >> resume-count.txt");
  try {
    claimResume(fixture, "attempt_bound_before_start");
    const coordinator = createCoordinator(new ActiveRunRegistry());
    coordinator.registerStore(fixture.store);

    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "resume should succeed");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["lost", "lost", "succeeded"]);
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_start").length, 1);
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resumed");
    assert.equal(fixture.store.listRuntimeEvents(fixture.workUnit.id, { limit: 100 }).some((event) =>
      event.type === "semaphore_acquired" && event.attemptId === attempts.at(-1)?.id), true);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listResourceLeases({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("startup recovery waits for a missing durable approval event before executing", async () => {
  const fixture = await createResumeFixture("missing-decision-event", "printf x >> recovered-after-event.txt");
  const appendApprovalDecisionEvent = fixture.store.appendApprovalDecisionEvent.bind(fixture.store);
  try {
    fixture.store.appendApprovalDecisionEvent = () => { throw new Error("injected_event_storage_failure"); };
    const activeRuns = new ActiveRunRegistry();
    const coordinator = createCoordinator(activeRuns);
    coordinator.registerStore(fixture.store);
    await activeRuns.waitForIdle();
    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "waiting_for_approval");
    await assert.rejects(readFile(resolve(fixture.cwd, "recovered-after-event.txt")), /ENOENT/u);

    fixture.store.appendApprovalDecisionEvent = appendApprovalDecisionEvent;
    coordinator.registerStore(fixture.store);
    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "recovered approval should resume");
    assert.equal(await readFile(resolve(fixture.cwd, "recovered-after-event.txt"), "utf8"), "x");
    assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).filter((event) =>
      event.type === "approval_approved" && event.data?.approvalId === fixture.approval.id).length, 1);
  } finally {
    fixture.store.appendApprovalDecisionEvent = appendApprovalDecisionEvent;
    await fixture.close();
  }
});

test("legacy resume_pending without its bound Attempt repairs the bound identity once", async () => {
  const fixture = await createResumeFixture("missing-bound-attempt", "printf x >> resume-count.txt");
  try {
    const missingAttemptId = "attempt_missing_bound_identity";
    const checkpoint = fixture.store.updateApprovalCheckpointStatus(fixture.checkpoint.id, {
      status: "resume_pending",
      expectedStatus: "approved",
      expectedRevision: fixture.checkpoint.revision,
      runnerResumeHandle: {
        kind: "ling_continuation",
        runnerId: "pi",
        runId: fixture.run.id,
        attemptId: missingAttemptId,
        verified: true,
        payload: { schemaVersion: 1, approvalId: fixture.approval.id },
      },
    }, "2026-08-16T02:02:00.000Z");
    assert.equal(checkpoint?.status, "resume_pending");
    assert.equal(fixture.store.getWorkUnitAttempt(missingAttemptId), undefined);

    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);
    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "missing Attempt repair should finish");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
    assert.deepEqual(attempts.map((attempt) => attempt.id), [fixture.priorAttempt.id, missingAttemptId]);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["lost", "succeeded"]);
  } finally {
    await fixture.close();
  }
});

test("invalid resume lineage quarantines only the checkpoint and emits an approval invalidation", async () => {
  const fixture = await createResumeFixture("lineage-quarantine", "printf x >> must-not-run.txt");
  try {
    fixture.store.database.prepare("UPDATE approval_checkpoints SET resume_basis_json = NULL WHERE id = ?")
      .run(fixture.checkpoint.id);
    const published = [];
    const coordinator = new ApprovalResumeCoordinator({
      activeRuns: new ActiveRunRegistry(),
      runnerRegistry: resumeRunnerRegistry(),
runtimeSupervisor: {
        getRestrictedCommandRuntime() { return undefined; },
        getRuntime() {
          return { runtimeInstanceId: "runtime_after_restart" };
        },
      },
      controlPlaneEvents: { publish(event) { published.push(event); } },
    });

    const result = coordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.deepEqual(result, {
      status: "blocked",
      runId: fixture.run.id,
      reason: "approval_resume_checkpoint_missing",
    });
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resume_failed");
    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "waiting_for_approval");
    assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "waiting_for_approval");
    assert.equal(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id)?.status, "waiting_for_approval");
    assert.deepEqual(published.map((event) => [event.domain, event.action]), [["approvals", "approval.resume_blocked"]]);
    await assert.rejects(() => readFile(resolve(fixture.cwd, "must-not-run.txt"), "utf8"), /ENOENT/u);
  } finally {
    await fixture.close();
  }
});

test("resume_pending with tool_start but no tool_end blocks effect-unknown and never retries", async () => {
  const fixture = await createResumeFixture("effect-unknown", "printf x >> must-not-run.txt");
  try {
    const claimed = claimResume(fixture, "attempt_effect_unknown");
    appendResumeToolStart(fixture, claimed.attempt.id);
    const coordinator = createCoordinator(new ActiveRunRegistry());
    coordinator.registerStore(fixture.store);

    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "failed", "effect unknown should fail closed");
    const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
    assert.equal(checkpoint?.status, "resume_failed");
    assert.equal(checkpoint?.resumeFailureReason, "approval_resume_effect_unknown");
    await assert.rejects(() => readFile(resolve(fixture.cwd, "must-not-run.txt"), "utf8"), /ENOENT/u);
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 2);
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_end").length, 0);

    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 2);
  } finally {
    await fixture.close();
  }
});

test("resume_pending with tool_end finalizes durable evidence without executing again", async () => {
  const fixture = await createResumeFixture("after-tool-end", "printf x >> resume-count.txt");
  try {
    const claimed = claimResume(fixture, "attempt_after_tool_end");
    await writeFile(resolve(fixture.cwd, "resume-count.txt"), "x", "utf8");
    appendResumeToolStart(fixture, claimed.attempt.id);
    fixture.store.appendEvent(fixture.run.id, "tool_end", {
      type: "tool_end",
      toolCallId: fixture.approval.toolCallId,
      toolName: "bash",
      result: { content: [{ type: "text", text: "persisted result" }], isError: false },
      isError: false,
      resumedFromApprovalId: fixture.approval.id,
      attemptId: claimed.attempt.id,
    });
    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);

    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "durable tool_end should finalize");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 2);
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resumed");
  } finally {
    await fixture.close();
  }
});

test("enforced restart after tool_end reuses the result and still waits for the Agent conclusion", async () => {
  const fixture = await createResumeFixture("harness-after-tool-end", "printf x >> resume-count.txt", false, true);
  try {
    const claimed = claimResume(fixture, "attempt_harness_after_tool_end");
    await writeFile(resolve(fixture.cwd, "resume-count.txt"), "x", "utf8");
    appendResumeToolStart(fixture, claimed.attempt.id);
    fixture.store.appendEvent(fixture.run.id, "tool_end", {
      type: "tool_end",
      toolCallId: fixture.approval.toolCallId,
      toolName: "bash",
      result: { content: [{ type: "text", text: "persisted result" }], isError: false },
      isError: false,
      resumedFromApprovalId: fixture.approval.id,
      attemptId: claimed.attempt.id,
    });

    const activeRuns = new ActiveRunRegistry();
    createCoordinator(activeRuns, fixture).registerStore(fixture.store);
    await activeRuns.waitForIdle();
    await waitForCondition(() => ["succeeded", "failed", "cancelled"].includes(
      fixture.store.getRun(fixture.run.id)?.status,
    ), `recovered approval continuation did not become terminal: ${JSON.stringify(fixture.dispatchErrors)}`);

    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "succeeded");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    assert.equal(fixture.runnerCalls.length, 1, "durable tool_end must still continue the Agent exactly once");
    assert.equal(fixture.runnerCalls[0].approvedToolContinuation?.result.content[0]?.text, "persisted result");
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_start").length, 1);
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_end").length, 1);
    assert.deepEqual(
      fixture.store.listWorkUnitAttempts(fixture.workUnit.id).map((attempt) => attempt.status),
      ["lost", "lost", "succeeded"],
    );
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resumed");
  } finally {
    await fixture.close();
  }
});

test("a second runtime suspension before tool_start preserves resume_pending and later recovers", async () => {
  const fixture = await createResumeFixture("second-suspend-before-start", "printf x >> resume-count.txt");
  try {
    const firstActiveRuns = new ActiveRunRegistry();
    const firstCoordinator = createCoordinator(firstActiveRuns);
    const started = firstCoordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.equal(started.status, "started");
    firstActiveRuns.suspendAll("daemon_restart");
    await firstActiveRuns.waitForIdle();

    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "running");
    assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "running");
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resume_pending");
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_start").length, 0);

    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);
    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "third attempt should recover");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    assert.deepEqual(
      fixture.store.listWorkUnitAttempts(fixture.workUnit.id).map((attempt) => attempt.status),
      ["lost", "lost", "succeeded"],
    );
  } finally {
    await fixture.close();
  }
});

test("a second runtime suspension after tool_start records effect-unknown instead of cancellation", async () => {
  const fixture = await createResumeFixture("second-suspend-after-start", "sleep 30; printf x >> uncertain.txt");
  try {
    const activeRuns = new ActiveRunRegistry();
    const coordinator = createCoordinator(activeRuns);
    const started = coordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.equal(started.status, "started");
    await waitForCondition(
      () => matchingToolEvents(fixture).some((event) => event.type === "tool_start"),
      "resumed tool_start should be durable",
    );
    activeRuns.suspendAll("daemon_restart");
    await activeRuns.waitForIdle();

    const run = fixture.store.getRun(fixture.run.id);
    const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
    assert.equal(run?.status, "failed");
    assert.equal(checkpoint?.status, "resume_failed");
    assert.equal(checkpoint?.resumeFailureReason, "approval_resume_effect_unknown");
    assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).some((event) => event.type === "run_cancelled"), false);
    assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).some((event) => event.type === "approval_cancelled"), false);
  } finally {
    await fixture.close();
  }
});

for (const stage of ["before-entry", "terminal-cas"]) test(`approval completion never overwrites summary without completion ownership: ${stage}`, async () => {
  const fixture = await createResumeFixture(`summary-${stage}`, "printf safe");
  try {
    const claimed = claimResume(fixture, `summary-owner-${stage}`);
    const path = getRunSummaryPath(fixture.store.paths, fixture.run.id);
    await writeFile(path, "existing-summary", "utf8");
    if (stage === "before-entry") fixture.store.createWorkUnitAttempt({ workUnitId: fixture.workUnit.id,
      attemptNumber: 3, runtimeInstanceId: "new-owner", runnerId: "pi", status: "started", now: "2026-09-07T00:00:00.000Z" });
    else fixture.store.commitApprovalResumeTerminal = () => ({ ok: false, code: "stale_transition" });
    const before = fixture.store.getWorkUnit(fixture.workUnit.id);
    await createCoordinator(new ActiveRunRegistry()).finishRun({ ...fixture, attempt: claimed.attempt }, "succeeded");
    assert.equal(await readFile(path, "utf8"), "existing-summary");
    assert.deepEqual(fixture.store.getWorkUnit(fixture.workUnit.id), before);
    assert.equal(fixture.store.getRun(fixture.run.id).status, "running");
  } finally { await fixture.close(); }
});

for (const [label, decision] of [["approve-array", ["approve"]], ["manual-array", ["manual"]], ["nested-deny-array", [["deny"]]]]) {
  test(`A22 real SQLite automatic review ${label} stays pending through suspension and reopen without redispatch`, async (t) => {
    const fixture = await createResumeFixture(`exact-active-${label}`, "printf x >> must-not-run.txt", false, true, true, "pending", { currentRuntime: true, reviewLineage: true });
    t.after(() => fixture.close());
    const reviewCalls = installSyntheticReviewRunner(fixture, decision);
    const sourceFence = toRuntimeAttemptFence(fixture.priorAttempt);
    const outcome = await reviewPendingApprovalAutomatically({
      store: fixture.store, runtimeSupervisor: fixture.runtimeSupervisor,
      runner: fixture.runnerRegistry.get("pi").adapter,
      provider: resolveProviderForRun(fixture.store, { providerPresetId: fixture.run.providerPresetId }, fixture.secretResolver),
      providerPresetId: fixture.run.providerPresetId,
      secretResolver: fixture.secretResolver,
      run: fixture.run, approval: fixture.approval, sourceFence,
      effectivePolicySnapshot: fixture.run.requestSnapshot.effectivePolicySnapshot,
    });
    assert.equal(outcome.status, "manual");
    assert.equal(outcome.code, "invalid_output");
    assert.equal(reviewCalls.length, 1);
    assertPendingReviewSource(fixture);
    assert.equal(fixture.store.getWorkUnit(outcome.workUnitId)?.status, "failed", "only the invalid reviewer Unit is failed");

    suspendReviewSourceAndReopen(fixture);
    const activeRuns = new ActiveRunRegistry();
    const resumeCoordinator = createCoordinator(activeRuns, fixture);
    const recovery = createReviewRecovery(fixture, resumeCoordinator);
    const first = await recovery.recoverStore(fixture.store);
    const second = await recovery.recoverStore(fixture.store);
    await activeRuns.waitForIdle();
    assert.equal(first.manual, 1);
    assert.equal(second.manual, 1);
    assertPendingReviewSource(fixture);
    assert.equal(reviewCalls.length, 1, "settled invalid output must not redispatch a reviewer after reopen");
    assert.equal(fixture.runnerCalls.length, 0, "pending approval must not enter the continuation Runner");
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 1);
    assert.equal(matchingToolEvents(fixture).length, 0);
    await assert.rejects(readFile(resolve(fixture.cwd, "must-not-run.txt")), /ENOENT/u);
  });
}

for (const [label, decision] of [["approve-array", ["approve"]], ["deny-array", ["deny"]], ["manual-array", ["manual"]], ["nested-approve-array", [["approve"]]], ["manual-string", "manual"]]) {
  test(`A22 real reopened SQLite automatic recovery ${label} remains manual and does not terminalize the source Run`, async (t) => {
    const fixture = await createResumeFixture(`exact-recovery-${label}`, "printf x >> must-not-run.txt", false, true, true, "pending", { reviewLineage: true });
    t.after(() => fixture.close());
    const reviewCalls = installSyntheticReviewRunner(fixture, decision);
    suspendReviewSourceAndReopen(fixture);
    const activeRuns = new ActiveRunRegistry();
    const resumeCoordinator = createCoordinator(activeRuns, fixture);
    const recovery = createReviewRecovery(fixture, resumeCoordinator);
    const first = await recovery.recoverStore(fixture.store);
    await activeRuns.waitForIdle();
    assert.equal(first.reviewed, 1);
    assert.equal(first.manual, 1);
    assert.equal(first.denied, 0);
    assert.equal(first.approved, 0);
    assertPendingReviewSource(fixture);
    assert.equal(reviewCalls.length, 1);
    const second = await recovery.recoverStore(fixture.store);
    resumeCoordinator.registerStore(fixture.store);
    await activeRuns.waitForIdle();
    assert.equal(second.manual, 1);
    assertPendingReviewSource(fixture);
    assert.equal(reviewCalls.length, 1, "manual/invalid output is durable and not a reason to rerun a model");
    assert.equal(fixture.runnerCalls.length, 0);
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 1);
    assert.equal(matchingToolEvents(fixture).length, 0);
    await assert.rejects(readFile(resolve(fixture.cwd, "must-not-run.txt")), /ENOENT/u);
  });
}

test("A22 real reopened SQLite exact deny still terminalizes the waiting source once without executing tools", async (t) => {
  const fixture = await createResumeFixture("exact-recovery-deny", "printf x >> must-not-run.txt", false, true, true, "pending", { reviewLineage: true });
  t.after(() => fixture.close());
  const reviewCalls = installSyntheticReviewRunner(fixture, "deny");
  suspendReviewSourceAndReopen(fixture);
  const activeRuns = new ActiveRunRegistry();
  const resumeCoordinator = createCoordinator(activeRuns, fixture);
  const recovery = createReviewRecovery(fixture, resumeCoordinator);
  const result = await recovery.recoverStore(fixture.store);
  await activeRuns.waitForIdle();
  assert.equal(result.denied, 1);
  assert.equal(result.manual, 0);
  assert.equal(fixture.store.getApprovalRequest(fixture.approval.id)?.status, "denied");
  assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "denied");
  assert.equal(fixture.store.getRun(fixture.run.id)?.status, "failed");
  assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "failed");
  assert.equal(fixture.store.getTask(fixture.run.taskId)?.status, "failed");
  assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).filter(event => event.type === "approval_denied").length, 1);
  await recovery.recoverStore(fixture.store);
  resumeCoordinator.registerStore(fixture.store);
  await activeRuns.waitForIdle();
  assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).filter(event => event.type === "approval_denied").length, 1);
  assert.equal(reviewCalls.length, 1);
  assert.equal(fixture.runnerCalls.length, 0);
  assert.equal(matchingToolEvents(fixture).length, 0);
  await assert.rejects(readFile(resolve(fixture.cwd, "must-not-run.txt")), /ENOENT/u);
});

test("A22 real reopened SQLite exact approve resumes the stored scoped command once", async (t) => {
  const fixture = await createResumeFixture("exact-recovery-approve", "printf x >> approved-once.txt", false, true, true, "pending", { reviewLineage: true });
  t.after(() => fixture.close());
  const reviewCalls = installSyntheticReviewRunner(fixture, "approve");
  suspendReviewSourceAndReopen(fixture);
  const activeRuns = new ActiveRunRegistry();
  const resumeCoordinator = createCoordinator(activeRuns, fixture);
  const recovery = createReviewRecovery(fixture, resumeCoordinator);
  const result = await recovery.recoverStore(fixture.store);
  await activeRuns.waitForIdle();
  assert.equal(result.approved, 1);
  assert.equal(result.manual, 0);
  assert.equal(fixture.store.getApprovalRequest(fixture.approval.id)?.status, "approved");
  assert.equal(fixture.store.getApprovalRequest(fixture.approval.id)?.resolvedBy, "system-reviewer");
  assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resumed", JSON.stringify(fixture.dispatchErrors));
  assert.equal(fixture.store.getRun(fixture.run.id)?.status, "succeeded");
  assert.equal(fixture.runnerCalls[0]?.approvedToolContinuation?.result.isError, false,
    JSON.stringify(fixture.runnerCalls[0]?.approvedToolContinuation?.result));
  assert.equal(await readFile(resolve(fixture.cwd, "approved-once.txt"), "utf8"), "x");
  assert.equal(fixture.runnerCalls.length, 1);
  assert.equal(matchingToolEvents(fixture).filter(event => event.type === "tool_start").length, 1);
  assert.equal(matchingToolEvents(fixture).filter(event => event.type === "tool_end").length, 1);
  await recovery.recoverStore(fixture.store);
  resumeCoordinator.registerStore(fixture.store);
  await activeRuns.waitForIdle();
  assert.equal(reviewCalls.length, 1);
  assert.equal(fixture.runnerCalls.length, 1);
  assert.equal(await readFile(resolve(fixture.cwd, "approved-once.txt"), "utf8"), "x");
});

function installSyntheticReviewRunner(fixture, decision) {
  const calls = [];
  const original = fixture.runnerRegistry.get("pi");
  fixture.runnerRegistry = createRunnerRegistry([{ ...original, adapter: { async runTask(options) {
    if (!options.task.id.startsWith("approval-review:")) return original.adapter.runTask(options);
    calls.push(options);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.mcpTools, []);
    assert.deepEqual(options.hostCapabilityTools, []);
    options.onEvent?.({ type: "message_end", role: "assistant", text: JSON.stringify({
      schemaVersion: 1, decision, reason: "Synthetic closed-set verdict, no external model.",
    }) });
    return { taskId: options.task.id, events: [], messages: [] };
  } } }]);
  return calls;
}

function suspendReviewSourceAndReopen(fixture) {
  const now = "2026-08-16T02:01:00.000Z";
  fixture.store.updateWorkUnitAttemptStatus({
    ...toRuntimeAttemptFence(fixture.priorAttempt), status: "lost", now, endedAt: now,
    errorCode: "runtime_suspend", errorMessage: "runtime-startup-recoverable-approval",
  });
  fixture.runtimeSupervisor.releaseAll();
  fixture.storeRegistry.closeAll();
  fixture.storeRegistry = new RunStoreRegistry(createSqliteRunStore);
  fixture.store = fixture.storeRegistry.getStore(fixture.cwd);
  fixture.runtimeSupervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: fixture.cwd, harness: { continuations: { mode: "enforce" } } }));
  fixture.run = fixture.store.getRun(fixture.run.id);
  fixture.approval = fixture.store.getApprovalRequest(fixture.approval.id);
  fixture.checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
  assert.equal(fixture.store.isRecoverableApprovalReviewOwner(fixture.approval.id, toRuntimeAttemptFence(fixture.priorAttempt)), true);
}

function createReviewRecovery(fixture, approvalResumeCoordinator) {
  return new ApprovalAutoReviewRecoveryCoordinator({
    runtimeSupervisor: fixture.runtimeSupervisor,
    runnerRegistry: fixture.runnerRegistry,
    secretResolver: fixture.secretResolver,
    approvalResumeCoordinator,
  });
}

function assertPendingReviewSource(fixture) {
  assert.equal(fixture.store.getApprovalRequest(fixture.approval.id)?.status, "pending");
  assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "pending");
  assert.equal(fixture.store.getRun(fixture.run.id)?.status, "waiting_for_approval");
  assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "waiting_for_approval");
  assert.equal(fixture.store.getTask(fixture.run.taskId)?.status, "running");
  assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).some(event => event.type === "approval_denied" || event.type === "run_failed"), false);
}

function createCoordinator(activeRuns, fixture) {
  const runnerRegistry = fixture?.runnerRegistry ?? resumeRunnerRegistry();
  const runtimeSupervisor = fixture?.runtimeSupervisor ?? {
    getRestrictedCommandRuntime() { return undefined; },
    getRuntime() {
      return { runtimeInstanceId: "runtime_after_restart" };
    },
  };
  return new ApprovalResumeCoordinator({
    activeRuns,
    runnerRegistry,
    runtimeSupervisor,
    ...(fixture ? {
      executeExistingRunContinuation: ({ cwd, runId, approvalId, preparedExecution }) =>
        executeExistingRunContinuation(
          { cwd, runId, origin: "approval_resume", idempotencyDiscriminator: approvalId, preparedExecution },
          { ...createDetachedRunExecutionSink(), writeError: (_status, body) => fixture.dispatchErrors.push(body) },
          runnerRegistry,
          fixture.storeRegistry,
          activeRuns,
          runtimeSupervisor,
          fixture.secretResolver ?? { resolve: () => ({ configured: false }) },
          {},
        ),
    } : {}),
  });
}

function resumeRunnerRegistry() {
  const runner = {
    id: "pi",
    displayName: "Pi",
    status: "enabled",
    adapter: { async runTask() { return { taskId: "unused", events: [], messages: [] }; } },
    resumeCapabilities: { nativeResume: false, hostApprovalContinuation: ["bash"] },
    nativeResumeConformance: {
      revision: "pi:test:resume-v1",
      readinessPassed: false,
      conformancePassed: false,
      abortPropagationVerified: false,
      approvalBridgeVerified: false,
    },
  };
  return {
    get(id) { return id === "pi" ? runner : undefined; },
    list() { return [runner]; },
    resolve() { return { runner, requestedRunnerId: "pi", effectiveRunnerId: "pi" }; },
  };
}

test("A28 Core pre-dispatch suspension rejects durable tool_start atomically", async t => {
  const fixture = await createResumeFixture("a28-started-effect-suspension", "printf must-not-execute", false, true, true);
  t.after(() => fixture.close());
  const claimed = claimResume(fixture, "a28-claimed-effect-attempt");
  appendResumeToolStart(fixture, claimed.attempt.id);
  const before = {
    run: fixture.store.getRun(fixture.run.id), unit: fixture.store.getWorkUnit(fixture.workUnit.id),
    attempt: fixture.store.getWorkUnitAttempt(claimed.attempt.id),
    checkpoint: fixture.store.getApprovalCheckpoint(fixture.checkpoint.id),
    events: matchingToolEvents(fixture),
  };
  assert.equal(before.events.length, 1, "the actual durable start must precede the suspension transaction");
  assert.equal(before.events[0].type, "tool_start");
  const result = fixture.store.commitApprovalResumeSuspension({
    kind: "resume_pre_dispatch", checkpointId: before.checkpoint.id,
    expectedCheckpointStatus: "resume_pending", expectedCheckpointRevision: before.checkpoint.revision,
    approvalId: fixture.approval.id, runId: before.run.id, expectedRunStatus: "running",
    workUnitId: before.unit.id, expectedWorkUnitStatus: "running", attemptId: before.attempt.id,
    cause: "runtime-shutdown", now: "2026-08-16T02:03:00.000Z",
  });
  assert.equal(result.ok, false, "an executed-or-unknown effect cannot be relabelled safe pre-dispatch");
  assert.deepEqual({
    run: fixture.store.getRun(fixture.run.id), unit: fixture.store.getWorkUnit(fixture.workUnit.id),
    attempt: fixture.store.getWorkUnitAttempt(claimed.attempt.id),
    checkpoint: fixture.store.getApprovalCheckpoint(fixture.checkpoint.id),
    events: matchingToolEvents(fixture),
  }, before, "rejection must preserve every durable execution fact and checkpoint revision");
});

for (const [label, attemptId] of [["missing", undefined], ["null", null], ["number", 7],
  ["array", []], ["object", {}], ["empty", ""], ["whitespace", " "]]) {
  test(`A28 Core pre-dispatch suspension rejects unattributed durable tool_start: ${label}`, async t => {
    const fixture = await createResumeFixture(`a28-unattributed-${label}`, "printf must-not-execute", false, true, true);
    t.after(() => fixture.close());
    const claimed = claimResume(fixture, `a28-unattributed-attempt-${label}`);
    appendResumeToolStart(fixture, attemptId);
    const before = {
      run: fixture.store.getRun(fixture.run.id), unit: fixture.store.getWorkUnit(fixture.workUnit.id),
      attempt: fixture.store.getWorkUnitAttempt(claimed.attempt.id),
      checkpoint: fixture.store.getApprovalCheckpoint(fixture.checkpoint.id),
    };
    const events = matchingToolEvents(fixture);
    assert.equal(events.length, 1, "the unknown-effect start is durably stored before suspension");
    assert.equal(events[0].type, "tool_start");
    const result = fixture.store.commitApprovalResumeSuspension({
      kind: "resume_pre_dispatch", checkpointId: before.checkpoint.id,
      expectedCheckpointStatus: "resume_pending", expectedCheckpointRevision: before.checkpoint.revision,
      approvalId: fixture.approval.id, runId: before.run.id, expectedRunStatus: "running",
      workUnitId: before.unit.id, expectedWorkUnitStatus: "running", attemptId: before.attempt.id,
      cause: "runtime-shutdown", now: "2026-08-16T02:03:00.000Z",
    });
    assert.equal(result.ok, false, "malformed attribution is unknown effect, never safe pre-dispatch");
    assert.deepEqual({
      run: fixture.store.getRun(fixture.run.id), unit: fixture.store.getWorkUnit(fixture.workUnit.id),
      attempt: fixture.store.getWorkUnitAttempt(claimed.attempt.id),
      checkpoint: fixture.store.getApprovalCheckpoint(fixture.checkpoint.id),
    }, before);
    assert.deepEqual(matchingToolEvents(fixture), events);
  });
}

for (const phase of ["approved", "resume_pending", "denied"]) {
  test(`delegation ownership blocks general approval recovery before writes: ${phase}`, async (t) => {
    const fixture = await createResumeFixture(`delegation-owner-${phase}`, "printf must-not-execute",
      false, true, true, phase === "denied" ? "pending" : "approve");
    t.after(() => fixture.close());
    if (phase === "resume_pending") claimResume(fixture, "delegated-resume-pending-attempt");
    if (phase === "denied") {
      fixture.store.updateWorkUnitAttemptStatus({ ...toRuntimeAttemptFence(fixture.priorAttempt),
        status: "lost", endedAt: "2026-08-16T02:01:00.000Z", errorCode: "runtime_suspend",
        now: "2026-08-16T02:01:00.000Z" });
      fixture.approval = fixture.store.denyApprovalRequest(fixture.approval.id,
        { resolvedBy: "local-user", reason: "deny isolated fixture" }, "2026-08-16T02:01:00.000Z");
    }
    // Admission-only ownership fixture: it is not a real delegation ledger.
    fixture.store.database.prepare("UPDATE work_units SET owner_type='delegation_step',owner_id=? WHERE id=?")
      .run("private-delegation-owner", fixture.workUnit.id);
    const snapshot = () => Object.fromEntries([
      "run_sessions", "work_units", "work_unit_attempts", "approval_requests", "approval_checkpoints",
      "runner_continuations", "run_events", "runtime_events", "control_plane_events", "artifacts",
      "resource_leases", "runtime_semaphore_slots",
    ].map((table) => [table, fixture.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const callbacks = [];
    const coordinator = new ApprovalResumeCoordinator({
      runtimeSupervisor: fixture.runtimeSupervisor,
      activeRuns: new ActiveRunRegistry(),
      runnerRegistry: fixture.runnerRegistry,
      executeExistingRunContinuation: async (input) => { callbacks.push(input); return undefined; },
    });
    const result = phase === "denied"
      ? coordinator.finalizeSuspendedApprovalDenial({ store: fixture.store, approval: fixture.approval })
      : coordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.deepEqual(result, { status: "blocked", runId: fixture.run.id, reason: "delegation.authority_invalid" });
    assert.deepEqual(snapshot(), before, "ownership refusal must precede decision events, claims and checkpoint writes");
    coordinator.registerStore(fixture.store);
    coordinator.registerStore(fixture.store);
    assert.deepEqual(snapshot(), before, "startup scans must not claim or finalize another recovery owner's rows");
    assert.equal(callbacks.length, 0);
    assert.equal(fixture.runnerCalls.length, 0);
  });
}

function claimResume(fixture, attemptId) {
  const result = fixture.store.commitApprovalResumeClaim({
    checkpointId: fixture.checkpoint.id,
    expectedCheckpointStatus: "approved",
    expectedCheckpointRevision: fixture.checkpoint.revision,
    approvalId: fixture.approval.id,
    runId: fixture.run.id,
    workUnitId: fixture.workUnit.id,
    expectedActiveAttemptId: fixture.priorAttempt.id,
    attemptToLoseId: fixture.priorAttempt.id,
    replacementAttempt: {
      id: attemptId,
      workUnitId: fixture.workUnit.id,
      attemptNumber: 2,
      runtimeInstanceId: "runtime_claimed",
      runnerId: "pi",
      effectiveRunnerId: "pi",
      providerPresetId: fixture.priorAttempt.providerPresetId,
      now: "2026-08-16T02:02:00.000Z",
    },
    runnerResumeHandle: {
      kind: "ling_continuation",
      runnerId: "pi",
      runId: fixture.run.id,
      attemptId,
      verified: true,
      payload: {
        schemaVersion: 1,
        approvalId: fixture.approval.id,
        resumeBasisFingerprint: fixture.checkpoint.resumeBasis.fingerprint,
      },
    },
    mode: "activate_waiting",
    now: "2026-08-16T02:02:00.000Z",
  });
  assert.equal(result.ok, true);
  return result;
}

function appendResumeToolStart(fixture, attemptId) {
  fixture.store.appendEvent(fixture.run.id, "tool_start", {
    type: "tool_start",
    toolCallId: fixture.approval.toolCallId,
    toolName: "bash",
    args: { command: fixture.command, cwd: fixture.cwd },
    resumedFromApprovalId: fixture.approval.id,
    attemptId,
  });
}

function matchingToolEvents(fixture) {
  return fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).filter((event) => {
    const data = event.data && typeof event.data === "object" ? event.data : {};
    return data.resumedFromApprovalId === fixture.approval.id;
  });
}

/** Public Core begin/claim/ready producers; no typed isolation or owner stub. */
function beginLinkedWorkflowResumeFixture(store, cwd, now) {
  const channel = store.createChannel({ name: "A12 linked workflow approval", boundPath: cwd,
    allowedTools: ["read", "bash", "write"] }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Resume linked workflow",
    objective: "Resume one approved command under its current generation", status: "ready", createdBy: "local-user" }, now);
  const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Resume recovery", prompt: "Resume safely",
    toParticipantId: "ling_agent", toParticipantLabel: "Ling" }, now);
  const lease = store.acquireResourceLease({ workspaceId: channel.workspaceId, resourceType: "workflow_step",
    resourceKey: step.id, ownerType: "workflow_step", ownerId: step.id, acquiredAt: now,
    // This file's durable crash boundary is fixed in August; admission uses the
    // actual recovery clock, so the fixture lease intentionally outlives it.
    expiresAt: "2100-01-01T00:00:00.000Z" });
  assert.ok(lease);
  const result = store.beginChannelWorkflowStepStart({ workflowStepId: step.id,
    expected: { status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt }, leaseId: lease.id,
    task: { channelId: channel.id, title: "Resume recovery", prompt: "Resume safely", assigneeTeammateId: "ling_agent" }, now });
  assert.equal(result.status, "begun", JSON.stringify(result));
  assert.equal(store.transitionTaskStatus({ taskId: result.task.id, expectedStatus: "todo", event: "claim", actor: "system", now }).ok, true);
  return { channel, workflow, step, lease, task: result.task, owner: result.owner };
}

async function createResumeFixture(suffix, command, typed = false, harness = false, trackedTask = false, resolution = "approve", sdkOptions = {}) {
  if (sdkOptions.workflowStartLinked) assert.ok(!typed && harness && trackedTask && sdkOptions.realSdk,
    "the linked workflow positive fixture uses real Pi recovery, not typed isolation bypass");
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-stack-approval-resume-recovery-${suffix}-`));
  const storeRegistry = new RunStoreRegistry(createSqliteRunStore);
  const store = storeRegistry.getStore(cwd);
  const now = "2026-08-16T02:00:00.000Z";
  const secretResolver = sdkOptions.realSdk
    ? createCompositeSecretResolver({ env: { LING_TEST_APPROVAL_KEY: "loopback-only-not-a-credential" } })
    : { resolve: () => ({ configured: false }) };
  const basis = typed ? createTypedWorkflowBasis(store, cwd, [typedOperation("run_command", command)], now) : undefined;
  const workflowStart = sdkOptions.workflowStartLinked ? beginLinkedWorkflowResumeFixture(store, cwd, now) : undefined;
  const taskChannel = trackedTask
    ? workflowStart?.channel ?? basis?.channel ?? store.createChannel({
        name: `Approval resume ${suffix}`,
        boundPath: cwd,
        allowedTools: ["read", "bash", "write"],
      }, now)
    : undefined;
  const trackedTaskRow = workflowStart?.task ?? (taskChannel ? store.createTask({
    channelId: taskChannel.id,
    title: "Resume recovery",
    prompt: "Resume safely",
    status: "running",
  }, now) : undefined);
  const taskSnapshot = {
    id: trackedTaskRow?.id ?? `task_resume_recovery_${suffix}`,
    title: "Resume recovery",
    prompt: "Resume safely",
    ...(taskChannel ? { channelId: taskChannel.id } : {}),
  };
  const threadRequest = { cwd, task: taskSnapshot, ...(sdkOptions.reviewLineage ? { teammateId: "ling_agent" } : {}),
    ...(workflowStart ? { workflowStepId: workflowStart.step.id, workflowStartOwner: workflowStart.owner,
      teammateId: "ling_agent" } : {}) };
  const thread = harness && (sdkOptions.realSdk || sdkOptions.reviewLineage) ? ensureLingThreadForRun(store, threadRequest, now) : harness ? store.createLingThread({
    kind: "conversation",
    teammateId: "ling_agent",
    title: "Approval resume recovery",
    objective: "Continue after one durable approved tool result",
  }, now) : undefined;
  const accepted = thread && (sdkOptions.realSdk || sdkOptions.reviewLineage)
    ? { turnId: ensureLingTurnForRun(store, thread, threadRequest, now).id }
    : thread ? store.appendConversationUserTurn({
    threadId: thread.id,
    title: taskSnapshot.title,
    userInstruction: taskSnapshot.prompt,
    payload: { body: taskSnapshot.prompt, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: `approval-resume:${suffix}`,
  }, now) : undefined;
  if (sdkOptions.conversationAnchor && thread && accepted) {
    // A real input anchor is required by the shared transcript contract. Keep
    // the A22 task/teammate Turn producer intact; add no synthetic tool history.
    store.appendConversationItem({ threadId: thread.id, turnId: accepted.turnId,
      ...(taskChannel ? { channelId: taskChannel.id } : {}), kind: "user_message", actorType: "system",
      visibility: taskChannel ? "channel" : "thread_participants",
      payload: { body: taskSnapshot.prompt, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: `readonly-input:${suffix}` }, now);
  }
  const preset = harness ? store.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Approval resume fixture",
    providerId: "approval-resume-fixture",
    model: "fixture",
    api: "openai-completions",
    baseUrl: sdkOptions.providerBaseUrl ?? "https://fixture.invalid/v1",
    authHeader: false,
    ...(sdkOptions.realSdk ? { apiKeyRef: "env:LING_TEST_APPROVAL_KEY" } : {}),
    reasoning: false,
    capabilities: ["chat", "tool_call"],
    enabled: true,
  }, now) : undefined;
  if (preset) store.recordProviderCheckResult(preset.id, {
    ok: true,
    code: "ready",
    message: "Synthetic ready",
    checkedAt: now,
  });
  const provider = preset ? resolveProviderForRun(
    store,
    { providerPresetId: preset.id },
    secretResolver,
  ) : undefined;
  const runtimeSupervisor = harness ? new RuntimeSupervisor(resolveConfig({
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  })) : undefined;
  const currentRuntime = sdkOptions.currentRuntime ? runtimeSupervisor?.getRuntime(cwd, store) : undefined;
  const runnerExecutionInput = provider ? await createStoredRunnerExecution(
    cwd,
    taskSnapshot,
    provider,
    {
      unifiedExec: runtimeSupervisor.getRuntimeToolFeatures().unifiedExec === true,
      shellSnapshot: runtimeSupervisor.getRuntimeToolFeatures().shellSnapshot === true,
    },
    sdkOptions.tools,
  ) : undefined;
  const effectivePolicySnapshot = thread ? applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({
    workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
    channelBoundPath: cwd,
  }).snapshot, thread.conversationMode.mode) : undefined;
  const run = store.createRun({
    id: `run_resume_recovery_${suffix}`,
    cwd,
    taskId: taskSnapshot.id,
    ...(basis ? { channelId: basis.channel.id, teammateId: gateOwner, workflowStepId: basis.step.id }
      : taskChannel ? { channelId: taskChannel.id } : {}),
    ...(workflowStart ? { workflowStepId: workflowStart.step.id } : {}),
    ...(thread ? { threadId: thread.id, turnId: accepted.turnId, turnRunRole: "primary", teammateId: "ling_agent" } : {}),
    ...(preset ? { providerPresetId: preset.id } : {}),
    providerName: provider?.provider ?? "test-provider",
    providerModel: provider?.model ?? "test-model",
    taskSnapshot,
    providerSnapshot: provider ?? { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd, ...(basis ? { workflowOperationExecution: basis.snapshot, delegatedRequirement: basis.requirement } : {}),
      ...(workflowStart ? { workflowStepId: workflowStart.step.id } : {}),
      ...(sdkOptions.tools ? { tools: [...sdkOptions.tools] } : {}),
      ...(harness ? { harnessFeatureSnapshot: { schemaVersion: 1, continuations: "enforce", toolBroker: "off",
        evaluations: "off", evaluationModelGate: "shadow", delegations: "off", delegationMaxDepth: 3 },
        authorizationMode: "smart", workspaceAccessMode: "workspace_write",
        providerPresetId: preset.id, threadId: thread.id, turnId: accepted.turnId, teammateId: "ling_agent",
        effectivePolicySnapshot, runnerExecutionInput } : {}) },
    ...(harness ? { contextViewId: `context_${suffix}`, contextViewCreatedAt: now } : {}),
    createdAt: now,
  });
  store.markRunStarted(run.id, now);
  if (basis) store.updateChannelWorkflowStep(basis.step.id, { runId: run.id }, now);
  const workUnit = store.createWorkUnit({
    id: `work_unit_resume_recovery_${suffix}`,
    workspaceId: "workspace_default",
    kind: "task_run",
    ownerType: "run",
    ownerId: run.id,
    taskId: run.taskId,
    providerPresetId: preset?.id,
    runnerId: "pi",
    effectiveRunnerId: "pi",
    idempotencyKey: `resume-recovery-${suffix}`,
    createdByActor: "system",
    request: { runId: run.id },
    linkedRunId: run.id,
    now,
  });
  const priorAttempt = store.createWorkUnitAttempt({
    id: `attempt_resume_recovery_${suffix}_1`,
    workUnitId: workUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: currentRuntime?.runtimeInstanceId ?? "runtime_before_restart",
    runnerId: "pi",
    effectiveRunnerId: "pi",
    providerPresetId: preset?.id,
    now,
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, now);
  if (workflowStart) {
    assert.equal(store.commitChannelWorkflowStepRunReady({ workflowStepId: workflowStart.step.id,
      owner: workflowStart.owner, runId: run.id, now }).status, "linked");
    assert.equal(store.transitionTaskStatus({ taskId: run.taskId, expectedStatus: "claimed", event: "start_run",
      actor: "runner", currentRunId: run.id, now }).ok, true);
  }
  const priorFence = {
    workUnitId: workUnit.id,
    attemptId: priorAttempt.id,
    runtimeInstanceId: priorAttempt.runtimeInstanceId,
    fencingToken: priorAttempt.fencingToken,
  };
  store.transitionWorkUnitStatus({ ...priorFence, activeAttemptId: priorAttempt.id, expectedStatus: "queued", event: "claim", actor: "system", now });
  store.transitionWorkUnitStatus({ ...priorFence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now });
  store.transitionWorkUnitStatus({ ...priorFence, expectedStatus: "running", event: "approval_requested", actor: "system", now });
  store.updateWorkUnitAttemptStatus({ ...priorFence, status: "waiting_for_approval", now });
  store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "approval_requested", actor: "system", now });
  const payload = { type: "bash", cwd, command, riskFlags: [], ...(sdkOptions.exec ? { exec: sdkOptions.exec } : {}) };
  const approvalInput = {
    runId: run.id,
    taskId: run.taskId,
    ...(run.channelId ? { channelId: run.channelId } : {}),
    toolCallId: `tool_resume_recovery_${suffix}`,
    actionType: "bash",
    risk: "medium",
    title: "Approve resume recovery",
    description: command,
    payload,
  };
  const approval = sdkOptions.realSdk || sdkOptions.reviewLineage
    ? store.createExecutionApprovalRequest(approvalInput, priorFence, now)
    : store.createApprovalRequest(approvalInput, now);
  const initialCheckpoint = store.getApprovalCheckpointForApproval(approval.id);
  assert.ok(initialCheckpoint);
  const resumeBasis = createApprovalResumeBasisV1({
    approvalId: approval.id,
    runId: run.id,
    workUnitId: workUnit.id,
    priorAttemptId: priorAttempt.id,
    ...(basis ? { workflowStepId: basis.step.id, delegatedRequirementFingerprint: basis.requirement.fingerprint } : {}),
    ...(workflowStart ? { workflowStepId: workflowStart.step.id } : {}),
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    sideEffectFingerprint: approvalSideEffectFingerprintV1({
      actionType: approval.actionType,
      toolCallId: approval.toolCallId,
      sideEffect: payload,
    }),
  });
  assert.ok(store.updateApprovalCheckpointStatus(initialCheckpoint.id, {
    status: "pending",
    expectedStatus: "pending",
    expectedRevision: initialCheckpoint.revision,
    resumeBasis,
  }, now));
  const resolved = resolution === "pending"
    ? approval
    : store.approveApprovalRequest(approval.id, { reason: "resume recovery" }, "2026-08-16T02:01:00.000Z");
  assert.equal(resolved?.status, resolution === "pending" ? "pending" : "approved");
  const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
  const runnerCalls = [];
  const runnerResults = [];
  const dispatchErrors = [];
  class ApprovalContinuationRunner extends PiRunnerAdapter {
    async runTask(options) {
      assert.ok(options.approvedToolContinuation, "approval resume must reach Runner as approved tool evidence");
      runnerCalls.push(options);
      if (sdkOptions.realSdk) {
        const result = await super.runTask(options);
        runnerResults.push(result);
        return result;
      }
      return {
        taskId: options.task.id,
        events: [],
        messages: [{ role: "assistant", content: "Approval continuation finished." }],
      };
    }
  }
  const runnerRegistry = harness ? createRunnerRegistry([{
    id: "pi",
    displayName: "Approval continuation fixture",
    status: "enabled",
    adapter: new ApprovalContinuationRunner(),
    resumeCapabilities: { nativeResume: false, hostApprovalContinuation: ["bash"] },
  }]) : undefined;
  return {
    cwd,
    command,
    store,
    storeRegistry,
    secretResolver,
    runnerCalls,
    runnerResults,
    dispatchErrors,
    runnerRegistry,
    runtimeSupervisor,
    ...(workflowStart ? { workflowStart } : {}),
    run: store.getRun(run.id),
    workUnit: store.getWorkUnit(workUnit.id),
    priorAttempt: store.getWorkUnitAttempt(priorAttempt.id),
    approval: resolved,
    checkpoint,
    async close() {
      this.runtimeSupervisor?.releaseAll();
      this.storeRegistry.closeAll();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function readonlyActionRow(action, turnRun) {
  return { id: `row-${action.id}`, title: action.title, toolEvidence: action.toolEvidence,
    operationExecution: { actionId: action.id, runId: action.runId, attemptId: action.attemptId,
      participantId: action.participantId, workflowStepId: action.workflowStepId,
      approvalId: action.approvalId, turnRunRole: turnRun.role, actionType: action.actionType,
      status: action.status, sourceRefs: action.sourceRefs, updatedAt: action.updatedAt } };
}

async function createLiveReadonlySourceFixture(t) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-live-readonly-source-"));
  const sourceStores = new RunStoreRegistry(createSqliteRunStore);
  const sourceStore = sourceStores.getStore(cwd);
  const runtimeSupervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } } }));
  const sourceRuns = new ActiveRunRegistry();
  const now = new Date().toISOString();
  const readPath = resolve(cwd, "source-sdk-read.txt");
  await writeFile(readPath, "Actual source SDK read.", "utf8");
  const provider = await startLoopbackPiProvider((_body, count) => count === 1 || count === 3
    ? { tool: "read", input: { path: readPath } }
    : count === 2 ? { tool: "bash", input: { command: "printf x >> source-resume-marker.txt", cwd } }
      : { text: "Actual takeover complete." });
  const secretResolver = createCompositeSecretResolver({ env: { LING_TEST_APPROVAL_KEY: "loopback-only-not-a-credential" } });
  const channel = sourceStore.createChannel({ name: "Readonly source", boundPath: cwd, allowedTools: ["bash", "read"] }, now);
  const task = sourceStore.createTask({ channelId: channel.id, title: "Readonly source", prompt: "Read, then request the marker command." }, now);
  const preset = sourceStore.createProviderPreset({ kind: "openai-compatible", displayName: "Readonly source loopback",
    providerId: "readonly-source-fixture", model: "fixture", api: "openai-completions", baseUrl: provider.baseUrl,
    apiKeyRef: "env:LING_TEST_APPROVAL_KEY", authHeader: false, reasoning: false, capabilities: ["chat", "tool_call"], enabled: true }, now);
  sourceStore.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Owned deterministic loopback", checkedAt: now });
  const observed = { sourceStream: [] };
  class LiveReadonlyRunner extends PiRunnerAdapter {
    async runTask(options) {
      if (!options.approvedToolContinuation) {
        assert.ok(!observed.sourceOptions, "the source is a single actual SDK lifecycle");
        observed.sourceOptions = options;
        const hostOnEvent = options.onEvent;
        return super.runTask({ ...options, onEvent(event) {
          hostOnEvent(event);
          if (event.type === "tool_end" && event.toolName === "read") {
            observed.sourceReadEnd = event;
            // Save the actual event and actual Host closure, not a fabricated
            // tool_end or a direct Store/adapter replacement.
            observed.redeliverSourceReadEnd = () => hostOnEvent(event);
          }
        } });
      }
      return super.runTask(options);
    }
  }
  const runnerRegistry = createRunnerRegistry([{ id: "pi", displayName: "Real readonly SDK source", status: "enabled",
    adapter: new LiveReadonlyRunner(), resumeCapabilities: { nativeResume: false, hostApprovalContinuation: ["bash"] } }]);
  const f = { cwd, provider, sourceStore, sourceStores, sourceRuns, runtimeSupervisor, runnerRegistry, secretResolver,
    observed, dispatchErrors: [], storeRegistry: undefined };
  t.after(async () => {
    sourceRuns.suspendAll("daemon_restart");
    f.replacementRuns?.suspendAll("daemon_restart");
    await f.sourceCompletion?.catch(() => undefined);
    await f.replacementRuns?.waitForIdle();
    runtimeSupervisor.releaseAll();
    f.storeRegistry?.closeAll();
    sourceStores.closeAll();
    await provider.close();
    await rm(cwd, { recursive: true, force: true });
  });
  f.sourceCompletion = executeRunRequest({ cwd, task: { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt },
    providerPresetId: preset.id, teammateId: "ling_agent", tools: ["bash", "read"], thinkingLevel: "off",
    authorizationMode: "always", workspaceAccessMode: "workspace_write" },
  { ...createDetachedRunExecutionSink(), kind: "sse", writeEvent: (_type, event) => observed.sourceStream.push(event),
    writeError: (_status, body) => f.dispatchErrors.push(body) }, runnerRegistry, sourceStores, sourceRuns,
  runtimeSupervisor, secretResolver, {});
  f.sourceCompletion.catch(error => { f.sourceFailure = error; });
  return f;
}

async function createStoredRunnerExecution(cwd, task, provider, runtimeToolFeatures, tools = ["bash"]) {
  const options = { cwd, task, provider, tools, runtimeToolFeatures };
  const preparedInput = await new PiRunnerAdapter().prepareTaskInput(options);
  return capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
}

async function waitForCondition(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(message);
}
