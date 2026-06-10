import type { ServerResponse } from "node:http";
import {
  type ApprovalPolicy,
  buildEffectiveTeammateSkills,
  createChannelWorkspaceSnapshot,
  createRunId,
  DEFAULT_WORKSPACE_ID,
  resolveSessionRunPolicy,
  getEffectiveTeammateSkill,
  getRunSummaryPath,
  redactSecrets,
  type EffectiveRunPolicySnapshot,
  type LingThread,
  type LingTurn,
  type RunEventEnvelope,
  type RunEventType,
  type RunArtifact,
  type RunSession,
  type RunStatus,
  type RunStore,
  type RunTool,
  type RunnerRequestSource,
  type RuntimeInstance,
  type SecretResolver,
  type SkillApprovalProfile,
  type WorkspaceRuntimeSettings,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import type { PiRunnerEvent, PiRunnerMcpToolDefinition, PiRunnerProviderConfig, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { McpBroker } from "../../context.js";
import { HttpError } from "../../errors.js";
import { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { UnsupportedRunnerError, type RunnerRegistry, type RunnerResolution } from "../../runtime/runners.js";
import { RunStoreRegistry } from "../../runtime/store-registry.js";
import { RuntimeSupervisor } from "../../runtime/supervisor.js";
import {
  isActiveWorkUnitStatus,
  isTerminalWorkUnitStatus,
  transitionWorkUnitCancelled,
  transitionWorkUnitTerminal,
} from "../../runtime/work-units.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import { renderUsedMemoryPrompt } from "../memory/prompt.js";
import { listExecutableSkillDefinitions } from "../skills/registry.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { listBundledPackageDescriptors } from "../plugins/source-index.js";
import { createManagedPluginRuntimeSnapshot } from "../plugins/runtime-injection.js";
import {
  createRunApprovalHandler,
  mergeApprovalProfiles,
  mergeRunTools,
} from "./approvals.js";
import { createRunPermissionRequestHandler } from "./permission-requests.js";
import { persistExtractedArtifacts } from "./artifacts.js";
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
  createMcpToolCallHandler,
  createPiRunnerMcpToolDefinitions,
  resolveMcpToolAccessForRun,
} from "./mcp.js";
import { createQueuedRunForConflict } from "./queue.js";
import { resolveProviderForRun } from "./providers.js";
import type { RunRequest } from "./schemas.js";
import { appendFailureEvent, writeTerminalSummary } from "./terminal.js";
import { auditIgnoredRunnerCompletion } from "./stale-completion.js";
import {
  ensureLingThreadForRun,
  ensureLingTurnForRun,
  inferLingTurnRunRole,
  markLingThreadRunActive,
  syncLingThreadForRunEvent,
  syncLingThreadForTerminalRun,
} from "./threads.js";
import { appendRuntimeProgressForRunEvent, syncWorkUnitForRunEvent } from "./work-units.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { writeJson, writeSse, writeSseHead } from "../../shared/response.js";

export interface ExecuteRunRequestOptions {
  readonly onRunReady?: (runId: string) => void;
  readonly afterRunTerminal?: (run: RunSession) => void;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
}

export interface RunExecutionSink {
  readonly kind: "sse" | "detached";
  onClose(listener: () => void): void;
  isClosed(): boolean;
  writeReady(data: unknown): void;
  writeEvent(event: string, data: unknown): void;
  writeError(statusCode: number, body: unknown): void;
  end(): void;
}

export function createSseRunExecutionSink(response: ServerResponse): RunExecutionSink {
  let closed = false;
  let sseStarted = false;
  const closeListeners: (() => void)[] = [];
  response.on("close", () => {
    closed = true;
    for (const listener of closeListeners.splice(0)) {
      listener();
    }
  });
  const ensureSseStarted = (): void => {
    if (!sseStarted) {
      writeSseHead(response);
      sseStarted = true;
    }
  };
  return {
    kind: "sse",
    onClose(listener) {
      closeListeners.push(listener);
    },
    isClosed() {
      return closed;
    },
    writeReady(data) {
      ensureSseStarted();
      writeSse(response, "ready", data);
    },
    writeEvent(event, data) {
      ensureSseStarted();
      writeSse(response, event, data);
    },
    writeError(statusCode, body) {
      if (!response.headersSent) {
        writeJson(response, statusCode, body);
      }
    },
    end() {
      if (!closed) {
        response.end();
      }
    },
  };
}

export function createDetachedRunExecutionSink(): RunExecutionSink {
  return {
    kind: "detached",
    onClose() {
      // Detached continuation runs are daemon-owned and are not tied to a browser stream.
    },
    isClosed() {
      return false;
    },
    writeReady() {},
    writeEvent() {},
    writeError() {},
    end() {},
  };
}

export async function executeRunRequest(
  runRequest: RunRequest,
  sink: RunExecutionSink,
  runnerRegistry: RunnerRegistry,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  options: ExecuteRunRequestOptions = {},
): Promise<string | undefined> {
  let store: RunStore | undefined;
  let run: RunSession | undefined;
  let workUnit: WorkUnit | undefined;
  let attempt: WorkUnitAttempt | undefined;
  let thread: LingThread | undefined;
  let turn: LingTurn | undefined;
  let runtime: RuntimeInstance | undefined;
  let runnerRequest: PiRunnerRunOptions;
  let preparedConcurrency: PreparedRunConcurrency = { taskExists: false, leases: [] };
  let resolvedSecretValues: readonly (string | undefined)[] = [];
  let resolvedProvider: PiRunnerProviderConfig | undefined;
  let runnerResolution: RunnerResolution | undefined;
  let runtimeSettings: WorkspaceRuntimeSettings | undefined;
  let runtimeTools: readonly RunTool[] | undefined;
  let mcpTools: readonly PiRunnerMcpToolDefinition[] = [];
  let memoryRecall: ReturnType<RunStore["recallMemory"]> | undefined;
  let selectedSkill: ReturnType<typeof getEffectiveTeammateSkill> | undefined;
  let runtimeApprovalProfile: SkillApprovalProfile | undefined;
  let effectivePolicySnapshot: EffectiveRunPolicySnapshot | undefined;
  let approvalPolicy: ApprovalPolicy | undefined;
  let runId = "";
  let createdAt = "";
  let workspaceCwd = "";
  try {
    workspaceCwd = runRequest.workspaceCwd ?? runRequest.cwd;
    store = storeRegistry.getStore(workspaceCwd);
    assertFullAccessPermissionConfirmed(runRequest);
    validateWorkflowStepOwner(store, runRequest);
    runtime = runtimeSupervisor.getRuntime(workspaceCwd, store);
    resolvedProvider = resolveProviderForRun(store, runRequest, secretResolver);
    const skillChannel = runRequest.task.channelId ? store.getChannel(runRequest.task.channelId) : undefined;
    const skillTeammate = runRequest.teammateId ? resolveAiTeammateReference(store, runRequest.teammateId) : undefined;
    const skillProviderPreset = runRequest.providerPresetId ? store.getProviderPreset(runRequest.providerPresetId) : undefined;
    if (runRequest.requestedSkillId) {
      if (!skillTeammate) {
        throw new HttpError(400, "skill_teammate_required", "requestedSkillId requires a resolved teammateId.");
      }
      const effectiveSkills = buildEffectiveTeammateSkills({
        teammate: skillTeammate,
        bindings: store.listTeammateSkillBindings(skillTeammate.id),
        skills: listExecutableSkillDefinitions(store),
        channelAllowedTools: skillChannel?.allowedTools,
        providerCapabilities: skillProviderPreset?.capabilities,
      });
      selectedSkill = getEffectiveTeammateSkill(effectiveSkills, runRequest.requestedSkillId);
      if (!selectedSkill) {
        throw new HttpError(400, "skill_not_bound", `Skill is not bound to teammate: ${runRequest.requestedSkillId}`);
      }
      if (!selectedSkill.executable) {
        throw new HttpError(
          400,
          "skill_not_executable",
          `Skill is not executable: ${selectedSkill.blockedReasons.map((reason) => reason.code).join(", ")}`,
        );
      }
    }
    const runStore = store;
    const mcpToolAccess = resolveMcpToolAccessForRun(runStore, secretResolver, runRequest, (teammateId) =>
      resolveAiTeammateReference(runStore, teammateId)?.id);
    mcpTools = createPiRunnerMcpToolDefinitions(mcpToolAccess);
    memoryRecall = store.recallMemory({
      teammateId: runRequest.teammateId,
      channelId: runRequest.task.channelId,
      taskId: runRequest.task.id,
      intent: "task-run",
      query: `${runRequest.task.title}\n${runRequest.task.prompt}`,
      maxResults: 6,
    });
    const memoryPrompt = renderUsedMemoryPrompt(memoryRecall.memories);
    const appendSystemPrompt = [
      ...(runRequest.appendSystemPrompt ?? []),
      ...(selectedSkill?.promptFragments ?? []),
      ...(memoryPrompt ? [memoryPrompt] : []),
    ];
    runtimeTools = selectedSkill
      ? mergeRunTools(runRequest.tools ?? [], selectedSkill.requiredTools)
      : runRequest.tools;
    runtimeApprovalProfile = selectedSkill
      ? mergeApprovalProfiles(runRequest.approvalProfile, selectedSkill.skill.approvalProfile)
      : runRequest.approvalProfile;
    runtimeSettings = loadWorkspaceRuntimeSettings(store, runnerRegistry);
    const runnerRequestSource: RunnerRequestSource = runRequest.runnerId
      ? getExplicitRunnerRequestSource(runRequest)
      : skillTeammate?.runnerId ? "teammate_default" : "workspace_default";
    runnerResolution = runnerRegistry.resolve({
      requestedRunnerId: runRequest.runnerId ?? skillTeammate?.runnerId ?? runtimeSettings.defaultRunnerId,
      defaultRunnerId: runtimeSettings.defaultRunnerId,
      allowedRunnerIds: runtimeSettings.allowedRunnerIds,
      requestSource: runnerRequestSource,
      explicitFallbackPolicy: runtimeSettings.explicitRunnerFallback,
      implicitFallbackPolicy: runtimeSettings.implicitRunnerFallback,
      providerApi: resolvedProvider.api,
      tools: runtimeTools,
    });
    const channelForPolicy = runRequest.task.channelId ? store.getChannel(runRequest.task.channelId) : undefined;
    const sessionPolicy = resolveSessionRunPolicy({
      workspacePolicy: store.getApprovalPolicy(),
      permissionMode: runRequest.permissionMode,
      channelBoundPath: channelForPolicy?.boundPath || runRequest.cwd,
      approvalProfile: runtimeApprovalProfile,
    });
    const channelWorkspaceSnapshot = channelForPolicy
      ? createChannelWorkspaceSnapshot(channelForPolicy, workspaceCwd)
      : undefined;
    approvalPolicy = sessionPolicy.approvalPolicy;
    effectivePolicySnapshot = sessionPolicy.snapshot;
    const runtimeToolFeatures = {
      ...runRequest.runtimeToolFeatures,
      unifiedExec: runtimeSupervisor.getRuntimeToolFeatures().unifiedExec === true,
      shellSnapshot: runtimeSupervisor.getRuntimeToolFeatures().shellSnapshot === true,
    };
    runnerRequest = {
      cwd: runRequest.cwd,
      task: runRequest.task,
      provider: resolvedProvider,
      tools: runtimeTools,
      mcpTools,
      thinkingLevel: runRequest.thinkingLevel,
      systemPrompt: runRequest.systemPrompt,
      appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
      agentDir: runRequest.agentDir,
      runtimeToolFeatures,
      onMcpToolCall: mcpTools.length > 0 ? createMcpToolCallHandler(store, secretResolver, mcpBroker, mcpTools) : undefined,
    };
    resolvedSecretValues = [resolvedProvider.apiKey];
    runId = createRunId();
    createdAt = new Date().toISOString();
    const idempotencyKey = runRequest.idempotencyKey ?? `run:${runId}`;
    const existingWorkUnit = runRequest.idempotencyKey
      ? store.findWorkUnitByIdempotency({
          kind: "task_run",
          ownerType: "task",
          ownerId: runRequest.task.id,
          idempotencyKey: runRequest.idempotencyKey,
        })
      : undefined;
    if (existingWorkUnit?.linkedRunId) {
      throw new DuplicateRunRequestError(existingWorkUnit.linkedRunId);
    }
    if (existingWorkUnit) {
      throw new HttpError(409, "duplicate_work_unit", `Duplicate work unit request: ${existingWorkUnit.id}`);
    }
    thread = ensureLingThreadForRun(store, runRequest, createdAt);
    turn = ensureLingTurnForRun(store, thread, runRequest, createdAt);
    workUnit = store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: runRequest.task.id,
      channelId: runRequest.task.channelId,
      taskId: runRequest.task.id,
      providerPresetId: runRequest.providerPresetId,
      runnerId: runnerResolution.effectiveRunnerId,
      requestedRunnerId: runnerResolution.requestedRunnerId,
      effectiveRunnerId: runnerResolution.effectiveRunnerId,
      fallbackReason: runnerResolution.fallbackReason,
      idempotencyKey,
      createdByActor: "user",
      request: {
        ...runRequest,
        permissionMode: effectivePolicySnapshot.mode,
        effectivePolicySnapshot,
        workspaceCwd,
        executionCwd: runRequest.cwd,
        channelWorkspaceBinding: channelWorkspaceSnapshot,
        threadId: thread.id,
        turnId: turn.id,
        provider: resolvedProvider,
        runnerResolution: toRunnerResolutionSnapshot(runnerResolution),
        runtimeSettings,
        runtimeToolFeatures,
        selectedSkillId: selectedSkill?.skillId,
        mcpToolAccess,
      },
      now: createdAt,
    });
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      type: "work_unit_created",
      actor: "system",
      ts: createdAt,
      data: {
        kind: workUnit.kind,
        ownerType: workUnit.ownerType,
        ownerId: workUnit.ownerId,
        requestedRunnerId: runnerResolution.requestedRunnerId,
        effectiveRunnerId: runnerResolution.effectiveRunnerId,
        requestSource: runnerResolution.requestSource,
        fallbackAllowed: runnerResolution.fallbackAllowed,
        fallbackReason: runnerResolution.fallbackReason,
      },
    });
    appendWorkUnitCreatedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit, createdAt);
    attempt = store.createWorkUnitAttempt({
      workUnitId: workUnit.id,
      attemptNumber: workUnit.attemptCount + 1,
      runtimeInstanceId: runtime.runtimeInstanceId,
      runnerId: runnerResolution.effectiveRunnerId,
      requestedRunnerId: runnerResolution.requestedRunnerId,
      effectiveRunnerId: runnerResolution.effectiveRunnerId,
      fallbackReason: runnerResolution.fallbackReason,
      providerPresetId: runRequest.providerPresetId,
      now: createdAt,
    });
    preparedConcurrency = prepareRunConcurrency({
      store,
      runRequest,
      runId,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      now: createdAt,
    });
    acquireRunRuntimeSemaphores({
      store,
      workUnit,
      attempt,
      channel: preparedConcurrency.channel,
      providerKey: runRequest.providerPresetId ?? `${resolvedProvider.provider}:${resolvedProvider.model}`,
      runnerId: runnerResolution.effectiveRunnerId,
      now: createdAt,
    });
    claimPreparedRunTask({
      store,
      task: preparedConcurrency.task,
      runRequest,
      runId,
      leases: preparedConcurrency.leases,
      attemptId: attempt.id,
      now: createdAt,
    });
    const claimTransition = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      now: createdAt,
      activeAttemptId: attempt.id,
    });
    if (!claimTransition.ok) {
      releasePreparedRunResources(store, preparedConcurrency.leases, attempt.id, createdAt, "work-unit-claim-failed");
      throw new Error(`Work unit claim failed: ${claimTransition.code}`);
    }
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      type: "work_unit_claimed",
      actor: "system",
      ts: createdAt,
      data: {
        runId,
      },
    });
    const managedPluginRuntime = createManagedPluginRuntimeSnapshot({
      cwd: runRequest.cwd,
      runId,
      store,
      descriptors: listBundledPackageDescriptors(),
      now: createdAt,
    });
    appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id, "queued", "claimed", runId, createdAt);
    run = store.createRun({
      id: runId,
      cwd: runRequest.cwd,
      taskId: runRequest.task.id,
      channelId: preparedConcurrency.channel?.id ?? runRequest.task.channelId,
      teammateId: mcpToolAccess.teammateId ?? runRequest.teammateId,
      workflowStepId: runRequest.workflowStepId,
      selectedSkillId: selectedSkill?.skillId,
      providerPresetId: runRequest.providerPresetId,
      providerName: resolvedProvider.provider,
      providerModel: resolvedProvider.model,
      taskSnapshot: runRequest.task,
      providerSnapshot: { providerPresetId: runRequest.providerPresetId, ...resolvedProvider },
      requestSnapshot: {
        ...runRequest,
        permissionMode: effectivePolicySnapshot.mode,
        effectivePolicySnapshot,
        workspaceCwd,
        executionCwd: runRequest.cwd,
        channelWorkspaceBinding: channelWorkspaceSnapshot,
        threadId: thread.id,
        turnId: turn.id,
        provider: resolvedProvider,
        runnerResolution: toRunnerResolutionSnapshot(runnerResolution),
        runtimeSettings,
        runtimeToolFeatures,
        selectedSkillId: selectedSkill?.skillId,
        mcpToolAccess,
        managedPluginRuntime,
      },
      workUnitId: workUnit.id,
      threadId: thread.id,
      turnId: turn.id,
      turnRunRole: inferLingTurnRunRole(runRequest),
      parentRunId: runRequest.parentRunId,
      interventionId: runRequest.interventionId,
      continuationReason: runRequest.continuationReason,
      createdAt,
    });
    store.linkRunToWorkUnit(run.id, workUnit.id, createdAt);
    markLingThreadRunActive(store, thread.id, run.id, createdAt);
    storeRegistry.rememberRun(run.id, store);
    if (memoryRecall.memories.length > 0) {
      store.recordUsedMemoryEvent(
        {
          memoryIds: memoryRecall.memories.map((item) => item.memory.id),
          intent: "task-run",
          recallQuery: memoryRecall.request.query,
          teammateId: run.teammateId,
          channelId: run.channelId,
          taskId: run.taskId,
          runId: run.id,
          responseId: run.id,
          policyVersion: memoryRecall.policyVersion,
        },
        createdAt,
      );
    }
    store.appendEvent(run.id, "run_created", {
      taskId: run.taskId,
      workUnitId: workUnit.id,
      workspaceCwd,
      cwd: run.cwd,
      threadId: thread.id,
      workflowStepId: runRequest.workflowStepId,
      providerName: run.providerName,
      providerModel: run.providerModel,
      requestedRunnerId: runnerResolution.requestedRunnerId,
      effectiveRunnerId: runnerResolution.effectiveRunnerId,
      requestSource: runnerResolution.requestSource,
      fallbackAllowed: runnerResolution.fallbackAllowed,
      fallbackReason: runnerResolution.fallbackReason,
      teammateId: run.teammateId,
      selectedSkillId: run.selectedSkillId,
      parentRunId: run.parentRunId,
      interventionId: run.interventionId,
      continuationReason: run.continuationReason,
      mcpToolAccess: {
        serverCount: mcpToolAccess.servers.length,
        toolCount: mcpToolAccess.totalToolCount,
      },
      leases: preparedConcurrency.leases.map((lease) => ({
        id: lease.id,
        resourceType: lease.resourceType,
        resourceKey: lease.resourceKey,
        workUnitId: lease.workUnitId,
        attemptId: lease.attemptId,
      })),
    });
    appendRunCreatedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, run, createdAt);
  } catch (error) {
    if (error instanceof QueueableRunConflictError && store && workUnit && attempt && resolvedProvider) {
      const queuedAt = new Date().toISOString();
      releasePreparedRunResources(store, preparedConcurrency.leases, attempt.id, queuedAt, "queued-conflict");
      run = createQueuedRunForConflict({
        store,
        storeRegistry,
        runRequest,
        runId,
        workspaceCwd: workspaceCwd || runRequest.cwd,
        workUnit,
        attempt,
        channel: error.channel ?? preparedConcurrency.channel,
        provider: resolvedProvider,
        thread,
        turn,
        turnRunRole: inferLingTurnRunRole(runRequest),
        selectedSkillId: selectedSkill?.skillId,
        queuedAt,
        reason: error.code,
        message: error.message,
      });
      try {
        options.onRunReady?.(run.id);
      } catch {
        // The queued run is durable; auxiliary link updates must not corrupt SSE.
      }
      sink.writeReady({
        ok: true,
        runId: run.id,
        workUnitId: workUnit.id,
        queued: true,
        queueReason: error.code,
      });
      appendRunCreatedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd || run.cwd, run, queuedAt);
      sink.end();
      return run.id;
    }
    if (preparedConcurrency.leases.length > 0) {
      const now = new Date().toISOString();
      for (const lease of preparedConcurrency.leases) {
        store?.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, now);
      }
    }
    if (store && workUnit && !isTerminalWorkUnitStatus(store.getWorkUnit(workUnit.id)?.status ?? workUnit.status)) {
      const now = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const failed = store.transitionWorkUnitStatus({
        workUnitId: workUnit.id,
        expectedStatus: store.getWorkUnit(workUnit.id)?.status,
        event: "runner_failed",
        actor: "system",
        reason: message,
        now,
        endedAt: now,
        errorCode: error instanceof HttpError ? error.code : "run_prepare_failed",
        errorMessage: message,
      });
      if (failed.ok) {
        store.appendRuntimeEvent({
          workUnitId: workUnit.id,
          attemptId: attempt?.id,
          type: "work_unit_failed",
          actor: "system",
          ts: now,
          data: { message },
        });
      }
    }
    if (store && thread && !run) {
      store.updateLingThread(thread.id, { status: "failed", activeRunId: null }, new Date().toISOString());
    }
    if (error instanceof DuplicateRunRequestError) {
      try {
        options.onRunReady?.(error.runId);
      } catch {
        // The run itself is already known; auxiliary link updates must not corrupt SSE.
      }
      sink.writeReady({ ok: true, runId: error.runId, duplicate: true });
      sink.end();
      return error.runId;
    }
    const statusCode = error instanceof HttpError ? error.statusCode : error instanceof UnsupportedRunnerError ? 400 : 500;
    sink.writeError(statusCode, {
      error: error instanceof HttpError ? error.code : error instanceof UnsupportedRunnerError ? error.code : "run_storage_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  if (!store || !run || !workUnit || !attempt || !runtime || !runnerResolution || !thread) {
    sink.writeError(500, { error: "run_storage_unavailable", message: "Run was not initialized." });
    return undefined;
  }

  sink.writeReady({ ok: true, runId: run.id });
  try {
    options.onRunReady?.(run.id);
  } catch {
    // The run itself is already known; auxiliary link updates must not corrupt SSE.
  }

  const abortController = new AbortController();
  let runStartedAt: string | undefined;
  let persistedRunError = false;
  let persistenceError: unknown;
  let extractedArtifactCounter = 0;
  const toolStartArgsById = new Map<string, unknown>();
  let sinkClosed = sink.isClosed();
  sink.onClose(() => {
    sinkClosed = true;
  });

  const streamEnvelope = (envelope: RunEventEnvelope): void => {
    if (!sinkClosed) {
      sink.writeEvent(envelope.type, envelope);
    }
  };

  activeRuns.add(run.id, {
    abortController,
    streamEnvelope,
  });

  let lastRuntimeActivityAt = Date.now();
  const recordRuntimeHeartbeat = (source: "supervisor" | "runner" = "supervisor", detail?: unknown): void => {
    const ts = new Date().toISOString();
    try {
      store.recordRuntimeHeartbeat({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        runtimeInstanceId: runtime.runtimeInstanceId,
        ts,
        source,
        detail,
      });
    } catch {
      // Heartbeat persistence must not hide runner output; runtime diagnostics will show stale state if storage fails.
    }
  };
  const requestRuntimeAbort = (event: "idle_timeout" | "hard_timeout"): void => {
    const current = store.getWorkUnit(workUnit.id);
    if (!current || current.status === "cancelling" || isTerminalWorkUnitStatus(current.status) || current.status === "stale") {
      return;
    }
    const now = new Date().toISOString();
    const transition = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: current.status,
      event,
      actor: "system",
      reason: event,
      now,
      lastHeartbeatAt: now,
    });
    if (transition.ok) {
      store.updateWorkUnitAttemptStatus({
        attemptId: attempt.id,
        status: "cancelling",
        now,
        abortRequestedAt: now,
        errorCode: event,
        errorMessage: event,
      });
      store.appendRuntimeEvent({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        type: "work_unit_cancelling",
        actor: "system",
        ts: now,
        data: { reason: event },
      });
      abortController.abort();
    }
  };
  const heartbeatTimer = setInterval(() => {
    recordRuntimeHeartbeat("supervisor");
    const current = store.getWorkUnit(workUnit.id);
    if (!current || !isActiveWorkUnitStatus(current.status)) {
      return;
    }
    if (Date.now() - lastRuntimeActivityAt > current.timeoutPolicy.idleTimeoutMs) {
      requestRuntimeAbort("idle_timeout");
    }
  }, workUnit.timeoutPolicy.heartbeatIntervalMs);
  if (typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }
  const hardTimeoutTimer = setTimeout(() => {
    requestRuntimeAbort("hard_timeout");
  }, workUnit.timeoutPolicy.hardTimeoutMs);
  if (typeof hardTimeoutTimer.unref === "function") {
    hardTimeoutTimer.unref();
  }

  const appendAndMaybeStream = (type: RunEventType, data: unknown): RunEventEnvelope | undefined => {
    if (persistenceError) {
      return undefined;
    }
    if (abortController.signal.aborted && type !== "run_cancelled") {
      return undefined;
    }
    if (store.getRun(run.id)?.status === "cancelled" && type !== "run_cancelled") {
      return undefined;
    }

    try {
      const envelope = store.appendEvent(run.id, type, redactSecrets(data, resolvedSecretValues));
      lastRuntimeActivityAt = Date.now();
      if (type === "run_error") {
        persistedRunError = true;
      }
      syncWorkUnitForRunEvent(store, workUnit.id, attempt.id, type, envelope);
      appendRuntimeProgressForRunEvent(store, workUnit.id, attempt.id, type, envelope);
      syncLingThreadForRunEvent(store, run, type, envelope);
      streamEnvelope(envelope);
      return envelope;
    } catch (error) {
      persistenceError = error;
      return undefined;
    }
  };

  try {
    runStartedAt = new Date().toISOString();
    const runStartTransition = store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "queued",
      event: "runner_started",
      actor: "runner",
      now: runStartedAt,
      startedAt: runStartedAt,
    });
    if (!runStartTransition.ok) {
      throw new Error(`Run transition failed: ${runStartTransition.code}`);
    }
    const workUnitStartTransition = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: "claimed",
      event: "runner_started",
      actor: "runner",
      now: runStartedAt,
      startedAt: runStartedAt,
      lastHeartbeatAt: runStartedAt,
    });
    if (!workUnitStartTransition.ok) {
      throw new Error(`Work unit start failed: ${workUnitStartTransition.code}`);
    }
    store.updateWorkUnitAttemptStatus({
      attemptId: attempt.id,
      status: "started",
      now: runStartedAt,
      startedAt: runStartedAt,
      lastHeartbeatAt: runStartedAt,
    });
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      type: "work_unit_started",
      actor: "runner",
      ts: runStartedAt,
      data: { runId: run.id },
    });
    appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id, "claimed", "running", run.id, runStartedAt);
    recordRuntimeHeartbeat("runner", { event: "runner_started" });
    if (preparedConcurrency.taskExists) {
      const taskStartTransition = store.transitionTaskStatus({
        taskId: run.taskId,
        expectedStatus: "claimed",
        event: "start_run",
        actor: "runner",
        now: runStartedAt,
        currentRunId: run.id,
      });
      if (!taskStartTransition.ok) {
        throw new Error(`Task transition failed: ${taskStartTransition.code}`);
      }
    }
    if (!approvalPolicy) {
      throw new Error("Run approval policy was not initialized.");
    }
    const result = await runnerResolution.runner.adapter.runTask({
      ...runnerRequest,
      onApprovalRequired: createRunApprovalHandler({
        store,
        run,
        approvalPolicy,
        appendAndMaybeStream,
        streamEnvelope,
        signal: abortController.signal,
        extraSecrets: resolvedSecretValues,
        controlPlaneEvents: options.controlPlaneEvents,
        workspaceCwd,
        unifiedExecEnabled: runnerRequest.runtimeToolFeatures?.unifiedExec === true,
        shellSnapshotEnabled: runnerRequest.runtimeToolFeatures?.shellSnapshot === true,
      }),
      onPermissionRequired: createRunPermissionRequestHandler({
        store,
        run,
        approvalPolicy,
        appendAndMaybeStream,
        streamEnvelope,
        signal: abortController.signal,
        extraSecrets: resolvedSecretValues,
        controlPlaneEvents: options.controlPlaneEvents,
        workspaceCwd,
        currentTools: runtimeTools ?? [],
        runnerId: runnerResolution.effectiveRunnerId,
        supportedTools: runnerResolution.runner.supportedTools,
        runnerCapabilities: runnerResolution.runner.capabilities,
        mcpToolRefs: mcpTools.map((tool) => `${tool.serverId}:${tool.rawName}`),
      }),
      onEvent: (event: PiRunnerEvent) => {
        if (event.type === "tool_start") {
          toolStartArgsById.set(event.toolCallId, event.args);
        }
        const eventEnvelope = appendAndMaybeStream(event.type, event);
        if (eventEnvelope && event.type === "tool_end") {
          const sourceArgs = toolStartArgsById.get(event.toolCallId);
          try {
            const artifacts = persistExtractedArtifacts({
              store,
              run,
              event,
              sourceArgs,
              nextIndex: () => {
                extractedArtifactCounter += 1;
                return extractedArtifactCounter;
              },
              extraSecrets: resolvedSecretValues,
            });
            for (const artifact of artifacts) {
              appendAndMaybeStream("artifact_created", {
                artifact,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              });
              appendArtifactControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, artifact);
            }
          } catch {
            // Artifact extraction is best-effort evidence capture; runner output remains authoritative.
          }
        }
      },
      signal: abortController.signal,
    });

    if (persistenceError) {
      throw persistenceError;
    }
    if (store.getRun(run.id)?.status === "cancelled") {
      const staleEvent = auditIgnoredRunnerCompletion({
        store,
        run,
        workUnit,
        attempt,
        reportedStatus: "succeeded",
      });
      if (staleEvent) {
        streamEnvelope(staleEvent);
      }
      if (!sinkClosed) {
        sink.end();
      }
      return run.id;
    }

    const resultEnvelope = appendAndMaybeStream("result", {
      taskId: result.taskId,
      messageCount: result.messages.length,
      runnerEventCount: result.events.length,
    });
    if (!resultEnvelope && persistenceError) {
      throw persistenceError;
    }

    const endedAt = new Date().toISOString();
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
      runId: run.id,
      status: "succeeded",
      taskId: run.taskId,
      eventCount: resultEnvelope?.seq ?? store.countEvents(run.id),
      messageCount: result.messages.length,
      startedAt: runStartedAt,
      endedAt,
      errorMessage: null,
    });
    const successTransition = store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "running",
      event: "runner_succeeded",
      actor: "runner",
      now: endedAt,
      endedAt,
      summaryPath,
      errorMessage: null,
    });
    if (!successTransition.ok) {
      const staleEvent = auditIgnoredRunnerCompletion({
        store,
        run,
        workUnit,
        attempt,
        reportedStatus: "succeeded",
        now: endedAt,
      });
      if (staleEvent) {
        streamEnvelope(staleEvent);
      }
      if (!sinkClosed) {
        sink.end();
      }
      return run.id;
    }
    transitionWorkUnitTerminal(store, {
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      event: "runner_succeeded",
      attemptStatus: "succeeded",
      runtimeEventType: "work_unit_succeeded",
      actor: "runner",
      now: endedAt,
    });
    appendRunCompletedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, run, "running", "succeeded", endedAt);
    appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id, "running", "succeeded", run.id, endedAt);
    syncLingThreadForTerminalRun(store, run.id, endedAt);
    if (preparedConcurrency.taskExists) {
      store.transitionTaskStatus({
        taskId: run.taskId,
        expectedStatus: "running",
        event: "run_succeeded",
        actor: "runner",
        now: endedAt,
        currentRunId: run.id,
      });
    }

    if (!sinkClosed) {
      sink.end();
    }
  } catch (error) {
    if (isAbortError(error) || store.getRun(run.id)?.status === "cancelled") {
      const cancelledAt = new Date().toISOString();
      const observedStatus = store.getRun(run.id)?.status;
      const previousStatus = observedStatus && observedStatus !== "cancelled" ? observedStatus : "running";
      ensureRunCancelled({
        store,
        runId: run.id,
        taskId: run.taskId,
        startedAt: runStartedAt,
        reason: "cancelled",
        active: false,
        streamEnvelope,
      });
      transitionWorkUnitCancelled(store, workUnit.id, attempt.id, "cancelled");
      appendRunCancelledControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, run, previousStatus, cancelledAt);
      appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id, "cancelling", "cancelled", run.id, cancelledAt);
      syncLingThreadForTerminalRun(store, run.id, cancelledAt);
      if (!sinkClosed) {
        sink.end();
      }
      return run.id;
    }
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), resolvedSecretValues);
    const endedAt = new Date().toISOString();
    const failureEvent = persistedRunError
      ? undefined
      : appendFailureEvent(store, run.id, message, sinkClosed, sink);
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
      runId: run.id,
      status: "failed",
      taskId: run.taskId,
      eventCount: failureEvent?.seq ?? store.countEvents(run.id),
      startedAt: runStartedAt,
      endedAt,
      errorMessage: message,
    });
    const failureTransition = store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "running",
      event: "runner_failed",
      actor: "runner",
      reason: message,
      now: endedAt,
      endedAt,
      summaryPath,
      errorMessage: message,
    });
    if (!failureTransition.ok) {
      const staleEvent = auditIgnoredRunnerCompletion({
        store,
        run,
        workUnit,
        attempt,
        reportedStatus: "failed",
        now: endedAt,
      });
      if (staleEvent) {
        streamEnvelope(staleEvent);
      }
      if (!sinkClosed) {
        sink.end();
      }
      return run.id;
    }
    transitionWorkUnitTerminal(store, {
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      event: "runner_failed",
      attemptStatus: "failed",
      runtimeEventType: "work_unit_failed",
      actor: "runner",
      now: endedAt,
      errorCode: "runner_failed",
      errorMessage: message,
    });
    appendRunCompletedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, run, "running", "failed", endedAt, "runner_failed");
    appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id, "running", "failed", run.id, endedAt, "runner_failed");
    syncLingThreadForTerminalRun(store, run.id, endedAt);
    if (preparedConcurrency.taskExists) {
      store.transitionTaskStatus({
        taskId: run.taskId,
        expectedStatus: "running",
        event: "run_failed",
        actor: "runner",
        reason: message,
        now: endedAt,
        currentRunId: run.id,
      });
    }

    if (!sinkClosed) {
      sink.end();
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(hardTimeoutTimer);
    store.releaseResourceLeasesForOwner("run", run.id, new Date().toISOString());
    store.releaseRuntimeSemaphoreSlotsForOwner(attempt.id, new Date().toISOString(), "run-finished");
    activeRuns.delete(run.id);
    const terminalRun = store.getRun(run.id);
    if (terminalRun && isTerminalRunStatus(terminalRun.status)) {
      options.afterRunTerminal?.(terminalRun);
    }
  }
  return run.id;
}

function appendRunCreatedControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  run: RunSession,
  now: string,
): void {
  if (!hub) {
    return;
  }
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "runs",
    entityType: "run",
    entityId: run.id,
    action: "run.created",
    data: {
      status: run.status,
      taskId: run.taskId,
      channelId: run.channelId ?? null,
      teammateId: run.teammateId ?? null,
      providerPresetId: run.providerPresetId ?? null,
      requestedSkillId: run.selectedSkillId ?? null,
      workUnitId: run.workUnitId ?? null,
    },
  }, now);
}

function appendRunCompletedControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  run: RunSession,
  previousStatus: RunStatus,
  status: Extract<RunStatus, "succeeded" | "failed">,
  terminalAt: string,
  errorCode?: string,
): void {
  if (!hub) {
    return;
  }
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "runs",
    entityType: "run",
    entityId: run.id,
    action: "run.completed",
    data: {
      previousStatus,
      status,
      terminalAt,
      ...(errorCode ? { errorCode } : {}),
    },
  }, terminalAt);
}

function appendRunCancelledControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  run: RunSession,
  previousStatus: RunStatus,
  now: string,
): void {
  if (!hub) {
    return;
  }
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "runs",
    entityType: "run",
    entityId: run.id,
    action: "run.cancelled",
    data: {
      previousStatus,
      status: "cancelled",
      reasonCode: "cancelled",
    },
  }, now);
}

function appendWorkUnitCreatedControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  workUnit: WorkUnit,
  now: string,
): void {
  if (!hub) {
    return;
  }
  appendControlPlaneEvent(store, hub, {
    workspaceId: workUnit.workspaceId,
    cwd,
    domain: "work_units",
    entityType: "work_unit",
    entityId: workUnit.id,
    action: "work_unit.created",
    data: {
      status: workUnit.status,
      kind: workUnit.kind,
      ownerType: workUnit.ownerType,
      ownerId: workUnit.ownerId,
      taskId: workUnit.taskId ?? null,
      channelId: workUnit.channelId ?? null,
      providerPresetId: workUnit.providerPresetId ?? null,
      requestedRunnerId: workUnit.requestedRunnerId ?? null,
      effectiveRunnerId: workUnit.effectiveRunnerId ?? null,
      createdByActor: workUnit.createdByActor,
    },
  }, now);
}

function appendWorkUnitTransitionControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  workUnitId: string,
  previousStatus: WorkUnit["status"],
  status: WorkUnit["status"],
  runId: string | undefined,
  now: string,
  blockedReason?: string,
): void {
  if (!hub) {
    return;
  }
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "work_units",
    entityType: "work_unit",
    entityId: workUnitId,
    action: "work_unit.transitioned",
    data: {
      previousStatus,
      status,
      runId: runId ?? null,
      ...(blockedReason ? { blockedReason } : {}),
    },
  }, now);
}

function appendArtifactControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  artifact: RunArtifact,
): void {
  if (!hub) {
    return;
  }
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "artifacts",
    entityType: "artifact",
    entityId: artifact.id,
    action: "artifact.created",
    data: {
      runId: artifact.runId ?? null,
      mediaJobId: artifact.mediaJobId ?? null,
      externalWorkId: artifact.externalWorkId ?? null,
      type: artifact.type,
      contentType: artifact.contentType ?? null,
      sizeBytes: artifact.sizeBytes ?? null,
    },
  }, artifact.createdAt);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function validateWorkflowStepOwner(store: RunStore, runRequest: RunRequest): void {
  if (!runRequest.workflowStepId) {
    return;
  }
  const workflowStep = store.getChannelWorkflowStep(runRequest.workflowStepId);
  if (!workflowStep) {
    throw new HttpError(
      400,
      "workflow_step_not_found",
      `Channel workflow step not found: ${runRequest.workflowStepId}`,
    );
  }
  if (runRequest.task.channelId && workflowStep.channelId !== runRequest.task.channelId) {
    throw new HttpError(
      400,
      "workflow_step_channel_mismatch",
      `Run request channel does not match workflow step: ${runRequest.workflowStepId}`,
    );
  }
  if (workflowStep.taskId && workflowStep.taskId !== runRequest.task.id) {
    throw new HttpError(
      400,
      "workflow_step_task_mismatch",
      `Run request task does not match workflow step: ${runRequest.workflowStepId}`,
    );
  }
}

function toRunnerResolutionSnapshot(resolution: RunnerResolution): {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource: RunnerRequestSource;
  readonly fallbackAllowed: boolean;
  readonly fallbackReason?: RunnerResolution["fallbackReason"];
} {
  return {
    requestedRunnerId: resolution.requestedRunnerId,
    effectiveRunnerId: resolution.effectiveRunnerId,
    requestSource: resolution.requestSource,
    fallbackAllowed: resolution.fallbackAllowed,
    fallbackReason: resolution.fallbackReason,
  };
}

function getExplicitRunnerRequestSource(runRequest: RunRequest): RunnerRequestSource {
  if (runRequest.workflowStepId) {
    return "workflow_step";
  }
  return "run_request";
}

function assertFullAccessPermissionConfirmed(runRequest: RunRequest): void {
  if (runRequest.permissionMode !== "full_access") {
    return;
  }
  const confirmation = runRequest.permissionConfirmation;
  if (
    !confirmation ||
    confirmation.mode !== "full_access" ||
    confirmation.confirmed !== true ||
    !confirmation.reason.trim() ||
    Number.isNaN(Date.parse(confirmation.confirmedAt))
  ) {
    throw new HttpError(
      400,
      "full_access_confirmation_required",
      "Full access runs require explicit permission confirmation.",
    );
  }
}
