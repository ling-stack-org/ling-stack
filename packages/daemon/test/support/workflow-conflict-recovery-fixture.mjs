import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSqliteWorkflowIsolationStore, createSqliteWorkflowUserCreationStore, resolveSessionRunPolicy,
  toRuntimeAttemptFence, workflowIsolationDigest } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { admissionParticipant, workflowAdmissionFixture } from "../../../core/test/support/workflow-step-admission-fixture.mjs";
import { compileWorkflowGraph } from "../../dist/features/channels/workflow-graph.js";
import { buildWorkflowStepContextPack } from "../../dist/features/channels/context-packs.js";
import { selectWorkflowIsolatedExecution } from "../../dist/features/channels/workflow-isolation-selection.js";
import { captureWorkflowIsolatedResult } from "../../dist/features/channels/workflow-isolated-result.js";
import { coordinateWorkflowIntegration } from "../../dist/features/channels/workflow-integration-coordinator.js";
import { readWorkflowIsolationWorktreeScope } from "../../dist/features/channels/workflow-isolation-planning.js";
import { createWorkflowStepContextArtifact } from "../../dist/features/channels/workflow-step-packets.js";
import { finalizeOrchestratedWorkflowStepRun } from "../../dist/features/channels/orchestrator.js";
import { createRunApprovalHandler } from "../../dist/features/runs/approvals.js";
import { capturePreparedRunnerInput } from "../../dist/features/runs/prepared-runner-input.js";
import { prepareWorkflowIsolatedExecution } from "../../dist/features/runs/workflow-isolation-execution.js";
import { workflowSafetySnapshot } from "../../dist/features/runs/workflow-safety.js";
import { AttemptHostOperationTracker } from "../../dist/runtime/attempt-host-operation-tracker.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";

const exec = promisify(execFile);
// These cases exercise real Git worktrees, Host leases, approvals, and recovery
// publication on the shared macOS runner. Keep the assertion budget separate from
// the shard watchdog so slower hosted disks do not turn a valid recovery into a
// false timeout.
export const recoveryHost = { skip: process.platform !== "darwin", timeout: 180_000 };
export const now = () => new Date().toISOString();

/** Real production selection, Pi preparation, Host writes/approvals/drain and Git capture. No model dispatch. */
export async function workflowConflictRecoveryFixture(t) {
  const attempts = [], cleanups = [], home = process.env.LING_STACK_HOME;
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const item of attempts) item.controller.abort();
    await Promise.allSettled(attempts.flatMap(item => item.pending));
    for (const item of attempts) item.finish();
    await Promise.allSettled(attempts.map(item => item.completion));
    if (home === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = home;
  });
  const f = await workflowAdmissionFixture(t);
  f.addCleanup = cleanup => cleanups.push(cleanup);
  process.env.LING_STACK_HOME = join(f.root, "user-data");
  f.gitAt = async (cwd, ...args) => (await exec("/usr/bin/git", args, { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: f.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Recovery fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
      GIT_COMMITTER_NAME: "Recovery fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout;
  f.git = async (...args) => (await f.gitAt(f.cwd, ...args)).toString().trim();
  await f.git("init", "--initial-branch=main", "--template=");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!.gitignore\n!shared.txt\n!right.txt\n");
  await writeFile(join(f.cwd, "shared.txt"), "base\n");
  await writeFile(join(f.cwd, "right.txt"), "base right\n");
  await f.git("add", "--", ".gitignore", "shared.txt", "right.txt");
  await f.git("commit", "-m", "recovery basis");
  const provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Recovery fixture", providerId: "recovery-fixture",
    model: "fixture", api: "openai-completions", capabilities: ["chat", "tool_call"], input: ["text"], authHeader: false, enabled: true }, now());
  f.channel = f.store.updateChannel(f.channel.id, { defaultProviderPresetId: provider.id, allowedTools: ["read", "write"],
    runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 2, writeLockScope: "boundPath", allowReadOnlyParallel: false } }, now());
  f.policy = f.store.updateApprovalPolicy({ toolDecisions: { write: "ask" }, allowedWritePaths: [f.root] }, now());
  f.effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: f.policy,
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  const adapter = new PiRunnerAdapter();
  t.mock.method(adapter, "runTask", () => assert.fail("Recovery must never dispatch a model"));
  f.runners = createRunnerRegistry([{ id: "pi", displayName: "Pi", status: "enabled", adapter }]);
  f.host = { enabled: () => true, toolBrokerMode: () => "enforce" };
  f.isolation = () => createSqliteWorkflowIsolationStore(f.store);
  f.describe = workflowId => {
    const selection = f.isolation().getSelection(workflowId), round = f.isolation().getIntegrationRound(selection.roundId);
    return { id: round.roundId, workflow: f.store.getChannelWorkflow(workflowId), steps: f.store.listChannelWorkflowSteps({ workflowId, complete: true }),
      plans: round.inputs.participants.map(p => f.isolation().getScopePlan(f.store.getChannelWorkflowStep(p.workflowStepId).metadata.isolationScopePlan.planId)) };
  };
  f.create = async () => {
    const graph = { schemaVersion: 1, id: "recovery-files", name: "Repair isolated files", entryNodeId: "left", maxParallelSteps: 2,
      nodes: ["left", "right"].map(id => ({ id, kind: "step", name: id, prompt: "{{objective}}", teammateId: admissionParticipant,
        requestedRunnerId: "pi", requiredTools: ["read", "write"], sideEffectClass: "workspace_write", autoStart: false,
        parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } })),
      edges: [{ id: "left-right", fromNodeId: "left", toNodeId: "right", condition: { kind: "all_succeeded" } }],
      termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
    const { workflow } = createSqliteWorkflowUserCreationStore(f.store).create({ channelId: f.channel.id, now: now(),
      compile: () => compileWorkflowGraph(f.store, { channelId: f.channel.id, workflowGraph: graph, objective: "Write bounded file changes",
        runnerId: "pi", autoStart: false, createdBy: "local-user" }, now(), f.runners) });
    await selectWorkflowIsolatedExecution({ store: f.store, workflowId: workflow.id, runnerRegistry: f.runners, host: f.host });
    return f.describe(workflow.id);
  };
  f.start = async (round, index) => {
    const plan = round.plans[index], step = f.store.getChannelWorkflowStep(plan.workflowStepId);
    const scope = { workflow: f.store.getChannelWorkflow(round.workflow.id), step, plan: plan.resourcePlan };
    const contextPack = buildWorkflowStepContextPack({ store: f.store, channel: f.store.getChannel(f.channel.id),
      workflow: scope.workflow, step, prompt: step.prompt, providerPresetId: provider.id,
      consumerTeammateId: admissionParticipant, workflowSteps: f.store.listChannelWorkflowSteps({ workflowId: round.workflow.id, complete: true }) });
    assert.ok(contextPack.agentContext, "Continuity-backed fixture must use a real production context stamp");
    const generation = f.begin(scope, f.input(scope, f.lease(scope, now()), { now: now() })), taskId = generation.task.id;
    assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "todo", event: "claim", actor: "system", now: now() }).ok, true);
    const task = f.store.getTask(taskId), executionTask = { id: task.id, channelId: task.channelId, title: task.title, prompt: task.prompt };
    const runId = `${round.id}-run-${index}`, pin = { planId: plan.planId, planDigest: plan.planDigest };
    const request = { cwd: plan.executionRoot, workspaceCwd: f.cwd, executionCwd: plan.executionRoot, task: executionTask, runnerId: "pi",
      providerPresetId: provider.id, teammateId: admissionParticipant, workflowStepId: step.id, workflowStartOwner: generation.owner,
      sourceMessageId: scope.workflow.metadata.sourceMessageId, contextPack,
      workflowIsolationPlan: pin, workflowSafetySnapshot: workflowSafetySnapshot(step.metadata.safetyPlan),
      effectivePolicySnapshot: f.effectivePolicySnapshot, harnessFeatureSnapshot: { toolBroker: "enforce" } };
    const unit = f.store.createWorkUnit({ id: `${runId}-unit`, workspaceId: f.channel.workspaceId, kind: "task_run", ownerType: "task",
      ownerId: taskId, taskId, channelId: f.channel.id, teammateId: admissionParticipant, runnerId: "pi", effectiveRunnerId: "pi",
      idempotencyKey: `unit:${runId}`, createdByActor: "system", request, now: now() });
    const attempt = f.store.createWorkUnitAttempt({ id: `${runId}-attempt`, workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: `${runId}-host`, runnerId: "pi", effectiveRunnerId: "pi", now: now() });
    const fence = toRuntimeAttemptFence(attempt), source = { runId, ...fence }, lease = { workspaceId: f.channel.workspaceId,
      ownerType: "run", ownerId: runId, ...fence, acquiredAt: now(), expiresAt: f.at(3_600) };
    assert.ok(f.store.acquireResourceLease({ ...lease, resourceType: "task", resourceKey: taskId }));
    assert.ok(f.store.acquireResourceLease({ ...lease, resourceType: "bound_path", resourceKey: plan.executionRoot }));
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
    f.store.createRun({ id: runId, cwd: plan.executionRoot, taskId, channelId: f.channel.id, teammateId: admissionParticipant,
      workflowStepId: step.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {},
      requestSnapshot: request, createdAt: now() });
    f.store.linkRunToWorkUnit(runId, unit.id, now());
    const writer = { bindingId: workflowIsolationDigest(source, "wib_"), ...fence };
    await prepareWorkflowIsolatedExecution({ store: f.store, isolation: f.isolation(), scope: await readWorkflowIsolationWorktreeScope(f.store, pin),
      binding: { bindingId: writer.bindingId, ...pin, startOwner: generation.owner, runId, fence }, now, prepareInput: async () => {
        const options = { cwd: plan.executionRoot, agentDir: join(f.root, "agent"), task: executionTask, tools: ["read", "write"],
          provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
          isolatedToolsProfile: "host_isolated_files_v1", onToolBefore: () => ({ allowed: true }),
          onIsolatedToolCall: () => assert.fail("Preparation cannot call tools"), onApprovalRequired: () => assert.fail("Preparation cannot approve"),
          runtimeToolFeatures: { requestPermissions: false, unifiedExec: false, shellSnapshot: false },
          initialToolSurface: { userInput: false, delegation: false, mediaGeneration: false, nativeFileCreate: false, toolHydration: false } };
        return capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput: await adapter.prepareTaskInput(options) });
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
    const toolCallIds = [], item = { round, plan, scope, generation, ...prepared, source, writer, task: executionTask,
      run: f.store.getRun(runId), controller: new AbortController(), pending: [] };
    item.completion = f.store.trackHostAttemptCompletion(source, new Promise(resolve => { item.finish = resolve; }),
      () => ({ schemaVersion: 1, toolCallIds, settledBuiltinReads: [] }));
    item.completion.catch(() => undefined); attempts.push(item);
    item.handler = createRunApprovalHandler({ store: f.store, run: item.run, sourceFence: fence, workUnitId: unit.id, attemptId: attempt.id,
      workflowIsolationBindingId: writer.bindingId, hostOperationTracker: new AttemptHostOperationTracker({ store: f.store, source }),
      approvalPolicy: f.policy, effectivePolicySnapshot: f.effectivePolicySnapshot, signal: item.controller.signal,
      appendAndMaybeStream(type, data) {
        const event = f.store.appendExecutionEvent(runId, fence, type, data);
        if (type === "approval_requested") item.onApproval?.(data.approvalId);
        return event;
      }, streamEnvelope() {} });
    item.write = async (content, path = "shared.txt") => {
      const request = { toolName: "write", toolCallId: `${runId}-write-${toolCallIds.length + 1}`, cwd: plan.executionRoot,
        task: executionTask, input: { path, content } };
      f.store.appendExecutionEvent(runId, fence, "tool_start", { attemptId: attempt.id, toolName: "write", toolCallId: request.toolCallId, input: request.input });
      const approval = new Promise(resolve => { item.onApproval = resolve; });
      const pending = item.handler(request).then(result => {
        f.store.appendExecutionEvent(runId, fence, "tool_end", { attemptId: attempt.id, toolName: "write", toolCallId: request.toolCallId,
          isError: result.handledResult?.isError ?? !result.approved, result: result.handledResult });
        toolCallIds.push(request.toolCallId); return result;
      });
      pending.catch(() => undefined); item.pending.push(pending);
      const approvalId = await Promise.race([approval, pending.then(result => assert.fail(`Expected approval: ${JSON.stringify(result)}`))]);
      f.store.approveApprovalRequest(approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
      const result = await pending;
      assert.equal(result.approved, true, JSON.stringify(result)); assert.notEqual(result.handledResult?.isError, true, JSON.stringify(result));
      return { approvalId, request, result };
    };
    return item;
  };
  f.finish = async item => {
    const endedAt = now();
    assert.equal(f.store.transitionRunStatus({ runId: item.run.id, expectedStatus: "running", event: "runner_succeeded", actor: "runner", endedAt, now: endedAt }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...item.fence, expectedStatus: "running", event: "runner_succeeded", actor: "runner", endedAt, now: endedAt }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...item.fence, status: "succeeded", endedAt, now: endedAt }));
    f.store.appendTerminalRuntimeAudit({ capability: { ...item.fence, attemptStatus: "succeeded", transitionedAt: endedAt },
      type: "work_unit_succeeded", actor: "runner", data: { runId: item.run.id } });
    item.finish(); await item.completion;
    assert.equal(f.store.getHostAttemptCompletion(item.source).effectCoverage, "pi_tracked_tools_v1");
    f.store.releaseHostAttemptResources(item.source, now());
    assert.equal(f.store.releaseResourceLease(item.generation.owner.leaseId, "workflow_step", item.scope.step.id, now()), 1);
    const result = await captureWorkflowIsolatedResult({ store: f.store, writer: item.writer, now });
    assert.equal(result.status, "sealed");
    const finalized = finalizeOrchestratedWorkflowStepRun(f.store, item.scope.step.id, item.task.id, f.store.getRun(item.run.id), now());
    assert.equal(finalized.status, "succeeded", JSON.stringify(finalized));
    return result;
  };
  f.conflict = async () => {
    const round = await f.create(), items = [];
    for (let index = 0; index < 2; index++) {
      const item = await f.start(round, index);
      item.approval = await item.write(`${index ? "right" : "left"} conflict\n`);
      item.result = await f.finish(item); items.push(item);
    }
    const coordinated = await coordinateWorkflowIntegration({ store: f.store, roundId: round.id, now });
    assert.equal(coordinated.status, "conflicted", JSON.stringify(coordinated));
    return { ...round, items, round: coordinated.round };
  };
  f.target = async () => ({ head: await f.git("rev-parse", "HEAD"), status: await f.git("status", "--porcelain=v1"),
    shared: await readFile(join(f.cwd, "shared.txt"), "utf8"), right: await readFile(join(f.cwd, "right.txt"), "utf8") });
  return f;
}
