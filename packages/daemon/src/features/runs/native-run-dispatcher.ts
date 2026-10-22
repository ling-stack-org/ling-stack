import type { ConversationExecutionSelectionQuery, ConversationExecutionSelectionResponse, RunnerAcceptanceIdentity } from "@ling-stack/contracts";
import { inspectNativeConversationSelection } from "./native-conversation-selection.js";
import {
  applyConversationModeToEffectiveRunPolicySnapshot,
  createChannelWorkspaceSnapshot,
  createRunId,
  DEFAULT_WORKSPACE_ID,
  getRunSummaryPath,
  resolveSessionRunPolicy,
  toRuntimeAttemptFence,
  type ApprovalPolicy,
  type EffectiveRunPolicySnapshot,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
  type SecretResolver,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkspaceRuntimeSettings,
  type WorkflowStepStartOwnerV1,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isDeepStrictEqual } from "node:util";
import { resolveNativeRunnerSelection } from "../../runtime/native-runners.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { createRunExecutionSupervision } from "../../runtime/run-execution-supervision.js";
import { AttemptLocalWriterGroup } from "../../runtime/attempt-local-writers.js";
import { observeHostAttemptCompletion } from "../../runtime/host-attempt-completion.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { UnsupportedRunnerError, type RunnerRegistry, type RunnerResolution } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import {
  isTerminalWorkUnitStatus,
  transitionWorkUnitCancelled,
  transitionWorkUnitTerminal,
} from "../../runtime/work-units.js";
import { ensureStartupReadyForRun } from "../../startup/run-gate.js";
import { ensureWorkspaceStateWritableForRun } from "../../startup/workspace-state-gate.js";
import type { StartupStateRegistry } from "../../startup/state.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { ensureRunCancelled } from "./cancellation.js";
import {
  DuplicateRunRequestError,
  QueueableRunConflictError,
  acquireRunRuntimeSemaphores,
  claimPreparedRunTask,
  prepareRunConcurrency,
  releasePreparedRunResources,
  type PreparedRunConcurrency,
} from "./concurrency.js";
import {
  appendRunCancelledControlPlaneEvent,
  appendRunCompletedControlPlaneEvent,
  appendRunCreatedControlPlaneEvent,
  appendWorkUnitCreatedControlPlaneEvent,
  appendWorkUnitTransitionControlPlaneEvent,
  assertFullAccessPermissionConfirmed,
  getExplicitRunnerRequestSource,
  isTerminalRunStatus,
  readActiveRunStopIntent,
  resolveRunWorkUnitOwner,
  toRunnerResolutionSnapshot,
  validateWorkflowStepOwner,
  type ExecuteRunRequestOptions,
  type RunExecutionSink,
} from "./orchestrator.js";
import { auditIgnoredRunnerCompletion } from "./stale-completion.js";
import { appendFailureEvent, writeTerminalSummary } from "./terminal.js";
import { notifyRunReady } from "./run-ready.js";
import { readNormalConversationPreparedRequest } from "../conversations/normal-conversation-prepared-request.js";
import { findExistingIdempotentRunRequest } from "./existing-idempotent-run.js";
import { failUnlinkedPreparationThread } from "./preparation-thread-failure.js";
import { captureWorkflowStartOwner, commitWorkflowStartReady, assertWorkflowRunAdmission } from "./workflow-step-start-admission.js";
import {
  ensureLingThreadForRun,
  ensureLingTurnForRun,
  inferLingTurnRunRole,
  markLingThreadRunActive,
  syncLingThreadForRunEvent,
  syncLingThreadForTerminalRun,
} from "./threads.js";
import { appendRuntimeProgressForRunEvent, syncWorkUnitForRunEvent } from "./work-units.js";
import type { RunRequest } from "./schemas.js";

export type NativeBoundRunRequest = RunRequest & {
  readonly executionBinding: Extract<NonNullable<RunRequest["executionBinding"]>, { readonly kind: "native_profile" }>;
};

export interface NativeRunTargetDispatchInput {
  readonly runRequest: NativeBoundRunRequest;
  readonly store: RunStore;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly approvalPolicy: ApprovalPolicy;
  readonly effectivePolicySnapshot: EffectiveRunPolicySnapshot;
  readonly signal: AbortSignal;
  /** Events are already authoritative in the native journal. Observers must not append them again. */
  readonly onEvent: (event: RunEventEnvelope) => void;
  readonly onApprovalWaitChanged?: (waiting: boolean) => void;
  readonly onLocalLifetime?: (lifetime: Promise<unknown>) => void;
  readonly assertCurrentAuthority?: () => void;
}

export type NativeRunAdmissionInput = Pick<NativeRunTargetDispatchInput,
  "runRequest" | "store" | "approvalPolicy" | "effectivePolicySnapshot" | "signal" | "assertCurrentAuthority">
  & { readonly workflowSurface?: RunnerAcceptanceIdentity["workflowSurface"] };

export interface NativeRunTargetResult {
  readonly status: "completed" | "cancelled";
  readonly stopReason?: string;
  readonly events: readonly RunEventEnvelope[];
}

export interface NativeRunTargetDispatcher {
  assertAvailable?(input: NativeRunAdmissionInput): Promise<void>;
  dispatch(input: NativeRunTargetDispatchInput): Promise<NativeRunTargetResult>;
}

export interface NativeRunDispatchInput {
  readonly runRequest: NativeBoundRunRequest;
  readonly sink: RunExecutionSink;
  readonly executionOptions: Omit<ExecuteRunRequestOptions, "nativeRunDispatcher">;
}

/** Deep workflow port. Target-specific process and credential ownership stay behind it. */
export interface NativeRunDispatcher {
  inspectConversationSelection?(cwd: string, query: ConversationExecutionSelectionQuery): Promise<ConversationExecutionSelectionResponse>;
  dispatch(input: NativeRunDispatchInput): Promise<string | undefined>;
}

export interface CreateNativeRunDispatcherOptions {
  readonly runnerRegistry: RunnerRegistry;
  readonly storeRegistry: RunStoreRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly startupState?: StartupStateRegistry;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly target: NativeRunTargetDispatcher;
}

export function createNativeRunDispatcher(options: CreateNativeRunDispatcherOptions): NativeRunDispatcher {
  return {
    dispatch: (input) => executeNativeRunRequest(input, options),
    inspectConversationSelection: (cwd, query) => inspectNativeConversationSelection(options.storeRegistry.getStore(cwd), options.runnerRegistry, options.target, query),
  };
}

async function executeNativeRunRequest(
  input: NativeRunDispatchInput,
  dependencies: CreateNativeRunDispatcherOptions,
): Promise<string | undefined> {
  const { runRequest, sink } = input;
  const binding = runRequest.executionBinding;
  const workspaceCwd = runRequest.workspaceCwd ?? runRequest.cwd;
  let store: RunStore | undefined;
  let run: RunSession | undefined;
  let workUnit: WorkUnit | undefined;
  let attempt: WorkUnitAttempt | undefined;
  let runnerResolution: RunnerResolution | undefined;
  let preparedConcurrency: PreparedRunConcurrency = { taskExists: false, leases: [] };
  let thread: ReturnType<typeof ensureLingThreadForRun> | undefined;
  let turn: ReturnType<typeof ensureLingTurnForRun> | undefined;
  let runtimeSettings: WorkspaceRuntimeSettings | undefined;
  let effectivePolicySnapshot: EffectiveRunPolicySnapshot | undefined;
  let approvalPolicy: ApprovalPolicy | undefined;
  let runId = "";
  let createdAt = "";
  let workflowStartOwner: WorkflowStepStartOwnerV1 | undefined;

  try {
    const delegationFeatures = dependencies.runtimeSupervisor.getHarnessFeatures().delegations;
    if (delegationFeatures.mode !== "off" && (delegationFeatures.rootBudget?.tokenBudget !== undefined
      || delegationFeatures.rootBudget?.costBudgetMicros !== undefined)) {
      throw new HttpError(409, "delegation.native_budget_gate_unavailable",
        "Native execution has no verified per-invocation delegation budget gate. Select Pi or remove the token/cost cap.");
    }
    store = dependencies.storeRegistry.getStore(workspaceCwd);
    const duplicate = findExistingIdempotentRunRequest(store, runRequest);
    if (duplicate?.linkedRunId) throw new DuplicateRunRequestError(duplicate.linkedRunId);
    if (duplicate) throw new HttpError(409, "duplicate_work_unit", `Duplicate work unit request: ${duplicate.id}`);
    await ensureWorkspaceStateWritableForRun(workspaceCwd);
    await ensureStartupReadyForRun({
      cwd: workspaceCwd,
      startupState: dependencies.startupState,
      storeRegistry: dependencies.storeRegistry,
      runnerRegistry: dependencies.runnerRegistry,
      secretResolver: dependencies.secretResolver,
    });
    store = dependencies.storeRegistry.getStore(workspaceCwd);
    assertFullAccessPermissionConfirmed(runRequest);
    validateWorkflowStepOwner(store, runRequest);
    const runtime = dependencies.runtimeSupervisor.getRuntime(workspaceCwd, store);
    runtimeSettings = loadWorkspaceRuntimeSettings(store, dependencies.runnerRegistry);
    runnerResolution = resolveNativeRunnerSelection(dependencies.runnerRegistry, runRequest,
      runtimeSettings.allowedRunnerIds, typeof dependencies.target.assertAvailable === "function");
    if (runnerResolution.effectiveRunnerId !== binding.engineId) {
      throw new HttpError(409, "native_execution_unavailable", "Native execution cannot fall back to another runner.");
    }
    const channel = runRequest.task.channelId ? store.getChannel(runRequest.task.channelId) : undefined;
    const sessionPolicy = resolveSessionRunPolicy({
      workspacePolicy: store.getApprovalPolicy(),
      authorizationMode: runRequest.authorizationMode,
      workspaceAccessMode: runRequest.workspaceAccessMode,
      permissionPreset: runRequest.permissionPreset,
      permissionMode: runRequest.permissionMode,
      channelBoundPath: channel?.boundPath || runRequest.cwd,
      approvalProfile: runRequest.approvalProfile,
    });
    approvalPolicy = sessionPolicy.approvalPolicy;
    effectivePolicySnapshot = sessionPolicy.snapshot;
    const channelWorkspaceSnapshot = channel ? createChannelWorkspaceSnapshot(channel, workspaceCwd) : undefined;
    runId = createRunId();
    createdAt = new Date().toISOString();
    thread = ensureLingThreadForRun(store, runRequest, createdAt);
    effectivePolicySnapshot = applyConversationModeToEffectiveRunPolicySnapshot(
      effectivePolicySnapshot,
      thread.conversationMode.mode,
    );
    if (thread.kind === "conversation" && !thread.channelId) {
      const source = runRequest.normalConversationContext?.hydration.source.itemId;
      if (!source || !readNormalConversationPreparedRequest(store, source, runRequest)) {
        throw new HttpError(409, "native_conversation_prepared_input_required", "Accepted conversation input is required.");
      }
    }
    await dependencies.target.assertAvailable?.({ runRequest: { ...runRequest, threadId: thread.id }, store, approvalPolicy, effectivePolicySnapshot,
      signal: AbortSignal.timeout(15_000) });
    if (dependencies.activeRuns.isShuttingDown()) throw new HttpError(503, "runtime_shutting_down", "Runtime is shutting down.");
    // Admission can await native probes. Re-read idempotency before creating any durable execution authority.
    const raced = findExistingIdempotentRunRequest(store, runRequest);
    if (raced?.linkedRunId) throw new DuplicateRunRequestError(raced.linkedRunId);
    if (raced) throw new HttpError(409, "duplicate_work_unit", `Duplicate work unit request: ${raced.id}`);
    turn = ensureLingTurnForRun(store, thread, runRequest, createdAt);
    const durableTaskSnapshot = store.getTask(runRequest.task.id) ?? runRequest.task;
    const durableRunRequest = { ...runRequest, task: durableTaskSnapshot, preselectedMemoryUse: undefined };
    const owner = resolveRunWorkUnitOwner(thread, runRequest, turn.id);
    const idempotencyKey = runRequest.idempotencyKey ?? `run:${runId}`;
    const existing = runRequest.idempotencyKey
      ? store.findWorkUnitByIdempotency({ kind: owner.kind, ownerType: owner.ownerType,
          ownerId: owner.ownerId, idempotencyKey: runRequest.idempotencyKey })
      : undefined;
    if (existing?.linkedRunId) throw new DuplicateRunRequestError(existing.linkedRunId);
    if (existing) throw new HttpError(409, "duplicate_work_unit", `Duplicate work unit request: ${existing.id}`);
    workflowStartOwner = captureWorkflowStartOwner(store, runRequest);
    workUnit = store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: owner.kind,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      channelId: runRequest.task.channelId,
      taskId: runRequest.task.id,
      teammateId: runRequest.teammateId,
      runnerId: binding.engineId,
      requestedRunnerId: binding.engineId,
      effectiveRunnerId: binding.engineId,
      idempotencyKey,
      createdByActor: "user",
      linkedMessageId: runRequest.linkedMessageId,
      request: {
        ...durableRunRequest,
        permissionMode: effectivePolicySnapshot.mode,
        effectivePolicySnapshot,
        workspaceCwd,
        executionCwd: runRequest.cwd,
        channelWorkspaceBinding: channelWorkspaceSnapshot,
        threadId: thread.id,
        turnId: turn.id,
        runnerResolution: toRunnerResolutionSnapshot(runnerResolution),
        runtimeSettings,
      },
      now: createdAt,
    });
    store.appendRuntimeEvent({ workUnitId: workUnit.id, type: "work_unit_created", actor: "system", ts: createdAt,
      data: { kind: workUnit.kind, ownerType: workUnit.ownerType, ownerId: workUnit.ownerId,
        requestedRunnerId: binding.engineId, effectiveRunnerId: binding.engineId,
        requestSource: runnerResolution.requestSource, fallbackAllowed: false } });
    appendWorkUnitCreatedControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd, workUnit, createdAt);
    attempt = store.createWorkUnitAttempt({ workUnitId: workUnit.id, attemptNumber: workUnit.attemptCount + 1,
      runtimeInstanceId: runtime.runtimeInstanceId, runnerId: binding.engineId,
      requestedRunnerId: binding.engineId, effectiveRunnerId: binding.engineId, now: createdAt });
    preparedConcurrency = prepareRunConcurrency({ store, runRequest, runId, workUnit, attempt, now: createdAt });
    acquireRunRuntimeSemaphores({ store, workUnit, attempt, channel: preparedConcurrency.channel,
      channelParallelLimit: runRequest.channelParallelLimit,
      providerKey: `native:${binding.profileId}:${binding.profileRevision}`, runnerId: binding.engineId, now: createdAt });
    claimPreparedRunTask({ store, task: preparedConcurrency.task, runRequest, runId,
      leases: preparedConcurrency.leases, attempt, now: createdAt });
    const claim = store.transitionWorkUnitStatus({ workUnitId: workUnit.id, attemptId: attempt.id,
      activeAttemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken, expectedStatus: "queued", event: "claim", actor: "system", now: createdAt });
    if (!claim.ok) {
      releasePreparedRunResources(store, attempt, createdAt, "work-unit-claim-failed");
      throw new Error(`Work unit claim failed: ${claim.code}`);
    }
    store.appendRuntimeEvent({ workUnitId: workUnit.id, attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
      type: "work_unit_claimed", actor: "system", ts: createdAt, data: { runId } });
    appendWorkUnitTransitionControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
      workUnit.id, "queued", "claimed", runId, createdAt);
    run = createNativeRun({ store, storeRegistry: dependencies.storeRegistry, runRequest: durableRunRequest,
      runId, workspaceCwd, workUnit, attempt, thread, turn, runtimeSettings,
      effectivePolicySnapshot, channelWorkspaceSnapshot, runnerResolution, createdAt });
    appendRunCreatedControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd, run, createdAt);
    commitWorkflowStartReady(store, runRequest, run.id, workflowStartOwner);
  } catch (error) {
    if (error instanceof QueueableRunConflictError && store && workUnit && attempt && runnerResolution
      && runtimeSettings && effectivePolicySnapshot && thread && turn) {
      const queuedAt = new Date().toISOString();
      releasePreparedRunResources(store, attempt, queuedAt, "queued-conflict");
      run = createQueuedNativeRun({ store, storeRegistry: dependencies.storeRegistry, runRequest,
        runId, workspaceCwd, workUnit, attempt, thread, turn, runtimeSettings,
        effectivePolicySnapshot, runnerResolution, queuedAt, reason: error.code, message: error.message });
      try { commitWorkflowStartReady(store, runRequest, run.id, workflowStartOwner, { claimQueuedTask: true }); }
      catch (ownerError) {
        sink.writeError(statusCode(ownerError), { error: errorCode(ownerError), message: String(ownerError) });
        return undefined;
      }
      notifyRunReady(input.executionOptions.onRunReady, run.id);
      sink.writeReady({ ok: true, runId: run.id, workUnitId: workUnit.id, queued: true, queueReason: error.code });
      appendRunCreatedControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd, run, queuedAt);
      sink.end();
      return run.id;
    }
    if (preparedConcurrency.leases.length > 0 && store && attempt) {
      store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), new Date().toISOString(), "run-prepare-failed");
    }
    if (store && workUnit && !isTerminalWorkUnitStatus(store.getWorkUnit(workUnit.id)?.status ?? workUnit.status)) {
      const now = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const currentAttempt = attempt ? store.getWorkUnitAttempt(attempt.id) : undefined;
      if (currentAttempt) transitionWorkUnitTerminal(store, { workUnitId: workUnit.id,
        attemptId: currentAttempt.id, event: "runner_failed", attemptStatus: "failed",
        runtimeEventType: "work_unit_failed", actor: "system", now,
        errorCode: errorCode(error), errorMessage: message });
    }
    if (store && thread && !run) failUnlinkedPreparationThread(store, thread.id, turn?.id, error, new Date().toISOString());
    if (error instanceof DuplicateRunRequestError) {
      notifyRunReady(input.executionOptions.onRunReady, error.runId);
      sink.writeReady({ ok: true, runId: error.runId, duplicate: true });
      sink.end();
      return error.runId;
    }
    sink.writeError(statusCode(error), { error: errorCode(error), message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }

  if (!store || !run || !workUnit || !attempt || !approvalPolicy || !effectivePolicySnapshot) {
    sink.writeError(500, { error: "run_storage_unavailable", message: "Native run was not initialized." });
    return undefined;
  }

  sink.writeReady({ ok: true, runId: run.id });
  notifyRunReady(input.executionOptions.onRunReady, run.id);
  const abortController = new AbortController();
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  let sinkClosed = sink.isClosed();
  sink.onClose(() => { sinkClosed = true; });
  const streamEnvelope = (event: RunEventEnvelope): void => { if (!sinkClosed) sink.writeEvent(event.type, event); };
  dependencies.activeRuns.add(run.id, { abortController, streamEnvelope, completion,
    runtimeInstanceId: attempt.runtimeInstanceId, workUnitId: workUnit.id, attemptId: attempt.id,
    fencingToken: attempt.fencingToken });
  const supervision = createRunExecutionSupervision({ store, runId: run.id, workUnit, attempt,
    activeRuns: dependencies.activeRuns, signal: abortController.signal });
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
  const writers = new AttemptLocalWriterGroup(source);
  const durableCompletion = observeHostAttemptCompletion(store, source, completion.then(() => writers.waitForIdle()),
    () => ({ schemaVersion: 1, kind: "native_journal_v1",
      submissionIds: store!.listNativeAttemptSubmissions(source).map(submission => submission.id) }),
    () => dependencies.activeRuns.retireDurablyDrainedAttempt(source));
  dependencies.activeRuns.trackAttemptCompletion(source, durableCompletion);
  let startedAt: string | undefined;

  try {
    startedAt = new Date().toISOString();
    const started = store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started",
      actor: "runner", now: startedAt, startedAt });
    if (!started.ok) throw new Error(`Run transition failed: ${started.code}`);
    const workStarted = store.transitionWorkUnitStatus({ workUnitId: workUnit.id, attemptId: attempt.id,
      activeAttemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken, expectedStatus: "claimed", event: "runner_started",
      actor: "runner", now: startedAt, startedAt, lastHeartbeatAt: startedAt });
    if (!workStarted.ok) throw new Error(`Work unit start failed: ${workStarted.code}`);
    store.updateWorkUnitAttemptStatus({ attemptId: attempt.id, workUnitId: attempt.workUnitId,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
      status: "started", now: startedAt, startedAt, lastHeartbeatAt: startedAt });
    store.appendRuntimeEvent({ workUnitId: workUnit.id, attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
      type: "work_unit_started", actor: "runner", ts: startedAt, data: { runId: run.id } });
    appendWorkUnitTransitionControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
      workUnit.id, "claimed", "running", run.id, startedAt);
    if (preparedConcurrency.taskExists) {
      const taskStarted = store.transitionTaskStatus({ taskId: run.taskId, expectedStatus: "claimed",
        event: "start_run", actor: "runner", now: startedAt, currentRunId: run.id });
      if (!taskStarted.ok) throw new Error(`Task transition failed: ${taskStarted.code}`);
    }
    supervision.start();
    const assertCurrentAuthority = (): void => {
      abortController.signal.throwIfAborted();
      assertWorkflowRunAdmission(store!, run!, workflowStartOwner, abortController.signal);
      resolveNativeRunnerSelection(dependencies.runnerRegistry, runRequest,
        loadWorkspaceRuntimeSettings(store!, dependencies.runnerRegistry).allowedRunnerIds,
        typeof dependencies.target.assertAvailable === "function");
      const channel = runRequest.task.channelId ? store!.getChannel(runRequest.task.channelId) : undefined;
      const policy = resolveSessionRunPolicy({ workspacePolicy: store!.getApprovalPolicy(),
        authorizationMode: runRequest.authorizationMode, workspaceAccessMode: runRequest.workspaceAccessMode,
        permissionPreset: runRequest.permissionPreset, permissionMode: runRequest.permissionMode,
        channelBoundPath: channel?.boundPath || runRequest.cwd, approvalProfile: runRequest.approvalProfile });
      const currentThread = run!.threadId ? store!.getLingThread(run!.threadId) : undefined;
      if (!currentThread || !isDeepStrictEqual(effectivePolicySnapshot,
        applyConversationModeToEffectiveRunPolicySnapshot(policy.snapshot, currentThread.conversationMode.mode))) {
        throw new HttpError(409, "native_policy_changed", "Run permissions changed during native preparation.");
      }
    };
    assertCurrentAuthority();
    const result = await dependencies.target.dispatch({ runRequest: { ...runRequest, threadId: run.threadId }, store, run, workUnit, attempt,
      approvalPolicy, effectivePolicySnapshot, signal: abortController.signal,
      assertCurrentAuthority,
      onApprovalWaitChanged: writers.wrapSync("native approval wait", supervision.approvalWaitChanged),
      onLocalLifetime: (lifetime) => {
        const finish = writers.reserve("native execution and callbacks");
        void lifetime.then(finish, finish);
      },
      onEvent: writers.wrapSync("native event projection", (event) => {
        supervision.activity();
        syncWorkUnitForRunEvent(store!, workUnit!.id, attempt!.id, event.type, event);
        appendRuntimeProgressForRunEvent(store!, workUnit!.id, attempt!.id, event.type, event);
        syncLingThreadForRunEvent(store!, run!, event.type, event);
        streamEnvelope(event);
      }) });
    if (abortController.signal.aborted) abortController.signal.throwIfAborted();
    if (result.status === "cancelled") {
      const observed = store.getRun(run.id);
      if (observed?.status !== "cancelled") {
        const cancelledAt = new Date().toISOString();
        const previousRunStatus = observed?.status ?? "running";
        const previousWorkStatus = store.getWorkUnit(workUnit.id)?.status ?? "running";
        ensureRunCancelled({ store, runId: run.id, taskId: run.taskId, startedAt,
          reason: result.stopReason ?? "native_execution_cancelled", active: false, streamEnvelope });
        appendRunCancelledControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
          run, previousRunStatus, cancelledAt);
        appendWorkUnitTransitionControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
          workUnit.id, previousWorkStatus, "cancelled", run.id, cancelledAt);
      }
      if (!sinkClosed) sink.end();
      return run.id;
    }
    if (store.getRun(run.id)?.status === "cancelled") {
      const stale = auditIgnoredRunnerCompletion({ store, run, workUnit, attempt, reportedStatus: "succeeded" });
      if (stale) streamEnvelope(stale);
      if (!sinkClosed) sink.end();
      return run.id;
    }
    const messageCount = result.events.filter((event) => event.type === "message_end").length;
    const resultEnvelope = store.appendEvent(run.id, "result", { taskId: run.taskId, messageCount,
      runnerEventCount: result.events.length, executionEngineId: binding.engineId, stopReason: result.stopReason });
    streamEnvelope(resultEnvelope);
    const endedAt = new Date().toISOString();
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), { runId: run.id,
      status: "succeeded", taskId: run.taskId, eventCount: resultEnvelope.seq, messageCount,
      startedAt, endedAt, errorMessage: null });
    const success = store.transitionRunStatus({ runId: run.id, expectedStatus: "running",
      event: "runner_succeeded", actor: "runner", now: endedAt, endedAt, summaryPath, errorMessage: null });
    if (!success.ok) {
      const stale = auditIgnoredRunnerCompletion({ store, run, workUnit, attempt,
        reportedStatus: "succeeded", now: endedAt });
      if (stale) streamEnvelope(stale);
      if (!sinkClosed) sink.end();
      return run.id;
    }
    transitionWorkUnitTerminal(store, { workUnitId: workUnit.id, attemptId: attempt.id,
      event: "runner_succeeded", attemptStatus: "succeeded", runtimeEventType: "work_unit_succeeded",
      actor: "runner", now: endedAt });
    appendRunCompletedControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
      run, "running", "succeeded", endedAt);
    appendWorkUnitTransitionControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
      workUnit.id, "running", "succeeded", run.id, endedAt);
    syncLingThreadForTerminalRun(store, run.id, endedAt);
    if (preparedConcurrency.taskExists) store.transitionTaskStatus({ taskId: run.taskId,
      expectedStatus: "running", event: "run_succeeded", actor: "runner", now: endedAt, currentRunId: run.id });
    if (!sinkClosed) sink.end();
  } catch (error) {
    const stopIntent = dependencies.activeRuns.getStopIntent(run.id) ?? readActiveRunStopIntent(abortController.signal.reason);
    const observed = store.getRun(run.id);
    if (observed?.status === "cancelled" || stopIntent?.kind === "user_cancel" || stopIntent?.kind === "workflow_cancel") {
      const cancelledAt = new Date().toISOString();
      const previous = observed?.status && observed.status !== "cancelled" ? observed.status : "running";
      ensureRunCancelled({ store, runId: run.id, taskId: run.taskId, startedAt,
        reason: "cancelled", active: false, streamEnvelope });
      transitionWorkUnitCancelled(store, workUnit.id, attempt.id, "cancelled");
      appendRunCancelledControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd, run, previous, cancelledAt);
      appendWorkUnitTransitionControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
        workUnit.id, "cancelling", "cancelled", run.id, cancelledAt);
      syncLingThreadForTerminalRun(store, run.id, cancelledAt);
      if (!sinkClosed) sink.end();
      return run.id;
    }
    const message = stopIntent?.kind === "runtime_failure" ? stopIntent.reason
      : stopIntent?.kind === "runtime_suspend" ? "runtime_interrupted_no_checkpoint"
      : error instanceof Error ? error.message : String(error);
    const endedAt = new Date().toISOString();
    const failureEvent = appendFailureEvent(
      store,
      run.id,
      toRuntimeAttemptFence(attempt),
      message,
      sinkClosed,
      sink,
      {},
      endedAt,
    );
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), { runId: run.id,
      status: "failed", taskId: run.taskId, eventCount: failureEvent?.seq ?? store.countEvents(run.id),
      startedAt, endedAt, errorMessage: message });
    const currentRun = store.getRun(run.id);
    const failed = store.transitionRunStatus({ runId: run.id, expectedStatus: currentRun?.status ?? "running",
      event: "runner_failed", actor: "runner", reason: message, now: endedAt,
      endedAt, summaryPath, errorMessage: message });
    if (failed.ok) {
      const currentWork = store.getWorkUnit(workUnit.id);
      transitionWorkUnitTerminal(store, { workUnitId: workUnit.id, attemptId: attempt.id,
        event: "runner_failed", attemptStatus: "failed", runtimeEventType: "work_unit_failed",
        actor: "runner", now: endedAt, errorCode: errorCode(error), errorMessage: message });
      appendRunCompletedControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
        run, currentRun?.status ?? "running", "failed", endedAt, errorCode(error));
      appendWorkUnitTransitionControlPlaneEvent(store, dependencies.controlPlaneEvents, workspaceCwd,
        workUnit.id, currentWork?.status ?? "running", "failed", run.id, endedAt, errorCode(error));
      syncLingThreadForTerminalRun(store, run.id, endedAt);
      if (preparedConcurrency.taskExists) store.transitionTaskStatus({ taskId: run.taskId,
        expectedStatus: "running", event: "run_failed", actor: "runner", reason: message,
        now: endedAt, currentRunId: run.id });
    }
    if (!sinkClosed) sink.end();
  } finally {
    supervision.dispose();
    writers.close();
    dependencies.activeRuns.trackAttemptCompletion(source, writers.waitForIdle());
    if (dependencies.activeRuns.get(run.id)?.attemptId === attempt.id) dependencies.activeRuns.delete(run.id);
    try {
      resolveCompletion?.();
      await durableCompletion;
      const terminal = store.getRun(run.id);
      if (terminal && isTerminalRunStatus(terminal.status)
        && store.getWorkUnit(workUnit.id)?.activeAttemptId === attempt.id) await input.executionOptions.afterRunTerminal?.(terminal);
    } finally {
      resolveCompletion?.();
    }
  }
  return run.id;
}

function createNativeRun(input: {
  readonly store: RunStore;
  readonly storeRegistry: RunStoreRegistry;
  readonly runRequest: NativeBoundRunRequest;
  readonly runId: string;
  readonly workspaceCwd: string;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly thread: NonNullable<ReturnType<typeof ensureLingThreadForRun>>;
  readonly turn: NonNullable<ReturnType<typeof ensureLingTurnForRun>>;
  readonly runtimeSettings: WorkspaceRuntimeSettings;
  readonly effectivePolicySnapshot: EffectiveRunPolicySnapshot;
  readonly channelWorkspaceSnapshot?: ReturnType<typeof createChannelWorkspaceSnapshot>;
  readonly runnerResolution: RunnerResolution;
  readonly createdAt: string;
}): RunSession {
  const binding = input.runRequest.executionBinding;
  const identity = nativeProviderIdentity(binding);
  const run = input.store.createRun({ id: input.runId, cwd: input.runRequest.cwd,
    taskId: input.runRequest.task.id, channelId: input.workUnit.channelId ?? input.runRequest.task.channelId,
    teammateId: input.runRequest.teammateId, workflowStepId: input.runRequest.workflowStepId,
    providerName: identity.providerName, providerModel: identity.providerModel,
    taskSnapshot: input.runRequest.task, providerSnapshot: identity.snapshot,
    requestSnapshot: { ...input.runRequest, permissionMode: input.effectivePolicySnapshot.mode,
      effectivePolicySnapshot: input.effectivePolicySnapshot, workspaceCwd: input.workspaceCwd,
      executionCwd: input.runRequest.cwd, channelWorkspaceBinding: input.channelWorkspaceSnapshot,
      threadId: input.thread.id, turnId: input.turn.id,
      runnerResolution: toRunnerResolutionSnapshot(input.runnerResolution), runtimeSettings: input.runtimeSettings },
    workUnitId: input.workUnit.id, threadId: input.thread.id, turnId: input.turn.id,
    turnRunRole: inferLingTurnRunRole(input.runRequest), parentRunId: input.runRequest.parentRunId,
    interventionId: input.runRequest.interventionId, continuationReason: input.runRequest.continuationReason,
    contextViewId: input.runRequest.contextProjection?.contextViewId,
    contextViewCreatedAt: input.runRequest.contextProjection?.contextViewCreatedAt, createdAt: input.createdAt });
  input.store.linkRunToWorkUnit(run.id, input.workUnit.id, input.createdAt);
  markLingThreadRunActive(input.store, input.thread.id, run.id, input.createdAt);
  input.storeRegistry.rememberRun(run.id, input.store);
  input.store.appendEvent(run.id, "run_created", { taskId: run.taskId, workUnitId: input.workUnit.id,
    attemptId: input.attempt.id, workspaceCwd: input.workspaceCwd, cwd: run.cwd, threadId: input.thread.id,
    providerName: run.providerName, providerModel: run.providerModel, executionEngineId: binding.engineId,
    executionProfileId: binding.profileId, executionProfileRevision: binding.profileRevision,
    requestedRunnerId: binding.engineId, effectiveRunnerId: binding.engineId,
    requestSource: input.runnerResolution.requestSource, fallbackAllowed: false, teammateId: run.teammateId });
  return run;
}

function createQueuedNativeRun(input: Omit<Parameters<typeof createNativeRun>[0], "createdAt" | "channelWorkspaceSnapshot">
  & { readonly queuedAt: string; readonly reason: string; readonly message: string }): RunSession {
  const run = createNativeRun({ ...input, createdAt: input.queuedAt });
  input.store.appendRuntimeEvent({ workUnitId: input.workUnit.id, attemptId: input.attempt.id,
    runtimeInstanceId: input.attempt.runtimeInstanceId, fencingToken: input.attempt.fencingToken,
    type: "work_unit_queued", actor: "system", ts: input.queuedAt,
    data: { runId: run.id, reason: input.reason, message: input.message } });
  return run;
}

function nativeProviderIdentity(binding: NativeBoundRunRequest["executionBinding"]): {
  readonly providerName: string;
  readonly providerModel: string;
  readonly snapshot: Record<string, unknown>;
} {
  return { providerName: binding.engineId, providerModel: binding.nativeModelId ?? "",
    snapshot: { executionEngineId: binding.engineId, profileId: binding.profileId,
      profileRevision: binding.profileRevision,
      ...(binding.nativeModelId === undefined ? {} : { nativeModelId: binding.nativeModelId }) } };
}

function statusCode(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof UnsupportedRunnerError) return 400;
  const code = errorCode(error);
  return code.startsWith("profile_") || code.startsWith("engine_") || code.startsWith("native_") ? 409 : 500;
}

function errorCode(error: unknown): string {
  if (error instanceof HttpError || error instanceof UnsupportedRunnerError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "native_execution_failed";
}
