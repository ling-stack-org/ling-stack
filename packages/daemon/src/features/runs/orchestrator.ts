import type { ServerResponse } from "node:http";
import {
  type ApprovalPolicy,
  buildSkillSourceRuntimeFallbackPlan,
  createChannelWorkspaceSnapshot,
  createRunId,
  DEFAULT_WORKSPACE_ID,
  applyConversationModeToEffectiveRunPolicySnapshot,
  resolveSessionRunPolicy,
  getEffectiveTeammateSkill,
  getRunSummaryPath,
  redactSecrets,
  type EffectiveRunPolicySnapshot,
  type LingThread,
  type LingTurn,
  type RunEventEnvelope,
  type RunEventDataByType,
  type RunEventEmitter,
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
  type SkillSourceRuntimeContext,
  type WorkspaceRuntimeSettings,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitKind,
  toRuntimeAttemptFence,
  resolveSkillSourceRuntimeView,
} from "@ling-stack/core";
import type {
  PiRunnerEvent,
  PiRunnerMcpToolDefinition,
  PiRunnerProviderConfig,
  PiRunnerRunOptions,
  PiRunnerSandboxBinding,
} from "@ling-stack/runner-pi";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { hostCapabilityToolsV1, type HostCapabilityToolDefinitionV1 } from "@ling-stack/contracts";
import { createWorkflowOperationExecutionSnapshot } from "./workflow-operation-snapshot.js";
import { workflowOperationEffectRejection } from "./workflow-operation-effect-gate.js";
import type { McpBroker } from "../../context.js";
import { HttpError } from "../../errors.js";
import { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { UnsupportedRunnerError, type RunnerRegistry, type RunnerResolution } from "../../runtime/runners.js";
import { RunStoreRegistry } from "../../runtime/store-registry.js";
import { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { checkPlatformNativeSandboxBackend } from "../../runtime/sandbox/platform-native.js";
import { ensureStartupReadyForRun } from "../../startup/run-gate.js";
import { ensureWorkspaceStateWritableForRun } from "../../startup/workspace-state-gate.js";
import type { StartupStateRegistry } from "../../startup/state.js";
import {
  isActiveWorkUnitStatus,
  isTerminalWorkUnitStatus,
  transitionWorkUnitCancelled,
  transitionWorkUnitTerminal,
} from "../../runtime/work-units.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import { CuaDriverComputerUseProjectionProducer } from "../computer-use/cua-driver-producer.js";
import { resolveEligibleCuaDriverProjectionServerIds } from "../computer-use/provider-eligibility.js";
import type { ComputerUseProjectionRegistry } from "../computer-use/registry.js";
import { renderUsedMemoryPrompt } from "../memory/prompt.js";
import { resolveCurrentRunSkill } from "./skill-selection.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { listBundledPackageDescriptors } from "../plugins/source-index.js";
import { createManagedPluginRuntimeSnapshot } from "../plugins/runtime-injection.js";
import { isBundledEmbeddedCuaDriverSelected } from "../plugins/cua-driver-runtime-mode.js";
import { createCuaDriverDescriptor } from "../plugins/presets.js";
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
import { hydrateRunnerToolSurface } from "./tool-surfaces.js";
import { createQueuedRunForConflict } from "./queue.js";
import { resolveProviderForRun, resolveProviderRunThinkingLevel } from "./providers.js";
import type { RunRequest } from "./schemas.js";
import { appendFailureEvent, writeTerminalSummary } from "./terminal.js";
import {
  createConversationMediaGenerationToolDefinitions,
  createConversationMediaGenerationToolHandler,
  isConversationMediaGenerationEligible,
} from "../media/conversation-tool-handler.js";
import { appendExecutionActionInvalidation } from "./execution-action-invalidation.js";
import { listConversationMediaGenerationTargets } from "../media/conversation-targets.js";
import { auditIgnoredRunnerCompletion } from "./stale-completion.js";
import { hasCurrentRunCallbackIdentity } from "./run-callback-ownership.js";
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
import { prepareNormalConversationExecution, readNormalConversationPreparedExecution,
  restoreNormalConversationExecutionOptions, assertPreparedExecutionMemoryCurrent } from "../conversations/normal-conversation-prepared-execution.js";
import { capturePreparedRunnerInput } from "./prepared-runner-input.js";
import type { HostCapabilityBridgeController } from "./host-capability-bridge-controller.js";
import { createHostCapabilityAuthority } from "./host-capability-authority.js";
import { dispatchHostOpenLocalTarget } from "./host-open-local-target.js";
import { ExecutionLoopDetector } from "./execution-loop-detector.js";

export interface ExecuteRunRequestOptions {
  readonly onRunReady?: (runId: string) => void;
  readonly afterRunTerminal?: (run: RunSession) => void | Promise<void>;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly startupState?: StartupStateRegistry;
  readonly computerUsePreviews?: ComputerUseProjectionRegistry;
  readonly hostCapabilityBridge?: HostCapabilityBridgeController;
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

/** Pre-Run failures are terminal for this dispatch transport, not successful Runs. */
function writeRunPreparationFailure(sink: RunExecutionSink, statusCode: number, body: unknown): void {
  try { sink.writeError(statusCode, body); }
  finally { sink.end(); }
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
      if (closed || response.writableEnded) return;
      if (!response.headersSent) {
        writeJson(response, statusCode, body);
      } else {
        writeSse(response, "error", body);
      }
    },
    end() {
      if (!closed && !response.writableEnded) {
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

/** Track the whole request, including preflight before any durable Run exists. */
export function executeRunRequest(
  ...args: Parameters<typeof executeAdmittedRunRequest>
): Promise<string | undefined> {
  const [request, sink, , , activeRuns] = args;
  const completion = Promise.resolve().then(() => {
    if (request.continuationReason === "user_input_answer" || request.userInputContinuationContext !== undefined) {
      writeRunPreparationFailure(sink, 409, { error: "user_input_continuation_coordinator_required",
        message: "Saved answers must resume their existing WorkUnit through the continuation coordinator, not create a new task." });
      return undefined;
    }
    if (activeRuns.isShuttingDown()) {
      writeRunPreparationFailure(sink, 503, { error: "runtime_shutting_down", message: "Runtime is shutting down." });
      return undefined;
    }
    return executeAdmittedRunRequest(...args);
  });
  activeRuns.trackCompletion(completion);
  return completion;
}

async function executeAdmittedRunRequest(
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
  let sandboxBinding: PiRunnerSandboxBinding | undefined;
  let runtimeSettings: WorkspaceRuntimeSettings | undefined;
  let runtimeTools: readonly RunTool[] | undefined;
  let mcpTools: readonly PiRunnerMcpToolDefinition[] = [];
  let memoryRecall: ReturnType<RunStore["recallMemory"]> | undefined;
  let selectedSkill: ReturnType<typeof getEffectiveTeammateSkill> | undefined;
  let selectedSkillSourceContext: SkillSourceRuntimeContext | undefined;
  let selectedSkillSourcePrompt: string | undefined;
  let runtimeApprovalProfile: SkillApprovalProfile | undefined;
  let effectivePolicySnapshot: EffectiveRunPolicySnapshot | undefined;
  let approvalPolicy: ApprovalPolicy | undefined;
  let durableTaskSnapshot: RunRequest["task"] = runRequest.task;
  let durableRunRequest: RunRequest = { ...runRequest, preselectedMemoryUse: undefined, runnerExecutionInput: undefined };
  let runId = "";
  let createdAt = "";
  let workspaceCwd = "";
  let computerUseProducer: CuaDriverComputerUseProjectionProducer | undefined;
  try {
    workspaceCwd = runRequest.workspaceCwd ?? runRequest.cwd;
    await ensureWorkspaceStateWritableForRun(workspaceCwd);
    await ensureStartupReadyForRun({
      cwd: workspaceCwd,
      startupState: options.startupState,
      storeRegistry,
      runnerRegistry,
      secretResolver,
    });
    store = storeRegistry.getStore(workspaceCwd);
    let preparedExecution = readNormalConversationPreparedExecution(store, runRequest);
    assertFullAccessPermissionConfirmed(runRequest);
    validateWorkflowStepOwner(store, runRequest);
    runtime = runtimeSupervisor.getRuntime(workspaceCwd, store);
    resolvedProvider = resolveProviderForRun(store, runRequest, secretResolver, {
      providerWebSocketFallbackEnabled: runtimeSupervisor.getTransportFeatures().providerWebSocketFallback,
    });
    const skillTeammate = runRequest.teammateId ? resolveAiTeammateReference(store, runRequest.teammateId) : undefined;
    const skillProviderPreset = runRequest.providerPresetId ? store.getProviderPreset(runRequest.providerPresetId) : undefined;
    selectedSkill = resolveCurrentRunSkill(store, runRequest);
    if (preparedExecution) {
      selectedSkillSourceContext = preparedExecution.payload.skillSourceContext;
    } else if (selectedSkill) {
      const skillOptimizationMode = runRequest.skillOptimizationMode ?? "no_operation";
      const sourceSnapshot = store.getSkillSourceSnapshot(selectedSkill.skillId);
      const compiledView = sourceSnapshot && skillRuntimeCompiledViewRequested(skillOptimizationMode)
        ? store.listSkillCompiledRuntimeViews({
            skillId: selectedSkill.skillId,
            sourceSnapshotId: sourceSnapshot.id,
            reviewStatus: "active",
          })[0]
        : undefined;
      const sourcePrompt = resolveSkillSourceRuntimeView({
        skillId: selectedSkill.skillId,
        snapshot: sourceSnapshot,
        compiledView,
        optimizationMode: skillOptimizationMode,
      });
      selectedSkillSourceContext = sourcePrompt.context;
      selectedSkillSourcePrompt = sourcePrompt.promptFragment;
    }
    const runStore = store;
    let mcpToolAccess = resolveMcpToolAccessForRun(runStore, secretResolver, runRequest, (teammateId) =>
      resolveAiTeammateReference(runStore, teammateId)?.id);
    mcpTools = createPiRunnerMcpToolDefinitions(mcpToolAccess);
    memoryRecall = preparedExecution || runRequest.skipMemoryRecall ? undefined : store.recallMemory({
      teammateId: runRequest.teammateId,
      channelId: runRequest.task.channelId,
      taskId: runRequest.task.id,
      intent: "task-run",
      query: `${runRequest.task.title}\n${runRequest.task.prompt}`,
      maxResults: 6,
    });
    const memoryPrompt = memoryRecall ? renderUsedMemoryPrompt(memoryRecall.memories) : undefined;
    const appendSystemPrompt = preparedExecution ? preparedExecution.payload.input.appendSystemPrompt ?? [] : [
      ...(runRequest.appendSystemPrompt ?? []),
      ...(selectedSkill?.promptFragments ?? []),
      ...(selectedSkillSourcePrompt ? [selectedSkillSourcePrompt] : []),
      ...(memoryPrompt ? [memoryPrompt] : []),
    ];
    runtimeTools = preparedExecution ? preparedExecution.payload.input.tools : selectedSkill
      ? mergeRunTools(runRequest.tools ?? [], selectedSkill.requiredTools)
      : runRequest.tools;
    runtimeApprovalProfile = selectedSkill
      ? mergeApprovalProfiles(runRequest.approvalProfile, selectedSkill.skill.approvalProfile)
      : runRequest.approvalProfile;
    runtimeSettings = loadWorkspaceRuntimeSettings(store, runnerRegistry);
    const effectiveReasoningSummary = runRequest.reasoningSummary
      ?? store.getWorkspaceSettings().defaultReasoningSummary
      ?? "auto";
    const runnerRequestSource: RunnerRequestSource = runRequest.runnerId
      ? getExplicitRunnerRequestSource(runRequest)
      : skillTeammate?.runnerId ? "teammate_default" : "workspace_default";
    runnerResolution = runnerRegistry.resolve({
      requestedRunnerId: preparedExecution?.payload.runnerId ?? runRequest.runnerId ?? skillTeammate?.runnerId ?? runtimeSettings.defaultRunnerId,
      ...(preparedExecution ? { allowFallback: false } : {}),
      defaultRunnerId: runtimeSettings.defaultRunnerId,
      allowedRunnerIds: runtimeSettings.allowedRunnerIds,
      requestSource: runnerRequestSource,
      explicitFallbackPolicy: runtimeSettings.explicitRunnerFallback,
      implicitFallbackPolicy: runtimeSettings.implicitRunnerFallback,
      providerApi: resolvedProvider.api,
      tools: runtimeTools,
    });
    if (runRequest.workflowOperationExecution && !(runnerResolution.runner.adapter instanceof PiRunnerAdapter)) {
      throw new HttpError(409, "operation_binding_runner_gate_unavailable", "This runner has no verified universal typed tool-before gate.");
    }
    const channelForPolicy = runRequest.task.channelId ? store.getChannel(runRequest.task.channelId) : undefined;
    const channelWorkspaceSnapshot = channelForPolicy
      ? createChannelWorkspaceSnapshot(channelForPolicy, workspaceCwd)
      : undefined;
    const runtimeToolFeatures = {
      ...runRequest.runtimeToolFeatures,
      unifiedExec: runtimeSupervisor.getRuntimeToolFeatures().unifiedExec === true,
      shellSnapshot: runtimeSupervisor.getRuntimeToolFeatures().shellSnapshot === true,
    };
    const selectedHostCapabilityTools = selectHostCapabilityToolsForRun(runRequest);
    const assertHostCapabilitiesCurrent = (): void => {
      if (selectedHostCapabilityTools.some((tool) => options.hostCapabilityBridge?.hasCapability(tool.capabilityId) !== true)) {
        throw new HttpError(409, "host_capability_desktop_required", "The selected Host capability is not currently available from Ling Desktop.");
      }
    };
    assertHostCapabilitiesCurrent();
    runnerRequest = {
      cwd: runRequest.cwd,
      task: runRequest.task,
      provider: resolvedProvider,
      tools: runtimeTools,
      mcpTools,
      thinkingLevel: resolveProviderRunThinkingLevel(resolvedProvider, runRequest.thinkingLevel),
      reasoningSummary: effectiveReasoningSummary,
      systemPrompt: runRequest.systemPrompt,
      appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
      agentDir: runRequest.agentDir,
      runtimePaths: {
        piDir: store.paths.piDir,
        artifactsDir: store.paths.artifactsDir,
      },
      runtimeToolFeatures,
      hostCapabilityTools: selectedHostCapabilityTools,
    };
    resolvedSecretValues = [resolvedProvider.apiKey];
    runId = createRunId();
    createdAt = new Date().toISOString();
    const idempotencyKey = runRequest.idempotencyKey ?? `run:${runId}`;
    thread = ensureLingThreadForRun(store, runRequest, createdAt);
    turn = ensureLingTurnForRun(store, thread, runRequest, createdAt);
    durableTaskSnapshot = store.getTask(runRequest.task.id) ?? runRequest.task;
    durableRunRequest = {
      ...runRequest,
      task: durableTaskSnapshot,
      reasoningSummary: effectiveReasoningSummary,
      preselectedMemoryUse: undefined,
      runnerExecutionInput: undefined,
    };
    const workUnitOwner = resolveRunWorkUnitOwner(thread, runRequest, turn.id);
    // Definitions belong to initial model input; executable handlers require the real Run below.
    const mediaGenerationEligible = isConversationMediaGenerationEligible({
      createdByActor: runRequest.createdByActor, workUnitKind: workUnitOwner.kind,
    });
    const currentMediaTools = mediaGenerationEligible ? createConversationMediaGenerationToolDefinitions(
      listConversationMediaGenerationTargets(store, secretResolver)) : [];
    const toolHydrationEnabled = runnerResolution.runner.toolHydration?.mode === "daemon_hydrated" &&
      runnerResolution.runner.toolHydration.conformance === "verified";
    runnerRequest = { ...runnerRequest, mediaGenerationTools: currentMediaTools,
      initialToolSurface: { mediaGeneration: currentMediaTools.length > 0, toolHydration: toolHydrationEnabled } };
    let usedMemory = preparedExecution ? preparedExecution.payload.usedMemory : memoryRecall && memoryRecall.memories.length > 0
      ? { memoryIds: memoryRecall.memories.map((item) => item.memory.id), recallQuery: memoryRecall.request.query,
          policyVersion: memoryRecall.policyVersion } : runRequest.preselectedMemoryUse;
    const assertPreparationCurrent = (): void => {
      if (activeRuns.isShuttingDown()) throw new HttpError(503, "runtime_shutting_down", "Runtime is shutting down.");
      assertHostCapabilitiesCurrent();
    };
    preparedExecution = await prepareNormalConversationExecution({ store, request: runRequest,
      runnerId: runnerResolution.effectiveRunnerId, adapter: runnerResolution.runner.adapter, options: runnerRequest,
      usedMemory, skillSourceContext: selectedSkillSourceContext, assertCurrent: assertPreparationCurrent });
    let executionInput = preparedExecution?.payload;
    if (!executionInput && runnerResolution.runner.adapter instanceof PiRunnerAdapter) {
      // All Pi surfaces retain the actual SDK input, not an approximation rebuilt
      // from requestSnapshot after a question or restart. Normal first-writer input is reused.
      const preparedInput = await runnerResolution.runner.adapter.prepareTaskInput(runnerRequest);
      assertPreparationCurrent();
      executionInput = capturePreparedRunnerInput({ runnerId: runnerResolution.effectiveRunnerId,
        options: runnerRequest, preparedInput, usedMemory, skillSourceContext: selectedSkillSourceContext });
    }
    const refreshPreparedExecution = (): void => {
      if (!executionInput) return;
      // Recheck after awaiting SDK preparation. A snapshot never authorizes a revoked provider/tool.
      assertPreparedExecutionMemoryCurrent(runStore, runRequest, executionInput);
      resolvedProvider = resolveProviderForRun(runStore, runRequest, secretResolver, {
        providerWebSocketFallbackEnabled: runtimeSupervisor.getTransportFeatures().providerWebSocketFallback,
      });
      const currentAccess = resolveMcpToolAccessForRun(runStore, secretResolver, runRequest,
        (teammateId) => resolveAiTeammateReference(runStore, teammateId)?.id);
      const currentMcp = createPiRunnerMcpToolDefinitions(currentAccess);
      runnerResolution = runnerRegistry.resolve({ requestedRunnerId: executionInput.runnerId, allowFallback: false,
        allowedRunnerIds: loadWorkspaceRuntimeSettings(runStore, runnerRegistry).allowedRunnerIds, providerApi: resolvedProvider.api,
        tools: executionInput.input.tools, requestSource: runnerRequestSource });
      runnerRequest = restoreNormalConversationExecutionOptions(executionInput, { ...runnerRequest,
        initialToolSurface: { mediaGeneration: mediaGenerationEligible,
          toolHydration: runnerResolution.runner.toolHydration?.mode === "daemon_hydrated" && runnerResolution.runner.toolHydration.conformance === "verified" },
        provider: resolvedProvider, mcpTools: currentMcp, mediaGenerationTools: mediaGenerationEligible
          ? createConversationMediaGenerationToolDefinitions(listConversationMediaGenerationTargets(runStore, secretResolver)) : [] });
      runtimeTools = executionInput.input.tools;
      mcpTools = runnerRequest.mcpTools ?? [];
      const names = new Set(mcpTools.map((tool) => tool.registeredName));
      mcpToolAccess = { ...currentAccess, totalToolCount: mcpTools.length, servers: currentAccess.servers.map((server) => ({ ...server,
        tools: server.tools.filter((tool) => names.has(tool.registeredName)) })).filter((server) => server.tools.length > 0) };
      resolvedSecretValues = [resolvedProvider.apiKey, ...Object.values(resolvedProvider.headers ?? {})];
      selectedSkillSourceContext = executionInput.skillSourceContext;
      usedMemory = executionInput.usedMemory;
      durableRunRequest = { ...durableRunRequest, runnerExecutionInput: executionInput,
        ...(preparedExecution ? { normalConversationPreparedExecutionRef: preparedExecution.ref } : {}) };
      assertPreparationCurrent();
    };
    refreshPreparedExecution();
    const existingWorkUnit = runRequest.idempotencyKey
      ? store.findWorkUnitByIdempotency({
          kind: workUnitOwner.kind,
          ownerType: workUnitOwner.ownerType,
          ownerId: workUnitOwner.ownerId,
          idempotencyKey: runRequest.idempotencyKey,
        })
      : undefined;
    if (existingWorkUnit?.linkedRunId) {
      throw new DuplicateRunRequestError(existingWorkUnit.linkedRunId);
    }
    if (existingWorkUnit) {
      throw new HttpError(409, "duplicate_work_unit", `Duplicate work unit request: ${existingWorkUnit.id}`);
    }
    sandboxBinding = await maybePreparePlatformNativeSandboxBinding({
      runnerResolution,
      runtimeSupervisor,
      workspaceRoot: workspaceCwd,
      runId,
      now: createdAt,
    });
    assertPreparationCurrent();
    // SDK/backend setup both await. Policy must be read after them, not before.
    refreshPreparedExecution();
    selectedSkill = resolveCurrentRunSkill(store, runRequest);
    runtimeApprovalProfile = selectedSkill ? mergeApprovalProfiles(runRequest.approvalProfile, selectedSkill.skill.approvalProfile)
      : runRequest.approvalProfile;
    if (executionInput && selectedSkill) {
      const permitted = mergeRunTools(runRequest.tools ?? [], selectedSkill.requiredTools);
      if (runtimeTools?.some((tool) => !permitted.includes(tool))) throw new HttpError(409, "prepared_skill_tools_changed",
        "A prepared core tool is no longer supplied by the selected skill.");
    }
    const currentChannelForPolicy = runRequest.task.channelId ? store.getChannel(runRequest.task.channelId) : undefined;
    const sessionPolicy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
      authorizationMode: runRequest.authorizationMode, workspaceAccessMode: runRequest.workspaceAccessMode,
      permissionPreset: runRequest.permissionPreset, permissionMode: runRequest.permissionMode,
      channelBoundPath: currentChannelForPolicy?.boundPath || runRequest.cwd, approvalProfile: runtimeApprovalProfile });
    approvalPolicy = sessionPolicy.approvalPolicy;
    effectivePolicySnapshot = applyConversationModeToEffectiveRunPolicySnapshot(sessionPolicy.snapshot,
      store.getLingThread(thread.id)?.conversationMode.mode ?? thread.conversationMode.mode);
    workUnit = store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: workUnitOwner.kind,
      ownerType: workUnitOwner.ownerType,
      ownerId: workUnitOwner.ownerId,
      channelId: runRequest.task.channelId,
      taskId: runRequest.task.id,
      teammateId: runRequest.teammateId,
      providerPresetId: runRequest.providerPresetId,
      runnerId: runnerResolution.effectiveRunnerId,
      requestedRunnerId: runnerResolution.requestedRunnerId,
      effectiveRunnerId: runnerResolution.effectiveRunnerId,
      fallbackReason: runnerResolution.fallbackReason,
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
        provider: resolvedProvider,
        runnerResolution: toRunnerResolutionSnapshot(runnerResolution),
        runtimeSettings,
        runtimeToolFeatures,
        selectedSkillId: selectedSkill?.skillId,
        skillSourceContext: selectedSkillSourceContext,
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
      workUnit,
      attempt,
      now: createdAt,
    });
    acquireRunRuntimeSemaphores({
      store,
      workUnit,
      attempt,
      channel: preparedConcurrency.channel,
      channelParallelLimit: runRequest.channelParallelLimit,
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
      attempt,
      now: createdAt,
    });
    const claimTransition = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      now: createdAt,
      activeAttemptId: attempt.id,
    });
    if (!claimTransition.ok) {
      releasePreparedRunResources(store, attempt, createdAt, "work-unit-claim-failed");
      throw new Error(`Work unit claim failed: ${claimTransition.code}`);
    }
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      type: "work_unit_claimed",
      actor: "system",
      ts: createdAt,
      data: {
        runId,
      },
    });
    const managedPluginDescriptors = [
      ...listBundledPackageDescriptors(),
      ...(mcpBroker.cuaDriverRuntimeAuthority
        && isBundledEmbeddedCuaDriverSelected(
          mcpBroker.cuaDriverRuntimeAuthority,
          workspaceCwd,
        )
        ? [createCuaDriverDescriptor()]
        : []),
    ];
    const managedPluginRuntime = createManagedPluginRuntimeSnapshot({
      cwd: runRequest.cwd,
      runId,
      store,
      descriptors: managedPluginDescriptors,
      now: createdAt,
      cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
    });
    const eligibleComputerUseProviderServerIds = resolveEligibleCuaDriverProjectionServerIds({
      store,
      descriptors: managedPluginDescriptors,
      runtimeSnapshot: managedPluginRuntime,
      runId,
      cwd: runRequest.cwd,
      now: createdAt,
      authorizedServerIds: mcpTools.map((tool) => tool.serverId),
      cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
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
      taskSnapshot: durableTaskSnapshot,
      providerSnapshot: { providerPresetId: runRequest.providerPresetId, ...resolvedProvider },
      requestSnapshot: {
        ...durableRunRequest,
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
        skillSourceContext: selectedSkillSourceContext,
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
      contextViewId: runRequest.contextProjection?.contextViewId,
      contextViewCreatedAt: runRequest.contextProjection?.contextViewCreatedAt,
      createdAt,
    });
    store.linkRunToWorkUnit(run.id, workUnit.id, createdAt);
    markLingThreadRunActive(store, thread.id, run.id, createdAt);
    storeRegistry.rememberRun(run.id, store);
    computerUseProducer = options.computerUsePreviews && eligibleComputerUseProviderServerIds.length > 0
      ? new CuaDriverComputerUseProjectionProducer({
          registry: options.computerUsePreviews,
          cwd: workspaceCwd,
          runId: run.id,
          workUnitId: workUnit.id,
          conversationId: thread.id,
          turnId: turn.id,
          startedAt: createdAt,
          eligibleServerIds: eligibleComputerUseProviderServerIds,
        })
      : undefined;
    runnerRequest = {
      ...runnerRequest,
      onMcpToolCall: mcpTools.length > 0
        ? createMcpToolCallHandler(store, secretResolver, mcpBroker, mcpTools, {
            runId: run.id,
            onStart: computerUseProducer
              ? (input) => {
                  computerUseProducer?.markProviderCallStarted(input);
                }
              : undefined,
            onResult: computerUseProducer
              ? (input) => {
                  computerUseProducer?.observeToolResult(input);
                }
              : undefined,
          })
        : undefined,
    };
    if (mediaGenerationEligible) {
      const mediaGenerationTools = runnerRequest.mediaGenerationTools ?? [];
      if (mediaGenerationTools.length > 0) {
        runnerRequest = {
          ...runnerRequest,
          mediaGenerationTools,
          onMediaGenerationToolCall: createConversationMediaGenerationToolHandler({
            store,
            storeRegistry,
            secretResolver,
            runtimeSupervisor,
            run,
            linkedMessageId: runRequest.linkedMessageId,
            controlPlaneEvents: options.controlPlaneEvents,
          }),
        };
      }
    }
    if (usedMemory && usedMemory.memoryIds.length > 0) {
      store.recordUsedMemoryEvent(
        {
          memoryIds: usedMemory.memoryIds,
          intent: "task-run",
          recallQuery: usedMemory.recallQuery,
          teammateId: run.teammateId,
          channelId: run.channelId,
          taskId: run.taskId,
          runId: run.id,
          responseId: run.id,
          policyVersion: usedMemory.policyVersion,
        },
        createdAt,
      );
    }
    store.appendEvent(run.id, "run_created", {
      taskId: run.taskId,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      workspaceCwd,
      cwd: run.cwd,
      threadId: thread.id,
      workflowStepId: runRequest.workflowStepId,
      providerName: run.providerName,
      providerModel: run.providerModel,
      providerTransport: {
        api: resolvedProvider.api,
        configured: skillProviderPreset?.providerTransport ?? "default",
        effective: resolvedProvider.providerTransport ?? "default",
        providerWebSocketFallbackEnabled: runtimeSupervisor.getTransportFeatures().providerWebSocketFallback,
        websocketFailures: 0,
        sseFallbacks: 0,
      },
      requestedRunnerId: runnerResolution.requestedRunnerId,
      effectiveRunnerId: runnerResolution.effectiveRunnerId,
      requestSource: runnerResolution.requestSource,
      fallbackAllowed: runnerResolution.fallbackAllowed,
      fallbackReason: runnerResolution.fallbackReason,
      teammateId: run.teammateId,
      selectedSkillId: run.selectedSkillId,
      skillSourceContext: selectedSkillSourceContext,
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
      releasePreparedRunResources(store, attempt, queuedAt, "queued-conflict");
      run = createQueuedRunForConflict({
        store,
        storeRegistry,
        runRequest: durableRunRequest,
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
    if (preparedConcurrency.leases.length > 0 && store && attempt) {
      const now = new Date().toISOString();
      store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), now, "run-prepare-failed");
    }
    if (store && workUnit && !isTerminalWorkUnitStatus(store.getWorkUnit(workUnit.id)?.status ?? workUnit.status)) {
      const now = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const currentAttempt = attempt?.id ? store.getWorkUnitAttempt(attempt.id) : undefined;
      const errorCode = error instanceof HttpError ? error.code : "run_prepare_failed";
      if (currentAttempt) {
        transitionWorkUnitTerminal(store, {
          workUnitId: workUnit.id,
          attemptId: currentAttempt.id,
          event: "runner_failed",
          attemptStatus: "failed",
          runtimeEventType: "work_unit_failed",
          actor: "system",
          now,
          errorCode,
          errorMessage: message,
        });
      } else {
        const failed = store.transitionWorkUnitStatus({
          workUnitId: workUnit.id,
          expectedStatus: store.getWorkUnit(workUnit.id)?.status,
          event: "runner_failed",
          actor: "system",
          reason: message,
          now,
          endedAt: now,
          errorCode,
          errorMessage: message,
        });
        if (failed.ok) {
          store.appendRuntimeEvent({
            workUnitId: workUnit.id,
            type: "work_unit_failed",
            actor: "system",
            ts: now,
            data: { message },
          });
        }
      }
    }
    // A pre-Run loser has no authority over a Run already linked by another dispatch.
    if (store && thread && !run && !(error instanceof DuplicateRunRequestError) &&
      !store.getLingThread(thread.id)?.activeRunId && (!turn || store.listLingTurnRuns(turn.id).length === 0)) {
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
    writeRunPreparationFailure(sink, statusCode, {
      error: error instanceof HttpError ? error.code : error instanceof UnsupportedRunnerError ? error.code : "run_storage_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  if (!store || !run || !workUnit || !attempt || !runtime || !runnerResolution || !thread) {
    writeRunPreparationFailure(sink, 500, { error: "run_storage_unavailable", message: "Run was not initialized." });
    return undefined;
  }

  sink.writeReady({ ok: true, runId: run.id });
  try {
    options.onRunReady?.(run.id);
  } catch {
    // The run itself is already known; auxiliary link updates must not corrupt SSE.
  }

  const abortController = new AbortController();
  let resolveRunCompletion: (() => void) | undefined;
  const runCompletion = new Promise<void>((resolve) => {
    resolveRunCompletion = resolve;
  });
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
    completion: runCompletion,
    runtimeInstanceId: runtime.runtimeInstanceId,
    workUnitId: workUnit.id,
    attemptId: attempt.id,
  });

  let lastRuntimeActivityAt = Date.now();
  let taskContinuationWaitDepth = 0;
  let pauseHardTimeout = (): void => undefined;
  let resumeHardTimeout = (): void => undefined;
  let requestExpiredHardTimeout = (): boolean => false;
  const recordRuntimeHeartbeat = (source: "supervisor" | "runner" = "supervisor", detail?: unknown): void => {
    const ts = new Date().toISOString();
    try {
      store.recordRuntimeHeartbeat({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        ts,
        source,
        detail,
      });
    } catch {
      // Heartbeat persistence must not hide runner output; runtime diagnostics will show stale state if storage fails.
    }
  };
  const waitForTaskContinuation = async (
    boundary: "run_start" | "before_agent_start" | "before_provider_request" | "tool_call",
  ): Promise<void> => {
    if (!runtimeSupervisor.isLockedTaskContinuationBlocked()) return;
    recordRuntimeHeartbeat("supervisor", {
      event: "locked_task_continuation_waiting",
      boundary,
    });
    taskContinuationWaitDepth += 1;
    if (taskContinuationWaitDepth === 1) pauseHardTimeout();
    try {
      await runtimeSupervisor.waitForLockedTaskContinuation(abortController.signal);
    } finally {
      taskContinuationWaitDepth = Math.max(0, taskContinuationWaitDepth - 1);
      if (taskContinuationWaitDepth === 0) resumeHardTimeout();
    }
    lastRuntimeActivityAt = Date.now();
    recordRuntimeHeartbeat("supervisor", {
      event: "locked_task_continuation_resumed",
      boundary,
    });
  };
  const requestRuntimeAbort = (
    event: "idle_timeout" | "hard_timeout" | "execution_loop_detected",
    reason: string = event,
  ): void => {
    const current = store.getWorkUnit(workUnit.id);
    if (!current || current.status === "cancelling" || isTerminalWorkUnitStatus(current.status) || current.status === "stale") {
      return;
    }
    const now = new Date().toISOString();
    const transition = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      activeAttemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      expectedStatus: current.status,
      event,
      actor: "system",
      reason,
      now,
      lastHeartbeatAt: now,
    });
    if (transition.ok) {
      store.updateWorkUnitAttemptStatus({
        attemptId: attempt.id,
        workUnitId: attempt.workUnitId,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        status: "cancelling",
        now,
        abortRequestedAt: now,
        errorCode: event,
        errorMessage: reason,
      });
      store.appendRuntimeEvent({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        type: "work_unit_cancelling",
        actor: "system",
        ts: now,
        data: { reason, code: event },
      });
      activeRuns.requestStop(run.id, {
        kind: "runtime_failure",
        code: event,
        reason,
      });
    }
  };
  const heartbeatTimer = setInterval(() => {
    recordRuntimeHeartbeat("supervisor");
    const current = store.getWorkUnit(workUnit.id);
    if (!current || !isActiveWorkUnitStatus(current.status)) {
      return;
    }
    if (taskContinuationWaitDepth > 0) {
      lastRuntimeActivityAt = Date.now();
      return;
    }
    if (current.status === "waiting_for_approval") {
      // Approval is a durable user wait with its own expiry. It must not consume
      // the execution idle budget while the runner is blocked on the decision.
      lastRuntimeActivityAt = Date.now();
      return;
    }
    // Timer callbacks can be delayed together when the event loop is busy. If
    // both budgets have elapsed by the time the heartbeat runs, the earlier
    // hard deadline is authoritative; do not let this observer race it into an
    // idle_timeout terminal state merely because its callback ran first.
    if (requestExpiredHardTimeout()) return;
    if (Date.now() - lastRuntimeActivityAt > current.timeoutPolicy.idleTimeoutMs) {
      requestRuntimeAbort("idle_timeout");
    }
  }, workUnit.timeoutPolicy.heartbeatIntervalMs);
  if (typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }
  let hardTimeoutRemainingMs = workUnit.timeoutPolicy.hardTimeoutMs;
  let hardTimeoutActiveSince = performance.now();
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimeoutPauseDepth = 0;
  let approvalHardTimeoutPaused = false;
  let runtimeStarted = false;
  const clearHardTimeout = (): void => {
    if (!hardTimeoutTimer) return;
    clearTimeout(hardTimeoutTimer);
    hardTimeoutTimer = undefined;
  };
  const accountHardTimeout = (now = performance.now()): void => {
    hardTimeoutRemainingMs -= Math.max(0, now - hardTimeoutActiveSince);
    hardTimeoutActiveSince = now;
  };
  const scheduleHardTimeout = (): void => {
    if (hardTimeoutTimer || !runtimeStarted || hardTimeoutPauseDepth > 0 || abortController.signal.aborted) return;
    const delay = Math.max(1, hardTimeoutRemainingMs);
    hardTimeoutTimer = setTimeout(() => {
      hardTimeoutTimer = undefined;
      if (store.getWorkUnit(workUnit.id)?.status === "waiting_for_approval") {
        pauseHardTimeout();
        return;
      }
      accountHardTimeout();
      if (hardTimeoutRemainingMs <= 0) {
        requestRuntimeAbort("hard_timeout");
        return;
      }
      scheduleHardTimeout();
    }, delay);
    if (typeof hardTimeoutTimer.unref === "function") hardTimeoutTimer.unref();
  };
  pauseHardTimeout = (): void => {
    hardTimeoutPauseDepth += 1;
    if (hardTimeoutPauseDepth > 1) return;
    accountHardTimeout();
    clearHardTimeout();
    if (hardTimeoutRemainingMs <= 0) requestRuntimeAbort("hard_timeout");
  };
  resumeHardTimeout = (): void => {
    if (hardTimeoutPauseDepth === 0) return;
    hardTimeoutPauseDepth -= 1;
    if (hardTimeoutPauseDepth > 0) return;
    hardTimeoutActiveSince = performance.now();
    if (!runtimeStarted) return;
    if (hardTimeoutRemainingMs <= 0) {
      requestRuntimeAbort("hard_timeout");
      return;
    }
    scheduleHardTimeout();
  };
  const beginApprovalHardTimeoutPause = (): void => {
    if (approvalHardTimeoutPaused) return;
    approvalHardTimeoutPaused = true;
    pauseHardTimeout();
  };
  const endApprovalHardTimeoutPause = (): void => {
    if (!approvalHardTimeoutPaused) return;
    approvalHardTimeoutPaused = false;
    resumeHardTimeout();
  };
  requestExpiredHardTimeout = (): boolean => {
    if (!runtimeStarted || hardTimeoutPauseDepth > 0 || abortController.signal.aborted) return false;
    const activeElapsedMs = Math.max(0, performance.now() - hardTimeoutActiveSince);
    if (activeElapsedMs < hardTimeoutRemainingMs) return false;
    requestRuntimeAbort("hard_timeout");
    return true;
  };
  const runnerCallbackFence = Object.freeze(toRuntimeAttemptFence(attempt));
  const loopDetector = new ExecutionLoopDetector(attempt.id);
  let loopStopRequested = false;
  const appendRunEvent = <K extends RunEventType>(
    type: K,
    data: RunEventDataByType[K],
    observeLoop: boolean,
  ): RunEventEnvelope | undefined => {
    if (persistenceError) {
      return undefined;
    }
    if (abortController.signal.aborted && type !== "run_cancelled") {
      return undefined;
    }
    const persistedRun = store.getRun(run.id);
    if (
      persistedRun &&
      isTerminalRunStatus(persistedRun.status) &&
      !(persistedRun.status === "cancelled" && type === "run_cancelled")
    ) {
      return undefined;
    }

    try {
      const attributedData = type === "assistant_reasoning_summary"
        ? { ...data, attemptId: runnerCallbackFence.attemptId } as RunEventDataByType[K]
        : data;
      const envelope = store.appendExecutionEvent(
        run.id,
        runnerCallbackFence,
        type,
        redactSecrets(attributedData, resolvedSecretValues) as RunEventDataByType[K],
      );
      lastRuntimeActivityAt = Date.now();
      if (type === "approval_requested") {
        // The approval handler starts this pause before persistence. Keep the
        // event-side update idempotent for paths that append the event first.
        beginApprovalHardTimeoutPause();
      } else if (type === "approval_approved") {
        endApprovalHardTimeoutPause();
      }
      if (type === "run_error") {
        persistedRunError = true;
      }
      syncWorkUnitForRunEvent(store, workUnit.id, attempt.id, type, envelope);
      appendRuntimeProgressForRunEvent(store, workUnit.id, attempt.id, type, envelope);
      syncLingThreadForRunEvent(store, run, type, envelope);
      try {
        appendExecutionActionInvalidation({
          store,
          hub: options.controlPlaneEvents,
          cwd: workspaceCwd,
          event: envelope,
        });
      } catch {
        // Projection invalidation is rebuildable and cannot invalidate the
        // authoritative Run event that was already committed above.
      }
      try {
        computerUseProducer?.observeRunEvent(envelope);
      } catch {
        // Computer Use projection is a derived surface and cannot block the authoritative run event.
      }
      streamEnvelope(envelope);
      if (observeLoop && !loopStopRequested) {
        const finding = loopDetector.observe(envelope);
        if (finding) {
          loopStopRequested = true;
          const loopEnvelope = appendRunEvent("loop_detected", finding.event, false);
          if (loopEnvelope) {
            requestRuntimeAbort("execution_loop_detected", finding.event.message);
          } else {
            activeRuns.requestStop(run.id, {
              kind: "runtime_failure",
              code: "runner_crash",
              reason: "execution_loop_detection_persistence_failed",
            });
          }
        }
      }
      return envelope;
    } catch (error) {
      persistenceError = error;
      return undefined;
    }
  };
  const appendAndMaybeStream: RunEventEmitter = <K extends RunEventType>(
    type: K,
    data: RunEventDataByType[K],
  ): RunEventEnvelope | undefined => appendRunEvent(type, data, true);

  try {
    runStartedAt = new Date().toISOString();
    const runStartTransition = store.transitionRunExecutionStatus({
      runId: run.id,
      sourceFence: runnerCallbackFence,
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
      attemptId: attempt.id,
      activeAttemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
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
      workUnitId: attempt.workUnitId,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      status: "started",
      now: runStartedAt,
      startedAt: runStartedAt,
      lastHeartbeatAt: runStartedAt,
    });
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      type: "work_unit_started",
      actor: "runner",
      ts: runStartedAt,
      data: { runId: run.id },
    });
    appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id, "claimed", "running", run.id, runStartedAt);
    recordRuntimeHeartbeat("runner", { event: "runner_started" });
    runtimeStarted = true;
    hardTimeoutActiveSince = performance.now();
    clearHardTimeout();
    scheduleHardTimeout();
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
    // Complete Host start bookkeeping so shutdown has a legal fenced failure
    // transition, then reject before any Runner or approval tool is invoked.
    await waitForTaskContinuation("run_start");
    abortController.signal.throwIfAborted();
    const runApprovalHandler = createRunApprovalHandler({
      restrictedCommandRuntime: runtimeSupervisor.getRestrictedCommandRuntime(),
      store,
      run,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      sourceFence: runnerCallbackFence,
      delegatedRequirementFingerprint: runRequest.delegatedRequirement?.fingerprint,
      executionOperationBindings: runRequest.executionOperationBindings,
      approvalPolicy,
      approvalProfile: runtimeApprovalProfile,
      effectivePolicySnapshot,
      appendAndMaybeStream,
      streamEnvelope,
      signal: abortController.signal,
      extraSecrets: resolvedSecretValues,
      controlPlaneEvents: options.controlPlaneEvents,
      workspaceCwd,
      unifiedExecEnabled: runnerRequest.runtimeToolFeatures?.unifiedExec === true,
      shellSnapshotEnabled: runnerRequest.runtimeToolFeatures?.shellSnapshot === true,
      onApprovalWaitStarted: beginApprovalHardTimeoutPause,
      onApprovalResolved: (approval) => {
        // The decision may already have a durable Run event (for example when
        // the HTTP approval route won the race). Always release the matching
        // in-memory wait exactly once, independent of event append ownership.
        endApprovalHardTimeoutPause();
      },
      onExistingApprovalDecisionEvent: (envelope) => {
        syncWorkUnitForRunEvent(store, workUnit.id, attempt.id, envelope.type, envelope);
        appendRuntimeProgressForRunEvent(store, workUnit.id, attempt.id, envelope.type, envelope);
        syncLingThreadForRunEvent(store, run, envelope.type, envelope);
      },
    });
    const hostCapabilityAuthority = runnerRequest.hostCapabilityTools?.length
      ? createHostCapabilityAuthority({
          store,
          run,
          workUnitId: workUnit.id,
          attemptId: attempt.id,
          sourceFence: runnerCallbackFence,
          signal: abortController.signal,
        })
      : undefined;
    const result = await runnerResolution.runner.adapter.runTask({
      ...runnerRequest,
      runId: run.id,
      runnerAttemptId: attempt.id,
      sandbox: sandboxBinding,
      onToolBefore: (request) => {
        const rejection = workflowOperationEffectRejection({ store, run, request,
          restrictedCommandRuntime: runtimeSupervisor.getRestrictedCommandRuntime() });
        if (rejection) return { allowed: false, code: rejection.code, reason: rejection.reason };
        if (runnerRequest.hostCapabilityTools?.some((tool) => tool.name === request.toolName)) {
          const hostRejection = hostCapabilityAuthority?.check({ ...request, task: runnerRequest.task });
          if (hostRejection) return { allowed: false, code: hostRejection.code, reason: hostRejection.reason };
        }
        return { allowed: true };
      },
      onApprovalRequired: async (request) => {
        const definition = mcpTools.find((tool) => tool.registeredName === request.toolName);
        if (definition) {
          mcpBroker.cuaDriverRuntimeAuthority?.assertLockedApprovalAllowed?.({
            serverId: definition.serverId,
            runId: run.id,
            computerUseSessionId: `computer_use_${run.id}`,
            toolId: definition.rawName,
            toolCallId: request.toolCallId,
            defaultApproval: request.defaultApproval ?? definition.defaultApproval,
          });
          try {
            computerUseProducer?.beginProviderIntent({ request, definition });
          } catch {
            // Projection setup is best-effort; approval policy and persistence remain authoritative.
          }
        }
        if (!runApprovalHandler) {
          return { approved: false, reason: "Run approval handler is unavailable." };
        }
        return runApprovalHandler(request);
      },
      onPermissionRequired: createRunPermissionRequestHandler({
        store,
        run,
        approvalPolicy,
        effectivePolicySnapshot,
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
      onTaskContinuationBoundary: (boundary) => waitForTaskContinuation(boundary),
      onHostCapabilityCall: hostCapabilityAuthority && options.hostCapabilityBridge
        ? (request) => dispatchHostOpenLocalTarget({
            bridge: options.hostCapabilityBridge!,
            authority: hostCapabilityAuthority,
            run,
            request,
          })
        : undefined,
      onToolHydrationRequest: runnerRequest.initialToolSurface?.toolHydration !== false && runnerResolution.runner.toolHydration?.mode === "daemon_hydrated" &&
        runnerResolution.runner.toolHydration.conformance === "verified"
        ? (request) => hydrateRunnerToolSurface({
            store,
            runnerRegistry,
            run,
            sourceFence: runnerCallbackFence,
            request,
          })
        : undefined,
      onEvent: (event: PiRunnerEvent) => {
        if (event.type === "tool_start") {
          toolStartArgsById.set(event.toolCallId, event.args);
        }
        const eventEnvelope = appendAndMaybeStream(
          event.type,
          { ...event } as RunEventDataByType[typeof event.type],
        );
        if (eventEnvelope && event.type === "tool_end" && store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence, true)) {
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

    const completionStopIntent = activeRuns.getStopIntent(run.id)
      ?? readActiveRunStopIntent(abortController.signal.reason);
    const completionRun = store.getRun(run.id);
    if (
      abortController.signal.aborted
      && completionRun?.status !== "cancelled"
      && !isCancellationStopIntent(completionStopIntent)
    ) {
      abortController.signal.throwIfAborted();
    }

    if (persistenceError) {
      throw persistenceError;
    }
    const terminalFailure = findRunnerTerminalFailure(result.events);
    if (terminalFailure) {
      throw new Error(terminalFailure);
    }
    if (!store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence)) {
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
    const summaryPath = getRunSummaryPath(store.paths, run.id);
    const successTransition = store.transitionRunExecutionStatus({
      runId: run.id,
      sourceFence: runnerCallbackFence,
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
    writeTerminalSummary(summaryPath, {
      runId: run.id, status: "succeeded", taskId: run.taskId,
      eventCount: resultEnvelope?.seq ?? store.countEvents(run.id), messageCount: result.messages.length,
      startedAt: runStartedAt, endedAt, errorMessage: null,
    });
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
    const stopIntent = activeRuns.getStopIntent(run.id) ?? readActiveRunStopIntent(abortController.signal.reason);
    const observedRun = store.getRun(run.id);
    if (!store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence, true)) {
      const staleEvent = auditIgnoredRunnerCompletion({
        store,
        run,
        workUnit,
        attempt,
        reportedStatus: observedRun?.status === "cancelled" || isCancellationStopIntent(stopIntent)
          ? "cancelled"
          : "failed",
      });
      if (staleEvent) streamEnvelope(staleEvent);
      if (!sinkClosed) sink.end();
      return run.id;
    }
    if (observedRun?.status === "cancelled" || isCancellationStopIntent(stopIntent)) {
      const cancelledAt = new Date().toISOString();
      const observedStatus = observedRun?.status;
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
      const staleEvent = auditIgnoredRunnerCompletion({
        store,
        run,
        workUnit,
        attempt,
        reportedStatus: "cancelled",
        reason: "run_cancelled",
        now: cancelledAt,
      });
      if (staleEvent) {
        streamEnvelope(staleEvent);
      }
      appendRunCancelledControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, run, previousStatus, cancelledAt);
      appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id, "cancelling", "cancelled", run.id, cancelledAt);
      syncLingThreadForTerminalRun(store, run.id, cancelledAt);
      if (!sinkClosed) {
        sink.end();
      }
      return run.id;
    }
    if (stopIntent?.kind === "runtime_suspend") {
      const suspendedAt = new Date().toISOString();
      const recoverableApproval = store.listApprovalRequests({ runId: run.id, status: "pending", limit: 1 })[0]
        ?? store.listApprovalRequests({ runId: run.id, status: "approved", limit: 1 })[0];
      const checkpoint = recoverableApproval ? store.getApprovalCheckpointForApproval(recoverableApproval.id) : undefined;
      const observedWorkUnit = store.getWorkUnit(workUnit.id);
      if (observedRun?.status === "waiting_for_approval"
        && observedWorkUnit?.status === "waiting_for_approval"
        && recoverableApproval
        && checkpoint
        && (checkpoint.status === "pending" || checkpoint.status === "approved")
        && checkpoint.status === recoverableApproval.status) {
        const suspension = store.commitApprovalResumeSuspension({
          kind: "approval_wait",
          checkpointId: checkpoint.id,
          expectedCheckpointStatus: checkpoint.status,
          expectedCheckpointRevision: checkpoint.revision,
          approvalId: recoverableApproval.id,
          runId: run.id,
          expectedRunStatus: "waiting_for_approval",
          workUnitId: observedWorkUnit.id,
          expectedWorkUnitStatus: "waiting_for_approval",
          attemptId: attempt.id,
          cause: stopIntent.cause,
          now: suspendedAt,
        });
        if (suspension.ok) {
          for (const event of suspension.controlPlaneEvents) options.controlPlaneEvents?.publish(event);
          if (!sinkClosed) {
            sink.end();
          }
          return run.id;
        }
      }
    }
    const runtimeFailure = stopIntent?.kind === "runtime_failure"
      ? stopIntent
      : stopIntent?.kind === "runtime_suspend"
        ? {
            kind: "runtime_failure" as const,
            code: "runner_crash" as const,
            reason: "runtime_interrupted_no_checkpoint",
          }
        : undefined;
    const message = redactTextWithSecrets(
      runtimeFailure?.reason ?? (error instanceof Error ? error.message : String(error)),
      resolvedSecretValues,
    );
    const endedAt = new Date().toISOString();
    const skillContextFallback = buildSkillSourceRuntimeFallbackPlan(selectedSkillSourceContext, message);
    const failureEvent = persistedRunError
      ? undefined
      : appendFailureEvent(
          store,
          run.id,
          runnerCallbackFence,
          message,
          sinkClosed,
          sink,
          skillContextFallback ? { skillContextFallback } : undefined,
        );
    const summaryPath = getRunSummaryPath(store.paths, run.id);
    const currentRun = store.getRun(run.id);
    const failureTransition = store.transitionRunExecutionStatus({
      runId: run.id,
      sourceFence: runnerCallbackFence,
      expectedStatus: currentRun?.status ?? "running",
      event: "runner_failed",
      actor: runtimeFailure ? "system" : "runner",
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
    writeTerminalSummary(summaryPath, {
      runId: run.id, status: "failed", taskId: run.taskId,
      eventCount: failureEvent?.seq ?? store.countEvents(run.id),
      startedAt: runStartedAt, endedAt, errorMessage: message,
    });
    const currentWorkUnit = store.getWorkUnit(workUnit.id);
    transitionWorkUnitTerminal(store, {
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      event: "runner_failed",
      attemptStatus: "failed",
      runtimeEventType: "work_unit_failed",
      actor: runtimeFailure ? "system" : "runner",
      now: endedAt,
      errorCode: runtimeFailure?.code ?? "runner_failed",
      errorMessage: message,
    });
    appendRunCompletedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, run, currentRun?.status ?? "running", "failed", endedAt, runtimeFailure?.code ?? "runner_failed");
    appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id, currentWorkUnit?.status ?? "running", "failed", run.id, endedAt, runtimeFailure?.code ?? "runner_failed");
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
    clearHardTimeout();
    const releaseAt = new Date().toISOString();
    store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), releaseAt, "run-finished");
    store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), releaseAt, "run-finished");
    if (activeRuns.get(run.id)?.attemptId === attempt.id) activeRuns.delete(run.id);
    try {
      const terminalRun = store.getRun(run.id);
      if (terminalRun && isTerminalRunStatus(terminalRun.status) && hasCurrentRunCallbackIdentity(store, run, runnerCallbackFence)) {
        try {
          computerUseProducer?.finish(terminalRun.status, terminalRun.errorMessage ?? undefined);
        } catch {
          // Computer Use projection finalization is best-effort and must not block run cleanup.
        }
        await options.afterRunTerminal?.(terminalRun);
      }
    } finally {
      resolveRunCompletion?.();
    }
  }
  return run.id;
}

function selectHostCapabilityToolsForRun(
  request: RunRequest,
): readonly HostCapabilityToolDefinitionV1[] {
  const execution = request.workflowOperationExecution;
  if (!execution) return [];
  const ownedIds = new Set(execution.ownedOperationIds);
  const needsOpen = execution.plan.operations.some((operation) =>
    ownedIds.has(operation.id) && operation.kind === "open_local_target");
  return needsOpen
    ? hostCapabilityToolsV1.filter((tool) => tool.capabilityId === "host.open_local_target")
    : [];
}

function skillRuntimeCompiledViewRequested(mode: string): boolean {
  return mode === "auto_safe" || mode === "auto_runtime_experimental";
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

function readActiveRunStopIntent(value: unknown): import("../../runtime/active-runs.js").ActiveRunStopIntentV1 | undefined {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    return undefined;
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  return kind === "user_cancel" || kind === "workflow_cancel" || kind === "runtime_suspend" || kind === "runtime_failure"
    ? value as import("../../runtime/active-runs.js").ActiveRunStopIntentV1
    : undefined;
}

function isCancellationStopIntent(
  value: import("../../runtime/active-runs.js").ActiveRunStopIntentV1 | undefined,
): value is Extract<import("../../runtime/active-runs.js").ActiveRunStopIntentV1, { readonly kind: "user_cancel" | "workflow_cancel" }> {
  return value?.kind === "user_cancel" || value?.kind === "workflow_cancel";
}

function isTerminalRunStatus(status: RunStatus): status is Extract<RunStatus, "succeeded" | "failed" | "cancelled"> {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function findRunnerTerminalFailure(events: readonly PiRunnerEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "run_error") {
      return event.message;
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "message_end" && event.role === "assistant") {
      if (event.errorMessage) {
        return event.errorMessage;
      }
      if (event.stopReason?.toLowerCase() === "error") {
        return "Provider message ended with an error.";
      }
      return undefined;
    }
  }
  return undefined;
}

function validateWorkflowStepOwner(store: RunStore, runRequest: RunRequest): void {
  if (!runRequest.workflowStepId) {
    if (runRequest.workflowOperationExecution !== undefined) {
      throw new HttpError(409, "operation_binding_snapshot_invalid", "Typed execution requires a workflow step owner.");
    }
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
  const expected = createWorkflowOperationExecutionSnapshot(workflowStep);
  if (expected || runRequest.workflowOperationExecution !== undefined) {
    if (!expected || JSON.stringify(expected) !== JSON.stringify(runRequest.workflowOperationExecution)
      || runRequest.teammateId !== expected.participantId
      || runRequest.delegatedRequirement?.fingerprint !== workflowStep.metadata?.delegatedRequirement?.fingerprint) {
      throw new HttpError(409, "operation_binding_snapshot_invalid", "Run dispatch must preserve the complete accepted typed plan, owner IDs and delegated requirement.");
    }
  }
}

async function maybePreparePlatformNativeSandboxBinding(input: {
  readonly runnerResolution: RunnerResolution;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly now: string;
}): Promise<PiRunnerSandboxBinding | undefined> {
  if (!input.runnerResolution.runner.capabilities?.includes("runtime:platform-native-sandbox")) {
    return undefined;
  }
  const check = await checkPlatformNativeSandboxBackend({
    workspaceRoot: input.workspaceRoot,
    config: input.runtimeSupervisor.getSandboxFeatures().platformNative,
    env: {
      LING_STACK_RUN_ID: input.runId,
    },
    now: input.now,
  });
  if (!check.ok) {
    throw new HttpError(
      409,
      "sandbox_not_ready",
      `Platform-native sandbox is not ready: ${check.readiness.blockingReasons.map((blocker) => blocker.code).join(", ")}`,
    );
  }
  return {
    profile: {
      id: check.profile.id,
      backendKind: check.profile.backendKind,
      displayName: check.profile.displayName,
    },
    manifest: {
      profileId: check.manifest.profileId,
      workspaceRoot: check.manifest.workspaceRoot,
      artifactImportRoots: check.manifest.artifactImportRoots,
    },
    sessionRef: {
      profileId: check.sessionRef.profileId,
      backendKind: check.sessionRef.backendKind,
      opaqueSessionId: check.sessionRef.opaqueSessionId,
    },
    readiness: check.readiness,
  };
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

function resolveRunWorkUnitOwner(
  thread: LingThread,
  runRequest: RunRequest,
  turnId: string,
): {
  readonly kind: WorkUnitKind;
  readonly ownerType: string;
  readonly ownerId: string;
} {
  if (thread.kind === "conversation") {
    return {
      kind: "conversation_run",
      ownerType: "conversation_turn",
      ownerId: turnId,
    };
  }
  if (thread.kind === "teammate_direct") {
    return {
      kind: "teammate_direct_reply",
      ownerType: "teammate_direct_message",
      ownerId: runRequest.sourceMessageId ?? runRequest.task.id,
    };
  }
  if (thread.kind === "channel_discussion") {
    return {
      kind: "channel_ai_reply",
      ownerType: "channel_message",
      ownerId: runRequest.sourceMessageId ?? runRequest.task.id,
    };
  }
  return {
    kind: "task_run",
    ownerType: "task",
    ownerId: runRequest.task.id,
  };
}

function assertFullAccessPermissionConfirmed(runRequest: RunRequest): void {
  const fullAccessRequested = runRequest.workspaceAccessMode !== undefined
    ? runRequest.workspaceAccessMode === "full_access"
    : runRequest.permissionMode === "full_access" || runRequest.permissionPreset === "full_access";
  if (!fullAccessRequested) {
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
