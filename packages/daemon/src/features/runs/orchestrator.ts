import type { ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
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
  type RunProgressCheckpointWitness,
  type CommitUserInputYieldResult,
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
  PiRunnerApprovedToolContinuation,
  PiRunnerEvent,
  PiRunnerMcpToolDefinition,
  PiRunnerProviderConfig,
  PiRunnerRunOptions,
  PiRunnerSandboxBinding,
  PiRunnerUserInputYieldDirective,
} from "@ling-stack/runner-pi";
import type { RunCompactionCheckpointBlockerCode } from "@ling-stack/contracts";
import { PiRunnerAdapter, PiRunnerYielded } from "@ling-stack/runner-pi";
import {
  hostCapabilityToolsV1,
  type HostCapabilityToolDefinitionV1,
  type RunnerContinuationOrigin,
} from "@ling-stack/contracts";
import { createWorkflowOperationExecutionSnapshot } from "./workflow-operation-snapshot.js";
import { workflowOperationEffectRejection } from "./workflow-operation-effect-gate.js";
import type { McpBroker } from "../../context.js";
import { HttpError } from "../../errors.js";
import { appendConversationResponseStyle } from "../../shared/conversation-response-style.js";
import { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { AttemptLocalWriterGroup } from "../../runtime/attempt-local-writers.js";
import { scopeUserInputLocalWriters } from "./user-input-local-writer-scope.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { DEFAULT_RUNNER_ID, UnsupportedRunnerError, type RunnerRegistry, type RunnerResolution } from "../../runtime/runners.js";
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
import { runtimeObservationScopeForProvider } from "../providers/runtime-observation-scope.js";
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
import { reviewPendingApprovalAutomatically } from "./approval-auto-review-host.js";
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
import {
  assertPreparedRunnerMemoryCurrent,
  capturePreparedRunnerInput,
} from "./prepared-runner-input.js";
import {
  rebuildExistingRunRequest,
  readStoredEffectivePolicySnapshot,
  readStoredRunnerExecution,
} from "./existing-run-request.js";
import type { HostCapabilityBridgeController } from "./host-capability-bridge-controller.js";
import { createHostCapabilityAuthority } from "./host-capability-authority.js";
import { dispatchHostOpenLocalTarget } from "./host-open-local-target.js";
import { ExecutionLoopDetector } from "./execution-loop-detector.js";
import {
  claimPreparedRunnerContinuation,
  createHarnessFeatureSnapshot,
  deferPreparedRunnerContinuation,
  executeRunnerContinuationReconstruction,
  finishPreparedRunnerContinuation,
  materializeExistingRunContinuation,
  prepareExistingRunContinuationPlan,
  prepareNewRunContinuation,
  resolveHarnessContinuationOrigin,
  resolveRunnerContinuationContext,
  startPreparedRunnerContinuation,
  type PreparedRunnerContinuationExecution,
  type RunnerContinuationContextIdentity,
} from "../harness/index.js";
import { isRecord } from "../../shared/validation.js";
import { prepareApprovedToolContinuation } from "./approval-continuation-tool.js";
import { assessRunCompactionRecovery } from "../harness/continuations/run-compaction-recovery.js";
import { commitInstalledRunCompaction } from "../harness/continuations/run-compaction-commit.js";
import { commitRunCompactionProgress } from "../harness/continuations/run-compaction-progress.js";
import { assessRunOrdinaryProgressRecovery, OrdinaryRunProgressController } from "../harness/continuations/run-ordinary-progress.js";
import { projectPublicRunEventEnvelope } from "./public-artifacts.js";
import { AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import { UserInputPauseCoordinator } from "./user-input-pause-coordinator.js";
import { providerForRunPersistence } from "./provider-persistence.js";
import {
  createProviderInvocationObserver,
  type ProviderInvocationFailureSink,
} from "../providers/runtime-invocations.js";
import { recordProviderInvocationFailureObservations } from "../providers/runtime-failure-observations.js";
import type { ProviderInvocationOrigin } from "../providers/runtime-invocations.js";

interface ExistingRunContinuationExecutionOptions {
  readonly runId: string;
  readonly origin: RunnerContinuationOrigin;
  readonly idempotencyDiscriminator: string;
  readonly preparedExecution?: PreparedRunnerContinuationExecution;
}

export interface ExecuteRunRequestOptions {
  /** Private diagnostic facts only; never selected from public Run request input. */
  readonly onProviderInvocationFailure?: ProviderInvocationFailureSink;
  readonly providerInvocationOrigin?: ProviderInvocationOrigin;
  readonly onRunReady?: (runId: string) => void;
  readonly afterRunTerminal?: (run: RunSession) => void | Promise<void>;
  /** Runs after a durable user-input yield, never for ordinary terminal completion. */
  readonly afterRunYielded?: (run: RunSession, wait: CommitUserInputYieldResult["wait"]) => void | Promise<void>;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly startupState?: StartupStateRegistry;
  readonly computerUsePreviews?: ComputerUseProjectionRegistry;
  readonly hostCapabilityBridge?: HostCapabilityBridgeController;
  /** Internal Host validation only until all executor and answer-recovery gates are complete. Never read from public Run input. */
  readonly enableUserInputPause?: boolean;
  /** Trusted daemon-only path. Public Run requests never select an existing Run. */
  readonly existingRunContinuation?: ExistingRunContinuationExecutionOptions;
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

export function executeExistingRunContinuation(
  input: {
    readonly cwd: string;
    readonly runId: string;
    readonly origin: ExistingRunContinuationExecutionOptions["origin"];
    readonly idempotencyDiscriminator: string;
    readonly preparedExecution?: PreparedRunnerContinuationExecution;
  },
  sink: RunExecutionSink,
  runnerRegistry: RunnerRegistry,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  options: ExecuteRunRequestOptions = {},
): Promise<string | undefined> {
  const store = storeRegistry.findStoreForRun(input.runId, input.cwd) ?? storeRegistry.getStore(input.cwd);
  const run = store.getRun(input.runId);
  if (!run) {
    writeRunPreparationFailure(sink, 404, { error: "run_not_found", message: `Run not found: ${input.runId}` });
    return Promise.resolve(undefined);
  }
  let request: RunRequest;
  try {
    request = rebuildExistingRunRequest(run, input.origin);
  } catch (error) {
    writeRunPreparationFailure(sink, 409, {
      error: "continuation_source_incomplete",
      message: error instanceof Error ? error.message : String(error),
    });
    return Promise.resolve(undefined);
  }
  const completion = Promise.resolve().then(() => executeAdmittedRunRequest(
    request,
    sink,
    runnerRegistry,
    storeRegistry,
    activeRuns,
    runtimeSupervisor,
    secretResolver,
    mcpBroker,
    {
      ...options,
      existingRunContinuation: {
        runId: input.runId,
        origin: input.origin,
        idempotencyDiscriminator: input.idempotencyDiscriminator,
        preparedExecution: input.preparedExecution,
      },
    },
  ));
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
  let continuationExecution: PreparedRunnerContinuationExecution | undefined;
  let continuationContext: RunnerContinuationContextIdentity | undefined;
  let sourceAttempt: WorkUnitAttempt | undefined;
  let compactionRecoveryModelView: readonly unknown[] | undefined;
  let ordinaryProgressRecoveryModelView: readonly unknown[] | undefined;
  let ordinaryProgressRecoveryWitness: RunProgressCheckpointWitness | undefined;
  const existingContinuation = options.existingRunContinuation;
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
    if (existingContinuation) {
      run = store.getRun(existingContinuation.runId);
      workUnit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
      thread = run?.threadId ? store.getLingThread(run.threadId) : undefined;
      turn = run ? store.getLingTurnForRun(run.id) : undefined;
      const activeAttempt = workUnit?.activeAttemptId ? store.getWorkUnitAttempt(workUnit.activeAttemptId) : undefined;
      sourceAttempt = existingContinuation.preparedExecution
        ? store.getWorkUnitAttempt(existingContinuation.preparedExecution.continuation.sourceAttemptId)
        : activeAttempt;
      if (!run || !workUnit || !thread || !turn || !sourceAttempt
        || run.id !== existingContinuation.runId
        || run.workUnitId !== workUnit.id
        || workUnit.linkedRunId !== run.id
        || (existingContinuation.preparedExecution
          ? !activeAttempt
            || activeAttempt.id !== existingContinuation.preparedExecution.attempt.id
            || existingContinuation.preparedExecution.continuation.runId !== run.id
            || existingContinuation.preparedExecution.continuation.workUnitId !== workUnit.id
          : workUnit.activeAttemptId !== sourceAttempt.id)) {
        throw new HttpError(409, "continuation_source_incomplete", "Existing Run continuation lineage is incomplete.");
      }
    }
    let preparedExecution = existingContinuation ? undefined : readNormalConversationPreparedExecution(store, runRequest);
    const existingRunnerExecution = existingContinuation && run ? readStoredRunnerExecution(run) : undefined;
    if (existingContinuation && !existingRunnerExecution) {
      throw new HttpError(409, "continuation_source_incomplete", "Existing Run has no valid frozen Runner execution input.");
    }
    const frozenExecution = preparedExecution?.payload ?? existingRunnerExecution;
    assertFullAccessPermissionConfirmed(runRequest);
    validateWorkflowStepOwner(store, runRequest);
    runtime = runtimeSupervisor.getRuntime(workspaceCwd, store);
    resolvedProvider = resolveProviderForRun(store, runRequest, secretResolver, {
      providerWebSocketFallbackEnabled: runtimeSupervisor.getTransportFeatures().providerWebSocketFallback,
    });
    const skillTeammate = runRequest.teammateId ? resolveAiTeammateReference(store, runRequest.teammateId) : undefined;
    const skillProviderPreset = runRequest.providerPresetId ? store.getProviderPreset(runRequest.providerPresetId) : undefined;
    selectedSkill = resolveCurrentRunSkill(store, runRequest);
    if (frozenExecution) {
      selectedSkillSourceContext = frozenExecution.skillSourceContext;
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
    memoryRecall = frozenExecution || runRequest.skipMemoryRecall ? undefined : store.recallMemory({
      teammateId: runRequest.teammateId,
      channelId: runRequest.task.channelId,
      taskId: runRequest.task.id,
      intent: "task-run",
      query: `${runRequest.task.title}\n${runRequest.task.prompt}`,
      maxResults: 6,
    });
    const memoryPrompt = memoryRecall ? renderUsedMemoryPrompt(memoryRecall.memories) : undefined;
    const appendSystemPrompt = frozenExecution ? frozenExecution.input.appendSystemPrompt ?? [] : appendConversationResponseStyle([
      ...(runRequest.appendSystemPrompt ?? []),
      ...(selectedSkill?.promptFragments ?? []),
      ...(selectedSkillSourcePrompt ? [selectedSkillSourcePrompt] : []),
      ...(memoryPrompt ? [memoryPrompt] : []),
    ]);
    runtimeTools = frozenExecution ? frozenExecution.input.tools : selectedSkill
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
      requestedRunnerId: frozenExecution?.runnerId ?? runRequest.runnerId ?? skillTeammate?.runnerId ?? runtimeSettings.defaultRunnerId,
      ...(frozenExecution ? { allowFallback: false } : {}),
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
    runId = existingContinuation?.runId ?? createRunId();
    createdAt = new Date().toISOString();
    const idempotencyKey = runRequest.idempotencyKey ?? `run:${runId}`;
    if (!existingContinuation) {
      thread = ensureLingThreadForRun(store, runRequest, createdAt);
      turn = ensureLingTurnForRun(store, thread, runRequest, createdAt);
    }
    if (!thread || !turn) {
      throw new HttpError(409, "continuation_source_incomplete", "Run thread or turn lineage is incomplete.");
    }
    durableTaskSnapshot = run?.taskSnapshot as RunRequest["task"] | undefined
      ?? store.getTask(runRequest.task.id)
      ?? runRequest.task;
    const harnessFeatureSnapshot = runRequest.harnessFeatureSnapshot ?? createHarnessFeatureSnapshot({
      harness: runtimeSupervisor.getHarnessFeatures(),
    });
    const harnessContinuationOrigin = resolveHarnessContinuationOrigin(runRequest);
    durableRunRequest = {
      ...runRequest,
      task: durableTaskSnapshot,
      reasoningSummary: effectiveReasoningSummary,
      preselectedMemoryUse: undefined,
      runnerExecutionInput: undefined,
      harnessFeatureSnapshot,
      harnessContinuationOrigin,
    };
    const workUnitOwner = existingContinuation && workUnit
      ? { kind: workUnit.kind, ownerType: workUnit.ownerType, ownerId: workUnit.ownerId }
      : resolveRunWorkUnitOwner(thread, runRequest, turn.id);
    // Definitions belong to initial model input; executable handlers require the real Run below.
    const mediaGenerationEligible = isConversationMediaGenerationEligible({
      createdByActor: runRequest.createdByActor, workUnitKind: workUnitOwner.kind,
    });
    const currentMediaTools = mediaGenerationEligible ? createConversationMediaGenerationToolDefinitions(
      listConversationMediaGenerationTargets(store, secretResolver)) : [];
    const toolHydrationEnabled = runnerResolution.runner.toolHydration?.mode === "daemon_hydrated" &&
      runnerResolution.runner.toolHydration.conformance === "verified";
    runnerRequest = { ...runnerRequest, mediaGenerationTools: currentMediaTools,
      initialToolSurface: { mediaGeneration: currentMediaTools.length > 0, toolHydration: toolHydrationEnabled,
        userInput: options.enableUserInputPause === true && Boolean(turn.sourceItemId) } };
    let usedMemory = frozenExecution?.usedMemory ?? (memoryRecall && memoryRecall.memories.length > 0
      ? { memoryIds: memoryRecall.memories.map((item) => item.memory.id), recallQuery: memoryRecall.request.query,
          policyVersion: memoryRecall.policyVersion } : runRequest.preselectedMemoryUse);
    const assertPreparationCurrent = (): void => {
      if (activeRuns.isShuttingDown()) throw new HttpError(503, "runtime_shutting_down", "Runtime is shutting down.");
      assertHostCapabilitiesCurrent();
    };
    if (!existingContinuation) {
      preparedExecution = await prepareNormalConversationExecution({ store, request: runRequest,
        runnerId: runnerResolution.effectiveRunnerId, adapter: runnerResolution.runner.adapter, options: runnerRequest,
        usedMemory, skillSourceContext: selectedSkillSourceContext, assertCurrent: assertPreparationCurrent });
    }
    let executionInput = existingRunnerExecution ?? preparedExecution?.payload;
    if (!existingContinuation && !executionInput && runnerResolution.runner.adapter instanceof PiRunnerAdapter) {
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
      if (existingContinuation) {
        assertPreparedRunnerMemoryCurrent(runStore, runRequest, executionInput);
      } else {
        assertPreparedExecutionMemoryCurrent(runStore, runRequest, executionInput);
      }
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
          toolHydration: runnerResolution.runner.toolHydration?.mode === "daemon_hydrated" && runnerResolution.runner.toolHydration.conformance === "verified",
          userInput: options.enableUserInputPause === true && Boolean(turn?.sourceItemId) },
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
    const existingWorkUnit = !existingContinuation && runRequest.idempotencyKey
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
    if (existingContinuation) {
      let needsOrdinaryRecovery = false;
      if (existingContinuation.origin === "daemon_recovery" && run && sourceAttempt) {
        const compaction = assessRunCompactionRecovery({ store, run, sourceAttempt, policySnapshot: effectivePolicySnapshot });
        if (compaction.kind !== "not_compacted") {
          if (compaction.kind === "blocked") {
            throw new HttpError(409, compaction.code,
              `Daemon recovery is blocked at the Run compaction boundary (${compaction.code}).`);
          }
          if (!(runnerResolution.runner.adapter instanceof PiRunnerAdapter)) {
            throw new HttpError(409, "checkpoint.reconstruction_unavailable",
              "The selected Runner cannot reconstruct the committed Pi compaction view.");
          }
          compactionRecoveryModelView = compaction.modelView;
        } else {
          needsOrdinaryRecovery = true;
        }
      }
      const frozenPolicy = readStoredEffectivePolicySnapshot(run?.requestSnapshot);
      if (!frozenPolicy || !isDeepStrictEqual(effectivePolicySnapshot, frozenPolicy)) {
        throw new HttpError(409, "continuation_policy_changed",
          "The stored Run policy no longer matches current workspace and conversation policy.");
      }
      // Preserve the existing policy-drift contract before the new ordinary
      // checkpoint reader, still before any replacement Attempt or provider I/O.
      if (needsOrdinaryRecovery && run && sourceAttempt) {
        const prepared = existingContinuation.preparedExecution;
        const progress = assessRunOrdinaryProgressRecovery({ store, run,
          sourceFence: toRuntimeAttemptFence(sourceAttempt), policySnapshot: effectivePolicySnapshot,
          ...(prepared ? { continuationBinding: { continuationId: prepared.continuation.id,
            targetFence: toRuntimeAttemptFence(prepared.attempt) } } : {}) });
        if (progress.kind === "blocked") {
          throw new HttpError(409, progress.code,
            `Daemon recovery is blocked at the ordinary Run progress boundary (${progress.code}).`);
        }
        if (progress.kind === "verified") {
          if (!(runnerResolution.runner.adapter instanceof PiRunnerAdapter)) {
            throw new HttpError(409, "checkpoint.reconstruction_unavailable",
              "The selected Runner cannot reconstruct the committed ordinary Pi view.");
          }
          ordinaryProgressRecoveryModelView = progress.modelView;
          ordinaryProgressRecoveryWitness = progress.witness;
        }
      }
    } else {
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
    }
    if (!store || !resolvedProvider || !effectivePolicySnapshot || !thread || !turn || !runnerResolution || !workUnit) {
      throw new Error("Run persistence dependencies were not initialized.");
    }
    const persistenceStore = store;
    const persistenceProvider = providerForRunPersistence(resolvedProvider);
    const persistencePolicySnapshot = effectivePolicySnapshot;
    const persistenceThread = thread;
    const persistenceTurn = turn;
    const persistenceRunnerResolution = runnerResolution;
    const persistenceWorkUnit = workUnit;
    const continuationEnforced = durableRunRequest.harnessFeatureSnapshot?.continuations === "enforce"
      && durableRunRequest.harnessContinuationOrigin !== undefined;
    let managedPluginRuntime: ReturnType<typeof createManagedPluginRuntimeSnapshot> | undefined;
    let eligibleComputerUseProviderServerIds: readonly string[] = [];
    const prepareManagedRuntime = (): void => {
      if (managedPluginRuntime) return;
      const managedPluginDescriptors = [
        ...listBundledPackageDescriptors(),
        ...(mcpBroker.cuaDriverRuntimeAuthority
          && isBundledEmbeddedCuaDriverSelected(mcpBroker.cuaDriverRuntimeAuthority, workspaceCwd)
          ? [createCuaDriverDescriptor()]
          : []),
      ];
      managedPluginRuntime = createManagedPluginRuntimeSnapshot({
        cwd: runRequest.cwd,
        runId,
        store: persistenceStore,
        descriptors: managedPluginDescriptors,
        now: createdAt,
        cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
      });
      eligibleComputerUseProviderServerIds = resolveEligibleCuaDriverProjectionServerIds({
        store: persistenceStore,
        descriptors: managedPluginDescriptors,
        runtimeSnapshot: managedPluginRuntime,
        runId,
        cwd: runRequest.cwd,
        now: createdAt,
        authorizedServerIds: mcpTools.map((tool) => tool.serverId),
        cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
      });
    };
    const persistRun = (context?: RunnerContinuationContextIdentity): RunSession => {
      prepareManagedRuntime();
      const persisted = persistenceStore.createRun({
        id: runId,
        cwd: runRequest.cwd,
        taskId: runRequest.task.id,
        channelId: preparedConcurrency.channel?.id ?? runRequest.task.channelId,
        teammateId: mcpToolAccess.teammateId ?? runRequest.teammateId,
        workflowStepId: runRequest.workflowStepId,
        selectedSkillId: selectedSkill?.skillId,
        providerPresetId: runRequest.providerPresetId,
        providerName: persistenceProvider.provider,
        providerModel: persistenceProvider.model,
        taskSnapshot: durableTaskSnapshot,
        providerSnapshot: { providerPresetId: runRequest.providerPresetId, ...persistenceProvider },
        requestSnapshot: {
          ...durableRunRequest,
          permissionMode: persistencePolicySnapshot.mode,
          effectivePolicySnapshot: persistencePolicySnapshot,
          workspaceCwd,
          executionCwd: runRequest.cwd,
          channelWorkspaceBinding: channelWorkspaceSnapshot,
          threadId: persistenceThread.id,
          turnId: persistenceTurn.id,
          provider: persistenceProvider,
          runnerResolution: toRunnerResolutionSnapshot(persistenceRunnerResolution),
          runtimeSettings,
          runtimeToolFeatures,
          selectedSkillId: selectedSkill?.skillId,
          skillSourceContext: selectedSkillSourceContext,
          mcpToolAccess,
          managedPluginRuntime,
        },
        workUnitId: persistenceWorkUnit.id,
        threadId: persistenceThread.id,
        turnId: persistenceTurn.id,
        turnRunRole: inferLingTurnRunRole(runRequest),
        parentRunId: runRequest.parentRunId,
        interventionId: runRequest.interventionId,
        continuationReason: runRequest.continuationReason,
        contextViewId: context?.contextViewId ?? runRequest.contextProjection?.contextViewId,
        contextViewCreatedAt: context?.contextViewCreatedAt ?? runRequest.contextProjection?.contextViewCreatedAt,
        createdAt,
      });
      persistenceStore.linkRunToWorkUnit(persisted.id, persistenceWorkUnit.id, createdAt);
      markLingThreadRunActive(persistenceStore, persistenceThread.id, persisted.id, createdAt);
      storeRegistry.rememberRun(persisted.id, persistenceStore);
      return persisted;
    };
    if (existingContinuation) {
      if (!executionInput || !sourceAttempt || !run || !workUnit) {
        throw new HttpError(409, "continuation_source_incomplete", "Existing Run continuation evidence is incomplete.");
      }
      if (existingContinuation.preparedExecution) {
        continuationExecution = existingContinuation.preparedExecution;
        attempt = continuationExecution.attempt;
      } else {
        if (!isExistingRunRepreparationOrigin(existingContinuation.origin)) {
          throw new HttpError(409, "continuation_source_incomplete",
            `Continuation origin ${existingContinuation.origin} requires its persisted prepared execution.`);
        }
        const existingTaskStatus = store.getTask(run.taskId)?.status;
        let expectedTaskStatus: "failed" | "claimed" | "running" | undefined;
        if (existingContinuation.origin === "runner_retry") {
          if (existingTaskStatus !== "failed") {
            throw new HttpError(409, "continuation_source_incomplete", "Existing Run task is not recoverable.");
          }
          expectedTaskStatus = "failed";
        } else if (existingTaskStatus === "claimed" || existingTaskStatus === "running") {
          expectedTaskStatus = existingTaskStatus;
        } else if (existingTaskStatus === undefined && existingContinuation.origin === "daemon_recovery"
          && workUnit.kind !== "task_run") {
          // Conversation and private replies carry a frozen Task snapshot, not a Task row.
          expectedTaskStatus = undefined;
        } else {
          throw new HttpError(409, "continuation_source_incomplete", "Existing Run task is not recoverable.");
        }
        const plan = prepareExistingRunContinuationPlan({
          store,
          run,
          workUnit,
          sourceAttempt,
          runtime,
          runner: runnerResolution.runner,
          origin: existingContinuation.origin,
          policySnapshot: effectivePolicySnapshot,
          execution: executionInput,
          workspaceCwd,
          now: createdAt,
          idempotencyDiscriminator: existingContinuation.idempotencyDiscriminator,
        });
        const activation = store.commitExistingRunContinuation({
          preparation: plan.preparation,
          ...(ordinaryProgressRecoveryWitness
            ? { recoveryProgressCheckpointGuard: ordinaryProgressRecoveryWitness } : {}),
          expectedRunStatus: existingContinuation.origin === "runner_retry"
            ? "failed"
            : run.status === "queued" ? "queued" : "running",
          expectedWorkUnitStatus: existingContinuation.origin === "runner_retry" ? "failed" : "stale",
          expectedTaskStatus,
          actor: existingContinuation.origin === "runner_retry" ? "local-user" : "system",
          reason: existingContinuation.origin === "runner_retry" ? "manual_retry" : "daemon_recovery",
          now: createdAt,
        });
        if (!activation.ok) {
          throw new HttpError(409, activation.code, `Existing Run continuation activation failed: ${activation.code}`);
        }
        run = activation.run;
        workUnit = activation.workUnit;
        continuationExecution = materializeExistingRunContinuation(plan, {
          continuation: activation.continuation,
          attempt: activation.attempt,
          replayed: activation.replayed,
        });
        attempt = activation.attempt;
      }
    } else if (continuationEnforced) {
      const sourceRun = runRequest.parentRunId ? store.getRun(runRequest.parentRunId) : undefined;
      const sourceWorkUnit = sourceRun?.workUnitId ? store.getWorkUnit(sourceRun.workUnitId) : undefined;
      const sourceAttempt = sourceWorkUnit?.activeAttemptId
        ? store.getWorkUnitAttempt(sourceWorkUnit.activeAttemptId)
        : undefined;
      if (!sourceRun || !sourceWorkUnit || !sourceAttempt || !executionInput) {
        throw new HttpError(409, "continuation_source_incomplete", "Durable continuation source evidence is incomplete.");
      }
      continuationContext = resolveRunnerContinuationContext({ request: durableRunRequest, sourceRunId: sourceRun.id, now: createdAt });
      run = persistRun(continuationContext);
      continuationExecution = prepareNewRunContinuation({
        store,
        request: durableRunRequest,
        run,
        workUnit,
        sourceRun,
        sourceAttempt,
        runtime,
        runner: runnerResolution.runner,
        requestedRunnerId: runnerResolution.requestedRunnerId,
        fallbackReason: runnerResolution.fallbackReason,
        policySnapshot: effectivePolicySnapshot,
        execution: executionInput,
        context: continuationContext,
        workspaceCwd,
        now: createdAt,
      });
      attempt = continuationExecution.attempt;
    } else {
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
    }
    preparedConcurrency = prepareRunConcurrency({
      store,
      runRequest,
      runId,
      workUnit,
      attempt,
      existingContinuationId: existingContinuation ? continuationExecution?.continuation.id : undefined,
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
    if (!existingContinuation
      || existingContinuation.origin === "runner_retry"
      || existingContinuation.origin === "manual_resume"
      || existingContinuation.origin === "queued_followup"
      || existingContinuation.origin === "interrupt_redirect") {
      claimPreparedRunTask({
        store,
        task: preparedConcurrency.task,
        runRequest,
        runId,
        leases: preparedConcurrency.leases,
        attempt,
        now: createdAt,
      });
    } else if (preparedConcurrency.task
      && preparedConcurrency.task.status !== "claimed"
      && preparedConcurrency.task.status !== "running") {
      throw new HttpError(409, "task_not_runnable", `Task ${preparedConcurrency.task.id} is ${preparedConcurrency.task.status}`);
    }
    const currentWorkUnitBeforeClaim = store.getWorkUnit(workUnit.id) ?? workUnit;
    if (currentWorkUnitBeforeClaim.status === "queued") {
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
      appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd,
        workUnit.id, "queued", "claimed", runId, createdAt);
    } else if (currentWorkUnitBeforeClaim.status !== "running") {
      throw new HttpError(409, "continuation_activation_state_invalid",
        `Existing Run WorkUnit is ${currentWorkUnitBeforeClaim.status}; expected queued or running.`);
    }
    if (continuationExecution) {
      continuationExecution = claimPreparedRunnerContinuation(store, continuationExecution, createdAt);
    }
    continuationContext ??= resolveRunnerContinuationContext({
      request: durableRunRequest,
      sourceRunId: runRequest.parentRunId ?? runId,
      now: createdAt,
    });
    run ??= persistRun(continuationContext);
    if (existingContinuation) {
      markLingThreadRunActive(store, thread.id, run.id, createdAt);
      storeRegistry.rememberRun(run.id, store);
    }
    prepareManagedRuntime();
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
            getHostOperationTracker: () => hostOperationTracker,
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
            getExecutionContext: options.enableUserInputPause === true && turn.sourceItemId
              && runnerRequest.initialToolSurface?.userInput === true
              ? () => localWriters && hostOperationTracker ? { localWriters, hostOperationTracker } : undefined
              : undefined,
          }),
        };
      }
    }
    if (!existingContinuation && usedMemory && usedMemory.memoryIds.length > 0) {
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
    if (!existingContinuation) {
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
    }
  } catch (error) {
    if (existingContinuation?.origin === "daemon_recovery"
      && error instanceof HttpError && (error.code === "provider_preflight_failed" || error.code.startsWith("checkpoint."))
      && store && run && workUnit && sourceAttempt && sourceAttempt.status === "lost"
      && workUnit.status === "stale") {
      const failedAt = new Date().toISOString();
      const summaryPath = getRunSummaryPath(store.paths, run.id);
      const terminal = store.commitStaleRunRecoveryFailure({
        runId: run.id,
        sourceFence: toRuntimeAttemptFence(sourceAttempt),
        expectedRunStatus: run.status === "queued" ? "queued" : "running",
        errorCode: error.code,
        errorMessage: error.message,
        summaryPath,
        now: failedAt,
      });
      if (terminal.ok) {
        store.appendEvent(run.id, "run_error", {
          message: error.message, code: error.code, origin: "daemon_recovery",
          sourceAttemptId: sourceAttempt.id,
        });
        writeTerminalSummary(summaryPath, {
          runId: run.id, status: "failed", taskId: run.taskId,
          eventCount: store.countEvents(run.id), startedAt: run.startedAt,
          endedAt: failedAt, errorMessage: error.message,
        });
        syncLingThreadForTerminalRun(store, run.id, failedAt);
        appendRunCompletedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd,
          terminal.run, run.status, "failed", failedAt, error.code);
        appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd,
          workUnit.id, "stale", "failed", run.id, failedAt, error.code);
        writeRunPreparationFailure(sink, error.statusCode, { error: error.code, message: error.message });
        return undefined;
      }
      writeRunPreparationFailure(sink, 409, {
        error: terminal.code,
        message: "Recovery preflight failure could not be settled because its execution lineage changed.",
      });
      return undefined;
    }
    if (error instanceof QueueableRunConflictError && existingContinuation && store && run && workUnit && attempt) {
      const queuedAt = new Date().toISOString();
      releasePreparedRunResources(store, attempt, queuedAt, "queued-conflict");
      if (existingContinuation.origin === "approval_resume") {
        failApprovalResumePreparation({
          store,
          continuation: existingContinuation,
          execution: continuationExecution,
          run,
          workUnit,
          attempt,
          message: error.message,
          now: queuedAt,
          controlPlaneEvents: options.controlPlaneEvents,
        });
        writeRunPreparationFailure(sink, 409, { error: error.code, message: error.message });
        return undefined;
      }
      if (continuationExecution) {
        continuationExecution = deferPreparedRunnerContinuation(store, continuationExecution, queuedAt);
      }
      sink.writeReady({
        ok: true,
        runId: run.id,
        workUnitId: workUnit.id,
        queued: true,
        queueReason: error.code,
      });
      sink.end();
      return run.id;
    }
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
        existingRun: run,
      });
      if (continuationExecution) {
        continuationExecution = deferPreparedRunnerContinuation(store, continuationExecution, queuedAt);
      }
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
    if (existingContinuation?.origin === "approval_resume"
      && store && run && workUnit && attempt && continuationExecution) {
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      failApprovalResumePreparation({
        store,
        continuation: existingContinuation,
        execution: continuationExecution,
        run,
        workUnit,
        attempt,
        message,
        now: failedAt,
        controlPlaneEvents: options.controlPlaneEvents,
      });
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      writeRunPreparationFailure(sink, statusCode, {
        error: error instanceof HttpError ? error.code : "run_storage_unavailable",
        message,
      });
      return undefined;
    }
    if (existingContinuation && existingContinuation.origin !== "approval_resume"
      && store && run && workUnit && attempt && continuationExecution) {
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof HttpError ? error.code : "run_prepare_failed";
      const currentRun = store.getRun(run.id);
      const currentWorkUnit = store.getWorkUnit(workUnit.id);
      const currentAttempt = store.getWorkUnitAttempt(attempt.id);
      const currentContinuation = store.getRunnerContinuation(continuationExecution.continuation.id);
      if (currentRun && currentWorkUnit && currentAttempt && currentContinuation
        && (currentRun.status === "queued" || currentRun.status === "running")
        && (currentWorkUnit.status === "queued" || currentWorkUnit.status === "claimed")
        && currentAttempt.status === "created"
        && (currentContinuation.state === "prepared" || currentContinuation.state === "claimed")) {
        const terminal = store.commitExistingRunContinuationPreparationFailure({
          continuationId: currentContinuation.id,
          expectedContinuationRevision: currentContinuation.revision,
          expectedContinuationState: currentContinuation.state,
          claimOwner: continuationExecution.claimOwner,
          claimToken: continuationExecution.claimToken,
          runId: currentRun.id,
          expectedRunStatus: currentRun.status,
          workUnitId: currentWorkUnit.id,
          expectedWorkUnitStatus: currentWorkUnit.status,
          targetFence: toRuntimeAttemptFence(currentAttempt),
          expectedAttemptStatus: "created",
          errorCode,
          errorMessage: message,
          now: failedAt,
        });
        if (terminal.ok) {
          appendRunCompletedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd,
            terminal.run, currentRun.status, "failed", failedAt, errorCode);
          appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd,
            terminal.workUnit.id, currentWorkUnit.status, "failed", terminal.run.id, failedAt, errorCode);
          const summaryPath = getRunSummaryPath(store.paths, terminal.run.id);
          writeTerminalSummary(summaryPath, {
            runId: terminal.run.id,
            status: "failed",
            taskId: terminal.run.taskId,
            eventCount: store.countEvents(terminal.run.id),
            startedAt: terminal.run.startedAt,
            endedAt: failedAt,
            errorMessage: message,
          });
          syncLingThreadForTerminalRun(store, terminal.run.id, failedAt);
          writeRunPreparationFailure(sink, error instanceof HttpError ? error.statusCode : 500, {
            error: errorCode,
            message,
          });
          return undefined;
        }
      }
      writeRunPreparationFailure(sink, 409, {
        error: "continuation_preparation_failure_stale",
        message: "Continuation preparation failure could not be settled because its execution lineage changed.",
      });
      return undefined;
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

  if (!store || !run || !workUnit || !attempt || !runtime || !runnerResolution || !thread
    || !resolvedProvider || !effectivePolicySnapshot || !runtimeSettings) {
    writeRunPreparationFailure(sink, 500, { error: "run_storage_unavailable", message: "Run was not initialized." });
    return undefined;
  }
  const activeProvider = resolvedProvider;
  const activeProviderObservationScope = runtimeObservationScopeForProvider(store, activeProvider);
  const activeEffectivePolicySnapshot = effectivePolicySnapshot;
  const activeRuntimeSettings = runtimeSettings;

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
  const activeToolCallCounts = new Map<string, number>();
  const unpairedToolCallIds = new Set<string>();
  let sinkClosed = sink.isClosed();
  // These are deliberately scoped to the captured attempt. A yielded source
  // keeps its own authority; it must never be reconstructed from a successor.
  let hostOperationTracker: AttemptHostOperationTracker | undefined;
  let localWriters: AttemptLocalWriterGroup | undefined;
  let pauseCoordinator: UserInputPauseCoordinator | undefined;
  let yieldedWait: CommitUserInputYieldResult["wait"] | undefined;
  let retainExecutionAuthority = false;
  sink.onClose(() => {
    sinkClosed = true;
  });

  const streamEnvelope = (envelope: RunEventEnvelope): void => {
    if (!sinkClosed) {
      sink.writeEvent(envelope.type, projectPublicRunEventEnvelope(envelope));
    }
  };

  activeRuns.add(run.id, {
    abortController,
    streamEnvelope,
    completion: runCompletion,
    runtimeInstanceId: runtime.runtimeInstanceId,
    workUnitId: workUnit.id,
    attemptId: attempt.id,
    fencingToken: attempt.fencingToken,
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
  // The SDK may compact between tool turns, then continue after either a
  // successful or failed summary. Until Host has committed a reconstructable
  // checkpoint, no subsequent task provider request may use that SDK view.
  let uncommittedCompactionCode: RunCompactionCheckpointBlockerCode | undefined;
  const hostCompactionEnabled = durableRunRequest.harnessFeatureSnapshot?.continuations === "enforce"
    && Boolean(run.contextViewId) && runnerResolution.runner.adapter instanceof PiRunnerAdapter;
  let ordinaryProgressController: OrdinaryRunProgressController | undefined;
  const beforeTaskContinuationBoundary = async (
    boundary: "before_agent_start" | "before_provider_request" | "tool_call",
    modelView?: readonly unknown[],
  ): Promise<void | PiRunnerUserInputYieldDirective> => {
    // Required user input has priority over lock-screen waits and compaction:
    // the callback must return the same typed directive synchronously from the
    // captured source attempt, otherwise it can be misclassified as failure.
    const requiredInput = pauseCoordinator?.beforeBoundary();
    if (requiredInput) return requiredInput;
    await waitForTaskContinuation(boundary);
    // The lock-screen gate may await while another SDK tool creates a required
    // question. Its pre-await check cannot authorize the next provider/effect.
    const requiredAfterWait = pauseCoordinator?.beforeBoundary();
    if (requiredAfterWait) return requiredAfterWait;
    if (boundary === "before_agent_start") {
      const progress = ordinaryProgressController?.verifyRecoveryBoundary();
      if (progress?.kind === "blocked") throw new HttpError(409, progress.code,
        `The ordinary Run recovery witness is no longer current (${progress.code}).`);
    }
    if (boundary === "before_provider_request" && uncommittedCompactionCode) {
      throw new HttpError(409, uncommittedCompactionCode,
        `A Host Run compaction checkpoint is required before the next model request (${uncommittedCompactionCode}).`);
    }
    if (boundary === "before_provider_request" && hostCompactionEnabled
      && store.getLatestRunCompactionStart(run.id)) {
      const progress = commitRunCompactionProgress({
        store, run, attempt, sourceFence: runnerCallbackFence,
        policySnapshot: effectivePolicySnapshot,
        modelView: redactCompactionModelView(modelView, resolvedSecretValues),
        activeToolCallIds: [...new Set([...activeToolCallCounts.keys(), ...unpairedToolCallIds])],
        allowRecoveredAttemptHandoff: Boolean(compactionRecoveryModelView),
      });
      if (progress.kind === "blocked") {
        throw new HttpError(409, progress.code,
          `A safe Run progress checkpoint is required before the next model request (${progress.code}).`);
      }
    } else if (boundary === "before_provider_request" && ordinaryProgressController) {
      const progress = ordinaryProgressController.beforeProviderBoundary({
        modelView: redactCompactionModelView(modelView, resolvedSecretValues),
        activeToolCallIds: [...new Set([...activeToolCallCounts.keys(), ...unpairedToolCallIds])],
      });
      if (progress.kind === "blocked") throw new HttpError(409, progress.code,
        `A safe ordinary Run progress checkpoint is required before the next model request (${progress.code}).`);
    }
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
    // A blocked pause retains the original owner for durable recovery. Idle
    // and hard-timeout observers must not turn an unknown Host outcome into a
    // cancellation while that recovery barrier is still unresolved.
    if (retainExecutionAuthority) return;
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
      if (retainExecutionAuthority) return;
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
    if (retainExecutionAuthority || !runtimeStarted || hardTimeoutPauseDepth > 0 || abortController.signal.aborted) return false;
    const activeElapsedMs = Math.max(0, performance.now() - hardTimeoutActiveSince);
    if (activeElapsedMs < hardTimeoutRemainingMs) return false;
    requestRuntimeAbort("hard_timeout");
    return true;
  };
  const runnerCallbackFence = Object.freeze(toRuntimeAttemptFence(attempt));
  // Other continuation origins keep their existing explicit retry/approval
  // semantics. Their facts cannot be silently promoted as daemon recovery.
  if (hostCompactionEnabled && (!existingContinuation || existingContinuation.origin === "daemon_recovery")) {
    ordinaryProgressController = new OrdinaryRunProgressController({ store, run,
      sourceFence: runnerCallbackFence, policySnapshot: effectivePolicySnapshot,
      ...(ordinaryProgressRecoveryWitness && continuationExecution ? { recovery: {
        witness: ordinaryProgressRecoveryWitness,
        continuationBinding: { continuationId: continuationExecution.continuation.id, targetFence: runnerCallbackFence },
      } } : {}) });
  }
  // The turn's persisted source item is the only valid question anchor. If a
  // legacy/internal run has no canonical item, do not expose request_user_input
  // rather than guessing from the latest message or task id.
  if (options.enableUserInputPause === true && turn.sourceItemId && runnerRequest.initialToolSurface?.userInput === true) {
    localWriters = new AttemptLocalWriterGroup({ runId: run.id, ...runnerCallbackFence });
    hostOperationTracker = new AttemptHostOperationTracker({
      store,
      source: { runId: run.id, ...runnerCallbackFence },
    });
    pauseCoordinator = new UserInputPauseCoordinator({
      store,
      runId: run.id,
      sourceItemId: turn.sourceItemId,
      sourceFence: runnerCallbackFence,
      runnerId: runnerResolution.effectiveRunnerId,
      executorGroup: hostOperationTracker.executorGroup,
      signal: abortController.signal,
    });
  }
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
        || type === "run_start" || type === "turn_start"
        || type === "provider_retry"
        || type === "context_compaction_start"
        || type === "context_compaction_end"
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
    const runBeforeStart = store.getRun(run.id);
    if (!runBeforeStart) throw new Error("Run disappeared before Runner start.");
    if (runBeforeStart.status === "queued") {
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
    } else if (runBeforeStart.status !== "running") {
      throw new Error(`Run start requires queued or running state, received ${runBeforeStart.status}.`);
    }
    const workUnitBeforeStart = store.getWorkUnit(workUnit.id);
    if (!workUnitBeforeStart) throw new Error("Work unit disappeared before Runner start.");
    if (workUnitBeforeStart.status === "claimed") {
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
      appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd,
        workUnit.id, "claimed", "running", run.id, runStartedAt);
    } else if (workUnitBeforeStart.status !== "running") {
      throw new Error(`Work unit start requires claimed or running state, received ${workUnitBeforeStart.status}.`);
    }
    if (continuationExecution) {
      continuationExecution = startPreparedRunnerContinuation(store, continuationExecution, runStartedAt);
    } else {
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
    }
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
    recordRuntimeHeartbeat("runner", { event: "runner_started" });
    runtimeStarted = true;
    hardTimeoutActiveSince = performance.now();
    clearHardTimeout();
    scheduleHardTimeout();
    if (preparedConcurrency.taskExists) {
      const taskBeforeStart = store.getTask(run.taskId);
      if (taskBeforeStart?.status === "claimed") {
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
      } else if (taskBeforeStart?.status !== "running") {
        throw new Error(`Task start requires claimed or running state, received ${taskBeforeStart?.status ?? "missing"}.`);
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
      hostOperationTracker,
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
      reviewPendingApproval: activeEffectivePolicySnapshot.authorizationMode === "smart"
        ? async (approval) => {
            let reviewerRunner;
            try {
              reviewerRunner = runnerRegistry.resolve({
                requestedRunnerId: DEFAULT_RUNNER_ID,
                allowFallback: false,
                allowedRunnerIds: activeRuntimeSettings.allowedRunnerIds,
                providerApi: activeProvider.api,
                tools: [],
              }).runner.adapter;
            } catch {
              return;
            }
            await reviewPendingApprovalAutomatically({
              store,
              runtimeSupervisor,
              runner: reviewerRunner,
              provider: activeProvider,
              providerPresetId: runRequest.providerPresetId,
              secretResolver,
              run,
              approval,
              sourceFence: runnerCallbackFence,
              effectivePolicySnapshot: activeEffectivePolicySnapshot,
              signal: abortController.signal,
              extraSecrets: resolvedSecretValues,
              // The reviewer owns each actual Runner lifetime independently
              // of its early manual fallback; outer approval writes remain
              // covered by the captured callback's local writer.
              localWriters,
            });
          }
        : undefined,
      onApprovalWaitStarted: beginApprovalHardTimeoutPause,
      onApprovalWaitAbandoned: endApprovalHardTimeoutPause,
      onApprovalResolved: (approval) => {
        // The decision may already have a durable Run event (for example when
        // the HTTP approval route won the race). Always release the matching
        // in-memory wait exactly once, independent of event append ownership.
        // Replay/persistence while that wait is held is not execution idleness.
        // Reset after the replay even when event-side handling released it first.
        lastRuntimeActivityAt = Date.now();
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
    const boundRunnerRequest: PiRunnerRunOptions = {
      ...runnerRequest,
      ...(runnerResolution.runner.adapter instanceof PiRunnerAdapter
        ? createProviderInvocationObserver({
            store, provider: activeProvider, taskId: runnerRequest.task.id,
            runId: run.id, attemptId: attempt.id, origin: options.providerInvocationOrigin ?? "task",
            signal: abortController.signal, onFailure: (failure) => {
              recordProviderInvocationFailureObservations({ store, secretResolver, failure });
              return options.onProviderInvocationFailure?.(failure);
            },
          })
        : {}),
      runId: run.id,
      runnerAttemptId: attempt.id,
      hostCompactionEnabled,
      ...(compactionRecoveryModelView
        ? { compactionRecovery: { schemaVersion: 1 as const, modelView: compactionRecoveryModelView } }
        : {}),
      ...(ordinaryProgressRecoveryModelView
        ? { ordinaryProgressRecovery: { schemaVersion: 1 as const, modelView: ordinaryProgressRecoveryModelView } }
        : {}),
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
      onTaskContinuationBoundary: beforeTaskContinuationBoundary,
      ...(pauseCoordinator ? {
        onUserInputRequest: (request: Parameters<NonNullable<PiRunnerRunOptions["onUserInputRequest"]>>[0]) =>
          pauseCoordinator!.request(request.toolCallId, request.input),
      } : {}),
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
            secretResolver,
            actualProvider: activeProvider,
            observationScope: activeProviderObservationScope,
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
        if (event.type === "context_compaction_end") {
          uncommittedCompactionCode = event.outcome === "sdk_installed"
            ? "checkpoint.missing" : "checkpoint.compaction_failed";
        }
        let compactionSnapshotArtifact: RunArtifact | undefined;
        let eventData: RunEventDataByType[typeof event.type] = { ...event } as RunEventDataByType[typeof event.type];
        let installedCompaction: Extract<PiRunnerEvent, { readonly type: "context_compaction_end" }> | undefined;
        if (event.type === "context_compaction_end") {
          const { compactedModelView: _modelView, compactedSummary: _summary, ...publicEvent } = event;
          eventData = publicEvent as RunEventDataByType[typeof event.type];
          installedCompaction = event;
        }
        if (event.type === "context_compaction_start" && event.contextSnapshot) {
          const { contextSnapshot: _contextSnapshot, ...persistedCompactionEvent } = event;
          eventData = persistedCompactionEvent as RunEventDataByType[typeof event.type];
          try {
            const artifactId = `artifact_${run.id}_compaction_${attempt.id}_${store.countEvents(run.id) + 1}`;
            compactionSnapshotArtifact = store.createArtifact({
              id: artifactId,
              runId: run.id,
              type: "json",
              path: `${run.id}/compaction/${artifactId}.json`,
              title: "Pre-compaction Host context snapshot",
              contentType: "application/vnd.ling.pi-compaction-context+json",
              sealedPayload: {
                schemaVersion: 1,
                boundary: "pi-compaction-context",
                runId: run.id,
                attemptId: attempt.id,
                contextViewId: run.contextViewId,
                model: run.providerModel,
                capturedAt: new Date().toISOString(),
                messages: redactSecrets(event.contextSnapshot, resolvedSecretValues),
              },
              createdAt: new Date().toISOString(),
            });
            eventData = { ...eventData, checkpointArtifactId: compactionSnapshotArtifact.id } as RunEventDataByType[typeof event.type];
          } catch {
            eventData = { ...eventData, checkpointArtifactUnavailable: true } as RunEventDataByType[typeof event.type];
          }
        }
        const eventEnvelope = appendAndMaybeStream(
          event.type,
          eventData,
        );
        if (eventEnvelope && event.type === "tool_start") {
          activeToolCallCounts.set(event.toolCallId, (activeToolCallCounts.get(event.toolCallId) ?? 0) + 1);
        } else if (eventEnvelope && event.type === "tool_end") {
          const activeCount = activeToolCallCounts.get(event.toolCallId) ?? 0;
          if (activeCount === 0) unpairedToolCallIds.add(event.toolCallId);
          else if (activeCount === 1) activeToolCallCounts.delete(event.toolCallId);
          else activeToolCallCounts.set(event.toolCallId, activeCount - 1);
        }
        if (eventEnvelope && installedCompaction?.outcome === "sdk_installed") {
          const committed = commitInstalledRunCompaction({
            store,
            run,
            attempt,
            sourceFence: runnerCallbackFence,
            policySnapshot: effectivePolicySnapshot,
            objective: run.taskId,
            endEventSeq: eventEnvelope.seq,
            summary: redactCompactionSummary(installedCompaction.compactedSummary, resolvedSecretValues),
            modelView: redactCompactionModelView(installedCompaction.compactedModelView, resolvedSecretValues),
            activeToolCallIds: [...new Set([...activeToolCallCounts.keys(), ...unpairedToolCallIds])],
          });
          if (committed.kind === "committed") {
            uncommittedCompactionCode = undefined;
          } else {
            uncommittedCompactionCode = committed.code;
          }
        }
        if (compactionSnapshotArtifact) {
          appendAndMaybeStream("artifact_created", {
            artifact: compactionSnapshotArtifact,
            toolName: "context_compaction",
          });
        }
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
    };
    const approvedToolContinuation: PiRunnerApprovedToolContinuation | undefined =
      existingContinuation?.origin === "approval_resume"
        ? await prepareApprovedToolContinuation({
            store,
            run,
            workUnit,
            attempt,
            approvalId: existingContinuation.idempotencyDiscriminator,
            runtimeSupervisor,
            appendAndMaybeStream,
            signal: abortController.signal,
            extraSecrets: resolvedSecretValues,
            shellSnapshotEnabled: runnerRequest.runtimeToolFeatures?.shellSnapshot === true,
          })
        : undefined;
    const unscopedContinuationRequest = approvedToolContinuation
      ? { ...boundRunnerRequest, approvedToolContinuation }
      : boundRunnerRequest;
    const continuationRunnerRequest = localWriters
      ? scopeUserInputLocalWriters(unscopedContinuationRequest, localWriters)
      : unscopedContinuationRequest;
    const reconstruction = continuationExecution
      ? await executeRunnerContinuationReconstruction({
          store,
          continuation: continuationExecution.continuation,
          runner: runnerResolution.runner,
          targetFence: runnerCallbackFence,
          workspaceCwd,
          policySnapshot: effectivePolicySnapshot,
          liveOptions: continuationRunnerRequest,
        })
      : undefined;
    if (reconstruction && !reconstruction.ok) {
      throw new Error(reconstruction.failureCode);
    }
    const result = reconstruction?.result
      ?? await runnerResolution.runner.adapter.runTask(continuationRunnerRequest);

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
    if (existingContinuation?.origin === "approval_resume") {
      const terminal = commitApprovalContinuationTerminal({
        store,
        hub: options.controlPlaneEvents,
        approvalId: existingContinuation.idempotencyDiscriminator,
        run,
        workUnit,
        attempt,
        execution: continuationExecution,
        status: "succeeded",
        summaryPath,
        now: endedAt,
      });
      if (!terminal) {
        const staleEvent = auditIgnoredRunnerCompletion({
          store,
          run,
          workUnit,
          attempt,
          reportedStatus: "succeeded",
          now: endedAt,
        });
        if (staleEvent) streamEnvelope(staleEvent);
        if (!sinkClosed) sink.end();
        return run.id;
      }
      if (continuationExecution && terminal.continuation) {
        continuationExecution = { ...continuationExecution, continuation: terminal.continuation };
      }
    } else {
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
    }
    if (continuationExecution && continuationExecution.continuation.state === "running") {
      continuationExecution = finishPreparedRunnerContinuation({
        store,
        execution: continuationExecution,
        nextState: "succeeded",
        now: endedAt,
      });
    }
    writeTerminalSummary(summaryPath, {
      runId: run.id, status: "succeeded", taskId: run.taskId,
      eventCount: resultEnvelope?.seq ?? store.countEvents(run.id), messageCount: result.messages.length,
      startedAt: runStartedAt, endedAt, errorMessage: null,
    });
    syncLingThreadForTerminalRun(store, run.id, endedAt);

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
    if (error instanceof PiRunnerYielded) {
      // Stop timeout escalation while the Host examines pause proofs. An
      // observation window is not further productive runtime or a safe stop.
      retainExecutionAuthority = true;
      clearHardTimeout();
      localWriters?.close();
      if (localWriters) {
        try { await localWriters.waitForIdle(1000); }
        catch {
          retainExecutionAuthority = true;
          if (!sinkClosed) {
            sink.writeEvent("user_input_pause_blocked", { runId: run.id,
              requestId: error.request.requestId, requestVersion: error.request.requestVersion,
              code: "local_writer_unconfirmed" });
            sink.end();
          }
          return run.id;
        }
      }
      // A typed SDK yield is a control outcome, not a failure. Core must commit
      // the waiting checkpoint before any terminal path or lease cleanup runs.
      if (!pauseCoordinator) {
        retainExecutionAuthority = true;
        if (!sinkClosed) sink.end();
        return run.id;
      }
      let pauseResult: Awaited<ReturnType<UserInputPauseCoordinator["completeYield"]>>;
      try {
        // A missing durable member must not keep a shutdown observation alive
        // forever. Timeout yields blocked, never a checkpoint or stop receipt.
        pauseResult = await pauseCoordinator.completeYield(error, 1000);
      } catch (pauseError) {
        // A malformed/stale/insufficient proof must preserve the original
        // owner and leave recovery to the durable blocker path; it must never
        // fall through to generic runner_failed cleanup.
        retainExecutionAuthority = true;
        if (!sinkClosed) {
          sink.writeEvent("user_input_pause_blocked", {
            runId: run.id,
            requestId: error.request.requestId,
            requestVersion: error.request.requestVersion,
            code: pauseError instanceof Error && "code" in pauseError
              ? String((pauseError as { readonly code?: unknown }).code ?? "proof_rejected")
              : "proof_rejected",
          });
          sink.end();
        }
        return run.id;
      }
      if (pauseResult.kind === "committed") {
        retainExecutionAuthority = false;
        yieldedWait = pauseResult.result.wait;
        if (!sinkClosed) sink.end();
        return run.id;
      }
      if (pauseResult.kind === "source_obsolete") {
        // Coordinator obsolescence also includes a shutdown/abort signal.
        // Only actual Core owner replacement permits old generic cleanup;
        // signal-only obsolescence retains the source's durable authority.
        retainExecutionAuthority = store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence, true);
        if (!sinkClosed) sink.end();
        return run.id;
      }
      retainExecutionAuthority = true;
      if (!sinkClosed) {
        sink.writeEvent("user_input_pause_blocked", {
          runId: run.id,
          requestId: error.request.requestId,
          requestVersion: error.request.requestVersion,
          code: pauseResult.code,
          blockers: pauseResult.drain.status === "blocked" ? pauseResult.drain.blockers : [],
        });
        sink.end();
      }
      return run.id;
    }
    if (observedRun?.status === "cancelled" || isCancellationStopIntent(stopIntent)) {
      const cancelledAt = new Date().toISOString();
      if (continuationExecution && continuationExecution.continuation.state === "running") {
        continuationExecution = finishPreparedRunnerContinuation({
          store,
          execution: continuationExecution,
          nextState: "cancelled",
          now: cancelledAt,
        });
      }
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
    if (existingContinuation?.origin === "approval_resume") {
      const terminal = commitApprovalContinuationTerminal({
        store,
        hub: options.controlPlaneEvents,
        approvalId: existingContinuation.idempotencyDiscriminator,
        run,
        workUnit,
        attempt,
        execution: continuationExecution,
        status: "failed",
        summaryPath,
        errorCode: runtimeFailure?.code ?? "runner_failed",
        errorMessage: message,
        now: endedAt,
      });
      if (!terminal) {
        const staleEvent = auditIgnoredRunnerCompletion({
          store,
          run,
          workUnit,
          attempt,
          reportedStatus: "failed",
          now: endedAt,
        });
        if (staleEvent) streamEnvelope(staleEvent);
        if (!sinkClosed) sink.end();
        return run.id;
      }
      if (continuationExecution && terminal.continuation) {
        continuationExecution = { ...continuationExecution, continuation: terminal.continuation };
      }
    } else {
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
      appendRunCompletedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, run,
        currentRun?.status ?? "running", "failed", endedAt, runtimeFailure?.code ?? "runner_failed");
      appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, workUnit.id,
        currentWorkUnit?.status ?? "running", "failed", run.id, endedAt, runtimeFailure?.code ?? "runner_failed");
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
    }
    if (continuationExecution && continuationExecution.continuation.state === "running") {
      continuationExecution = finishPreparedRunnerContinuation({
        store,
        execution: continuationExecution,
        nextState: "failed",
        now: endedAt,
      });
    }
    writeTerminalSummary(summaryPath, {
      runId: run.id, status: "failed", taskId: run.taskId,
      eventCount: failureEvent?.seq ?? store.countEvents(run.id),
      startedAt: runStartedAt, endedAt, errorMessage: message,
    });
    syncLingThreadForTerminalRun(store, run.id, endedAt);

    if (!sinkClosed) {
      sink.end();
    }
  } finally {
    if (retainExecutionAuthority && localWriters) {
      // The execution function is returning. Transfer remaining local callback
      // ownership to the registry; never release the SQLite attempt/resources.
      clearHardTimeout();
      activeRuns.retainBlockedAttempt(run.id, localWriters, () => {
        clearInterval(heartbeatTimer);
        resolveRunCompletion?.();
      });
    } else if (!retainExecutionAuthority) {
      localWriters?.close();
      if (localWriters) activeRuns.trackCompletion(localWriters.waitForIdle());
      clearInterval(heartbeatTimer);
      clearHardTimeout();
      // A committed user-input yield already released the captured leases in
      // Core's atomic wait transaction. Do not use the generic run-finished
      // reason as a second authority action.
      if (!yieldedWait) {
        const releaseAt = new Date().toISOString();
        store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), releaseAt, "run-finished");
        store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), releaseAt, "run-finished");
      }
      if (activeRuns.get(run.id)?.attemptId === attempt.id) activeRuns.delete(run.id);
      try {
        const terminalRun = store.getRun(run.id);
        if (yieldedWait) {
          await options.afterRunYielded?.(terminalRun ?? run, yieldedWait);
        } else if (terminalRun && isTerminalRunStatus(terminalRun.status) && hasCurrentRunCallbackIdentity(store, run, runnerCallbackFence)) {
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
  }
  return run.id;
}

function commitApprovalContinuationTerminal(input: {
  readonly store: RunStore;
  readonly hub?: ControlPlaneEventHub;
  readonly approvalId: string;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly execution?: PreparedRunnerContinuationExecution;
  readonly status: "succeeded" | "failed";
  readonly summaryPath: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly now: string;
}): { readonly run: RunSession; readonly continuation?: PreparedRunnerContinuationExecution["continuation"] } | undefined {
  const checkpoint = input.store.getApprovalCheckpointForApproval(input.approvalId);
  const run = input.store.getRun(input.run.id);
  const workUnit = input.store.getWorkUnit(input.workUnit.id);
  if (!checkpoint
    || checkpoint.status !== "resume_pending"
    || !run
    || run.status !== "running"
    || !workUnit
    || workUnit.status !== "running"
    || workUnit.activeAttemptId !== input.attempt.id) {
    return undefined;
  }
  const terminal = input.store.commitApprovalResumeTerminal({
    kind: "verified_lineage",
    checkpointId: checkpoint.id,
    expectedCheckpointStatus: "resume_pending",
    expectedCheckpointRevision: checkpoint.revision,
    approvalId: input.approvalId,
    runId: run.id,
    expectedRunStatus: "running",
    workUnitId: workUnit.id,
    expectedWorkUnitStatus: "running",
    attemptId: input.attempt.id,
    status: input.status,
    attemptStatus: input.status,
    checkpointStatus: input.status === "succeeded" ? "resumed" : "resume_failed",
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    summaryPath: input.summaryPath,
    runnerContinuationTerminal: input.execution ? {
      continuationId: input.execution.continuation.id,
      expectedRevision: input.execution.continuation.revision,
      expectedState: input.execution.continuation.state as "prepared" | "claimed" | "running",
      claimOwner: input.execution.claimOwner,
      claimToken: input.execution.claimToken,
      targetFence: toRuntimeAttemptFence(input.execution.attempt),
    } : undefined,
    now: input.now,
  });
  if (!terminal.ok || terminal.kind !== "verified_lineage") return undefined;
  for (const event of terminal.controlPlaneEvents) input.hub?.publish(event);
  return { run: terminal.run, continuation: terminal.runnerContinuation };
}

function failApprovalResumePreparation(input: {
  readonly store: RunStore;
  readonly continuation: ExistingRunContinuationExecutionOptions;
  readonly execution?: PreparedRunnerContinuationExecution;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly message: string;
  readonly now: string;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
}): void {
  const summaryPath = getRunSummaryPath(input.store.paths, input.run.id);
  const terminal = commitApprovalContinuationTerminal({
    store: input.store,
    hub: input.controlPlaneEvents,
    approvalId: input.continuation.idempotencyDiscriminator,
    run: input.run,
    workUnit: input.workUnit,
    attempt: input.attempt,
    execution: input.execution,
    status: "failed",
    summaryPath,
    errorCode: "approval_resume_prepare_failed",
    errorMessage: input.message,
    now: input.now,
  });
  if (!terminal) return;
  writeTerminalSummary(summaryPath, {
    runId: terminal.run.id,
    status: "failed",
    taskId: terminal.run.taskId,
    eventCount: input.store.countEvents(terminal.run.id),
    startedAt: terminal.run.startedAt,
    endedAt: input.now,
    errorMessage: input.message,
  });
  syncLingThreadForTerminalRun(input.store, terminal.run.id, input.now);
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

function isExistingRunRepreparationOrigin(
  origin: RunnerContinuationOrigin,
): origin is Extract<RunnerContinuationOrigin, "runner_retry" | "daemon_recovery" | "approval_resume"> {
  return origin === "runner_retry" || origin === "daemon_recovery" || origin === "approval_resume";
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

function redactCompactionSummary(value: string | undefined, secrets: readonly (string | undefined)[]): string | undefined {
  if (!value) return undefined;
  const redacted = redactSecrets(value, secrets);
  return typeof redacted === "string" ? redacted : value;
}

function redactCompactionModelView(value: readonly unknown[] | undefined, secrets: readonly (string | undefined)[]): readonly unknown[] | undefined {
  if (!value) return undefined;
  const redacted = redactSecrets(value, secrets);
  return Array.isArray(redacted) ? redacted : value;
}
