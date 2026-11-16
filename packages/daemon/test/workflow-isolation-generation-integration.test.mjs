import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteWorkflowIsolationStore, resolveSessionRunPolicy, toRuntimeAttemptFence, workflowIsolationDigest } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { admissionParticipant, workflowAdmissionFixture } from "../../core/test/support/workflow-step-admission-fixture.mjs";
import { WORKFLOW_CANDIDATE_VALIDATORS } from "../dist/features/channels/workflow-candidate-validation.js";
import { captureWorkflowIsolatedResult } from "../dist/features/channels/workflow-isolated-result.js";
import { reconcileWorkflowParallelParentFences } from "../dist/features/channels/workflow-isolation-parent-fence.js";
import { planWorkflowIsolatedRound, readWorkflowIsolationWorktreeScope } from "../dist/features/channels/workflow-isolation-planning.js";
import { createWorkflowStepContextArtifact } from "../dist/features/channels/workflow-step-packets.js";
import { createRunApprovalHandler } from "../dist/features/runs/approvals.js";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { assertWorkflowIsolatedExecutionAuthority } from "../dist/features/runs/workflow-isolation-file-authority.js";
import { prepareWorkflowIsolatedExecution } from "../dist/features/runs/workflow-isolation-execution.js";
import { workflowSafetySnapshot } from "../dist/features/runs/workflow-safety.js";
import { planWorkflowGitWorktree } from "../dist/features/workspaces/workflow-git-repository.js";
import { assertWorkflowRepositoryRunAllowed } from "../dist/features/workspaces/workflow-repository-fence.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { nativeGit, now, workflowMultibranchIntegrationFixture } from "./support/workflow-multibranch-integration-fixture.mjs";

const exec = promisify(execFile);
const parallelExecution = { profile: "isolated_siblings_v1", maxConcurrentSteps: 2, writeLockScope: "boundPath" };
const hostFiles = { skip: process.platform !== "darwin", timeout: 60_000 };
const trackedFiles = ["left.txt", "right.txt"];

// Real planning, prepared Pi input, approvals, Host writes and drain; no model transport or Runner dispatch.
async function parallelRoundFixture(t) {
  const attempts = [];
  t.after(async () => {
    for (const item of attempts) item.controller.abort();
    await Promise.allSettled(attempts.flatMap(item => item.pending));
    for (const item of attempts) item.finish();
    await Promise.allSettled(attempts.map(item => item.completion));
  });
  const f = await workflowAdmissionFixture(t);
  f.gitAt = async (cwd, ...args) => (await exec("/usr/bin/git", args, { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: f.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Generation fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
      GIT_COMMITTER_NAME: "Generation fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout;
  f.git = async (...args) => (await f.gitAt(f.cwd, ...args)).toString().trim();
  await f.git("init", "--initial-branch=main");
  await f.git("config", "core.logAllRefUpdates", "always");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!.gitignore\n!left.txt\n!right.txt\n");
  for (const path of trackedFiles) await writeFile(join(f.cwd, path), `base ${path}\n`);
  await f.git("add", "--", ".gitignore", ...trackedFiles);
  await f.git("commit", "-m", "generation handoff basis");
  f.worktreeRoot = join(f.root, "generation-worktrees");
  await mkdir(f.worktreeRoot);
  const provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Generation fixture", providerId: "generation-fixture",
    model: "fixture", api: "openai-completions", capabilities: ["chat", "tool_call"], input: ["text"], authHeader: false, enabled: true }, now());
  f.store.recordProviderCheckResult(provider.id, { ok: true, code: "static_check", message: "No transport", checkedAt: now() });
  f.channel = f.store.updateChannel(f.channel.id, { defaultProviderPresetId: provider.id, allowedTools: ["read", "write"],
    runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 2, writeLockScope: "boundPath", allowReadOnlyParallel: false } }, now());
  f.policy = f.store.updateApprovalPolicy({ toolDecisions: { write: "ask" }, allowedWritePaths: [f.worktreeRoot] }, now());
  f.effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: f.policy,
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  f.isolation = createSqliteWorkflowIsolationStore(f.store);
  f.parent = round => f.peer.database.prepare("SELECT * FROM workflow_parallel_parent_fences WHERE round_id=?").get(round.id);
  f.slots = item => f.store.listRuntimeSemaphoreSlots({ workUnitId: item.fence.workUnitId, status: "active", limit: 100 });
  f.authority = item => assertWorkflowIsolatedExecutionAuthority({ store: f.store, run: item.run,
    sourceFence: item.fence, bindingId: item.writer.bindingId, now: now() });
  f.createRound = async name => {
    const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: name, objective: "Exact generation ownership",
      status: "ready", createdBy: "local-user", metadata: { maxParallelSteps: 2 } }, now());
    const steps = trackedFiles.map((path, index) => f.store.createChannelWorkflowStep({ workflowId: workflow.id, position: index,
      title: `Write ${path}`, prompt: `Write ${path}`, toParticipantId: admissionParticipant, toParticipantLabel: "Engineer",
      metadata: { sideEffectClass: "workspace_write", requestedRunnerId: "pi", requiredTools: ["read", "write"],
        parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [`generation:${path}`] },
        policy: { onRunFailed: "fail_workflow", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true } } }, now()));
    const graph = { schemaVersion: 1, id: `graph-${name}`, name, entryNodeId: "write-0", nodes: steps.map((step, index) => ({
      id: `write-${index}`, kind: "step", name: step.title, prompt: step.prompt, sideEffectClass: "workspace_write",
      parallelPolicy: step.metadata.parallelPolicy })), edges: [], termination: { success: "all_required_succeeded",
      onFailedRequiredNode: "fail_workflow", onApprovalDenied: "block_for_user" } };
    f.store.updateChannelWorkflow(workflow.id, { metadata: { ...workflow.metadata, workflowGraph: graph,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, now());
    const id = `generation-round-${name}`;
    const planned = await planWorkflowIsolatedRound({ store: f.store, workflowId: workflow.id, roundId: id, worktreeRoot: f.worktreeRoot,
      parallelExecution, validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })), now: now() });
    assert.equal(planned.round.generation, 1);
    const round = { id, workflow, steps, plans: planned.plans };
    assert.equal(f.parent(round).state, "held");
    return round;
  };
  f.start = async (round, index = 0) => {
    const plan = round.plans[index], step = f.store.getChannelWorkflowStep(plan.workflowStepId);
    const scope = { workflow: f.store.getChannelWorkflow(round.workflow.id), step, plan: plan.resourcePlan };
    const startInput = f.input(scope, f.lease(scope, now()), { now: now() }), generation = f.begin(scope, startInput);
    const taskId = generation.task.id;
    assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "todo", event: "claim", actor: "system", now: now() }).ok, true);
    const task = f.store.getTask(taskId), executionTask = { id: task.id, channelId: task.channelId, title: task.title, prompt: task.prompt };
    const runId = `${round.id}-run-${index}`, pin = { planId: plan.planId, planDigest: plan.planDigest };
    const request = { cwd: plan.executionRoot, workspaceCwd: f.cwd, executionCwd: plan.executionRoot, task: executionTask,
      runnerId: "pi", providerPresetId: provider.id, teammateId: admissionParticipant, workflowStepId: step.id,
      workflowStartOwner: generation.owner, workflowIsolationPlan: pin, workflowSafetySnapshot: workflowSafetySnapshot(step.metadata.safetyPlan),
      effectivePolicySnapshot: f.effectivePolicySnapshot, harnessFeatureSnapshot: { toolBroker: "enforce" } };
    const unit = f.store.createWorkUnit({ id: `${runId}-unit`, workspaceId: f.channel.workspaceId, kind: "task_run", ownerType: "task",
      ownerId: taskId, taskId, channelId: f.channel.id, teammateId: admissionParticipant, runnerId: "pi", effectiveRunnerId: "pi",
      idempotencyKey: `unit:${runId}`, createdByActor: "system", request, now: now() });
    const attempt = f.store.createWorkUnitAttempt({ id: `${runId}-attempt`, workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: `${runId}-host`, runnerId: "pi", effectiveRunnerId: "pi", now: now() });
    const fence = toRuntimeAttemptFence(attempt), source = { runId, ...fence };
    const leaseInput = { workspaceId: f.channel.workspaceId, ownerType: "run", ownerId: runId, ...fence,
      acquiredAt: now(), expiresAt: f.at(3_600) };
    assert.ok(f.store.acquireResourceLease({ ...leaseInput, resourceType: "task", resourceKey: taskId }));
    assert.ok(f.store.acquireResourceLease({ ...leaseInput, resourceType: "bound_path", resourceKey: plan.executionRoot }));
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
    f.store.createRun({ id: runId, cwd: plan.executionRoot, taskId, channelId: f.channel.id, teammateId: admissionParticipant,
      workflowStepId: step.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {},
      requestSnapshot: request, createdAt: now() });
    f.store.linkRunToWorkUnit(runId, unit.id, now());
    const writer = { bindingId: workflowIsolationDigest(source, "wib_"), ...fence };
    const gitScope = await readWorkflowIsolationWorktreeScope(f.store, pin);
    await prepareWorkflowIsolatedExecution({ store: f.store, isolation: f.isolation, scope: gitScope,
      binding: { bindingId: writer.bindingId, ...pin, startOwner: generation.owner, runId, fence }, now,
      prepareInput: async () => {
        const options = { cwd: plan.executionRoot, agentDir: join(f.root, "agent"), task: executionTask, tools: ["read", "write"],
          provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
          isolatedToolsProfile: "host_isolated_files_v1", onToolBefore: () => ({ allowed: true }),
          onIsolatedToolCall: () => assert.fail("preparation cannot execute a tool"),
          onApprovalRequired: () => assert.fail("preparation cannot consume approval"),
          runtimeToolFeatures: { requestPermissions: false, unifiedExec: false, shellSnapshot: false },
          initialToolSurface: { userInput: false, delegation: false, mediaGeneration: false, nativeFileCreate: false, toolHydration: false } };
        return capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput: await new PiRunnerAdapter().prepareTaskInput(options) });
      } });
    const prepared = { run: f.store.getRun(runId), unit: f.store.getWorkUnit(unit.id), attempt, fence };
    assert.equal(f.transfer(scope, generation, prepared, { now: now(), expiresAt: f.at(3_600) }).status, "transferred");
    assert.equal(f.ready(scope, generation, prepared, { now: now() }).status, "linked");
    const context = createWorkflowStepContextArtifact({ store: f.store, workflow: f.store.getChannelWorkflow(round.workflow.id),
      step: f.current(scope), run: f.store.getRun(runId), runRequest: { ...request, task }, now: now() });
    f.store.updateChannelWorkflowStep(step.id, { metadata: { ...f.current(scope).metadata, contextArtifactId: context.id } }, now());
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
    assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "queued", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "claimed", event: "start_run", actor: "system", currentRunId: runId, now: now() }).ok, true);
    const toolCallIds = [], item = { round, plan, scope, startInput, generation, ...prepared, source, writer, task: executionTask,
      run: f.store.getRun(runId), controller: new AbortController(), pending: [] };
    item.completion = f.store.trackHostAttemptCompletion(source, new Promise(resolve => { item.finish = resolve; }),
      () => ({ schemaVersion: 1, toolCallIds, settledBuiltinReads: [] }));
    item.completion.catch(() => undefined);
    attempts.push(item);
    item.handler = createRunApprovalHandler({ store: f.store, run: item.run, sourceFence: fence, workUnitId: unit.id, attemptId: attempt.id,
      workflowIsolationBindingId: writer.bindingId, hostOperationTracker: new AttemptHostOperationTracker({ store: f.store, source }),
      approvalPolicy: f.policy, effectivePolicySnapshot: f.effectivePolicySnapshot, signal: item.controller.signal,
      appendAndMaybeStream(type, data) {
        const event = f.store.appendExecutionEvent(runId, fence, type, data);
        if (type === "approval_requested") item.onApproval?.(data.approvalId);
        return event;
      }, streamEnvelope() {} });
    item.beginWrite = async content => {
      const request = { toolName: "write", toolCallId: `${runId}-write-${toolCallIds.length + 1}`,
        cwd: plan.executionRoot, task: executionTask, input: { path: trackedFiles[index], content } };
      f.store.appendExecutionEvent(runId, fence, "tool_start", { attemptId: attempt.id, toolName: "write", toolCallId: request.toolCallId, input: request.input });
      const approval = new Promise(resolve => { item.onApproval = resolve; });
      const pending = item.handler(request).then(result => {
        f.store.appendExecutionEvent(runId, fence, "tool_end", { attemptId: attempt.id, toolName: "write", toolCallId: request.toolCallId,
          isError: result.handledResult?.isError ?? !result.approved, result: result.handledResult });
        toolCallIds.push(request.toolCallId);
        return result;
      });
      pending.catch(() => undefined);
      item.pending.push(pending);
      const approvalId = await Promise.race([approval, pending.then(result => assert.fail(`expected real approval: ${JSON.stringify(result)}`))]);
      return { approvalId, pending, request };
    };
    item.approveWrite = async content => {
      const write = await item.beginWrite(content);
      f.store.approveApprovalRequest(write.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
      const result = await write.pending;
      assert.equal(result.approved, true, JSON.stringify(result));
      assert.notEqual(result.handledResult?.isError, true, JSON.stringify(result));
      return write;
    };
    assert.equal(f.authority(item).binding.bindingId, writer.bindingId);
    return item;
  };
  f.stop = async (item, outcome = "failed") => {
    assert.equal(f.store.transitionRunStatus({ runId: item.run.id, expectedStatus: "running", event: `runner_${outcome}`,
      actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...item.fence, expectedStatus: "running", event: `runner_${outcome}`,
      actor: "runner", endedAt: now(), now: now() }).ok, true);
    const endedAt = now();
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...item.fence, status: outcome, endedAt, now: endedAt }));
    f.store.appendTerminalRuntimeAudit({ capability: { ...item.fence, attemptStatus: outcome, transitionedAt: endedAt },
      type: `work_unit_${outcome}`, actor: "runner", data: { runId: item.run.id } });
    item.finish();
    await item.completion;
    assert.equal(f.store.getHostAttemptCompletion(item.source).effectCoverage, "pi_tracked_tools_v1");
    f.store.releaseHostAttemptResources(item.source, now());
    assert.equal(f.store.releaseResourceLease(item.generation.owner.leaseId, "workflow_step", item.scope.step.id, now()), 1);
    assert.deepEqual(f.slots(item), []);
    assert.equal(f.store.transitionTaskStatus({ taskId: item.task.id, expectedStatus: "running", event: `run_${outcome}`, actor: "system", now: now() }).ok, true);
    assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: item.scope.step.id, expectedStatus: "running",
      event: outcome === "failed" ? "fail" : "succeed", actor: "system", now: now() }).ok, true);
  };
  f.retire = round => {
    for (const step of f.store.listChannelWorkflowSteps({ workflowId: round.workflow.id, complete: true })) {
      if (step.status === "queued") assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id,
        expectedStatus: "queued", event: "skip", actor: "system", now: now() }).ok, true);
    }
    assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: round.workflow.id, expectedStatus: "running",
      event: "step_failed", actor: "system", now: now() }).ok, true);
    reconcileWorkflowParallelParentFences(f.store, round.workflow.id, now());
    assert.equal(f.parent(round).state, "released");
  };
  return f;
}

test("a running successor retains its files, approvals and resources after late predecessor callbacks and capture", hostFiles, async t => {
  const f = await parallelRoundFixture(t), previous = await f.createRound("previous"), old = await f.start(previous);
  const oldWrite = await old.approveWrite("retained old result\n");
  await f.stop(old);
  f.retire(previous);
  assert.ok(f.store.getHostAttemptCompletion(old.source).drainedAt);
  assert.deepEqual(f.store.listResourceLeases({ attemptId: old.fence.attemptId, status: "active" }), []);
  assert.deepEqual(f.store.listResourceLeases({ ownerType: "workflow_step", ownerId: old.scope.step.id, status: "active" }), []);
  assert.deepEqual(f.isolation.listPendingIntents({ roundId: previous.id }), []);
  assert.equal(f.store.getChannelWorkflow(previous.workflow.id).status, "failed");
  assert.equal(await readFile(join(old.plan.executionRoot, "left.txt"), "utf8"), "retained old result\n");
  assert.equal(await readFile(join(f.cwd, "left.txt"), "utf8"), "base left.txt\n");
  assert.equal(f.store.listHarnessToolExecutions(old.run.id).filter(execution => execution.state === "succeeded").length, 1);
  assert.equal(f.isolation.getTerminalResultIntent(old.writer.bindingId), undefined);
  assert.doesNotThrow(() => assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd }), "the original repository fence really released");

  const successor = await f.createRound("successor");
  assert.equal(f.parent(successor).state, "held");
  assert.equal(f.parent(previous).state, "released");
  const current = [await f.start(successor, 0), await f.start(successor, 1)];
  const writes = await Promise.all(current.map((item, index) => item.beginWrite(`successor ${index}\n`)));
  const snapshot = async () => ({
    parent: f.parent(successor), round: f.isolation.getIntegrationRound(successor.id),
    workflow: f.store.getChannelWorkflow(successor.workflow.id),
    canonicalFiles: await Promise.all(trackedFiles.map(path => readFile(join(f.cwd, path), "utf8"))),
    executions: await Promise.all(current.map(async item => ({
      binding: f.isolation.getExecutionBinding(item.writer.bindingId),
      step: f.store.getChannelWorkflowStep(item.scope.step.id), run: f.store.getRun(item.run.id),
      unit: f.store.getWorkUnit(item.unit.id), attempt: f.store.getWorkUnitAttempt(item.attempt.id),
      leases: f.store.listResourceLeases({ status: "active", attemptId: item.fence.attemptId }),
      startLeases: f.store.listResourceLeases({ status: "active", ownerType: "workflow_step", ownerId: item.scope.step.id }),
      slots: f.slots(item), approvals: f.store.listApprovalRequests({ runId: item.run.id, limit: 100 }),
      checkpoints: f.store.listApprovalRequests({ runId: item.run.id, limit: 100 })
        .map(approval => f.store.getApprovalCheckpointForApproval(approval.id)),
      files: await Promise.all(trackedFiles.map(path => readFile(join(item.plan.executionRoot, path), "utf8"))),
      head: (await f.gitAt(item.plan.executionRoot, "rev-parse", "HEAD")).toString().trim(),
      branch: (await f.gitAt(f.cwd, "show-ref", "--verify", item.plan.branchRef)).toString().trim(),
    }))),
  });
  for (const item of current) {
    assert.equal(f.authority(item).binding.bindingId, item.writer.bindingId);
    assert.equal(f.store.getRun(item.run.id).status, "waiting_for_approval");
    assert.ok(f.slots(item).length > 0);
  }
  const before = await snapshot();
  assert.throws(() => old.handler(oldWrite.request), error => error.code === "attempt_execution_stale_owner");
  assert.throws(() => old.handler({ ...oldWrite.request, toolCallId: "late-old-call", cwd: current[0].plan.executionRoot,
    task: current[0].task, input: { path: "left.txt", content: "old callback must not write successor\n" } }),
  error => error.code === "attempt_execution_stale_owner");
  assert.throws(() => f.store.approveApprovalRequest(oldWrite.approvalId,
    { resolvedBy: "local-user", decisionKind: "approve_once" }, now()), /not pending/);
  f.store.releaseHostAttemptResources(old.source, now());
  reconcileWorkflowParallelParentFences(f.store, previous.workflow.id, now());
  assert.deepEqual(await snapshot(), before, "old callbacks, approvals and cleanup cannot consume or release successor authority");
  const retained = await captureWorkflowIsolatedResult({ store: f.store, writer: old.writer, now });
  assert.equal(retained.status, "sealed", "the original result may be sealed only in its historical scope");
  assert.equal(retained.packet.context.lineage.runId, old.run.id);
  assert.equal(retained.packet.context.scope.roundId, previous.id);
  assert.deepEqual(await snapshot(), before, "historical result capture cannot mutate the live successor");
  assert.equal(f.isolation.assertExecutionBinding({ writer: old.writer, now: now() }).status, "stale");
  for (const [index, write] of writes.entries()) {
    f.store.approveApprovalRequest(write.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
    assert.equal((await write.pending).approved, true);
    assert.equal(await readFile(join(current[index].plan.executionRoot, trackedFiles[index]), "utf8"), `successor ${index}\n`);
  }
  assert.equal(await readFile(join(old.plan.executionRoot, "left.txt"), "utf8"), "retained old result\n");
  for (const [index, item] of current.entries()) {
    const siblings = current.slice(index + 1), active = siblings.map(sibling => f.slots(sibling));
    await f.stop(item);
    assert.deepEqual(siblings.map(sibling => f.slots(sibling)), active,
      "stopping one branch must not release the other branch's active slots");
  }
  f.retire(successor);
});

test("serial retry creates a current generation after the original Attempt has really drained", nativeGit, async t => {
  const f = await workflowMultibranchIntegrationFixture(t), original = f.branches[0];
  await original.start();
  original.mutate();
  assert.equal(f.isolation.advanceIntegrationRound({ commandId: "block-before-retry", roundId: f.roundId,
    generation: 1, expectedRevision: f.round().revision, from: "preparing", to: "blocked",
    reason: "Retry with a distinct integration location", writer: original.writer, now: now() }).status, "updated");
  await original.complete();
  assert.ok(f.store.getHostAttemptCompletion(original.source).drainedAt);
  assert.equal(f.store.getHostAttemptCompletion(original.source).effectCoverage, "pi_tracked_tools_v1");
  assert.deepEqual(f.store.listResourceLeases({ attemptId: original.fence.attemptId, status: "active" }), []);
  assert.deepEqual(f.store.listResourceLeases({ ownerType: "workflow_step", ownerId: original.scope.step.id, status: "active" }), []);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ workUnitId: original.fence.workUnitId, status: "active", limit: 100 }), []);
  assert.deepEqual(f.isolation.listPendingIntents({ roundId: f.roundId }), []);

  const worktreeRoot = join(f.root, "retry-worktrees");
  await mkdir(worktreeRoot);
  const scope = await planWorkflowGitWorktree({ repository: f.repository, worktreeRoot, roundId: f.roundId,
    stepId: "integration", generation: 2, worktreeId: "generation-two-integration" });
  const before = await f.snapshot();
  const result = f.isolation.beginIntegrationRoundGeneration({ commandId: "retry-after-original-drain", roundId: f.roundId,
    expectedGeneration: 1, expectedRevision: f.round().revision, writer: original.writer,
    inputs: { ...f.inputs, integration: { executionRoot: scope.executionRoot, worktreeId: scope.worktreeId, branchRef: scope.branchRef } },
    now: now() });
  if (result.status !== "created") assert.deepEqual(await f.snapshot(), before, "the rejected retry must not change Git or the original journal");
  assert.equal(result.status, "created", `A drained original writer must be able to establish its retry: ${JSON.stringify(result)}`);
  assert.equal(f.round().generation, 2);
  assert.equal(f.isolation.getIntegrationRound(f.roundId, 1).phase, "blocked");
  const successor = await f.snapshot();
  await assert.rejects(captureWorkflowIsolatedResult({ store: f.store, writer: original.writer, now }),
    error => error.code === "workflow_isolation.terminal_lineage_changed");
  assert.deepEqual(await f.snapshot(), successor, "a previous generation cannot capture files or publish into its retry");
});
