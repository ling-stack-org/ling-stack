import { isDeepStrictEqual } from "node:util";
import {
  type ApprovalPolicy,
  approvalSideEffectFingerprintV1,
  buildSkillSourceRuntimeFallbackPlan,
  createChannelWorkspaceSnapshot,
  createRunId,
  captureRunProgressCheckpointLineage,
  delegationDigest,
  DelegationCompletionBarrierError,
  type DelegationPreparedExecution,
  type RootRunSuspensionActivationRecord,
  createRuntimeResourceRenewal,
  DEFAULT_WORKSPACE_ID,
  isExternalExecutionEngineId,
  isApprovalResumeBasisV1,
  applyConversationModeToEffectiveRunPolicySnapshot,
  resolveSessionRunPolicy,
  hostCompactionResourceBoundaryArtifactId,
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
  type ReadRunFinalSettlementResult,
  RunProgressCheckpointError,
  type CommitUserInputYieldResult,
  type UserInputContinuationBinding,
  type UserInputContinuationClaim,
  type UserInputContinuationSeed,
  UserInputRunCreatedDeferredError,
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
} from "@ling-stack/core";
import type {
  PiRunnerApprovedToolContinuation,
  PiRunnerEvent,
  PiRunnerMcpToolDefinition,
  PiRunnerProviderConfig,
  PiRunnerRunOptions,
  PiRunnerSandboxBinding,
  PiRunnerTaskContinuationDirective,
} from "@ling-stack/runner-pi";
import type { RunCompactionCheckpointBlockerCode } from "@ling-stack/contracts";
import { DELEGATION_TOOL_NAMES, PiRunnerAdapter, PiRunnerYielded, PiRunnerSuspended, isPiToolFreeCompletion, readPiCompletedTools, readPiCompletedBuiltinReads,
  type PiToolBoundaryObservation } from "@ling-stack/runner-pi";
import {
  hostCapabilityToolsV1,
  type HostCapabilityToolDefinitionV1,
  type RunnerContinuationOrigin,
} from "@ling-stack/contracts";
import { createWorkflowOperationExecutionSnapshot } from "./workflow-operation-snapshot.js";
import { workflowOperationEffectRejection } from "./workflow-operation-effect-gate.js";
import { captureWorkflowStartOwner, commitWorkflowStartReady, assertWorkflowRunAdmission } from "./workflow-step-start-admission.js";
import { failUnlinkedPreparationThread } from "./preparation-thread-failure.js";
import type { McpBroker } from "../../context.js";
import { HttpError } from "../../errors.js";
import { appendConversationResponseStyle } from "../../shared/conversation-response-style.js";
import { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { runSuspensionOrderFor } from "../../runtime/run-suspension-order.js";
import { AttemptLocalWriterGroup } from "../../runtime/attempt-local-writers.js";
import { observeHostAttemptCompletion } from "../../runtime/host-attempt-completion.js";
import { createRunExecutionSupervision } from "../../runtime/run-execution-supervision.js";
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
  isTerminalWorkUnitStatus,
  transitionWorkUnitCancelled,
  transitionWorkUnitTerminal,
} from "../../runtime/work-units.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import { CuaDriverComputerUseProjectionProducer } from "../computer-use/cua-driver-producer.js";
import { resolveEligibleCuaDriverProjectionServerIds } from "../computer-use/provider-eligibility.js";
import type { ComputerUseProjectionRegistry } from "../computer-use/registry.js";
import { assertPreselectedMemoryCurrent, renderUsedMemoryPrompt } from "../memory/prompt.js";
import { resolveCurrentRunSkill } from "./skill-selection.js";
import { prepareRunSkillSource } from "./skill-source-context.js";
import { withGstackHostContext } from "./gstack-host-context.js";
import { restorePackagedSkillContext } from "../skills/packaged-runtime.js";
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
  recoverPreparedRunConcurrency,
  releasePreparedRunResources,
  type PreparedRunConcurrency,
  UserInputContinuationPrestartDeferredError,
} from "./concurrency.js";
import {
  createMcpToolCallHandler,
  createPiRunnerMcpToolDefinitions,
  resolveMcpToolAccessForRun,
} from "./mcp.js";
import { hydrateRunnerToolSurface } from "./tool-surfaces.js";
import { compareProviderRuntimeObservationScope, runtimeObservationScopeForProvider } from "../providers/runtime-observation-scope.js";
import { createQueuedRunForConflict } from "./queue.js";
import { resolveProviderForRun, resolveProviderRunThinkingLevel } from "./providers.js";
import { findExistingIdempotentRunRequest } from "./existing-idempotent-run.js";
import type { RunRequest } from "./schemas.js";
import { appendFailureEvent, writeTerminalSummary } from "./terminal.js";
import { notifyRunReady } from "./run-ready.js";
import {
  createConversationMediaGenerationToolDefinitions,
  createConversationMediaGenerationToolHandler,
  isConversationMediaGenerationEligible,
} from "../media/conversation-tool-handler.js";
import { appendContextCompactionInvalidation, appendExecutionActionInvalidation } from "./execution-action-invalidation.js";
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
import { approvalEventReflectsRunState } from "./approval-event-state.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import type { RunExecutionSink } from "./run-execution-sink.js";
export { createDetachedRunExecutionSink, createSseRunExecutionSink, type RunExecutionSink } from "./run-execution-sink.js";
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
import { suspendClaimedApprovalResumePreparation } from "./approval-resume-preparation.js";
import { assessRunCompactionRecovery } from "../harness/continuations/run-compaction-recovery.js";
import { sealRunCompactionSuspensionBoundary } from "../harness/continuations/run-compaction-suspension.js";
import { commitInstalledRunCompaction } from "../harness/continuations/run-compaction-commit.js";
import { commitRunCompactionProgress } from "../harness/continuations/run-compaction-progress.js";
import { assessRunOrdinaryProgressRecovery, OrdinaryRunProgressController } from "../harness/continuations/run-ordinary-progress.js";
import { RunGracefulSuspensionController, RunGracefulSuspensionBlocked } from "../harness/continuations/run-graceful-suspension.js";
import { assessDelegatedRunRecovery, type DelegatedRunRecoveryAssessment } from "../harness/delegations/delegated-run-recovery.js";
import { projectPublicRunEventEnvelope } from "./public-artifacts.js";
import { AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import { observeHostCompactionResourceBoundary } from "../harness/continuations/host-compaction-resource-boundary.js";
import { UserInputPauseCoordinator } from "./user-input-pause-coordinator.js";
import { withUserInputContinuationReceiver } from "./user-input-continuation-receiver.js";
import { failUserInputAnswerStartup, finalizeUserInputAnswerWorkflow } from "./user-input-answer-dispatch.js";
import { prepareUserInputContinuationExecution, type UserInputPreparedExecution } from "./user-input-execution-preparation.js";
import { readUserInputSourceExecution } from "./user-input-source-execution.js";
import { providerForRunPersistence } from "./provider-persistence.js";
import {
  createProviderInvocationObserver,
  type ProviderInvocationFailureSink,
} from "../providers/runtime-invocations.js";
import { recordProviderInvocationFailureObservations } from "../providers/runtime-failure-observations.js";
import type { ProviderInvocationOrigin } from "../providers/runtime-invocations.js";
import { admitOriginalDelegationRoot, admitOriginalDelegatedChild, readOriginalDelegatedExecutionEntry, readOriginalRunSuspensionLifecycle,
  commitOriginalRunFinalSettlement,
  activateOriginalRootRunSuspension, readOriginalRootRunSuspensionActivation, withOriginalRootRunSuspensionReceiver,
  type OriginalDelegatedExecution, type OriginalDelegatedExecutionEntry } from "../harness/delegations/store-composition.js";
import { bindOriginalDelegationProviderBudget } from "../harness/delegations/provider-budget-host.js";
import { settleDelegationsForParentOutcome } from "../harness/delegations/completion-wait.js";
import { readOriginalDelegationRuntimeRegistry,
  type DelegationRuntimeRegistry } from "../harness/delegations/runtime-registry.js";
import { createDelegationRunnerToolHandler } from "../harness/delegations/runner-tools.js";

interface ExistingRunContinuationExecutionOptions {
  readonly runId: string;
  readonly origin: RunnerContinuationOrigin;
  readonly idempotencyDiscriminator: string;
  readonly preparedExecution?: PreparedRunnerContinuationExecution;
}
import { isNativeApprovalEvent } from "./native-approval-events.js";
import type { NativeRunDispatcher } from "./native-run-dispatcher.js";

interface UserInputContinuationExecutionOptions {
  readonly threadId: string;
  readonly deliveryId: string;
  readonly claim: UserInputContinuationClaim;
  readonly binding?: UserInputContinuationBinding;
}

export interface UserInputReceiverAccepted {
  readonly runId: string;
  readonly deliveryId: string;
  readonly acceptedAt: string;
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
  /** Trusted durable outbox consumer. Public callers cannot supply delivery claims or bindings. */
  readonly userInputContinuation?: UserInputContinuationExecutionOptions;
  /** Original composition-owned capability; public request DTOs can never select or forge this path. */
  readonly delegatedExecution?: OriginalDelegatedExecutionEntry;
  /** Trusted process-local scheduling signal emitted only after the durable Pi receiver ACK. */
  readonly onUserInputReceiverAccepted?: (input: UserInputReceiverAccepted) => void;
  readonly nativeRunDispatcher?: NativeRunDispatcher;
}

/** Pre-Run failures are terminal for this dispatch transport, not successful Runs. */
function writeRunPreparationFailure(sink: RunExecutionSink, statusCode: number, body: unknown): void {
  try { sink.writeError(statusCode, body); }
  finally { sink.end(); }
}

/** Track the whole request, including preflight before any durable Run exists. */
export function executeRunRequest(
  ...args: Parameters<typeof executeAdmittedRunRequest>
): Promise<string | undefined> {
  const [request, sink, , , activeRuns, , , , options = {}] = args;
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
    if (!request.executionBinding && isExternalExecutionEngineId(request.runnerId)) {
      writeRunPreparationFailure(sink, 409, { error: "legacy_runner_migration_required",
        message: "Endpoint execution is retired. Select a native profile before starting this engine." });
      return undefined;
    }
    if (request.executionBinding?.kind === "native_profile") {
      if (options.delegatedExecution) {
        writeRunPreparationFailure(sink, 409, { error: "delegation.native_execution_unsupported",
          message: "Dynamic delegated execution requires its original Pi Host entry." });
        return undefined;
      }
      const { nativeRunDispatcher, ...executionOptions } = options;
      if (!nativeRunDispatcher) {
        writeRunPreparationFailure(sink, 409, {
          error: "native_execution_unavailable",
          message: "Native execution is not available for this workflow.",
        });
        return undefined;
      }
      return nativeRunDispatcher.dispatch({
        runRequest: request as RunRequest & {
          readonly executionBinding: Extract<NonNullable<RunRequest["executionBinding"]>, { readonly kind: "native_profile" }>;
        },
        sink,
        executionOptions,
      });
    }
    return executeAdmittedRunRequest(...args);
  });
  activeRuns.trackCompletion(completion);
  return completion;
}

/** Original startup registry entry. Reuses normal supervision; it never creates another Runner loop. */
export function executeDelegatedRunRequest(
  input: { readonly store: RunStore; readonly request: RunRequest; readonly executionEntry: OriginalDelegatedExecutionEntry },
  sink: RunExecutionSink,
  runnerRegistry: RunnerRegistry,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  options: ExecuteRunRequestOptions = {},
): Promise<string | undefined> {
  if (storeRegistry.getStore(input.request.cwd) !== input.store) {
    writeRunPreparationFailure(sink, 409, { error: "delegation.authority_invalid", message: "Delegated execution requires the original owning Store." });
    return Promise.resolve(undefined);
  }
  return executeRunRequest(input.request, sink, runnerRegistry, storeRegistry, activeRuns,
    runtimeSupervisor, secretResolver, mcpBroker, { ...options, delegatedExecution: input.executionEntry });
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
  const owningWorkUnit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  if (owningWorkUnit?.ownerType === "delegation_step") {
    writeRunPreparationFailure(sink, 409, {
      error: "delegation.authority_invalid",
      message: "Delegated recovery requires its original private execution entry, not an ordinary continuation.",
    });
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

/** Execute the one durable successor selected by the Host delivery worker. */
export function executeUserInputContinuation(
  input: UserInputContinuationExecutionOptions & { readonly request: RunRequest },
  sink: RunExecutionSink,
  runnerRegistry: RunnerRegistry,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  options: ExecuteRunRequestOptions = {},
): Promise<string | undefined> {
  if (input.claim.threadId !== input.threadId || input.claim.deliveryId !== input.deliveryId
    || input.binding && input.binding.deliveryId !== input.deliveryId) {
    writeRunPreparationFailure(sink, 409, { error: "user_input_continuation_identity_invalid",
      message: "The durable delivery claim and admitted binding must identify the same continuation." });
    return Promise.resolve(undefined);
  }
  const completion = Promise.resolve().then(() => {
    if (activeRuns.isShuttingDown()) {
      writeRunPreparationFailure(sink, 503, { error: "runtime_shutting_down", message: "Runtime is shutting down." });
      return undefined;
    }
    return executeAdmittedRunRequest(input.request, sink, runnerRegistry, storeRegistry, activeRuns,
      runtimeSupervisor, secretResolver, mcpBroker, { ...options, userInputContinuation: input });
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
  let delegationDeadlineAt: string | undefined;
  let workflowDelegationRootAdmissionPending = false;
  let dynamicDelegationRegistry: DelegationRuntimeRegistry | undefined;
  let delegatedExecution: OriginalDelegatedExecution | undefined;
  let delegatedPreparation: DelegationPreparedExecution | undefined;
  let delegatedRecovery: Extract<DelegatedRunRecoveryAssessment, { kind: "verified" }> | undefined;
  let approvalPolicy: ApprovalPolicy | undefined;
  let durableTaskSnapshot: RunRequest["task"] = runRequest.task;
  let durableRunRequest: RunRequest = { ...runRequest, preselectedMemoryUse: undefined, runnerExecutionInput: undefined };
  let runId = "";
  let createdAt = "";
  let workspaceCwd = "";
  let computerUseProducer: CuaDriverComputerUseProjectionProducer | undefined;
  let continuationExecution: PreparedRunnerContinuationExecution | undefined;
  let rootSuspensionActivation: RootRunSuspensionActivationRecord | undefined;
  let continuationContext: RunnerContinuationContextIdentity | undefined;
  let sourceAttempt: WorkUnitAttempt | undefined;
  let compactionRecoveryModelView: readonly unknown[] | undefined;
  let ordinaryProgressRecoveryModelView: readonly unknown[] | undefined;
  let ordinaryProgressRecoveryWitness: RunProgressCheckpointWitness | undefined;
  let compactionRecoveryCheckpointId: string | undefined;
  let finalSettlementRecovery: { readonly suspensionId: string;
    readonly result: Extract<ReadRunFinalSettlementResult, { kind: "verified" }> } | undefined;
  const readStoppedFinalSettlement = (sourceFence: ReturnType<typeof toRuntimeAttemptFence>, now: string): ReadRunFinalSettlementResult => {
    if (!store) return { kind: "blocked", code: "checkpoint.lineage_mismatch" };
    const lifecycle = readOriginalRunSuspensionLifecycle(store, runtimeSupervisor);
    const suspension = lifecycle.getRunSuspensionForAttempt(sourceFence.attemptId);
    if (suspension?.seal?.witness.kind !== "settlement") return { kind: "not_settled" };
    const result = lifecycle.readStoppedFinalSettlementRecovery({ suspensionId: suspension.id, sourceFence, now });
    return result.kind === "not_settled" ? { kind: "blocked", code: "checkpoint.missing" } : result;
  };
  const existingContinuation = options.existingRunContinuation;
  const userInputContinuation = options.userInputContinuation;
  let userInputClaim = userInputContinuation?.claim;
  let userInputSeed: UserInputContinuationSeed | undefined;
  let userInputSourceRun: RunSession | undefined;
  let userInputPrepared: UserInputPreparedExecution | undefined;
  let userInputBinding: UserInputContinuationBinding | undefined;
  let workflowStartOwner: import("@ling-stack/core").WorkflowStepStartOwnerV1 | undefined;
  let lifecycleTimeMs = Number.NEGATIVE_INFINITY;
  const raiseLifecycleTimeFloor = (timestamp: string): void => {
    lifecycleTimeMs = Math.max(lifecycleTimeMs, Date.parse(timestamp));
  };
  const lifecycleNow = (): string => {
    lifecycleTimeMs = Math.max(lifecycleTimeMs, Date.now());
    return new Date(lifecycleTimeMs).toISOString();
  };
  const executionNow = (): string => userInputContinuation ? lifecycleNow() : new Date().toISOString();
  // Required-input checkpoints need durable effect receipts. An internal opt-in
  // cannot turn an off/shadow Broker into an enforced execution path.
  const userInputAvailable = (): boolean => !delegatedExecution && options.enableUserInputPause === true
    && Boolean(turn?.sourceItemId) && durableRunRequest.harnessFeatureSnapshot?.toolBroker === "enforce";
  try {
    if ([existingContinuation, userInputContinuation, options.delegatedExecution].filter(Boolean).length > 1) {
      throw new HttpError(409, "continuation_identity_conflict", "A Run cannot use two continuation owners.");
    }
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
    if (options.delegatedExecution) {
      delegatedExecution = readOriginalDelegatedExecutionEntry(options.delegatedExecution, store);
      const expected = delegatedExecution.buildRequest();
      if (delegationDigest(runRequest) !== delegationDigest(expected)) {
        throw new HttpError(409, "delegation.request_changed", "Delegated execution must use its exact Host-built frozen request.");
      }
      delegatedExecution.assertCurrent();
      const child = delegatedExecution.claimed;
      // A successor may use only its original preparation and a verified Host
      // checkpoint. It never falls through to preparing the first prompt again.
      if (!(child.step.state === "spawning" && child.attempt.attemptNumber === 1 && !delegatedExecution.prepared)
        && !(child.step.state === "resuming" && child.attempt.attemptNumber > 1 && delegatedExecution.prepared)) {
        throw new HttpError(409, "delegation.checkpoint_reconstruction_unavailable",
          "Delegated resume requires a verified original transcript/checkpoint; re-prompting is not recovery.");
      }
      run = store.getRun(child.run.id); workUnit = store.getWorkUnit(child.workUnit.id); attempt = store.getWorkUnitAttempt(child.attempt.id);
      thread = run?.threadId ? store.getLingThread(run.threadId) : undefined;
      turn = store.getLingTurnForRun(child.step.parentRunId) ?? store.getLingTurnForRun(child.step.rootRunId);
      if (!run || !workUnit || !attempt || !thread || !turn || turn.threadId !== thread.id
        || run.threadId !== runRequest.threadId || runRequest.turnId !== turn.id) {
        throw new HttpError(409, "delegation.lineage_invalid", "Delegated child must reuse its parent's existing thread and Turn.");
      }
      storeRegistry.rememberRun(run.id, store);
    }
    if (!delegatedExecution && !existingContinuation && !userInputContinuation && runRequest.normalConversationPreparedRequestRef) {
      const existing = findExistingIdempotentRunRequest(store, runRequest);
      if (existing?.linkedRunId) throw new DuplicateRunRequestError(existing.linkedRunId);
      if (existing) throw new HttpError(409, "duplicate_work_unit", `Duplicate work unit request: ${existing.id}`);
    }
    if (userInputContinuation) {
      userInputSeed = store.getUserInputContinuationSeed(userInputContinuation.threadId, userInputContinuation.deliveryId);
      if (userInputSeed) raiseLifecycleTimeFloor(userInputSeed.createdAt);
      userInputSourceRun = userInputSeed ? store.getRun(userInputSeed.source.runId) : undefined;
      const requestPreparation = store.getUserInputContinuationPreparation(
        userInputContinuation.threadId,
        userInputContinuation.deliveryId,
        "request",
      );
      if (requestPreparation) raiseLifecycleTimeFloor(requestPreparation.createdAt);
      if (!userInputSeed || !userInputSourceRun || userInputSeed.source.cwd !== runRequest.cwd
        || userInputSeed.source.threadId !== runRequest.threadId || userInputSeed.source.turnId !== runRequest.turnId
        || userInputSeed.source.taskBinding.taskId !== runRequest.task.id
        || userInputSeed.source.participantId !== (runRequest.teammateId ?? "ling_agent")
        || userInputSeed.source.workflowStepId !== runRequest.workflowStepId
        || userInputSeed.source.runId !== runRequest.parentRunId
        || runRequest.continuationReason !== "user_input_answer") {
        throw new HttpError(409, "user_input_source_request_invalid", "Durable answer source no longer matches the prepared request.");
      }
      workUnit = store.getWorkUnit(userInputSeed.source.fence.workUnitId);
      thread = store.getLingThread(userInputSeed.source.threadId);
      turn = store.getLingTurn(userInputSeed.source.turnId);
      userInputBinding = userInputContinuation.binding;
      if (userInputBinding) {
        raiseLifecycleTimeFloor(userInputBinding.createdAt);
        const current = store.getUserInputContinuationBinding(userInputContinuation.threadId, userInputContinuation.deliveryId);
        if (!current || !isDeepStrictEqual(current, userInputBinding)) {
          throw new HttpError(409, "user_input_binding_changed", "Durable answer binding changed before execution.");
        }
        run = store.getRun(userInputBinding.runId);
      }
      if (!workUnit || !thread || !turn || workUnit.id !== userInputSeed.source.fence.workUnitId
        || thread.id !== userInputSeed.source.threadId || turn.threadId !== thread.id
        || userInputBinding && (!run || run.workUnitId !== workUnit.id || userInputBinding.fence.workUnitId !== workUnit.id)) {
        throw new HttpError(409, "continuation_source_incomplete", "Durable answer continuation lineage is incomplete.");
      }
    } else if (existingContinuation) {
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
            || !isDeepStrictEqual(toRuntimeAttemptFence(activeAttempt), toRuntimeAttemptFence(existingContinuation.preparedExecution.attempt))
            || existingContinuation.preparedExecution.continuation.runId !== run.id
            || existingContinuation.preparedExecution.continuation.workUnitId !== workUnit.id
            || existingContinuation.preparedExecution.continuation.targetAttemptId !== activeAttempt.id
          : workUnit.activeAttemptId !== sourceAttempt.id)) {
        throw new HttpError(409, "continuation_source_incomplete", "Existing Run continuation lineage is incomplete.");
      }
      if (existingContinuation.preparedExecution && activeAttempt) {
        if (sourceAttempt.errorCode === "runtime_graceful_suspend"
          && readOriginalRootRunSuspensionActivation(store, runtimeSupervisor, { runId: run.id, targetAttemptId: activeAttempt.id })) {
          // This caller has no dispatch custody. Do not enter preparation-failure
          // cleanup, which belongs to the original executor and its retained claim.
          writeRunPreparationFailure(sink, 409, { error: "suspension_start.dispatch_not_regranted",
            message: "A consumed root suspension is audit-only; a saved continuation does not regrant dispatch.",
            status: "blocked", runId: run.id });
          return undefined;
        }
        // This target was claimed by the coordinator before asynchronous Runner preflight.
        // Early failure/shutdown cleanup must retain its real fence, not fall through as unowned.
        continuationExecution = existingContinuation.preparedExecution;
        attempt = activeAttempt;
      }
    }
    let preparedExecution = delegatedExecution || existingContinuation || userInputContinuation ? undefined : readNormalConversationPreparedExecution(store, runRequest);
    const existingRunnerExecution = (existingContinuation || userInputBinding || delegatedExecution?.prepared) && run ? readStoredRunnerExecution(run) : undefined;
    if ((existingContinuation || userInputBinding || delegatedExecution?.prepared) && !existingRunnerExecution) {
      throw new HttpError(409, "continuation_source_incomplete", "Existing Run has no valid frozen Runner execution input.");
    }
    const userInputSourceExecution = userInputSeed && userInputSourceRun
      ? readUserInputSourceExecution(store, userInputSourceRun, userInputSeed)
      : undefined;
    const frozenExecution = preparedExecution?.payload ?? existingRunnerExecution ?? userInputSourceExecution;
    const policyRequest = userInputContinuation && runRequest.userInputContinuationContext
      ? {
          ...runRequest,
          ...runRequest.userInputContinuationContext.sourcePolicyIntent,
          permissionConfirmation: undefined,
        }
      : runRequest;
    assertFullAccessPermissionConfirmed(policyRequest);
    if (!delegatedExecution) validateWorkflowStepOwner(store, runRequest);
    workflowStartOwner = delegatedExecution ? undefined : userInputBinding?.workflowStartOwner ?? captureWorkflowStartOwner(
        store,
        runRequest,
        existingContinuation?.runId ?? userInputSeed?.source.runId,
        { waitingForInput: Boolean(userInputContinuation) },
      );
    runtime = runtimeSupervisor.getRuntime(workspaceCwd, store);
    resolvedProvider = resolveProviderForRun(store, runRequest, secretResolver, {
      providerWebSocketFallbackEnabled: runtimeSupervisor.getTransportFeatures().providerWebSocketFallback,
    });
    const skillTeammate = runRequest.teammateId ? resolveAiTeammateReference(store, runRequest.teammateId) : undefined;
    const skillProviderPreset = runRequest.providerPresetId ? store.getProviderPreset(runRequest.providerPresetId) : undefined;
    selectedSkill = resolveCurrentRunSkill(store, runRequest);
    if (frozenExecution) {
      selectedSkillSourceContext = restorePackagedSkillContext(frozenExecution.skillSourceContext, selectedSkill?.skillId);
    } else if (selectedSkill) {
      const skillOptimizationMode = runRequest.skillOptimizationMode ?? "no_operation";
      const sourcePrompt = prepareRunSkillSource(store, selectedSkill.skillId, skillOptimizationMode);
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
    if (!frozenExecution) assertPreselectedMemoryCurrent(store, runRequest);
    const memoryPrompt = memoryRecall ? renderUsedMemoryPrompt(memoryRecall.memories)
      : runRequest.preselectedMemoryUse?.renderedPrompt;
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
      ? mergeApprovalProfiles(policyRequest.approvalProfile, selectedSkill.skill.approvalProfile)
      : policyRequest.approvalProfile;
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
    runId = delegatedExecution?.claimed.run.id ?? existingContinuation?.runId ?? userInputSeed?.successorRunId ?? createRunId();
    createdAt = userInputContinuation ? lifecycleNow() : new Date().toISOString();
    const idempotencyKey = runRequest.idempotencyKey ?? `run:${runId}`;
    if (!delegatedExecution && !existingContinuation && !userInputContinuation) {
      thread = ensureLingThreadForRun(store, runRequest, createdAt);
      turn = ensureLingTurnForRun(store, thread, runRequest, createdAt);
    }
    if (!thread || !turn) {
      throw new HttpError(409, "continuation_source_incomplete", "Run thread or turn lineage is incomplete.");
    }
    // A Task row is the canonical objective, not necessarily the actual model
    // input: workflow steps render a source-bound context pack into task.prompt.
    // Preserve Task metadata but freeze the accepted execution fields for both
    // checkpoints and restart. Existing Runs retain their original snapshot.
    durableTaskSnapshot = userInputContinuation ? runRequest.task : run?.taskSnapshot as RunRequest["task"] | undefined
      ?? { ...store.getTask(runRequest.task.id), ...runRequest.task, channelId: runRequest.task.channelId };
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
    const workUnitOwner = (delegatedExecution || existingContinuation || userInputContinuation) && workUnit
      ? { kind: workUnit.kind, ownerType: workUnit.ownerType, ownerId: workUnit.ownerId }
      : resolveRunWorkUnitOwner(thread, runRequest, turn.id);
    // Definitions belong to initial model input; executable handlers require the real Run below.
    const mediaGenerationEligible = delegatedExecution ? false : frozenExecution
      ? frozenExecution.input.initialToolSurface?.mediaGeneration === true
      : isConversationMediaGenerationEligible({
          createdByActor: runRequest.createdByActor,
          workUnitKind: workUnitOwner.kind,
        });
    const currentMediaTools = mediaGenerationEligible ? createConversationMediaGenerationToolDefinitions(
      listConversationMediaGenerationTargets(store, secretResolver)) : [];
    const toolHydrationEnabled = !delegatedExecution && runnerResolution.runner.toolHydration?.mode === "daemon_hydrated" &&
      runnerResolution.runner.toolHydration.conformance === "verified";
    dynamicDelegationRegistry = runnerResolution.runner.adapter instanceof PiRunnerAdapter
      ? readOriginalDelegationRuntimeRegistry(runtimeSupervisor) : undefined;
    const delegationToolSurfaceEnabled = runnerResolution.runner.adapter instanceof PiRunnerAdapter
      && dynamicDelegationRegistry?.isSelectedWorkflow({ store, workflowStepId: runRequest.workflowStepId,
        channelId: runRequest.task.channelId }) === true;
    runnerRequest = { ...runnerRequest, mediaGenerationTools: currentMediaTools,
      initialToolSurface: { mediaGeneration: currentMediaTools.length > 0, toolHydration: toolHydrationEnabled,
        userInput: userInputAvailable(),
        nativeFileCreate: runRequest.workflowOperationExecution !== undefined,
        delegation: delegationToolSurfaceEnabled } };
    if (!frozenExecution && runnerResolution.runner.adapter instanceof PiRunnerAdapter) {
      runnerRequest = withGstackHostContext(runnerRequest, selectedSkillSourceContext);
    }
    const preselectedMemory = runRequest.preselectedMemoryUse;
    let usedMemory = frozenExecution?.usedMemory ?? (memoryRecall && memoryRecall.memories.length > 0
      ? { memoryIds: memoryRecall.memories.map((item) => item.memory.id), recallQuery: memoryRecall.request.query,
          policyVersion: memoryRecall.policyVersion } : preselectedMemory ? {
            memoryIds: preselectedMemory.memoryIds, recallQuery: preselectedMemory.recallQuery,
            policyVersion: preselectedMemory.policyVersion,
          } : undefined);
    const assertPreparationCurrent = (): void => {
      if (activeRuns.isShuttingDown()) throw new HttpError(503, "runtime_shutting_down", "Runtime is shutting down.");
      assertHostCapabilitiesCurrent();
      if (!frozenExecution) assertPreselectedMemoryCurrent(runStore, runRequest);
      delegatedExecution?.assertCurrent();
    };
    if (userInputContinuation?.claim && !userInputBinding) {
      userInputPrepared = await prepareUserInputContinuationExecution({
        store,
        claim: userInputContinuation.claim,
        runnerId: runnerResolution.effectiveRunnerId,
        adapter: runnerResolution.runner.adapter,
        currentOptions: runnerRequest,
        now: lifecycleNow,
        assertCurrent: assertPreparationCurrent,
      });
    } else if (!delegatedExecution && !existingContinuation && !userInputContinuation) {
      preparedExecution = await prepareNormalConversationExecution({ store, request: runRequest,
        runnerId: runnerResolution.effectiveRunnerId, adapter: runnerResolution.runner.adapter, options: runnerRequest,
        usedMemory, skillSourceContext: selectedSkillSourceContext, assertCurrent: assertPreparationCurrent });
    }
    let executionInput = userInputPrepared?.execution ?? existingRunnerExecution ?? preparedExecution?.payload;
    if (!existingContinuation && !userInputContinuation && !executionInput && runnerResolution.runner.adapter instanceof PiRunnerAdapter) {
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
      if (delegatedExecution || existingContinuation || userInputContinuation) {
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
      dynamicDelegationRegistry = runnerResolution.runner.adapter instanceof PiRunnerAdapter
        ? readOriginalDelegationRuntimeRegistry(runtimeSupervisor) : undefined;
      const currentDelegationToolSurfaceEnabled = runnerResolution.runner.adapter instanceof PiRunnerAdapter
        && dynamicDelegationRegistry?.isSelectedWorkflow({ store: runStore,
          workflowStepId: runRequest.workflowStepId, channelId: runRequest.task.channelId }) === true;
      runnerRequest = restoreNormalConversationExecutionOptions(executionInput, { ...runnerRequest,
        initialToolSurface: { mediaGeneration: mediaGenerationEligible,
          toolHydration: runnerResolution.runner.toolHydration?.mode === "daemon_hydrated" && runnerResolution.runner.toolHydration.conformance === "verified",
          userInput: userInputAvailable(),
          nativeFileCreate: runRequest.workflowOperationExecution !== undefined,
          delegation: currentDelegationToolSurfaceEnabled },
        provider: resolvedProvider, mcpTools: currentMcp, mediaGenerationTools: mediaGenerationEligible
          ? createConversationMediaGenerationToolDefinitions(listConversationMediaGenerationTargets(runStore, secretResolver)) : [] });
      runtimeTools = executionInput.input.tools;
      mcpTools = runnerRequest.mcpTools ?? [];
      const names = new Set(mcpTools.map((tool) => tool.registeredName));
      mcpToolAccess = { ...currentAccess, totalToolCount: mcpTools.length, servers: currentAccess.servers.map((server) => ({ ...server,
        tools: server.tools.filter((tool) => names.has(tool.registeredName)) })).filter((server) => server.tools.length > 0) };
      resolvedSecretValues = [resolvedProvider.apiKey, ...Object.values(resolvedProvider.headers ?? {})];
      selectedSkillSourceContext = restorePackagedSkillContext(executionInput.skillSourceContext, selectedSkill?.skillId);
      usedMemory = executionInput.usedMemory;
      durableRunRequest = { ...durableRunRequest, runnerExecutionInput: executionInput,
        ...(preparedExecution ? { normalConversationPreparedExecutionRef: preparedExecution.ref } : {}) };
      assertPreparationCurrent();
    };
    refreshPreparedExecution();
    const existingWorkUnit = !delegatedExecution && !existingContinuation && !userInputContinuation && runRequest.idempotencyKey
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
    runtimeApprovalProfile = selectedSkill ? mergeApprovalProfiles(policyRequest.approvalProfile, selectedSkill.skill.approvalProfile)
      : policyRequest.approvalProfile;
    if (executionInput && selectedSkill) {
      const permitted = mergeRunTools(runRequest.tools ?? [], selectedSkill.requiredTools);
      if (runtimeTools?.some((tool) => !permitted.includes(tool))) throw new HttpError(409, "prepared_skill_tools_changed",
        "A prepared core tool is no longer supplied by the selected skill.");
    }
    const currentChannelForPolicy = runRequest.task.channelId ? store.getChannel(runRequest.task.channelId) : undefined;
    const sessionPolicy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
      authorizationMode: policyRequest.authorizationMode, workspaceAccessMode: policyRequest.workspaceAccessMode,
      permissionPreset: policyRequest.permissionPreset, permissionMode: policyRequest.permissionMode,
      channelBoundPath: currentChannelForPolicy?.boundPath || runRequest.cwd, approvalProfile: runtimeApprovalProfile });
    approvalPolicy = sessionPolicy.approvalPolicy;
    effectivePolicySnapshot = applyConversationModeToEffectiveRunPolicySnapshot(sessionPolicy.snapshot,
      store.getLingThread(thread.id)?.conversationMode.mode ?? thread.conversationMode.mode);
    if (delegatedExecution) {
      if (!executionInput || !(runnerResolution.runner.adapter instanceof PiRunnerAdapter) || !run || !attempt) {
        throw new HttpError(409, "delegation.preparation_unavailable", "Delegated execution requires the original Pi SDK preparation.");
      }
      delegatedExecution.assertCurrent();
      if (delegatedExecution.prepared) {
        const recovery = assessDelegatedRunRecovery({ store, child: delegatedExecution.claimed,
          prepared: delegatedExecution.prepared, policySnapshot: effectivePolicySnapshot, now: executionNow(),
          readFinalSettlementRecovery: readStoppedFinalSettlement });
        if (recovery.kind === "blocked") throw new HttpError(409, recovery.code,
          `Delegated recovery requires a verified original checkpoint (${recovery.code}).`);
        delegatedRecovery = recovery;
        delegatedPreparation = recovery.prepared;
        sourceAttempt = recovery.sourceAttempt;
        if ("finalSettlementRecovery" in recovery) {
          const view = recovery.finalSettlementRecovery.modelView;
          if (isCompactedModelView(view)) compactionRecoveryModelView = view;
          else ordinaryProgressRecoveryModelView = view;
        } else if ("ordinaryProgressRecovery" in recovery) {
          ordinaryProgressRecoveryModelView = recovery.ordinaryProgressRecovery.modelView;
          ordinaryProgressRecoveryWitness = recovery.ordinaryProgressWitness;
        } else {
          compactionRecoveryModelView = recovery.compactionRecovery.modelView;
          compactionRecoveryCheckpointId = recovery.compactionCheckpointId;
        }
      }
    } else if (existingContinuation) {
      let needsOrdinaryRecovery = false;
      if (existingContinuation.origin === "daemon_recovery" && run && sourceAttempt) {
        // A stopped successor may retain A's exact compacted view without any
        // new tool round. Only original constructor custody can verify its
        // stopped source and every real activation/ACK edge; a boolean handoff
        // or the public live reader must not substitute for that observation.
        const stoppedLifecycle = sourceAttempt.errorCode === "runtime_graceful_suspend"
          ? readOriginalRunSuspensionLifecycle(store, runtimeSupervisor) : undefined;
        const stopped = stoppedLifecycle?.getRunSuspensionForAttempt(sourceAttempt.id);
        const final = stopped?.seal?.witness.kind === "settlement"
          ? stoppedLifecycle!.readStoppedFinalSettlementRecovery({ suspensionId: stopped.id,
              sourceFence: toRuntimeAttemptFence(sourceAttempt), now: executionNow() }) : undefined;
        if (final?.kind === "blocked") throw new HttpError(409, final.code,
          `Daemon final settlement recovery is blocked (${final.code}).`);
        if (final?.kind === "not_settled") throw new HttpError(409, "checkpoint.missing",
          "The stopped final settlement is missing; an older progress view cannot replace it.");
        if (final?.kind === "verified") {
          if (!(runnerResolution.runner.adapter instanceof PiRunnerAdapter)) throw new HttpError(409,
            "checkpoint.reconstruction_unavailable", "Final settlement recovery requires the original Pi SDK.");
          finalSettlementRecovery = { suspensionId: stopped!.id, result: final };
          if (isCompactedModelView(final.modelView)) compactionRecoveryModelView = final.modelView;
          else ordinaryProgressRecoveryModelView = final.modelView;
        }
        const observation = stopped?.seal?.witness.kind === "compaction"
          ? stoppedLifecycle!.readStoppedCompactionSuspensionRecovery({ suspensionId: stopped.id,
              sourceFence: toRuntimeAttemptFence(sourceAttempt), now: executionNow() }) : undefined;
        const compaction = finalSettlementRecovery ? { kind: "not_compacted" as const }
          : observation?.kind === "verified"
          ? { kind: "verified" as const, checkpoint: { id: observation.witness.checkpoint.checkpointId }, modelView: observation.modelView }
          : observation?.kind === "blocked" ? observation
          : assessRunCompactionRecovery({ store, run, sourceAttempt, policySnapshot: effectivePolicySnapshot });
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
          compactionRecoveryCheckpointId = compaction.checkpoint.id;
        } else {
          needsOrdinaryRecovery = finalSettlementRecovery === undefined;
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
    } else if (!delegatedExecution && !userInputContinuation) {
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
    } else if (userInputBinding) {
      const frozenPolicy = readStoredEffectivePolicySnapshot(run?.requestSnapshot);
      if (!frozenPolicy || !isDeepStrictEqual(effectivePolicySnapshot, frozenPolicy)) {
        throw new HttpError(409, "continuation_policy_changed",
          "The admitted answer continuation no longer matches current workspace and conversation policy.");
      }
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
    if (delegatedExecution) {
      // H10 already created and H11 already claimed these exact identities.
      // There is no Task/Run/Attempt creation or ordinary continuation here.
      if (!executionInput || !run || !workUnit || !attempt || runtime.runtimeInstanceId !== attempt.runtimeInstanceId) {
        throw new HttpError(409, "delegation.source_attempt_stale", "Delegated claim belongs to another physical runtime.");
      }
      delegatedExecution.assertCurrent();
    } else if (existingContinuation) {
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
          suspensionArtifactIds: finalSettlementRecovery?.result.artifactIds,
        });
        const stoppedSuspension = existingContinuation.origin === "daemon_recovery"
          && sourceAttempt.errorCode === "runtime_graceful_suspend"
          ? readOriginalRunSuspensionLifecycle(store, runtimeSupervisor).getRunSuspensionForAttempt(sourceAttempt.id) : undefined;
        if (sourceAttempt.errorCode === "runtime_graceful_suspend") {
          const stopped = stoppedSuspension && readOriginalRunSuspensionLifecycle(store, runtimeSupervisor).getRunSuspensionStop(stoppedSuspension.id);
          if (!stoppedSuspension || stopped?.state !== "stopped" || !stopped.receiptDigest) {
            throw new HttpError(409, "suspension_activation.stopped_proof_missing", "Graceful root recovery requires its exact stopped receipt.");
          }
          const activated = activateOriginalRootRunSuspension({ store, supervisor: runtimeSupervisor, activation: {
            suspensionId: stoppedSuspension.id, sourceFence: toRuntimeAttemptFence(sourceAttempt),
            expectedReceiptDigest: stopped.receiptDigest, replayArtifactId: plan.preparation.contextSnapshotArtifactId,
            target: { runtimeInstanceId: runtime.runtimeInstanceId, runnerId: runnerResolution.runner.id,
              runnerCapabilityRevision: runnerResolution.runner.nativeResumeConformance.revision },
            claim: { owner: plan.claimOwner, token: plan.claimToken, expiresAt: plan.claimExpiresAt }, now: createdAt,
          } });
          if (activated.kind !== "activated") throw new HttpError(409, "suspension_start.dispatch_not_regranted",
            "This root suspension has already been consumed; no dispatch claim is reissued.");
          rootSuspensionActivation = activated.record;
          run = activated.run; workUnit = activated.workUnit; attempt = activated.attempt;
          continuationExecution = { continuation: activated.continuation, attempt: activated.attempt,
            claimOwner: plan.claimOwner, claimToken: plan.claimToken, claimExpiresAt: plan.claimExpiresAt };
        } else {
          const activation = store.commitExistingRunContinuation({
            ...(compactionRecoveryCheckpointId ? { compactionResourceBoundary: {
              checkpointId: compactionRecoveryCheckpointId,
              artifactId: hostCompactionResourceBoundaryArtifactId({ runId: run.id, ...toRuntimeAttemptFence(sourceAttempt) },
                compactionRecoveryCheckpointId),
            } } : {}),
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
      }
    } else if (userInputContinuation) {
      if (!executionInput || !(runnerResolution.runner.adapter instanceof PiRunnerAdapter) || !userInputSeed || !workUnit) {
        throw new HttpError(409, "user_input_receiver_unverified",
          "Durable answer continuation requires a verified Pi receiver and frozen execution input.");
      }
      if (!userInputBinding) {
        const claim = userInputContinuation.claim;
        if (!claim) throw new HttpError(409, "user_input_claim_missing", "Durable answer claim is missing.");
        if (!userInputPrepared) {
          throw new HttpError(409, "user_input_execution_preparation_missing", "Answer execution preparation is missing.");
        }
        const admissionAt = lifecycleNow();
        userInputBinding = store.admitUserInputContinuation({ ...claim,
          executionRef: userInputPrepared.ref,
          runtimeInstanceId: runtime.runtimeInstanceId,
          effectivePolicySnapshot,
          workflowStartOwner,
        }, admissionAt);
        raiseLifecycleTimeFloor(userInputBinding.createdAt);
        createdAt = userInputBinding.createdAt;
        // Admission advances the durable delivery revision without replacing its claim.
        // Only this successful Host admission can promote the pre-admission revision.
        userInputClaim = { ...claim, expectedRevision: userInputBinding.deliveryRevision };
        workflowStartOwner = userInputBinding.workflowStartOwner;
      }
      run = store.getRun(userInputBinding.runId);
      workUnit = store.getWorkUnit(userInputBinding.fence.workUnitId);
      attempt = store.getWorkUnitAttempt(userInputBinding.fence.attemptId);
      if (!run || !workUnit || !attempt || run.id !== runId || workUnit.id !== userInputBinding.fence.workUnitId
        || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), userInputBinding.fence)) {
        throw new HttpError(409, "continuation_source_incomplete", "Admitted answer continuation is incomplete.");
      }
      storeRegistry.rememberRun(run.id, store);
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
    if (!attempt) {
      throw new HttpError(409, "user_input_dispatch_attempt_missing", "Answer continuation has no runnable attempt.");
    }
    const providerConcurrencyKey = runRequest.providerPresetId
      ?? `${resolvedProvider.provider}:${resolvedProvider.model}`;
    if (delegatedExecution) {
      const channel = runRequest.task.channelId ? store.getChannel(runRequest.task.channelId) : undefined;
      if (runRequest.task.channelId && !channel || channel && channel.status !== "active") {
        throw new HttpError(409, "delegation.channel_unavailable", "Delegated channel is no longer active.");
      }
      // The child deliberately shares its parent's Task/workflow scope. It
      // does not acquire or mutate the parent's ordinary Task claim/lease.
      // The selected root already owns the channel_parallel slot while it
      // waits for required descendants. Reacquiring that same ordinary queue
      // slot here would deadlock every dynamic child in a serial channel.
      // Provider and Runner semaphores still cap physical child execution.
      preparedConcurrency = { channel, taskExists: false, leases: [] };
      acquireRunRuntimeSemaphores({ store, workUnit, attempt, providerKey: providerConcurrencyKey,
        runnerId: runnerResolution.effectiveRunnerId, now: createdAt });
    } else if (userInputContinuation && userInputBinding) {
      preparedConcurrency = recoverPreparedRunConcurrency({
        store,
        claim: userInputClaim!,
        binding: userInputBinding,
        runRequest,
        runId,
        workUnit,
        attempt,
        channelParallelLimit: runRequest.channelParallelLimit,
        providerKey: providerConcurrencyKey,
        runnerId: runnerResolution.effectiveRunnerId,
        now: lifecycleNow(),
      });
    } else {
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
        providerKey: providerConcurrencyKey,
        runnerId: runnerResolution.effectiveRunnerId,
        now: createdAt,
      });
    }
    if (!delegatedExecution && !userInputContinuation && (!existingContinuation
      || existingContinuation.origin === "runner_retry"
      || existingContinuation.origin === "manual_resume"
      || existingContinuation.origin === "queued_followup"
      || existingContinuation.origin === "interrupt_redirect")) {
      claimPreparedRunTask({
        store,
        task: preparedConcurrency.task,
        runRequest,
        runId,
        leases: preparedConcurrency.leases,
        attempt,
        now: createdAt,
      });
    } else if (!delegatedExecution && preparedConcurrency.task
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
    } else if (currentWorkUnitBeforeClaim.status !== "running"
      && !((delegatedExecution || userInputContinuation) && currentWorkUnitBeforeClaim.status === "claimed"
        && currentWorkUnitBeforeClaim.activeAttemptId === attempt.id)) {
      throw new HttpError(409, "continuation_activation_state_invalid",
        `Existing Run WorkUnit is ${currentWorkUnitBeforeClaim.status}; expected queued or running.`);
    }
    if (continuationExecution && !rootSuspensionActivation) {
      continuationExecution = claimPreparedRunnerContinuation(store, continuationExecution, createdAt);
    }
    if (!delegatedExecution) {
      continuationContext ??= resolveRunnerContinuationContext({
        request: durableRunRequest,
        sourceRunId: runRequest.parentRunId ?? runId,
        now: createdAt,
      });
      run ??= persistRun(continuationContext);
    }
    if (!run) throw new HttpError(409, "delegation.lineage_invalid", "Existing child Run disappeared before dispatch.");
    if (delegatedExecution) {
      const admission = admitOriginalDelegatedChild({ store, claimed: delegatedExecution.claimed,
        originalProvider: resolvedProvider, effectivePolicySnapshot, runtimeTools: runnerRequest.tools,
        request: policyRequest, approvalProfile: runtimeApprovalProfile,
        hasAdditionalToolSurfaces: Boolean(runnerRequest.mcpTools?.length || runnerRequest.hostCapabilityTools?.length
          || runnerRequest.mediaGenerationTools?.length || runnerRequest.initialToolSurface?.userInput), now: createdAt });
      delegationDeadlineAt = admission.reservation.deadlineAt < admission.root.deadlineAt
        ? admission.reservation.deadlineAt : admission.root.deadlineAt;
      if (!executionInput) throw new HttpError(409, "delegation.preparation_unavailable", "Delegated SDK preparation is unavailable.");
      if (!delegatedRecovery) {
        const preparation = delegatedExecution.dispatchAuthority.capturePreparation({ child: delegatedExecution.claimed,
          request: durableRunRequest, execution: executionInput, policy: effectivePolicySnapshot, now: createdAt });
        delegatedPreparation = delegatedExecution.commitPreparation(preparation, createdAt);
        run = store.getRun(run.id);
        if (!run) throw new HttpError(409, "delegation.lineage_invalid", "Prepared child Run disappeared.");
      }
      delegatedExecution.assertCurrent();
    }
    if (runtimeSupervisor.getHarnessFeatures().delegations.mode !== "off" && !run.parentRunId) {
      workflowDelegationRootAdmissionPending = Boolean(run.workflowStepId && !userInputContinuation);
      if (!workflowDelegationRootAdmissionPending) {
        const delegationRoot = admitOriginalDelegationRoot({ store, run, attempt, originalProvider: resolvedProvider,
          effectivePolicySnapshot, runtimeTools: runnerRequest.tools, request: policyRequest,
          approvalProfile: runtimeApprovalProfile,
          hasAdditionalToolSurfaces: Boolean(runnerRequest.mcpTools?.length || runnerRequest.hostCapabilityTools?.length
            || runnerRequest.mediaGenerationTools?.length || runnerRequest.initialToolSurface?.userInput), now: createdAt });
        delegationDeadlineAt = delegationRoot?.deadlineAt;
      }
    }
    if (existingContinuation || userInputContinuation) {
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
            getExecutionContext: durableRunRequest.harnessFeatureSnapshot?.toolBroker === "enforce"
              ? () => localWriters && hostOperationTracker ? { localWriters, hostOperationTracker } : undefined
              : undefined,
          }),
        };
      }
    }
    if (!delegatedExecution && !existingContinuation && usedMemory && usedMemory.memoryIds.length > 0) {
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
    if (!delegatedExecution && !existingContinuation) {
      const runCreatedData = {
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
      };
      if (userInputContinuation && userInputBinding) {
        store.publishUserInputContinuationRunCreated({
          claim: userInputClaim!,
          bindingRef: { id: userInputBinding.id, fingerprint: userInputBinding.fingerprint },
          sourceFence: userInputBinding.fence,
          runId: run.id,
          workspaceCwd,
          data: runCreatedData,
        }, lifecycleNow());
      } else {
        store.appendEvent(run.id, "run_created", runCreatedData, createdAt);
      }
      appendRunCreatedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd, run, createdAt,
        userInputBinding ? `user-input-run-created:${userInputBinding.deliveryId}:${run.id}` : undefined);
    }
    if (run && !delegatedExecution && !userInputContinuation) commitWorkflowStartReady(store, runRequest, run.id, workflowStartOwner);
    if (workflowDelegationRootAdmissionPending && run && attempt && resolvedProvider && effectivePolicySnapshot) {
      const delegationRoot = admitOriginalDelegationRoot({ store, run: store.getRun(run.id) ?? run, attempt,
        originalProvider: resolvedProvider, effectivePolicySnapshot, runtimeTools: runnerRequest.tools,
        request: policyRequest, approvalProfile: runtimeApprovalProfile,
        hasAdditionalToolSurfaces: Boolean(runnerRequest.mcpTools?.length || runnerRequest.hostCapabilityTools?.length
          || runnerRequest.mediaGenerationTools?.length || runnerRequest.initialToolSurface?.userInput), now: createdAt });
      delegationDeadlineAt = delegationRoot?.deadlineAt;
      workflowDelegationRootAdmissionPending = false;
    }
  } catch (error) {
    if (rootSuspensionActivation) {
      // Activation consumed the old receipt exactly once. A failed preflight
      // neither proves execution/drain nor creates a schedulable dispatch grant.
      writeRunPreparationFailure(sink, 409, { error: error instanceof HttpError ? error.code : "suspension_start.preparation_blocked",
        message: "Stopped-root preparation remains blocked; its consumed claim is retained.", status: "blocked", runId: run?.id });
      return run?.id;
    }
    if (options.delegatedExecution) {
      // Preparation did not cross the Pi ACK. Retain the committed child,
      // first input (if any) and reservation; do not fall into ordinary Task
      // mutation, createQueuedRunForConflict or a fabricated terminal result.
      if (store && attempt) releasePreparedRunResources(store, attempt, executionNow(), "delegation-preparation-blocked");
      const internalCode = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
      const preparationCode = error instanceof HttpError ? error.code
        : typeof internalCode === "string" && /^delegation\.[a-z][a-z0-9_]{0,79}$/.test(internalCode)
          ? internalCode : "delegation.preparation_blocked";
      writeRunPreparationFailure(sink, error instanceof HttpError ? error.statusCode : 409, {
        error: preparationCode,
        message: error instanceof HttpError ? error.message : preparationCode, status: "blocked",
        runId: run?.id ?? delegatedExecution?.claimed.run.id,
      });
      return run?.id;
    }
    if (userInputContinuation) {
      const failureCode = error instanceof HttpError ? error.code : "user_input_receiver_unavailable";
      const failureMessage = error instanceof Error ? error.message : String(error);
      const recoverable = error instanceof UserInputContinuationPrestartDeferredError
        || error instanceof UserInputRunCreatedDeferredError;
      if (!recoverable && userInputBinding && store) {
        failUserInputAnswerStartup(store, userInputBinding, userInputClaim!,
          failureCode, failureMessage, lifecycleNow());
      }
      writeRunPreparationFailure(sink, error instanceof HttpError ? error.statusCode : 503, {
        error: failureCode,
        message: failureMessage,
      });
      return undefined;
    }
    if (existingContinuation?.origin === "approval_resume" && error instanceof HttpError
      && error.code === "runtime_shutting_down" && store && run && attempt && continuationExecution) {
      const suspension = suspendClaimedApprovalResumePreparation({
        store, run, attempt, execution: continuationExecution,
        approvalId: existingContinuation.idempotencyDiscriminator, cause: "runtime_shutting_down",
        controlPlaneEvents: options.controlPlaneEvents, now: executionNow(),
      });
      if (suspension.kind === "blocked") {
        console.warn("approval_resume_preparation_suspension_blocked: existing execution authority was retained");
      }
      // Returning the logical Run prevents the coordinator from quarantining a safe pause
      // merely because physical preflight returned; a rejected proof remains non-terminal.
      sink.end();
      return run.id;
    }
    if (existingContinuation?.origin === "daemon_recovery"
      && error instanceof HttpError && (error.code === "provider_preflight_failed" || error.code.startsWith("checkpoint."))
      && store && run && workUnit && sourceAttempt && sourceAttempt.status === "lost"
      && workUnit.status === "stale") {
      const failedAt = executionNow();
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
      const queuedAt = executionNow();
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
      try { commitWorkflowStartReady(store, runRequest, run.id, workflowStartOwner); }
      catch (ownerError) { writeRunPreparationFailure(sink, 409, { error: "workflow_start_owner_stale", message: String(ownerError) }); return undefined; }
      sink.writeReady({
        ok: true,
        runId: run.id,
        workUnitId: workUnit.id,
        sourceFence: toRuntimeAttemptFence(attempt),
        queued: true,
        queueReason: error.code,
      });
      sink.end();
      return run.id;
    }
    if (error instanceof QueueableRunConflictError && store && workUnit && attempt && resolvedProvider) {
      const queuedAt = executionNow();
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
      try { commitWorkflowStartReady(store, runRequest, run.id, workflowStartOwner, { claimQueuedTask: true }); }
      catch (ownerError) { writeRunPreparationFailure(sink, 409, { error: "workflow_start_owner_stale", message: String(ownerError) }); return undefined; }
      notifyRunReady(options.onRunReady, run.id);
      sink.writeReady({
        ok: true,
        runId: run.id,
        workUnitId: workUnit.id,
        sourceFence: toRuntimeAttemptFence(attempt),
        queued: true,
        queueReason: error.code,
      });
      appendRunCreatedControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd || run.cwd, run, queuedAt);
      sink.end();
      return run.id;
    }
    if (existingContinuation?.origin === "approval_resume"
      && store && run && workUnit && attempt && continuationExecution) {
      const failedAt = executionNow();
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
      const failedAt = executionNow();
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
      const now = executionNow();
      store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), now, "run-prepare-failed");
    }
    if (store && workUnit && !isTerminalWorkUnitStatus(store.getWorkUnit(workUnit.id)?.status ?? workUnit.status)) {
      const now = executionNow();
      const message = error instanceof Error ? error.message : String(error);
      const currentAttempt = attempt?.id ? store.getWorkUnitAttempt(attempt.id) : undefined;
      const errorCode = error instanceof HttpError ? error.code : "run_prepare_failed";
      if (currentAttempt) {
        const currentRun = run?.id ? store.getRun(run.id) : undefined;
        if (currentRun && ["queued", "running", "waiting_for_approval"].includes(currentRun.status)) {
          store.transitionRunExecutionStatus({ runId: currentRun.id, sourceFence: toRuntimeAttemptFence(currentAttempt),
            expectedStatus: currentRun.status as "queued" | "running" | "waiting_for_approval",
            event: "runner_failed", actor: "system", reason: message, now, endedAt: now,
            errorMessage: message });
        }
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
    if (store && thread && !run) failUnlinkedPreparationThread(store, thread.id, turn?.id, error, executionNow());
    if (error instanceof DuplicateRunRequestError) {
      try { if (store) commitWorkflowStartReady(store, runRequest, error.runId, workflowStartOwner); }
      catch (ownerError) { writeRunPreparationFailure(sink, 409, { error: "workflow_start_owner_stale", message: String(ownerError) }); return undefined; }
      notifyRunReady(options.onRunReady, error.runId);
      // A duplicate caller did not capture the original producer's execution capability.
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

  sink.writeReady({ ok: true, runId: run.id, sourceFence: toRuntimeAttemptFence(attempt) });
  notifyRunReady(options.onRunReady, run.id);

  const abortController = new AbortController();
  const runnerCallbackFence = Object.freeze(toRuntimeAttemptFence(attempt));
  let runtimeStarted = false;
  let gracefulSuspensionController: RunGracefulSuspensionController | undefined;
  const hostCompactionEnabled = durableRunRequest.harnessFeatureSnapshot?.continuations === "enforce"
    && Boolean(run.contextViewId) && runnerResolution.runner.adapter instanceof PiRunnerAdapter;
  let gracefullySuspended = false;
  let shutdownSuspensionCause: "daemon_restart" | "desktop_quit" | "process_signal" | undefined;
  let approvalSuspensionBlocked: unknown;
  const suspensionOrder = runSuspensionOrderFor(activeRuns);
  const suspensionSource = suspensionOrder.capture(store, { runId: run.id, ...runnerCallbackFence });
  const assertCurrentRunAdmission = (): void => {
    abortController.signal.throwIfAborted();
    if (delegatedExecution) delegatedExecution.assertCurrent();
    else assertWorkflowRunAdmission(store, run, workflowStartOwner, abortController.signal);
  };
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
  let durableAttemptCompletion: Promise<void> | undefined;
  let pauseCoordinator: UserInputPauseCoordinator | undefined;
  let yieldedWait: CommitUserInputYieldResult["wait"] | undefined;
  let retainExecutionAuthority = false;
  let deferredApprovalSuspension: (() => void) | undefined;
  let delegatedInterrupted = false;
  let delegatedAckCommitted = false;
  let waitingForDelegationCompletion = false;
  const isCapturedActiveAttempt = (): boolean => {
    const active = activeRuns.get(run.id);
    return active?.workUnitId === runnerCallbackFence.workUnitId
      && active.attemptId === runnerCallbackFence.attemptId
      && active.runtimeInstanceId === runnerCallbackFence.runtimeInstanceId
      && active.fencingToken === runnerCallbackFence.fencingToken;
  };
  const readApprovalWaitSuspension = () => {
    const currentRun = store.getRun(run.id);
    const currentUnit = store.getWorkUnit(workUnit.id);
    const currentAttempt = store.getWorkUnitAttempt(attempt.id);
    if (!isCapturedActiveAttempt() || !store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence)
      || !currentRun || currentRun.status !== "waiting_for_approval" || currentRun.endedAt
      || currentRun.workUnitId !== workUnit.id
      || !currentUnit || currentUnit.status !== "waiting_for_approval" || currentUnit.linkedRunId !== run.id
      || currentUnit.activeAttemptId !== attempt.id || currentUnit.ownerType === "delegation_step"
      || !currentAttempt || currentAttempt.workUnitId !== workUnit.id
      || currentAttempt.runtimeInstanceId !== runnerCallbackFence.runtimeInstanceId
      || currentAttempt.fencingToken !== runnerCallbackFence.fencingToken
      || !["started", "waiting_for_approval"].includes(currentAttempt.status)
      || currentAttempt.endedAt || currentAttempt.abortRequestedAt || delegatedExecution
      || store.hasPendingRunTerminalIntent({ runId: run.id, ...runnerCallbackFence })) {
      throw new RunGracefulSuspensionBlocked("suspension.source_stale");
    }
    // Approval resume owns its existing checkpoint, not the ordinary SDK
    // suspension ledger. Dynamic trees must retain their private lifecycle.
    const descendants = store.getDelegationCompletionEvidence({ rootRunIds: [run.id] });
    if (descendants.steps.length || descendants.issues.length || gracefulSuspensionController?.hasPendingRequest()) {
      throw new RunGracefulSuspensionBlocked("suspension.boundary_unavailable");
    }
    const approval = store.listApprovalRequests({ runId: run.id, status: "pending", limit: 1 })[0]
      ?? store.listApprovalRequests({ runId: run.id, status: "approved", limit: 1 })[0];
    const checkpoint = approval && store.getApprovalCheckpointForApproval(approval.id);
    const basis = checkpoint?.resumeBasis;
    if (!approval || !checkpoint || !isApprovalResumeBasisV1(basis)
      || (checkpoint.status !== "pending" && checkpoint.status !== "approved")
      || checkpoint.status !== approval.status || checkpoint.runId !== run.id || approval.runId !== run.id
      || basis.runId !== run.id || basis.workUnitId !== workUnit.id || basis.priorAttemptId !== attempt.id
      || basis.workflowStepId !== currentRun.workflowStepId || checkpoint.workflowStepId !== currentRun.workflowStepId
      || approval.workflowStepId !== currentRun.workflowStepId
      || basis.approvalId !== approval.id || checkpoint.approvalId !== approval.id
      || basis.toolCallId !== approval.toolCallId || checkpoint.toolCallId !== basis.toolCallId
      || basis.actionType !== approval.actionType || checkpoint.actionType !== basis.actionType
      || basis.sideEffectFingerprint !== approvalSideEffectFingerprintV1({ actionType: approval.actionType,
        toolCallId: basis.toolCallId, sideEffect: approval.payload })
      || basis.sideEffectFingerprint !== approvalSideEffectFingerprintV1({ actionType: checkpoint.actionType,
        toolCallId: basis.toolCallId, sideEffect: checkpoint.sideEffect })) {
      throw new RunGracefulSuspensionBlocked("suspension.witness_mismatch");
    }
    if (basis.workflowStepId) {
      const step = store.getChannelWorkflowStep(basis.workflowStepId);
      if (step?.runId !== run.id
        || step.metadata?.delegatedRequirement?.fingerprint !== basis.delegatedRequirementFingerprint) {
        throw new RunGracefulSuspensionBlocked("suspension.witness_mismatch");
      }
    }
    return { approval, checkpoint, checkpointStatus: checkpoint.status, workUnit: currentUnit };
  };
  const settleDelegationsBeforeTerminal = async (outcome: "failed" | "cancelled", failure?: { readonly code: string; readonly message: string }): Promise<boolean> => {
    try {
      if (dynamicDelegationRegistry && store.getDelegationCompletionEvidence({ rootRunIds: [run.id] }).steps.length) {
        // Persist the original disposition before bounded observation can time
        // out. It is a cleanup intent, never a drain/effect/usage receipt.
        dynamicDelegationRegistry.prepareParentTerminalIntent({ store, runId: run.id, sourceFence: runnerCallbackFence,
          desiredOutcome: outcome, errorCode: failure?.code ?? "cancelled", errorMessage: failure?.message ?? "cancelled" });
      }
      // Parent cancellation has already aborted its Runner signal. Own a
      // separate bounded cleanup observation; timeout retains authority rather
      // than certifying any still-live/unknown descendant as stopped.
      await settleDelegationsForParentOutcome({ store, registry: dynamicDelegationRegistry, runId: run.id,
        sourceFence: runnerCallbackFence, outcome, signal: AbortSignal.timeout(1000) });
      if (store.hasPendingRunTerminalIntent({ runId: run.id, ...runnerCallbackFence })) {
        // The sealed intent owns this terminal transition even on the fast
        // stop path. Ordinary cleanup must not publish a second terminal or
        // run channel/goal follow-ups before the original Host drain.
        if (!sinkClosed) sink.end();
        return false;
      }
      return true;
    } catch (cleanupError) {
      retainExecutionAuthority = store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence, true);
      if (!sinkClosed) {
        const evidence = store.getDelegationCompletionEvidence({ rootRunIds: [run.id] });
        sink.writeEvent("delegation_blocked", { runId: run.id, status: "blocked",
          code: cleanupError instanceof DelegationCompletionBarrierError ? cleanupError.code : "delegation.stop_with_parent_unverified",
          completionStatus: evidence.status, evidenceFingerprint: evidence.fingerprint });
        sink.end();
      }
      return false;
    }
  };
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
    runtimeInstanceId: attempt.runtimeInstanceId,
    workUnitId: workUnit.id,
    attemptId: attempt.id,
    fencingToken: attempt.fencingToken,
    runtimeShutdownPolicy: hostCompactionEnabled ? "checkpoint" : "stop_without_resume",
    ...(delegatedExecution ? { terminalHandoff: delegatedExecution.terminalHandoff } : {}),
    requestGracefulSuspension: request => {
      try {
        if (!isDeepStrictEqual(request.source, { runId: run.id, ...runnerCallbackFence })) {
          throw new RunGracefulSuspensionBlocked("suspension.source_stale");
        }
        abortController.signal.throwIfAborted();
        shutdownSuspensionCause = request.cause;
        if (!runtimeStarted) {
          // No Runner has been dispatched. The original preflight may finish
          // its no-execution failure path, but must not start after shutdown.
          activeRuns.requestStop(run.id, { kind: "runtime_suspend", cause: request.cause,
            runtimeInstanceId: runnerCallbackFence.runtimeInstanceId });
          return;
        }
        if (store.getRun(run.id)?.status === "waiting_for_approval"
          || store.getWorkUnit(workUnit.id)?.status === "waiting_for_approval") {
          try { readApprovalWaitSuspension(); }
          catch (error) {
            approvalSuspensionBlocked = error;
            // End only the exact original polling callback. The blocked
            // source keeps its authority and cannot become a normal resume.
            if (isCapturedActiveAttempt()) activeRuns.requestStop(run.id, { kind: "runtime_suspend",
              cause: request.cause, runtimeInstanceId: runnerCallbackFence.runtimeInstanceId });
            throw error;
          }
          activeRuns.requestStop(run.id, { kind: "runtime_suspend", cause: request.cause,
            runtimeInstanceId: runnerCallbackFence.runtimeInstanceId });
          return;
        }
        if (!gracefulSuspensionController) {
          throw new RunGracefulSuspensionBlocked("suspension.source_not_started");
        }
        gracefulSuspensionController.request(request.cause);
      } catch (error) {
        suspensionOrder.block(suspensionSource, error);
        throw error;
      }
    },
  });
  // Startup discovery may have observed a durable child before its parent Run
  // re-entered this process. Re-scan only after the exact parent fence is live;
  // the registry's bounded periodic sweep covers pages not revisited here.
  if (!delegatedExecution && dynamicDelegationRegistry) {
    dynamicDelegationRegistry.recoverStore(store);
  }

  let taskContinuationWaitDepth = 0;
  const supervision = createRunExecutionSupervision({ store, runId: run.id, workUnit, attempt, activeRuns,
    signal: abortController.signal, now: executionNow, retainAuthority: () => retainExecutionAuthority,
    absoluteDeadlineAt: delegationDeadlineAt,
    waitingForContinuation: () => taskContinuationWaitDepth > 0 || waitingForDelegationCompletion });
  const recordRuntimeHeartbeat = supervision.heartbeat;
  const pauseHardTimeout = supervision.pause;
  const resumeHardTimeout = supervision.resume;
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
    supervision.activity();
    recordRuntimeHeartbeat("supervisor", {
      event: "locked_task_continuation_resumed",
      boundary,
    });
  };
  // The SDK may compact between tool turns, then continue after either a
  // successful or failed summary. Until Host has committed a reconstructable
  // checkpoint, no subsequent task provider request may use that SDK view.
  let uncommittedCompactionCode: RunCompactionCheckpointBlockerCode | undefined;
  let ordinaryProgressController: OrdinaryRunProgressController | undefined;
  let delegatedRecoveryProviderAdmitted = false;
  const verifyDelegatedRecovery = (): void => {
    if (!delegatedRecovery || delegatedRecoveryProviderAdmitted) return;
    const fresh = assessDelegatedRunRecovery({ store, child: delegatedExecution!.claimed,
      prepared: delegatedPreparation, policySnapshot: effectivePolicySnapshot, now: executionNow(),
      readFinalSettlementRecovery: readStoppedFinalSettlement });
    if (fresh.kind === "blocked") throw new HttpError(409, fresh.code,
      `Delegated checkpoint is no longer current (${fresh.code}).`);
    if (!isDeepStrictEqual(fresh, delegatedRecovery)) throw new HttpError(409,
      "checkpoint.lineage_mismatch", "Delegated recovery changed before its receiver/model boundary.");
  };
  const verifyFinalSettlementRecovery = (): void => {
    if (!finalSettlementRecovery || !sourceAttempt) return;
    // A complete restored view sends no provider request, so the normal
    // invocation gate cannot catch credentials revoked after the actual ACK.
    if (run.providerPresetId) {
      const current = activeProviderObservationScope && compareProviderRuntimeObservationScope({
        store, scope: activeProviderObservationScope, secretResolver });
      if (!current || current.state !== "managed_generation_match" && current.state !== "sampled_value_match") {
        throw new HttpError(409, "delegation.provider_revoked", "Final completion lost its original Provider authority.");
      }
    }
    const fresh = readOriginalRunSuspensionLifecycle(store, runtimeSupervisor).readStoppedFinalSettlementRecovery({
      suspensionId: finalSettlementRecovery.suspensionId, sourceFence: toRuntimeAttemptFence(sourceAttempt), now: executionNow() });
    if (fresh.kind === "blocked") throw new HttpError(409, fresh.code, "Final SDK settlement is no longer recoverable.");
    if (!isDeepStrictEqual(fresh, finalSettlementRecovery.result)) throw new HttpError(409,
      "checkpoint.lineage_mismatch", "Final SDK settlement changed before its receiver/completion boundary.");
  };
  const beforeTaskContinuationBoundary = async (
    boundary: "before_agent_start" | "before_provider_request" | "tool_call",
    modelView?: readonly unknown[],
  ): Promise<void | PiRunnerTaskContinuationDirective> => {
    assertCurrentRunAdmission();
    // Required user input has priority over lock-screen waits and compaction:
    // the callback must return the same typed directive synchronously from the
    // captured source attempt, otherwise it can be misclassified as failure.
    const requiredInput = pauseCoordinator?.beforeBoundary();
    if (requiredInput) return requiredInput;
    const suspension = await gracefulSuspensionController?.beforeBoundary({ boundary,
      modelView: redactCompactionModelView(modelView, resolvedSecretValues),
      activeToolCallIds: [...new Set([...activeToolCallCounts.keys(), ...unpairedToolCallIds])] });
    if (suspension) {
      suspensionOrder.ready(suspensionSource);
      return suspension;
    }
    await waitForTaskContinuation(boundary);
    assertCurrentRunAdmission();
    // The lock-screen gate may await while another SDK tool creates a required
    // question. Its pre-await check cannot authorize the next provider/effect.
    const requiredAfterWait = pauseCoordinator?.beforeBoundary();
    if (requiredAfterWait) return requiredAfterWait;
    // A graceful request deliberately does not abort an in-flight executor.
    // Recheck after the real lock-screen wait so a request arriving there cannot
    // escape this safe boundary and send another provider request on unlock.
    const suspensionAfterWait = await gracefulSuspensionController?.beforeBoundary({ boundary,
      modelView: redactCompactionModelView(modelView, resolvedSecretValues),
      activeToolCallIds: [...new Set([...activeToolCallCounts.keys(), ...unpairedToolCallIds])] });
    if (suspensionAfterWait) {
      suspensionOrder.ready(suspensionSource);
      return suspensionAfterWait;
    }
    if (boundary === "before_agent_start") {
      verifyFinalSettlementRecovery();
      verifyDelegatedRecovery();
      const progress = ordinaryProgressController?.verifyRecoveryBoundary();
      if (progress?.kind === "blocked") throw new HttpError(409, progress.code,
        `The ordinary Run recovery witness is no longer current (${progress.code}).`);
    }
    if (boundary === "before_provider_request") {
      verifyDelegatedRecovery();
      delegatedRecoveryProviderAdmitted = true;
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
      observeHostCompactionResourceBoundary({ store, source: { runId: run.id, ...runnerCallbackFence },
        observation: toolBoundaryObservation, hostToolCallIds: [...hostToolCalls], hostBoundaryUnverified });
    } else if (boundary === "before_provider_request" && ordinaryProgressController) {
      const progress = ordinaryProgressController.beforeProviderBoundary({
        modelView: redactCompactionModelView(modelView, resolvedSecretValues),
        activeToolCallIds: [...new Set([...activeToolCallCounts.keys(), ...unpairedToolCallIds])],
      });
      if (progress.kind === "blocked") throw new HttpError(409, progress.code,
        `A safe ordinary Run progress checkpoint is required before the next model request (${progress.code}).`);
      if (progress.kind === "committed" && progress.delegationInstructions) {
        return { kind: "delegation_instructions", schemaVersion: 1,
          insertAfterMessageCount: progress.delegationInstructions.insertAfterMessageCount,
          messages: progress.delegationInstructions.messages };
      }
    }
  };
  const requestRuntimeAbort = supervision.requestAbort;
  const beginApprovalHardTimeoutPause = (): void => supervision.approvalWaitChanged(true);
  const endApprovalHardTimeoutPause = (): void => supervision.approvalWaitChanged(false);
  let userInputReceiverAccepted = userInputBinding === undefined && delegatedExecution === undefined && rootSuspensionActivation === undefined;
  const pendingUserInputRunnerEvents: PiRunnerEvent[] = [];
  let flushPendingUserInputRunnerEvents = (): void => undefined;
  let toolBoundaryObservation: PiToolBoundaryObservation | undefined;
  let finalSettlementBoundary: "original" | "restored" = "original";
  let delegationCompletionObservedAtSdkBoundary = false;
  const observeSuccessfulDelegations = async (signal: AbortSignal): Promise<void> => {
    waitingForDelegationCompletion = true;
    try {
      await settleDelegationsForParentOutcome({ store, registry: dynamicDelegationRegistry,
        runId: run.id, sourceFence: runnerCallbackFence, outcome: "succeeded", signal,
        onChanged(evidence) {
          if (!evidence.steps.length && !evidence.issues.length) return;
          store.appendRuntimeEvent({ ...runnerCallbackFence, type: "work_unit_progress", actor: "system", ts: executionNow(),
            data: { kind: "delegation_fan_in", runId: run.id, status: evidence.status,
              evidenceFingerprint: evidence.fingerprint, requiredCount: evidence.steps.filter(node => node.step.required).length } });
          if (!sinkClosed) sink.writeEvent("delegation_fan_in", { runId: run.id, status: evidence.status,
            evidenceFingerprint: evidence.fingerprint });
        } });
    } finally { waitingForDelegationCompletion = false; }
  };
  const beforeFinalCompletionBoundary = async (modelView: readonly unknown[], boundary: "original" | "restored") => {
    assertCurrentRunAdmission();
    verifyFinalSettlementRecovery();
    verifyDelegatedRecovery();
    // Required questions are not final success, and an uncommitted compacted
    // view cannot acquire settlement authority through either callback.
    if (pauseCoordinator?.beforeBoundary()) throw new RunGracefulSuspensionBlocked("checkpoint.effect_unknown");
    if (uncommittedCompactionCode) throw new HttpError(409, uncommittedCompactionCode,
      "Final SDK settlement cannot bypass an uncommitted compaction.");
    if (gracefulSuspensionController && !gracefulSuspensionController.hasPendingRequest()) {
      // Preserve this exact SDK window while waiting for real optional drain
      // and required fan-in. Shutdown aborts observation, not the executors.
      try {
        await observeSuccessfulDelegations(AbortSignal.any([abortController.signal, gracefulSuspensionController.requestSignal]));
        delegationCompletionObservedAtSdkBoundary = true;
      } catch (error) {
        abortController.signal.throwIfAborted();
        if (!gracefulSuspensionController.hasPendingRequest()) throw error;
      }
      assertCurrentRunAdmission();
      verifyFinalSettlementRecovery();
      verifyDelegatedRecovery();
    }
    finalSettlementBoundary = boundary;
    try {
      const directive = await gracefulSuspensionController?.beforeSettledBoundary({
        modelView: redactCompactionModelView(modelView, resolvedSecretValues),
        activeToolCallIds: [...new Set([...activeToolCallCounts.keys(), ...unpairedToolCallIds])] });
      if (directive) suspensionOrder.ready(suspensionSource);
      return directive;
    } finally { finalSettlementBoundary = "original"; }
  };
  let hostToolBoundaryEntered = existingContinuation?.origin === "approval_resume";
  let hostBoundaryUnverified = hostToolBoundaryEntered;
  const hostToolCalls = new Set<string>();
  const delegationToolSurfaceEnabled = runnerRequest.initialToolSurface?.delegation === true;
  if (delegationToolSurfaceEnabled && !dynamicDelegationRegistry) {
    throw new HttpError(409, "delegation.dynamic_gate_unavailable", "Dynamic delegation Host binding is unavailable.");
  }
  let delegationParentTools: ReturnType<DelegationRuntimeRegistry["bindParent"]> | undefined;
  const delegationRunnerToolHandler: PiRunnerRunOptions["onDelegationToolCall"] = delegationToolSurfaceEnabled
    ? async request => {
        // The prepared tool surface is frozen before Runner start, but the
        // parent authority becomes executable only after the exact Attempt is
        // running. Bind lazily at the first real tool call; every delegated
        // mutation still revalidates this same live Host fence.
        delegationParentTools ??= dynamicDelegationRegistry!.bindParent({ store, runId: run.id,
          sourceFence: runnerCallbackFence, assertCurrent: assertCurrentRunAdmission });
        return createDelegationRunnerToolHandler({ tools: delegationParentTools,
          signal: abortController.signal })(request);
      }
    : undefined;
  const delegationProgressBinding = delegatedExecution ? Object.freeze({
    reservationId: delegatedExecution.claimed.reservation.id,
    targetFence: runnerCallbackFence,
  }) : undefined;
  // Other continuation origins keep their existing explicit retry/approval
  // semantics. Their facts cannot be silently promoted as daemon recovery.
  if (hostCompactionEnabled && (!existingContinuation || existingContinuation.origin === "daemon_recovery")) {
    ordinaryProgressController = new OrdinaryRunProgressController({ store, run,
      sourceFence: runnerCallbackFence, policySnapshot: effectivePolicySnapshot,
      delegationBinding: delegationProgressBinding,
      ...(ordinaryProgressRecoveryWitness && delegatedRecovery ? { recovery: {
        witness: ordinaryProgressRecoveryWitness, modelView: ordinaryProgressRecoveryModelView!,
        delegationBinding: delegatedRecovery.delegationBinding,
      } } : ordinaryProgressRecoveryWitness && continuationExecution ? { recovery: {
        witness: ordinaryProgressRecoveryWitness, modelView: ordinaryProgressRecoveryModelView!,
        continuationBinding: { continuationId: continuationExecution.continuation.id, targetFence: runnerCallbackFence },
      } } : {}) });
    gracefulSuspensionController = new RunGracefulSuspensionController({ store, run,
      sourceFence: runnerCallbackFence, policySnapshot: activeEffectivePolicySnapshot,
      progress: ordinaryProgressController,
      compactionProgress: input => sealRunCompactionSuspensionBoundary({ store, run, attempt,
        sourceFence: runnerCallbackFence, policySnapshot: activeEffectivePolicySnapshot,
        modelView: input.modelView, activeToolCallIds: input.activeToolCallIds,
        allowRecoveredAttemptHandoff: Boolean(compactionRecoveryModelView) }),
      settlementProgress: input => {
        if (!Array.isArray(input.modelView)) return { kind: "blocked", code: "checkpoint.snapshot_unavailable" };
        try {
          const current = store.getRun(run.id);
          if (!current) return { kind: "blocked", code: "checkpoint.lineage_mismatch" };
          const { lineage } = captureRunProgressCheckpointLineage(store, current, activeEffectivePolicySnapshot);
          const committed = commitOriginalRunFinalSettlement({ store, supervisor: runtimeSupervisor,
            observation: { runId: run.id, sourceFence: runnerCallbackFence, boundary: finalSettlementBoundary, observation: toolBoundaryObservation,
              hostToolCallIds: [...hostToolCalls], activeToolCallIds: input.activeToolCallIds,
              hostBoundaryUnverified, assertCurrent: assertCurrentRunAdmission,
              redact: view => redactCompactionModelView(view, resolvedSecretValues) },
            settlement: { runId: run.id, sourceFence: runnerCallbackFence, expectedLineage: lineage,
              modelView: input.modelView, now: executionNow() } });
          if (committed.kind === "verified") return { kind: "sealed", witness: committed.witness };
          return { kind: "blocked", code: committed.kind === "blocked" ? committed.code : "checkpoint.missing" };
        } catch (error) {
          if (error instanceof RunProgressCheckpointError) return { kind: "blocked", code: error.code };
          throw error;
        }
      },
      // Resolve constructor custody only when a real shutdown requests it.
      // Ordinary direct fixtures/disabled installations do not gain a writer.
      lifecycle: {
        requestRunSuspension: input => readOriginalRunSuspensionLifecycle(store, runtimeSupervisor).requestRunSuspension(input),
        sealRunSuspension: input => readOriginalRunSuspensionLifecycle(store, runtimeSupervisor).sealRunSuspension(input),
        beginRunSuspensionStop: input => readOriginalRunSuspensionLifecycle(store, runtimeSupervisor).beginRunSuspensionStop(input),
        commitRunSuspensionStopped: input => readOriginalRunSuspensionLifecycle(store, runtimeSupervisor).commitRunSuspensionStopped(input),
        getRunSuspensionStop: id => readOriginalRunSuspensionLifecycle(store, runtimeSupervisor).getRunSuspensionStop(id),
      },
      assertCurrent: assertCurrentRunAdmission,
      assertCleanupCurrent: () => {
        // Core's own begin-stop may have changed a child to cancelling. Do not
        // reuse its live dispatch gate, or remove the abort guard to bypass it.
        abortController.signal.throwIfAborted();
        if (runtimeSupervisor.getRuntime(workspaceCwd, store).runtimeInstanceId !== attempt.runtimeInstanceId
          || !store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence, true)) {
          throw new RunGracefulSuspensionBlocked("suspension.source_stale");
        }
        const current = store.getRun(run.id)!;
        if (delegatedExecution) delegatedExecution.assertSuspensionCleanupCurrent();
        else assertWorkflowRunAdmission(store, current, workflowStartOwner, abortController.signal);
        const teammate = current.teammateId ? store.getAiTeammate(current.teammateId) : undefined;
        const channel = current.channelId ? store.getChannel(current.channelId) : undefined;
        if (current.teammateId && (!teammate || teammate.status !== "active" || teammate.hidden)
          || current.channelId && (!channel || channel.status !== "active")) {
          throw new RunGracefulSuspensionBlocked("checkpoint.permission_drift");
        }
        captureRunProgressCheckpointLineage(store, current, activeEffectivePolicySnapshot);
      }, now: executionNow,
      awaitDescendantsReady: () => suspensionOrder.waitForDescendants(suspensionSource, "ready") });
  }
  localWriters = new AttemptLocalWriterGroup({ runId: run.id, ...runnerCallbackFence });
  // The turn's persisted source item is the only valid question anchor. If a
  // legacy/internal run has no canonical item, do not expose request_user_input
  // rather than guessing from the latest message or task id.
  const userInputSelected = userInputAvailable()
    && runnerRequest.initialToolSurface?.userInput === true;
  // Observe already journaled execution independently of the internal question tool.
  // Off/shadow keep their existing fallback behavior and cannot supply this proof.
  if (durableRunRequest.harnessFeatureSnapshot?.toolBroker === "enforce") {
    hostOperationTracker = new AttemptHostOperationTracker({
      store,
      source: { runId: run.id, ...runnerCallbackFence },
    });
    activeRuns.registerAttemptExecutors(hostOperationTracker.executorGroup);
  }
  // The turn's persisted source item is the only valid question anchor. If a
  // legacy/internal run has no canonical item, do not expose request_user_input
  // rather than guessing from the latest message or task id.
  if (userInputSelected && hostOperationTracker && turn.sourceItemId) {
    pauseCoordinator = new UserInputPauseCoordinator({
      store,
      runId: run.id,
      sourceItemId: turn.sourceItemId,
      sourceFence: runnerCallbackFence,
      runnerId: runnerResolution.effectiveRunnerId,
      executorGroup: hostOperationTracker.executorGroup,
      signal: abortController.signal,
      now: executionNow,
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
        || type === "message_end" || type === "turn_end"
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
        executionNow(),
      );
      supervision.activity();
      if (type === "approval_requested"
        && approvalEventReflectsRunState(store, envelope)
        && !isNativeApprovalEvent(store, envelope)) {
        // The approval handler starts this pause before persistence. Keep the
        // event-side update idempotent for paths that append the event first.
        beginApprovalHardTimeoutPause();
      } else if (type === "approval_approved" && !isNativeApprovalEvent(store, envelope)) {
        endApprovalHardTimeoutPause();
      }
      if (type === "run_error") {
        persistedRunError = true;
      }
      syncWorkUnitForRunEvent(store, workUnit.id, attempt.id, type, envelope);
      if (type === "approval_requested" && shutdownSuspensionCause
        && gracefulSuspensionController?.hasPendingRequest()
        && store.getRun(run.id)?.status === "waiting_for_approval"
        && store.getWorkUnit(workUnit.id)?.status === "waiting_for_approval") {
        // Shutdown can persist an ordinary request immediately before a tool
        // commits its approval. There is no subsequent provider boundary to
        // seal. Stop the actual wait, but do not manufacture a checkpoint or
        // downgrade that ordinary request to approval-resume authority.
        approvalSuspensionBlocked = new RunGracefulSuspensionBlocked("suspension.boundary_unavailable");
        suspensionOrder.block(suspensionSource, approvalSuspensionBlocked);
        if (isCapturedActiveAttempt()) activeRuns.requestStop(run.id, { kind: "runtime_suspend",
          cause: shutdownSuspensionCause, runtimeInstanceId: runnerCallbackFence.runtimeInstanceId });
      }
      appendRuntimeProgressForRunEvent(store, workUnit.id, attempt.id, type, envelope);
      if (!delegatedExecution) syncLingThreadForRunEvent(store, run, type, envelope);
      try {
        appendExecutionActionInvalidation({
          store,
          hub: options.controlPlaneEvents,
          cwd: workspaceCwd,
          event: envelope,
        });
        appendContextCompactionInvalidation({ store, hub: options.controlPlaneEvents, cwd: workspaceCwd, event: envelope });
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

  const scheduleDelegationRecoveryAfterAck = (): void => {
    const registry = dynamicDelegationRegistry;
    if (!registry) return;
    queueMicrotask(() => {
      try { registry.recoverStore(store); }
      catch {
        // Discovery is a retryable observer, not ownership of the committed
        // ACK. The bounded registry sweep can revisit it without redispatching
        // a consumed activation; surface the unavailable scan, not a false failure.
        if (!sinkClosed) sink.writeEvent("delegation_blocked", { runId: run.id, status: "blocked",
          code: "delegation.recovery_discovery_unavailable" });
      }
    });
  };

  const startObservedRuntime = (startedAt: string, alreadyStartedByCore: boolean): void => {
    if (runtimeStarted) throw new Error("Runner start was accepted more than once.");
    runStartedAt = startedAt;
    const runBeforeStart = store.getRun(run.id);
    if (!runBeforeStart) throw new Error("Run disappeared before Runner start.");
    if (!alreadyStartedByCore && runBeforeStart.status === "queued") {
      const runStartTransition = store.transitionRunExecutionStatus({
        runId: run.id,
        sourceFence: runnerCallbackFence,
        expectedStatus: "queued",
        event: "runner_started",
        actor: "runner",
        now: startedAt,
        startedAt,
      });
      if (!runStartTransition.ok) {
        throw new Error(`Run transition failed: ${runStartTransition.code}`);
      }
    } else if (runBeforeStart.status !== "running") {
      throw new Error(`Run start requires queued or running state, received ${runBeforeStart.status}.`);
    }
    const workUnitBeforeStart = store.getWorkUnit(workUnit.id);
    if (!workUnitBeforeStart) throw new Error("Work unit disappeared before Runner start.");
    if (!alreadyStartedByCore && workUnitBeforeStart.status === "claimed") {
      const workUnitStartTransition = store.transitionWorkUnitStatus({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        activeAttemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        expectedStatus: "claimed",
        event: "runner_started",
        actor: "runner",
        now: startedAt,
        startedAt,
        lastHeartbeatAt: startedAt,
      });
      if (!workUnitStartTransition.ok) {
        throw new Error(`Work unit start failed: ${workUnitStartTransition.code}`);
      }
      appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd,
        workUnit.id, "claimed", "running", run.id, startedAt);
    } else if (workUnitBeforeStart.status !== "running") {
      throw new Error(`Work unit start requires claimed or running state, received ${workUnitBeforeStart.status}.`);
    }
    if (alreadyStartedByCore) {
      appendWorkUnitTransitionControlPlaneEvent(store, options.controlPlaneEvents, workspaceCwd,
        workUnit.id, "claimed", "running", run.id, startedAt);
    }
    if (!alreadyStartedByCore && continuationExecution) {
      continuationExecution = startPreparedRunnerContinuation(store, continuationExecution, startedAt);
    } else if (!alreadyStartedByCore) {
      store.updateWorkUnitAttemptStatus({
        attemptId: attempt.id,
        workUnitId: attempt.workUnitId,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        status: "started",
        now: startedAt,
        startedAt,
        lastHeartbeatAt: startedAt,
      });
    } else if (store.getWorkUnitAttempt(attempt.id)?.status !== "started") {
      throw new Error("Accepted user input continuation Attempt is not started.");
    }
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      type: "work_unit_started",
      actor: "runner",
      ts: startedAt,
      data: { runId: run.id },
    });
    recordRuntimeHeartbeat("runner", { event: "runner_started" });
    if (localWriters) {
      const capturedWriters = localWriters;
      // Persist only after the original main lifetime and its closed callback
      // group drain. This observes off/shadow without enabling Broker enforcement.
      durableAttemptCompletion = observeHostAttemptCompletion(store, capturedWriters.source,
        runCompletion.then(() => capturedWriters.waitForIdle()),
        () => {
          if (!hostToolBoundaryEntered && isPiToolFreeCompletion(toolBoundaryObservation, run.id, attempt.id)) return true;
          const sdkTools = readPiCompletedTools(toolBoundaryObservation, run.id, attempt.id);
          const settledBuiltinReads = readPiCompletedBuiltinReads(toolBoundaryObservation, run.id, attempt.id);
          if (hostBoundaryUnverified || !sdkTools || !settledBuiltinReads) return false;
          const settledDelegationCalls = sdkTools.filter(tool => (DELEGATION_TOOL_NAMES as readonly string[]).includes(tool.toolName))
            .map(tool => ({ toolCallId: tool.toolCallId,
              toolName: tool.toolName as (typeof DELEGATION_TOOL_NAMES)[number] }));
          const toolCallIds = [...new Set([...sdkTools.map(tool => tool.toolCallId), ...hostToolCalls])];
          const delegationIds = new Set(settledDelegationCalls.map(call => call.toolCallId));
          if (!hostOperationTracker && toolCallIds.some(id => !delegationIds.has(id)
            && !settledBuiltinReads.some(read => read.toolCallId === id))) return false;
          return { schemaVersion: 1, toolCallIds, settledBuiltinReads,
            ...(settledDelegationCalls.length ? { settledDelegationCalls } : {}) };
        }, () => activeRuns.retireDurablyDrainedAttempt(capturedWriters.source));
      activeRuns.trackAttemptCompletion(capturedWriters.source, durableAttemptCompletion);
      if (dynamicDelegationRegistry) {
        const originalRegistry = dynamicDelegationRegistry;
        activeRuns.trackAttemptCompletion(capturedWriters.source,
          durableAttemptCompletion.then(() => originalRegistry.reconcileTerminalIntents(store)));
      }
    }
    runtimeStarted = true;
    supervision.start();
    if (preparedConcurrency.taskExists) {
      const taskBeforeStart = store.getTask(run.taskId);
      if (!alreadyStartedByCore && taskBeforeStart?.status === "claimed") {
        const taskStartTransition = store.transitionTaskStatus({
          taskId: run.taskId,
          expectedStatus: "claimed",
          event: "start_run",
          actor: "runner",
          now: startedAt,
          currentRunId: run.id,
        });
        if (!taskStartTransition.ok) {
          throw new Error(`Task transition failed: ${taskStartTransition.code}`);
        }
      } else if (taskBeforeStart?.status !== "running") {
        throw new Error(`Task start requires claimed or running state, received ${taskBeforeStart?.status ?? "missing"}.`);
      }
    }
  };

  try {
    if (!approvalPolicy) {
      throw new Error("Run approval policy was not initialized.");
    }
    if (!delegatedExecution && !userInputBinding && !rootSuspensionActivation) startObservedRuntime(executionNow(), false);
    // Complete Host start bookkeeping so shutdown has a legal fenced failure
    // transition, then reject before any Runner or approval tool is invoked.
    await waitForTaskContinuation("run_start");
    abortController.signal.throwIfAborted();
    const runApprovalHandler = createRunApprovalHandler({
      recordCompactionBoundaryEvidence: hostCompactionEnabled,
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
        supervision.activity();
        endApprovalHardTimeoutPause();
      },
      onExistingApprovalDecisionEvent: (envelope) => {
        syncWorkUnitForRunEvent(store, workUnit.id, attempt.id, envelope.type, envelope);
        appendRuntimeProgressForRunEvent(store, workUnit.id, attempt.id, envelope.type, envelope);
        if (!delegatedExecution) syncLingThreadForRunEvent(store, run, envelope.type, envelope);
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
      ...(runnerResolution.runner.adapter instanceof PiRunnerAdapter && runtimeSupervisor.getHarnessFeatures().delegations.mode !== "off"
        && (!run.parentRunId || delegatedExecution) ? { providerBudget: bindOriginalDelegationProviderBudget({ store, run, attempt, originalProvider: activeProvider }) } : {}),
      ...(delegationRunnerToolHandler ? { onDelegationToolCall: delegationRunnerToolHandler } : {}),
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
      onToolBoundaryObservation: receipt => {
        if (toolBoundaryObservation) { hostToolBoundaryEntered = true; hostBoundaryUnverified = true; }
        toolBoundaryObservation = receipt;
      },
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
        try { assertCurrentRunAdmission(); }
        catch (error) { return { allowed: false, code: delegatedExecution ? "delegation.source_attempt_stale" : "workflow_start_owner_stale",
          reason: error instanceof Error ? error.message : "Execution no longer owns this task and source." }; }
        const rejection = delegatedExecution ? undefined : workflowOperationEffectRejection({ store, run, request,
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
      onTaskSettledBoundary: modelView => beforeFinalCompletionBoundary(modelView, "original"),
      onTaskRestoredCompleteBoundary: modelView => beforeFinalCompletionBoundary(modelView, "restored"),
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
        if (!userInputReceiverAccepted) {
          pendingUserInputRunnerEvents.push(event);
          return;
        }
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
                capturedAt: executionNow(),
                messages: redactSecrets(event.contextSnapshot, resolvedSecretValues),
              },
              createdAt: executionNow(),
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
    flushPendingUserInputRunnerEvents = (): void => {
      userInputReceiverAccepted = true;
      for (const pendingEvent of pendingUserInputRunnerEvents.splice(0)) {
        boundRunnerRequest.onEvent?.(pendingEvent);
      }
    };
    assertCurrentRunAdmission();
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
            workflowStartOwner,
          })
        : undefined;
    const unscopedContinuationRequest = approvedToolContinuation
      ? { ...boundRunnerRequest, approvedToolContinuation }
      : boundRunnerRequest;
    const continuationRunnerRequest = localWriters
      ? scopeUserInputLocalWriters(unscopedContinuationRequest, localWriters, {
          requireTrackedMedia: hostOperationTracker !== undefined,
          onToolBoundary: request => {
            hostToolBoundaryEntered = true;
            const id = request && typeof request === "object" && "toolCallId" in request ? request.toolCallId : undefined;
            if (typeof id === "string" && id) hostToolCalls.add(id);
            else hostBoundaryUnverified = true;
          },
        })
      : unscopedContinuationRequest;
    const executableRunnerRequest = delegatedExecution
      ? delegatedExecution.dispatchAuthority.withReceiver({ store, child: delegatedExecution.claimed,
          prepared: delegatedPreparation!, adapter: runnerResolution.runner.adapter, options: continuationRunnerRequest,
          now: executionNow, onAccepted: (reference, acceptedAt) => {
            verifyDelegatedRecovery();
            delegatedExecution!.commitStart(reference, acceptedAt);
            delegatedAckCommitted = true;
            startObservedRuntime(acceptedAt, true);
            flushPendingUserInputRunnerEvents();
            scheduleDelegationRecoveryAfterAck();
          } })
      : rootSuspensionActivation
      ? withOriginalRootRunSuspensionReceiver({ store, supervisor: runtimeSupervisor, record: rootSuspensionActivation,
          execution: continuationExecution!, adapter: runnerResolution.runner.adapter, options: continuationRunnerRequest,
          beforeAccepted: () => {
            assertCurrentRunAdmission();
            verifyFinalSettlementRecovery();
            const progress = ordinaryProgressController?.verifyRecoveryBoundary();
            if (progress?.kind === "blocked") throw new HttpError(409, progress.code,
              "The restored root checkpoint changed before its SDK acknowledgement.");
          },
          now: executionNow, onAccepted: (started, acceptedAt) => {
            assertCurrentRunAdmission();
            continuationExecution = { ...continuationExecution!, continuation: started.continuation, attempt: started.attempt };
            startObservedRuntime(acceptedAt, true);
            flushPendingUserInputRunnerEvents();
            scheduleDelegationRecoveryAfterAck();
          } })
      : userInputBinding
      ? withUserInputContinuationReceiver({
          store,
          threadId: userInputContinuation!.threadId,
          binding: userInputBinding,
          claim: userInputClaim!,
          adapter: runnerResolution.runner.adapter,
          options: continuationRunnerRequest,
          now: lifecycleNow,
          onAccepted: (acceptedAt) => {
            startObservedRuntime(acceptedAt, true);
            flushPendingUserInputRunnerEvents();
            try {
              options.onUserInputReceiverAccepted?.({ runId: userInputBinding!.runId,
                deliveryId: userInputBinding!.deliveryId, acceptedAt });
            } catch {
              // Process-local scheduling observers never own the durable ACK or
              // the model execution that is now allowed to proceed.
            }
          },
        })
      : continuationRunnerRequest;
    assertCurrentRunAdmission();
    const reconstruction = continuationExecution
      ? await executeRunnerContinuationReconstruction({
          store,
          continuation: continuationExecution.continuation,
          runner: runnerResolution.runner,
          targetFence: runnerCallbackFence,
          workspaceCwd,
          policySnapshot: effectivePolicySnapshot,
          liveOptions: executableRunnerRequest,
        })
      : undefined;
    if (reconstruction && !reconstruction.ok) {
      throw new Error(reconstruction.failureCode);
    }
    assertCurrentRunAdmission();
    const result = reconstruction?.result
      ?? await runnerResolution.runner.adapter.runTask(executableRunnerRequest);
    gracefulSuspensionController?.assertSuspensionHandled();
    if ((delegatedExecution || rootSuspensionActivation) && !runtimeStarted) {
      throw new HttpError(409, "delegation.receiver_unacknowledged", "Runner returned without its real prepared-input ACK.");
    }
    if (delegatedExecution?.isInterrupting()) {
      delegatedInterrupted = true;
      if (!sinkClosed) sink.end();
      return run.id;
    }

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

    if (!delegationCompletionObservedAtSdkBoundary) await observeSuccessfulDelegations(abortController.signal);
    gracefulSuspensionController?.assertSuspensionHandled();
    // Keep the transaction's completion barrier too: a concurrent descendant
    // admission can change the read set after the asynchronous observation.
    assertCurrentRunAdmission();
    const endedAt = executionNow();
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
    if (!delegatedExecution) syncLingThreadForTerminalRun(store, run.id, endedAt);

    if (!sinkClosed) {
      sink.end();
    }
  } catch (error) {
    if (approvalSuspensionBlocked && store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence, true)) {
      retainExecutionAuthority = true;
      suspensionOrder.block(suspensionSource, approvalSuspensionBlocked);
      if (!sinkClosed) {
        sink.writeError(409, { error: approvalSuspensionBlocked instanceof RunGracefulSuspensionBlocked
          ? approvalSuspensionBlocked.code : "suspension.stop_unverified", message: "Approval suspension remains unverified." });
        sink.end();
      }
      return run.id;
    }
    if (gracefulSuspensionController?.hasPendingRequest()) {
      try {
        if (!(error instanceof PiRunnerSuspended)) {
          // Keep a verified boundary's real blocker. The fallback guard is for
          // an ordinary result/error with no handled suspension, not a reason
          // to replace effect/permission/lineage failures with "no boundary".
          if (error instanceof RunGracefulSuspensionBlocked) throw error;
          gracefulSuspensionController.assertSuspensionHandled();
          throw error;
        }
        gracefulSuspensionController.observeSuspended(error);
        gracefullySuspended = true;
        if (!sinkClosed) sink.end();
      } catch (suspensionError) {
        retainExecutionAuthority = true;
        suspensionOrder.block(suspensionSource, suspensionError);
        if (!sinkClosed) {
          sink.writeError(409, { error: suspensionError instanceof RunGracefulSuspensionBlocked
            ? suspensionError.code : "suspension.stop_unverified", message: "Graceful suspension remains unverified." });
          sink.end();
        }
      }
      return run.id;
    }
    const stopIntent = activeRuns.getStopIntent(run.id) ?? readActiveRunStopIntent(abortController.signal.reason);
    const observedRun = store.getRun(run.id);
    const observedWorkUnit = store.getWorkUnit(workUnit.id);
    const observedAttempt = store.getWorkUnitAttempt(attempt.id);
    if (error instanceof DelegationCompletionBarrierError
      && (error.status === "pending" || error.status === "blocked")) {
      // Incomplete/unknown child effects are a recovery blocker, not a Runner
      // failure or a stopped-Host receipt. Preserve the exact original owner.
      retainExecutionAuthority = true;
      if (!sinkClosed) {
        sink.writeEvent("delegation_blocked", { runId: run.id, status: "blocked",
          code: error.code, completionStatus: error.status, evidenceFingerprint: error.fingerprint });
        sink.end();
      }
      return run.id;
    }
    if ((delegatedExecution || rootSuspensionActivation) && !runtimeStarted) {
      // No ACK is not a terminal proof. In particular an adapter resolving or
      // rejecting cannot turn a claimed child into success/zero-cost failure.
      retainExecutionAuthority = true;
      if (!sinkClosed) {
        sink.writeEvent("delegation_blocked", { runId: run.id, status: "blocked",
          code: error instanceof HttpError ? error.code : rootSuspensionActivation
            ? "suspension_start.receiver_unacknowledged" : delegatedAckCommitted
            ? "delegation.start_bookkeeping_unverified" : "delegation.receiver_unacknowledged" });
        sink.end();
      }
      return run.id;
    }
    if (delegatedExecution && store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence, true)
      && delegatedExecution.isInterrupting()) {
      delegatedInterrupted = true;
      if (!sinkClosed) sink.end();
      return run.id;
    }
    const unacknowledgedUserInputStartup = Boolean(userInputBinding
      && !store.getUserInputContinuationReceipt(userInputContinuation!.threadId, userInputBinding.deliveryId)
      && observedRun?.status === "queued"
      && observedWorkUnit?.status === "claimed"
      && observedWorkUnit.activeAttemptId === attempt.id
      && observedAttempt?.status === "created");
    if (unacknowledgedUserInputStartup && userInputBinding
      && error instanceof HttpError && error.code === "workflow_start_owner_stale"
      && failUserInputAnswerStartup(store, userInputBinding, userInputClaim!,
        error.code, error.message, executionNow())) {
      if (!sinkClosed) {
        sink.writeError(error.statusCode, { error: error.code, message: error.message });
        sink.end();
      }
      return undefined;
    }
    if (unacknowledgedUserInputStartup && userInputBinding) {
      // The Pi session never crossed the durable receiver boundary. Keep the
      // admitted binding intact so another daemon can reopen the same frozen
      // Run/Attempt; no model request, terminal state, or applied answer exists.
      if (!sinkClosed) {
        sink.writeEvent("user_input_receiver_unavailable", {
          runId: run.id,
          deliveryId: userInputBinding.deliveryId,
          code: error instanceof HttpError ? error.code : "user_input_receiver_unavailable",
        });
        sink.end();
      }
      return run.id;
    }
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
      supervision.stopWatchdogs();
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
      if (!await settleDelegationsBeforeTerminal("cancelled")) return run.id;
      const cancelledAt = executionNow();
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
      if (delegatedExecution && observedRun && observedRun.status !== "cancelled") {
        const cancelled = store.transitionRunExecutionStatus({ runId: run.id, sourceFence: runnerCallbackFence,
          expectedStatus: observedRun.status, event: "cancel", actor: "system", reason: "delegated execution cancelled",
          now: cancelledAt, endedAt: cancelledAt });
        if (!cancelled.ok) throw new HttpError(409, "delegation.source_attempt_stale", "Delegated cancellation lost its original source.");
      } else if (!delegatedExecution) {
        ensureRunCancelled({
          store,
          runId: run.id,
          taskId: run.taskId,
          startedAt: runStartedAt,
          reason: "cancelled",
          active: false,
          streamEnvelope,
          now: executionNow,
        });
      }
      transitionWorkUnitCancelled(store, workUnit.id, attempt.id, "cancelled", cancelledAt);
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
      if (!delegatedExecution) syncLingThreadForTerminalRun(store, run.id, cancelledAt);
      if (!sinkClosed) {
        sink.end();
      }
      return run.id;
    }
    if (stopIntent?.kind === "runtime_suspend") {
      if (observedRun?.status === "waiting_for_approval"
        || observedWorkUnit?.status === "waiting_for_approval") {
        try {
          const capturedApproval = readApprovalWaitSuspension();
          if (!localWriters) throw new RunGracefulSuspensionBlocked("suspension.stop_unverified");
          const capturedWriters = localWriters;
          const cause = stopIntent.cause;
          const commitCapturedApprovalSuspension = (): void => {
            const writerSnapshot = capturedWriters.getSnapshot();
            if (!writerSnapshot.closed || writerSnapshot.writers.length
              || store.listHostOperationBlockers({ runId: run.id, ...runnerCallbackFence }).length) {
              throw new RunGracefulSuspensionBlocked("suspension.stop_unverified");
            }
            // A drain is not fresh authorization. Revalidate the same original
            // checkpoint, including its revision, before the atomic Core CAS.
            const { approval, checkpoint, checkpointStatus, workUnit: approvalUnit } = readApprovalWaitSuspension();
            if (approval.id !== capturedApproval.approval.id || checkpoint.id !== capturedApproval.checkpoint.id
              || checkpoint.revision !== capturedApproval.checkpoint.revision
              || checkpointStatus !== capturedApproval.checkpointStatus
              || checkpoint.resumeBasis?.fingerprint !== capturedApproval.checkpoint.resumeBasis?.fingerprint) {
              throw new RunGracefulSuspensionBlocked("suspension.witness_mismatch");
            }
            const suspension = store.commitApprovalResumeSuspension({
              kind: "approval_wait",
              checkpointId: checkpoint.id,
              expectedCheckpointStatus: checkpointStatus,
              expectedCheckpointRevision: checkpoint.revision,
              approvalId: approval.id,
              runId: run.id,
              expectedRunStatus: "waiting_for_approval",
              workUnitId: approvalUnit.id,
              expectedWorkUnitStatus: "waiting_for_approval",
              attemptId: attempt.id,
              cause,
              now: executionNow(),
            });
            if (!suspension.ok) throw new RunGracefulSuspensionBlocked("suspension.witness_mismatch");
            for (const event of suspension.controlPlaneEvents) {
              try { options.controlPlaneEvents?.publish(event); }
              catch {
                // The Core CAS is already committed. A consumer failure must
                // not turn notification delivery into a second stop decision;
                // these durable invalidations remain available for replay.
                console.warn("approval_suspension_notification_failed: committed invalidation remains replayable");
              }
            }
          };
          capturedWriters.close();
          try { await capturedWriters.waitForIdle(1000); }
          catch (drainError) {
            const snapshot = capturedWriters.getSnapshot();
            if (!snapshot.closed || !snapshot.writers.length) throw drainError;
            // Only the observation expired. Preserve this already-validated
            // source's continuation until its original callbacks really drain.
            // The registry's drain callback still has the exact active fence.
            deferredApprovalSuspension = commitCapturedApprovalSuspension;
            retainExecutionAuthority = true;
            if (!sinkClosed) sink.end();
            return run.id;
          }
          commitCapturedApprovalSuspension();
          if (!sinkClosed) sink.end();
          return run.id;
        } catch (suspensionError) {
          retainExecutionAuthority = store.isCurrentRunExecutionOwner(run.id, runnerCallbackFence, true);
          suspensionOrder.block(suspensionSource, suspensionError);
          if (!sinkClosed) {
            sink.writeError(409, { error: suspensionError instanceof RunGracefulSuspensionBlocked
              ? suspensionError.code : "suspension.stop_unverified", message: "Approval suspension remains unverified." });
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
    if (!await settleDelegationsBeforeTerminal("failed", { code: runtimeFailure?.code ?? "runner_failed", message })) return run.id;
    const endedAt = executionNow();
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
          endedAt,
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
    if (!delegatedExecution) syncLingThreadForTerminalRun(store, run.id, endedAt);

    if (!sinkClosed) {
      sink.end();
    }
  } finally {
    if (retainExecutionAuthority && localWriters) {
      if (!deferredApprovalSuspension) {
        suspensionOrder.block(suspensionSource, new Error("runtime_suspension_source_retained"));
      }
      // The execution function is returning. Transfer remaining local callback
      // ownership to the registry; never release the SQLite attempt/resources.
      supervision.stopWatchdogs();
      activeRuns.retainBlockedAttempt(run.id, localWriters, () => {
        let approvalSuspended = false;
        try {
          if (deferredApprovalSuspension) {
            deferredApprovalSuspension();
            approvalSuspended = true;
            retainExecutionAuthority = false;
          }
        } catch (suspensionError) {
          suspensionOrder.block(suspensionSource, suspensionError);
        } finally {
          supervision.dispose();
          resolveRunCompletion?.();
        }
        if (approvalSuspended) {
          // Let the original completion observer finish after the main lifetime
          // resolves; never await our own callback. Observer fulfillment itself
          // is not a durable receipt: Core's resource veto remains authoritative.
          activeRuns.trackCompletion(Promise.resolve(durableAttemptCompletion).then(() => {
            suspensionOrder.finish(suspensionSource);
          }, completionError => {
            suspensionOrder.block(suspensionSource, completionError);
          }));
        }
      });
    } else if (!retainExecutionAuthority) {
      localWriters?.close();
      if (localWriters) activeRuns.trackAttemptCompletion(localWriters.source, localWriters.waitForIdle());
      supervision.dispose();
      // Started executions release through their durable completion observer,
      // after execution and local writers drain. Preparation failures
      // have not registered a lifetime and still need their original cleanup.
      if (!yieldedWait && !runtimeStarted) {
        const releaseAt = executionNow();
        store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), releaseAt, "run-finished");
        store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), releaseAt, "run-finished");
      }
      if (activeRuns.get(run.id)?.attemptId === attempt.id) activeRuns.delete(run.id);
      try {
        const terminalRun = store.getRun(run.id);
        if (gracefullySuspended && gracefulSuspensionController) {
          // Resolve the original callback lifetime first. Waiting on this at
          // the SDK boundary would deadlock the very source being suspended.
          resolveRunCompletion?.();
          await durableAttemptCompletion;
          await suspensionOrder.waitForDescendants(suspensionSource, "finished");
          gracefulSuspensionController.commitStopped();
        } else if (delegatedInterrupted && delegatedExecution) {
          resolveRunCompletion?.();
          await durableAttemptCompletion;
          delegatedExecution.commitInterrupted(executionNow());
        } else if (yieldedWait) {
          await options.afterRunYielded?.(terminalRun ?? run, yieldedWait);
        } else if (dynamicDelegationRegistry && store.hasPendingRunTerminalIntent({ runId: run.id, ...runnerCallbackFence })) {
          // A fast stop still uses the same durable finalizer as a delayed
          // drain. Keep this completion inside the original caller's awaited
          // lifetime, rather than racing its return against a later microtask.
          resolveRunCompletion?.();
          await durableAttemptCompletion;
          await dynamicDelegationRegistry.reconcileTerminalIntents(store);
        } else if (terminalRun && isTerminalRunStatus(terminalRun.status) && hasCurrentRunCallbackIdentity(store, run, runnerCallbackFence)) {
          try {
            computerUseProducer?.finish(terminalRun.status, terminalRun.errorMessage ?? undefined);
          } catch {
            // Computer Use projection finalization is best-effort and must not block run cleanup.
          }
          // Successors may acquire the same channel slot. End this execution's
          // lifetime and finish durable cleanup before admitting another Run.
          resolveRunCompletion?.();
          await durableAttemptCompletion;
          // Atomic Host result production follows the original lifetime and
          // exact-usage settlement. Narrative text and the Run status alone
          // never satisfy a required dynamic participant.
          if (delegatedExecution) delegatedExecution.terminal(executionNow());
          if (userInputBinding) {
            finalizeUserInputAnswerWorkflow(store, userInputBinding, terminalRun, terminalRun.endedAt ?? executionNow());
          }
          await options.afterRunTerminal?.(terminalRun);
        }
        suspensionOrder.finish(suspensionSource);
      } catch (finalizationError) {
        suspensionOrder.block(suspensionSource, finalizationError);
        throw finalizationError;
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

function isExistingRunRepreparationOrigin(
  origin: RunnerContinuationOrigin,
): origin is Extract<RunnerContinuationOrigin, "runner_retry" | "daemon_recovery" | "approval_resume"> {
  return origin === "runner_retry" || origin === "daemon_recovery" || origin === "approval_resume";
}

export function appendRunCreatedControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  run: RunSession,
  now: string,
  idempotencyKey?: string,
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
    idempotencyKey,
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

export function appendRunCompletedControlPlaneEvent(
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

export function appendRunCancelledControlPlaneEvent(
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

export function appendWorkUnitCreatedControlPlaneEvent(
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

export function appendWorkUnitTransitionControlPlaneEvent(
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

export function readActiveRunStopIntent(value: unknown): import("../../runtime/active-runs.js").ActiveRunStopIntentV1 | undefined {
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

export function isTerminalRunStatus(status: RunStatus): status is Extract<RunStatus, "succeeded" | "failed" | "cancelled"> {
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

export function validateWorkflowStepOwner(store: RunStore, runRequest: RunRequest): void {
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

export function toRunnerResolutionSnapshot(resolution: RunnerResolution): {
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

export function getExplicitRunnerRequestSource(runRequest: RunRequest): RunnerRequestSource {
  if (runRequest.workflowStepId) {
    return "workflow_step";
  }
  return "run_request";
}

export function resolveRunWorkUnitOwner(
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

export function assertFullAccessPermissionConfirmed(runRequest: RunRequest): void {
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

/** Selects the SDK installer only; the original Core ledger owns verification. */
function isCompactedModelView(view: readonly unknown[]): boolean {
  const first = view[0];
  return first !== null && typeof first === "object" && "role" in first && first.role === "compactionSummary";
}
