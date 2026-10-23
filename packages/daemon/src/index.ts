import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  listBuiltinSkillPackExtensions,
  listBuiltinToolExtensions,
  createCompositeSecretResolver,
  getRunSummaryPath,
  resolveStoragePaths,
  type RunStore,
} from "@ling-stack/core";
import { createPiRunner, getPiRunnerExtension } from "@ling-stack/runner-pi";
import {
  listBuiltinProviderExtensions,
} from "@ling-stack/providers";
import { isTerminalComputerUseStatus } from "@ling-stack/contracts";
import {
  createLingExtensionRegistry,
  type ChannelSourceExtensionMetadata,
  type LingExtensionRegistry,
} from "@ling-stack/plugin-sdk";
import {
  defaultDaemonConfig,
  resolveConfig,
  type DaemonConfig,
  type ResolvedDaemonConfig,
} from "./config.js";
import type { DaemonContext, DaemonDependencies, RunnerAdapter } from "./context.js";
import { AutomationSchedulerRegistry } from "./features/automations/scheduler.js";
import { ExternalWorkBackgroundSchedulerRegistry } from "./features/external-work/background-scheduler.js";
import { appendControlPlaneEvent, ControlPlaneEventHub } from "./features/control-plane/events.js";
import {
  configureTerminalReportStore,
  recoverTerminalReports,
} from "./features/channels/terminal-report-coordinator.js";
import { ChannelReplyDispatchCoordinator } from "./features/channels/channel-reply-dispatch-coordinator.js";
import { ChannelTurnDispatchWorkerRegistry } from "./features/channels/channel-turn-dispatch-worker.js";
import { createChannelTurnDispatchExecutor } from "./features/channels/channel-turn-dispatch-executor.js";
import { maybeScheduleRunTerminalReport } from "./features/channels/terminal-report-coordinator.js";
import { reconcileAllContinuityWorkflows } from "./features/channels/workflow-reconciliation.js";
import {
  maybeQueueGoalContinuation,
  maybeStartNextRunInterventionContinuation,
} from "./features/runs/interventions.js";
import { createDefaultMcpBroker } from "./features/mcp/broker.js";
import { createSystemKeychainSecretStore } from "./features/providers/keychain-secret-store.js";
import { createEngineSecretStore, withEngineSecretResolver } from "./features/execution-engines/engine-secret-store.js";
import { ProviderStartupRefreshService } from "./features/providers/startup-refresh.js";
import { ProviderImportPreflightService } from "./features/providers/import-preflight.js";
import { ActiveDirectReplyRegistry } from "./features/teammates/direct-reply-active-registry.js";
import { reconcileTeammateDirectRun, recoverPendingTeammateDirectMessages } from "./features/teammates/direct-message-lifecycle.js";
import { ApprovalResumeCoordinator } from "./features/runs/approval-resume-coordinator.js";
import { syncLingThreadForTerminalRun } from "./features/runs/threads.js";
import { writeTerminalSummary } from "./features/runs/terminal.js";
import { UserInputDeliveryWorker } from "./features/runs/user-input-delivery-worker.js";
import { createUserInputWorkflowTerminalHook } from "./features/runs/user-input-workflow-terminal.js";
import { ApprovalAutoReviewRecoveryCoordinator } from "./features/runs/approval-auto-review-recovery.js";
import { recoverApprovalPostCommitStore } from "./features/runs/approval-postcommit-recovery.js";
import { runApprovalPostCommitEffects } from "./features/runs/approval-postcommit-effects.js";
import { syncWorkflowApprovalDecision } from "./features/channels/orchestrator.js";
import { DaemonRunnerRecoveryCoordinator } from "./features/harness/continuations/daemon-recovery-coordinator.js";
import { reconcileHarnessToolExecutionsAtStartup } from "./features/harness/tool-execution/recovery.js";
import { RunEvaluationSchedulerRegistry } from "./features/harness/evaluations/scheduler.js";
import { RunEvaluationTaskWorkerComposition } from "./features/harness/evaluations/task-worker-composition.js";
import { HarnessProjectionReconciler } from "./features/harness/reliability/projection-reconciler.js";
import { HarnessLifecycleCoordinator } from "./features/harness/reliability/lifecycle-coordinator.js";
import { HarnessArtifactRetentionService } from "./features/harness/reliability/artifact-retention-service.js";
import { assertDelegationRecoveryParentCurrent, createDelegationRuntimeRegistry, createDelegationWorkflowSelector,
  type DelegationRuntimeRegistry } from "./features/harness/delegations/runtime-registry.js";
import type { OriginalDelegationLifecycle } from "./features/harness/delegations/store-composition.js";
import {
  createDetachedRunExecutionSink,
  executeDelegatedRunRequest,
  executeExistingRunContinuation,
  executeUserInputContinuation,
} from "./features/runs/orchestrator.js";
import { resumePendingMediaJobExecutions, syncMediaJobForApprovalDecision } from "./features/media/executor.js";
import { createNativeRunDispatcher } from "./features/runs/native-run-dispatcher.js";
import { publishConversationMediaProjectionChange } from "./features/media/conversation-events.js";
import { ActiveRunRegistry } from "./runtime/active-runs.js";
import { createRunShutdownCoordinator } from "./runtime/run-shutdown-coordinator.js";
import { createRunnerRegistry, DEFAULT_RUNNER_ID, LEGACY_PI_RUNNER_ID, type RunnerRegistry } from "./runtime/runners.js";
import { listNativeRunnerRegistrations } from "./runtime/native-runners.js";
import { RunStoreRegistry, type RunStoreFactory } from "./runtime/store-registry.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { createOriginalOfficeDirectoryStoreFactory } from "./features/office-documents/office-local-directory-core-authority.js";
import {
  retryRuntimeWorkUnit,
  startRuntimeWorkUnit,
  transitionWorkUnitCancelled,
  transitionWorkUnitTerminal,
} from "./runtime/work-units.js";
import { routeRequest } from "./server/router.js";
import { attachRpcWebSocketServer } from "./server/rpc.js";
import {
  CHROME_BROWSER_DEFAULT_EXTENSION_IDS,
  CHROME_BROWSER_PLUGIN_ID,
  CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
} from "@ling-stack/contracts";
import { ChromeBrowserSessionController } from "./features/browser-extension/session-controller.js";
import { attachChromeBrowserWebSocketServer } from "./features/browser-extension/websocket-server.js";
import { createChromeBrowserNativeBroker } from "./features/browser-extension/native-broker.js";
import { shutdownAfterNativeBroker } from "./features/browser-extension/native-broker-shutdown.js";
import { ChromeBrowserPluginService, normalizeChromeBrowserStoreUrl } from "./features/plugins/chrome-browser.js";
import { createChromeBrowserGenerationBroker } from "./features/plugins/chrome-browser-generation-broker.js";
import { OfficeDriverController } from "./features/office-documents/driver-controller.js";
import { OfficeDocumentsPluginService } from "./features/plugins/office-documents.js";
import { createOfficeDocumentsGenerationBroker } from "./features/plugins/office-documents-generation-broker.js";
import { writeJson } from "./shared/response.js";
import { StartupOptionalWarmupCoordinator } from "./startup/optional-warmups.js";
import { StartupStateRegistry } from "./startup/state.js";
import { initializeDaemonWithCleanup } from "./startup/initialization.js";
import { warmDefaultWorkspaceStartup } from "./startup/warmup.js";
import { ComputerUseProjectionRegistry } from "./features/computer-use/registry.js";
import { CuaDriverDesktopBridgeAuthority } from "./features/computer-use/desktop-bridge-authority.js";
import { HumanEvaluationDesktopAuthority } from "./features/harness/evaluations/human-evaluation-authority.js";
import { HumanEvaluationService } from "./features/harness/evaluations/human-evaluation-service.js";
import { createLockedControlAuditPublisher } from "./features/computer-use/locked-control-audit.js";
import { LockedComputerControlRegistry } from "./features/computer-use/locked-control-registry.js";
import {
  createDisabledLockedControlCapability,
  createPackagedLockedControlPolicy,
  lockedControlPlatformForNode,
} from "./features/computer-use/locked-control-policy.js";
import { bundledEmbeddedCuaDriverGateEnabled } from "./features/plugins/cua-driver-feature-gates.js";
import {
  CuaDriverClientPool,
  type CuaDriverPooledClientFactory,
} from "./features/plugins/cua-driver-client-pool.js";
import {
  DefaultCuaDriverLeaseMcpClientFactory,
  type CuaDriverLeaseMcpClient,
} from "./features/plugins/cua-driver-lease-client.js";
import { BundledCuaDriverActivationService } from "./features/plugins/cua-driver-bundled-activation.js";
import { CuaDriverDaemonActivationCoordinator } from "./features/plugins/cua-driver-daemon-composition.js";
import { createCuaDriverGenerationBroker } from "./features/plugins/cua-driver-generation-broker.js";
import { WorkspaceFileCapabilityRegistry } from "./features/previews/workspace-file-capabilities.js";
import { createCuaDriverDescriptor } from "./features/plugins/presets.js";
import { RemoteAccessController } from "./features/remote-access/controller.js";
import { EngineManagementFeature } from "./features/execution-engines/feature.js";
import { DefaultRemoteReplyDispatcher } from "./features/remote-access/default-reply-dispatcher.js";
import { HostCapabilityBridgeController } from "./features/runs/host-capability-bridge-controller.js";

export { defaultDaemonConfig } from "./config.js";
export type { DaemonConfig, HarnessFeatureConfig, ResolvedDaemonConfig } from "./config.js";
export * from "./features/harness/index.js";
export type { DaemonDependencies, ExternalSecretStore, McpBroker, RunnerAdapter, RunnerNativeResumeInputV1 } from "./context.js";
export {
  createRunnerRegistry,
  DEFAULT_RUNNER_ID,
  LEGACY_PI_RUNNER_ID,
  UnsupportedRunnerError,
  normalizeRunnerId,
  resolveRunnerNativeResumeGate,
  resolveRunnerResumeCapabilities,
  resolveRunnerToolExecutionGate,
  type RegisteredRunner,
  type RunnerNativeResumeConformanceV1,
  type RunnerNativeResumeGateBlocker,
  type RunnerNativeResumeGateV1,
  type RunnerResumeCapabilitiesV1,
  type RunnerRegistry,
  type RunnerResolution,
  type RunnerResolutionInput,
  type RunnerToolExecutionConformanceV1,
  type RunnerToolExecutionGateBlocker,
  type RunnerToolExecutionGateV1,
} from "./runtime/runners.js";
export type { RunnerFallbackReason } from "@ling-stack/core";
export { ActiveRunRegistry } from "./runtime/active-runs.js";
export { ActiveDirectReplyRegistry } from "./features/teammates/direct-reply-active-registry.js";
export { ChannelReplyDispatchCoordinator } from "./features/channels/channel-reply-dispatch-coordinator.js";
export { ChannelTurnDispatchWorkerRegistry } from "./features/channels/channel-turn-dispatch-worker.js";
export { RunStoreRegistry } from "./runtime/store-registry.js";
export { RuntimeSupervisor } from "./runtime/supervisor.js";
export { StartupStateRegistry } from "./startup/state.js";
export type { RunStoreFactory } from "./runtime/store-registry.js";
export type { RunRequest } from "./features/runs/schemas.js";
export {
  bundledEmbeddedCuaDriverGateEnabled,
  cuaDriverFeatureFlagsFromConfig,
  resolveCuaDriverDistribution,
} from "./features/plugins/cua-driver-feature-gates.js";
export {
  CuaDriverLeaseRegistry,
  cuaDriverLeasePoolKey,
  type CuaDriverLeasePublishResult,
  type CuaDriverLeaseRegistryOptions,
} from "./features/plugins/cua-driver-lease.js";
export {
  CuaDriverClientPool,
  type CuaDriverPoolHandle,
  type CuaDriverPooledClient,
  type CuaDriverPooledClientFactory,
} from "./features/plugins/cua-driver-client-pool.js";
export {
  captureCuaDriverActivationFence,
  commitCurrentCuaDriverActivation,
  isCurrentCuaDriverActivationFence,
} from "./features/plugins/cua-driver-activation-fence.js";
export {
  DefaultCuaDriverLeaseMcpClientFactory,
  createCuaDriverLeaseProxyHeaders,
  deriveCuaDriverLeaseProxyToken,
  type CuaDriverLeaseClientCheckResult,
  type CuaDriverLeaseClientHealthResult,
  type CuaDriverLeaseClientListToolsResult,
  type CuaDriverLeaseMcpClient,
  type CuaDriverLeaseMcpClientFactoryOptions,
} from "./features/plugins/cua-driver-lease-client.js";
export {
  BundledCuaDriverActivationError,
  BundledCuaDriverActivationService,
  type BundledCuaDriverActivationOperation,
  type BundledCuaDriverActivationResult,
  type BundledCuaDriverResetResult,
} from "./features/plugins/cua-driver-bundled-activation.js";
export {
  CuaDriverGenerationBrokerError,
  createCuaDriverGenerationBroker,
  type CuaDriverGenerationBrokerErrorCode,
} from "./features/plugins/cua-driver-generation-broker.js";
export { CuaDriverDaemonActivationCoordinator } from "./features/plugins/cua-driver-daemon-composition.js";
export {
  ChromeBrowserSessionController,
  ChromeBrowserSessionError,
  chromeExtensionIdFromOrigin,
} from "./features/browser-extension/session-controller.js";
export { attachChromeBrowserWebSocketServer } from "./features/browser-extension/websocket-server.js";
export { createChromeBrowserNativeBroker } from "./features/browser-extension/native-broker.js";
export { handleChromeBrowserPair } from "./features/browser-extension/routes.js";
export { ChromeBrowserPluginService, createChromeBrowserDescriptor, normalizeChromeBrowserStoreUrl } from "./features/plugins/chrome-browser.js";
export { createChromeBrowserGenerationBroker, chromeBrowserTools } from "./features/plugins/chrome-browser-generation-broker.js";
export { OfficeDriverController } from "./features/office-documents/driver-controller.js";
export { OfficeDocumentsPluginService, createOfficeDocumentsDescriptor } from "./features/plugins/office-documents.js";
export {
  createOfficeDocumentsGenerationBroker,
  officeAllTools,
  officeDocumentTools,
  officeToolsForCapabilities,
} from "./features/plugins/office-documents-generation-broker.js";

export interface DaemonServer {
  readonly server: Server;
  readonly config: ResolvedDaemonConfig;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly startupState: StartupStateRegistry;
  readonly computerUsePreviews: ComputerUseProjectionRegistry;
  readonly remoteAccessManagement: {
    readonly capability: string;
    readonly csrfToken: string;
  };
  /** Trusted embedding only. Never serialize this object into health or browser responses. */
  readonly engineManagement: EngineManagementFeature["credentials"];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemonServer(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): DaemonServer {
  const resolvedConfig = resolveConfig(config);
  const runnerRegistry = dependencies.runnerRegistry ?? createDefaultRunnerRegistry(dependencies.runner, resolvedConfig);
  const extensionRegistry = dependencies.extensionRegistry ?? createDefaultLingExtensionRegistry();
  const externalSecretStore = dependencies.externalSecretStore ?? createSystemKeychainSecretStore();
  const engineSecretStore = dependencies.engineManagement?.secretStore ?? createEngineSecretStore();
  const baseSecretResolver = dependencies.secretResolver
    ?? createCompositeSecretResolver({ keychainResolver: externalSecretStore });
  const secretResolver = withEngineSecretResolver(engineSecretStore, baseSecretResolver);
  const defaultStoragePaths = resolveStoragePaths(resolvedConfig.defaultWorkspaceCwd);
  const engineManagement = new EngineManagementFeature({
    userPaths: defaultStoragePaths.user,
    runnerRegistry,
    allowedOrigins: [],
    secretStore: engineSecretStore,
    secretResolver: baseSecretResolver,
    ...dependencies.engineManagement,
  });
  const externalWorkFetch = dependencies.externalWorkFetch;
  const webFetch = dependencies.webFetch ?? dependencies.channelWebFetch;
  const webResolveHostAddresses = dependencies.webResolveHostAddresses ?? dependencies.channelWebResolveHostAddresses;
  const imageVisionSummarizer = dependencies.imageVisionSummarizer;
  const baseMcpBroker = dependencies.mcpBroker ?? createDefaultMcpBroker();
  const desktopBridgeToken = dependencies.desktopBridgeToken ?? process.env.LING_DESKTOP_BRIDGE_TOKEN;
  const bundledCuaDriverEnabled = bundledEmbeddedCuaDriverGateEnabled(resolvedConfig, process.platform);
  const cuaDriverDescriptor = createCuaDriverDescriptor();
  const cuaDriverClientPool = new CuaDriverClientPool<CuaDriverLeaseMcpClient>({
    factory: dependencies.cuaDriverLeaseClientFactory
      ?? createLazyCuaDriverLeaseClientFactory(desktopBridgeToken),
  });
  const controlPlaneEvents = new ControlPlaneEventHub();
  const startupState = new StartupStateRegistry();
  const computerUsePreviews = new ComputerUseProjectionRegistry(dependencies.computerUseProjectionOptions);
  const hostCapabilityBridge = new HostCapabilityBridgeController();
  const providerStartupRefresh = new ProviderStartupRefreshService({ secretResolver, controlPlaneEvents, startupState });
  const providerImportPreflight = new ProviderImportPreflightService({ secretResolver, controlPlaneEvents });
  let automationSchedulers: AutomationSchedulerRegistry;
  let startupOptionalWarmups: StartupOptionalWarmupCoordinator;
  let channelTurnDispatchWorker: ChannelTurnDispatchWorkerRegistry;
  let channelTurnDispatchReady = false;
  let approvalResumeCoordinator: ApprovalResumeCoordinator | undefined;
  let userInputDeliveryWorker!: UserInputDeliveryWorker;
  const approvalRecoveryStores = new Set<RunStore>();
  let approvalRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let approvalAutoReviewRecoveryCoordinator: ApprovalAutoReviewRecoveryCoordinator | undefined;
  let daemonRunnerRecoveryCoordinator: DaemonRunnerRecoveryCoordinator | undefined;
  let runEvaluationScheduler: RunEvaluationSchedulerRegistry | undefined;
  let harnessShuttingDown = false;
  const harnessProjectionStores = new Set<RunStore>();
  const harnessProjectionReconciler = new HarnessProjectionReconciler({ pageSize: 100, maxPagesPerDomain: 16 });
  const harnessArtifactRetention = new HarnessArtifactRetentionService({ pageSize: 100, maxPagesPerSweep: 16 });
  let harnessProjectionTimer: ReturnType<typeof setInterval> | undefined;
  const reconcileHarnessProjections = (store: RunStore): void => {
    if (harnessShuttingDown) return;
    void harnessProjectionReconciler.reconcileStore(store).catch(() => {
      // Derived metadata failure cannot authorize execution or fabricate a ready checkpoint.
      if (!harnessShuttingDown) console.warn("harness_projection_reconcile_incomplete: checkpoint remains rebuildable");
    });
    void harnessArtifactRetention.collectStore(store).catch(() => {
      if (!harnessShuttingDown) console.warn("harness_artifact_retention_incomplete: enrolled bodies remain protected");
    });
  };
  const runEvaluationTaskWorkers = new RunEvaluationTaskWorkerComposition({
    activation: dependencies.runEvaluationQaTaskWorker,
  });
  // Chrome/Office plugin synchronization opens the Store during construction.
  // The same original Supervisor must exist before any default Store is opened;
  // an injected factory remains untrusted and is never retrofitted with custody.
  const runtimeSupervisor = new RuntimeSupervisor(resolvedConfig, (event) => {
    appendControlPlaneEvent(event.store, controlPlaneEvents, {
      workspaceId: event.workUnit.workspaceId,
      cwd: event.cwd,
      domain: "work_units",
      entityType: "work_unit",
      entityId: event.workUnit.id,
      action: "work_unit.transitioned",
      data: {
        previousStatus: event.previousStatus,
        status: event.status,
        reason: event.reason,
        runId: event.workUnit.linkedRunId ?? null,
        attemptId: event.workUnit.activeAttemptId ?? null,
      },
    }, event.now);
  }, dependencies.officeLocalNativeArtifact
    ? { officeLocalNativeArtifact: dependencies.officeLocalNativeArtifact }
    : undefined);
  let workspaceCustodyReady = false;
  let delegationRuntimeRegistry: DelegationRuntimeRegistry | undefined;
  const pendingDelegationStores = new Map<RunStore, OriginalDelegationLifecycle>();
  const originalDelegationStores = new WeakSet<RunStore>();
  const pendingOwnedStores = new Map<RunStore, string>();
  const initializedOwnedStores = new WeakSet<RunStore>();
  const initializeOwnedStore = (cwd: string, store: RunStore): void => {
    if (harnessShuttingDown) throw new Error("runtime_shutting_down");
    if (initializedOwnedStores.has(store)) return;
    runtimeSupervisor.getRuntime(cwd, store);
    const recoveryNow = new Date().toISOString();
    store.recoverStaleRuns(recoveryNow);
    store.recoverStaleChannelWorkflows(recoveryNow);
    dependencies.initializeBundledSkills?.(store);
    // A process may have crossed the shell side-effect boundary before the
    // daemon disappeared. Expired executing claims are never retried; they
    // become explicit unknown outcomes before any recovery dispatch runs.
    reconcileHarnessToolExecutionsAtStartup({ cwd, store, now: new Date().toISOString(), limit: 500 });
    try {
      recoverPendingTeammateDirectMessages(store, controlPlaneEvents);
    } catch {
      console.warn("teammate_direct_recovery_failed: linked pending replies remain recoverable");
    }
    approvalRecoveryStores.add(store);
    userInputDeliveryWorker.registerStore(store);
    configureNormalNarrationPublication(store, (event) => controlPlaneEvents.publish(event));
    const narrationRecovery = recoverNormalNarrationPublications(store, new Date().toISOString()).catch(() => {
      // Do not leak database/provider details, but do not hide a failed recovery sweep.
      console.warn("normal_narration_recovery_failed: pending publications remain recoverable");
    });
    activeRuns.trackCompletion(narrationRecovery);
    configureTerminalReportStore(store, {
      enabled: resolvedConfig.channels.terminalReports === true,
      runnerRegistry,
      secretResolver,
      onPublished: ({ event }) => controlPlaneEvents.publish(event),
    });
    approvalResumeCoordinator?.registerStore(store);
    approvalAutoReviewRecoveryCoordinator?.registerStore(store);
    daemonRunnerRecoveryCoordinator?.registerStore(store);
    if (originalDelegationStores.has(store)) delegationRuntimeRegistry?.recoverStore(store);
    runEvaluationTaskWorkers.registerStore(cwd, store);
    runEvaluationScheduler?.registerStore(store);
    startupOptionalWarmups?.start(cwd, store);
    reconcileAllContinuityWorkflows(store, { cause: "startup" });
    if (resolvedConfig.channels.terminalReports === true) {
      const terminalReportRecovery = recoverTerminalReports(store).catch(() => {
        console.warn("terminal_report_recovery_failed: conflicting sources remain recoverable");
      });
      activeRuns.trackCompletion(terminalReportRecovery);
    }
    harnessProjectionStores.add(store);
    reconcileHarnessProjections(store);
    if (channelTurnDispatchReady) channelTurnDispatchWorker?.start(store);
    initializedOwnedStores.add(store);
    pendingOwnedStores.delete(store);
  };
  const storeRegistry = new RunStoreRegistry(
    dependencies.storeFactory ?? createOriginalOfficeDirectoryStoreFactory(runtimeSupervisor, { runnerRegistry, secretResolver,
      onDelegationStore: (store, lifecycle) => {
        originalDelegationStores.add(store);
        if (delegationRuntimeRegistry) delegationRuntimeRegistry.registerStore(store, lifecycle);
        else pendingDelegationStores.set(store, lifecycle);
      },
    }), {
    trustedWorkspaceRoots: [resolvedConfig.defaultWorkspaceCwd],
    beforeRecovery: (cwd, store) => {
      if (harnessShuttingDown) throw new Error("runtime_shutting_down");
      // Both default and injected factories must pass the original Supervisor's
      // workspace owner before any registry or initialized-store recovery runs.
      runtimeSupervisor.getRuntime(cwd, store);
    },
    recoverOnOpen: false,
    onStoreInitialized: (cwd, store) => {
      pendingOwnedStores.set(store, cwd);
      if (workspaceCustodyReady) initializeOwnedStore(cwd, store);
    },
  });
  runEvaluationScheduler = new RunEvaluationSchedulerRegistry({
    enabled: resolvedConfig.harness.evaluations.mode !== "off",
  });
  const chromeBrowserSessions = new ChromeBrowserSessionController({
    workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
    allowedExtensionIds: dependencies.chromeBrowserExtensionIds
      ?? readChromeBrowserExtensionIds(process.env.LING_CHROME_EXTENSION_IDS),
    getStore: (cwd) => storeRegistry.getStore(cwd),
  });
  const chromeBrowserPlugin = new ChromeBrowserPluginService({
    controller: chromeBrowserSessions,
    getStore: (cwd) => storeRegistry.getStore(cwd),
    storeUrl: normalizeChromeBrowserStoreUrl(process.env.LING_CHROME_EXTENSION_STORE_URL)
      ?? `https://chromewebstore.google.com/detail/${CHROME_BROWSER_PRODUCTION_EXTENSION_ID}`,
    ...(process.env.LING_BROWSER_HOST_PATH ? { hostPath: process.env.LING_BROWSER_HOST_PATH } : {}),
  });
  let lastChromeBrowserProjection = "";
  chromeBrowserSessions.setStateChangeListener((cwd, snapshot) => {
    chromeBrowserPlugin.handleSessionStateChange(cwd);
    const projection = JSON.stringify({
      connected: snapshot.connected,
      hostState: snapshot.hostState,
      extensionState: snapshot.extensionState,
      transport: snapshot.transport ?? null,
      extensionVersion: snapshot.extensionVersion ?? null,
    });
    if (projection === lastChromeBrowserProjection) return;
    lastChromeBrowserProjection = projection;
    appendControlPlaneEvent(storeRegistry.getStore(cwd), controlPlaneEvents, {
      workspaceId: "workspace_default",
      cwd,
      domain: "mcp",
      entityType: "managed_plugin",
      entityId: CHROME_BROWSER_PLUGIN_ID,
      action: "chrome_browser.connection_changed",
      data: JSON.parse(projection) as Record<string, unknown>,
    });
  });
  const officeDriverController = new OfficeDriverController();
  const officeDocumentsPlugin = new OfficeDocumentsPluginService({
    controller: officeDriverController,
    getStore: (cwd) => storeRegistry.getStore(cwd),
  });
  let cuaDriverActivationCoordinator: CuaDriverDaemonActivationCoordinator | undefined;
  let lockedComputerControl: LockedComputerControlRegistry | undefined;
  const cuaDriverDesktopBridgeAuthority = new CuaDriverDesktopBridgeAuthority({
    workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
    scheduleDeadline: dependencies.cuaDriverLeaseScheduleDeadline,
    onLeaseReplaced: (_previous, next) => {
      cuaDriverActivationCoordinator?.handleLeaseChanged(next);
    },
    onAuthorityRotated: () => {
      lockedComputerControl?.revoke("locked_control_authority_rotated", false);
    },
  });
  const lockedControlPlatform = lockedControlPlatformForNode();
  if (lockedControlPlatform) {
    const lockedControlAudit = createLockedControlAuditPublisher({
      storeRegistry,
      controlPlaneEvents,
    });
    lockedComputerControl = new LockedComputerControlRegistry({
      workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
      policy: createPackagedLockedControlPolicy("disabled"),
      capability: createDisabledLockedControlCapability(lockedControlPlatform),
      isScopeActive: ({ workspaceCwd, runId, computerUseSessionId }) => {
        const store = storeRegistry.findStoreForRun(runId, workspaceCwd);
        const run = store?.getRun(runId);
        const projection = computerUsePreviews.get(workspaceCwd, computerUseSessionId);
        return Boolean(
          run
          && (run.status === "running" || run.status === "waiting_for_approval")
          && projection
          && !isTerminalComputerUseStatus(projection.status),
        );
      },
      isAuthorityCurrent: (identity) => cuaDriverDesktopBridgeAuthority.isCurrentHandshake(identity),
      appendAudit: (event) => lockedControlAudit.append(event),
    });
  }
  const cuaDriverActivationService = new BundledCuaDriverActivationService({
    leaseRegistry: cuaDriverDesktopBridgeAuthority.leaseRegistry,
    clientPool: cuaDriverClientPool,
    getDesktopAvailability: () => cuaDriverDesktopBridgeAuthority.getCurrentAvailability(),
  });
  cuaDriverActivationCoordinator = new CuaDriverDaemonActivationCoordinator({
    enabled: bundledCuaDriverEnabled,
    workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
    storeRegistry,
    descriptor: cuaDriverDescriptor,
    leaseRegistry: cuaDriverDesktopBridgeAuthority.leaseRegistry,
    getDesktopAvailability: () => cuaDriverDesktopBridgeAuthority.getCurrentAvailability(),
    activationService: cuaDriverActivationService,
    clientPool: cuaDriverClientPool,
  });
  const chromeBrowserMcpBroker = createChromeBrowserGenerationBroker({
    baseBroker: baseMcpBroker,
    workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
    controller: chromeBrowserSessions,
  });
  const officeDocumentsMcpBroker = createOfficeDocumentsGenerationBroker({
    baseBroker: chromeBrowserMcpBroker,
    workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
    controller: officeDriverController,
  });
  const mcpBroker = createCuaDriverGenerationBroker({
    baseBroker: officeDocumentsMcpBroker,
    bundledEnabled: bundledCuaDriverEnabled,
    workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
    leaseRegistry: cuaDriverDesktopBridgeAuthority.leaseRegistry,
    clientPool: cuaDriverClientPool,
    ...(lockedComputerControl ? { lockedControlRegistry: lockedComputerControl } : {}),
  });
  const backgroundSchedulers = new ExternalWorkBackgroundSchedulerRegistry(storeRegistry, secretResolver, externalWorkFetch);
  const activeRuns = new ActiveRunRegistry();
  const nativeRunTargetDispatcher = dependencies.nativeRunTargetDispatcher === undefined
    ? engineManagement.runTargetDispatcher
    : dependencies.nativeRunTargetDispatcher;
  const nativeRunDispatcher = nativeRunTargetDispatcher
    ? createNativeRunDispatcher({
        runnerRegistry,
        storeRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        startupState,
        controlPlaneEvents,
        target: nativeRunTargetDispatcher,
      })
    : undefined;
  automationSchedulers = new AutomationSchedulerRegistry(
    runnerRegistry,
    storeRegistry,
    activeRuns,
    runtimeSupervisor,
    secretResolver,
    mcpBroker,
    computerUsePreviews,
    controlPlaneEvents,
    startupState,
    nativeRunDispatcher,
  );
  startupOptionalWarmups = new StartupOptionalWarmupCoordinator({
    startupState,
    providerStartupRefresh,
    automationSchedulers,
  });
  const activeDirectReplies = new ActiveDirectReplyRegistry();
  const channelReplyDispatchCoordinator = new ChannelReplyDispatchCoordinator();
  const afterChannelRunTerminal = async (terminalRun: import("@ling-stack/core").RunSession): Promise<void> => {
    const sourceRunId = terminalRun.parentRunId ?? terminalRun.id;
    const store = storeRegistry.findStoreForRun(sourceRunId, terminalRun.cwd)
      ?? storeRegistry.findStoreForRun(terminalRun.id, terminalRun.cwd);
    if (!store) return;
    try {
      reconcileTeammateDirectRun(store, terminalRun, controlPlaneEvents);
    } catch {
      console.warn("teammate_direct_reconciliation_failed: the original reply remains recoverable");
    }
    maybeScheduleRunTerminalReport(store, terminalRun.id, { linkedRunId: terminalRun.id });
    const goalContinuation = maybeQueueGoalContinuation({ terminalRun, store, activeRuns });
    await maybeStartNextRunInterventionContinuation({
      sourceRunId: goalContinuation?.sourceRunId ?? sourceRunId,
      terminalRun,
      store,
      runnerRegistry,
      storeRegistry,
      activeRuns,
      runtimeSupervisor,
      secretResolver,
      mcpBroker,
      controlPlaneEvents,
      startupState,
      computerUsePreviews,
      nativeRunDispatcher,
    });
    daemonRunnerRecoveryCoordinator?.recoverStore(store);
  };
  const channelTurnDispatchOptions = {
    config: resolvedConfig,
    storeRegistry,
    runnerRegistry,
    activeRuns,
    runtimeSupervisor,
    secretResolver,
    mcpBroker,
    controlPlaneEvents,
    startupState,
    computerUsePreviews,
    hostCapabilityBridge,
    nativeRunDispatcher,
    replyDispatchCoordinator: channelReplyDispatchCoordinator,
    imageVisionSummarizer,
    webFetch,
    webResolveHostAddresses,
    afterRunTerminal: afterChannelRunTerminal,
  };
  // Explicit typed Host startup selection. No HTTP/model request can add an
  // ID, and a normal installation leaves dynamic producers closed by default.
  const selectedDelegationWorkflowIds = resolvedConfig.harness.delegations.selectedWorkflowIds;
  delegationRuntimeRegistry = createDelegationRuntimeRegistry({
    supervisor: runtimeSupervisor, activeRuns,
    onRunTerminal: async ({ store, run, controlPlaneEvents: terminalEvents }) => {
      for (const event of terminalEvents) controlPlaneEvents.publish(event);
      // Dynamic children's incoming result is their completion contract. Only
      // the external root receives ordinary channel/goal follow-up handling.
      if (run.workUnitId && store.getWorkUnit(run.workUnitId)?.ownerType === "delegation_step") return;
      if ((run.status !== "failed" && run.status !== "cancelled") || !run.endedAt) {
        throw new Error("run_terminal_intent_projection_invalid");
      }
      writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
        runId: run.id, status: run.status, taskId: run.taskId,
        eventCount: store.countEvents(run.id), startedAt: run.startedAt,
        endedAt: run.endedAt, errorMessage: run.errorMessage ?? null,
      });
      // A retrying outbox must not account for the same root twice or replace
      // a successor's active thread. The first sync clears this exact owner.
      if (run.threadId && store.getLingThread(run.threadId)?.activeRunId === run.id) {
        syncLingThreadForTerminalRun(store, run.id, run.endedAt);
      }
      await afterChannelRunTerminal(run);
    },
    ...(selectedDelegationWorkflowIds.length ? { isWorkflowSelected: createDelegationWorkflowSelector(selectedDelegationWorkflowIds) } : {}),
    assertRecoveryParentCurrent: input => assertDelegationRecoveryParentCurrent({ ...input, activeRuns }),
    executeDelegatedRunRequest: input => executeDelegatedRunRequest(input, createDetachedRunExecutionSink(),
      runnerRegistry, storeRegistry, activeRuns, runtimeSupervisor, secretResolver, mcpBroker, {
        controlPlaneEvents, startupState, computerUsePreviews, hostCapabilityBridge, enableUserInputPause: true,
      }),
  });
  for (const [store, lifecycle] of pendingDelegationStores) delegationRuntimeRegistry.registerStore(store, lifecycle);
  pendingDelegationStores.clear();
  userInputDeliveryWorker = new UserInputDeliveryWorker({
    activeRuns,
    runtimeSupervisor,
    execute: (input) => {
      let resolveAccepted!: (runId: string) => void;
      const accepted = new Promise<string>((resolve) => { resolveAccepted = resolve; });
      const completion = executeUserInputContinuation(
        { request: input.request, threadId: input.threadId, deliveryId: input.deliveryId,
          claim: input.claim, ...(input.binding ? { binding: input.binding } : {}) },
        createDetachedRunExecutionSink(),
        runnerRegistry,
        storeRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        mcpBroker,
        {
          controlPlaneEvents,
          startupState,
          computerUsePreviews,
          hostCapabilityBridge,
          enableUserInputPause: true,
          afterRunTerminal: createUserInputWorkflowTerminalHook(channelTurnDispatchOptions),
          onUserInputReceiverAccepted: ({ runId }) => resolveAccepted(runId),
        },
      );
      // The worker owns admission through durable receiver acceptance only.
      // The full Run remains owned by ActiveRunRegistry after this slot frees.
      return Promise.race([accepted, completion]);
    },
    onError: (failure) => {
      console.warn(`user_input_delivery_${failure.phase}_failed:${failure.code}`);
    },
  });
  approvalResumeCoordinator = new ApprovalResumeCoordinator({
    runtimeSupervisor,
    activeRuns,
    runnerRegistry,
    controlPlaneEvents,
    afterRunTerminal: afterChannelRunTerminal,
    executeExistingRunContinuation: ({ cwd, runId, approvalId, preparedExecution }) =>
      executeExistingRunContinuation(
        {
          cwd,
          runId,
          origin: "approval_resume",
          idempotencyDiscriminator: approvalId,
          preparedExecution,
        },
        createDetachedRunExecutionSink(),
        runnerRegistry,
        storeRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        mcpBroker,
        {
          controlPlaneEvents,
          startupState,
          computerUsePreviews,
          hostCapabilityBridge,
          afterRunTerminal: afterChannelRunTerminal,
        },
      ),
  });
  approvalAutoReviewRecoveryCoordinator = new ApprovalAutoReviewRecoveryCoordinator({
    runtimeSupervisor,
    runnerRegistry,
    secretResolver,
    approvalResumeCoordinator,
  });
  daemonRunnerRecoveryCoordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor,
    activeRuns,
    executeExistingRunContinuation: ({ cwd, runId, origin, idempotencyDiscriminator, preparedExecution }) =>
      executeExistingRunContinuation(
        {
          cwd,
          runId,
          origin,
          idempotencyDiscriminator,
          preparedExecution,
        },
        createDetachedRunExecutionSink(),
        runnerRegistry,
        storeRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        mcpBroker,
        {
          controlPlaneEvents,
          startupState,
          computerUsePreviews,
          hostCapabilityBridge,
          afterRunTerminal: afterChannelRunTerminal,
        },
      ),
  });
  channelTurnDispatchWorker = new ChannelTurnDispatchWorkerRegistry(
    runtimeSupervisor,
    createChannelTurnDispatchExecutor(channelTurnDispatchOptions),
  );
  const remoteAccessManagementCapability = dependencies.remoteAccessManagementCapability
    ?? process.env.LING_MOBILE_ACCESS_MANAGEMENT_CAPABILITY
    ?? randomBytes(32).toString("base64url");
  const remoteReplyDispatcher = dependencies.remoteReplyDispatcher === null
    ? undefined
    : dependencies.remoteReplyDispatcher ?? new DefaultRemoteReplyDispatcher({
      store: storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd),
      storeRegistry,
      runnerRegistry,
      activeRuns,
      runtimeSupervisor,
      secretResolver,
      mcpBroker,
      providerStartupRefresh,
      controlPlaneEvents,
      startupState,
      computerUsePreviews,
      nativeRunDispatcher,
    });
  const remoteAccess = new RemoteAccessController({
    store: storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd),
    stateDir: dependencies.remoteAccessStateDir ?? defaultStoragePaths.user.stateDir,
    listenerPort: resolvedConfig.remoteAccess.listenerPort,
    workspaceDisplayName: defaultStoragePaths.workspace.identity.displayName,
    managementCapability: remoteAccessManagementCapability,
    managementAllowedOrigins: resolvedConfig.remoteAccess.managementAllowedOrigins,
    dispatcher: remoteReplyDispatcher,
  });
  const workspaceFileCapabilities = new WorkspaceFileCapabilityRegistry();
  // Terminal-QA human authority is independent of CU gate, live Run or lease.
  // Construction neither enrolls an ordinary task nor authenticates any sample.
  const humanEvaluations = new HumanEvaluationService({
    authority: new HumanEvaluationDesktopAuthority({ workspaceCwd: resolvedConfig.defaultWorkspaceCwd }),
    getStore: () => storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd),
    events: controlPlaneEvents,
  });
  const context: DaemonContext = {
    config: resolvedConfig,
    runnerRegistry,
    extensionRegistry,
    storeRegistry,
    activeRuns,
    approvalResumeCoordinator,
    userInputDeliveryWorker,
    activeDirectReplies,
    channelReplyDispatchCoordinator,
    channelTurnDispatchWorker,
    runtimeSupervisor,
    secretResolver,
    externalSecretStore,
    mcpBroker,
    externalWorkFetch,
    webFetch,
    webResolveHostAddresses,
    imageVisionSummarizer,
    backgroundSchedulers,
    automationSchedulers,
    controlPlaneEvents,
    providerStartupRefresh,
    providerImportPreflight,
    startupState,
    startupOptionalWarmups,
    computerUsePreviews,
    cuaDriverDesktopBridgeAuthority,
    lockedComputerControl,
    cuaDriverActivationService,
    cuaDriverActivationCoordinator,
    computerUseStop: dependencies.computerUseStop,
    desktopBridgeToken,
    computerUseRouteToken:
      dependencies.computerUseRouteToken
      ?? process.env.LING_COMPUTER_USE_ROUTE_TOKEN
      ?? dependencies.desktopBridgeToken
      ?? process.env.LING_DESKTOP_BRIDGE_TOKEN,
    computerUseTargetOwnershipTimeoutMs: dependencies.computerUseTargetOwnershipTimeoutMs,
    remoteAccess,
    engineManagement,
    nativeRunDispatcher,
    chromeBrowserSessions,
    chromeBrowserPlugin,
    officeDriverController,
    officeDocumentsPlugin,
    workspaceFileCapabilities,
    hostCapabilityBridge,
    humanEvaluations,
  };
  const server = createServer((request, response) => {
    if (harnessShuttingDown || activeRuns.isShuttingDown()) {
      writeJson(response, 503, { error: "runtime_shutting_down", message: "Runtime is shutting down." });
      return;
    }
    const completion = Promise.resolve().then(async () => {
      try {
        await routeRequest(request, response, context);
      } catch (error) {
        if (!response.headersSent) {
          writeJson(response, 500, {
            error: "internal_error",
            message: error instanceof Error ? error.message : String(error),
          });
        } else {
          response.end();
        }
      }
    });
    // Closing a socket does not cancel its async route handler.
    activeRuns.trackCompletion(completion);
  });
  const rpcWebSocketServer = attachRpcWebSocketServer(server, context);
  const chromeBrowserWebSocketServer = attachChromeBrowserWebSocketServer({
    server,
    controller: chromeBrowserSessions,
    host: resolvedConfig.host,
    port: resolvedConfig.port,
    workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
  });
  const chromeBrowserNativeBroker = (dependencies.chromeBrowserNativeMessagingEnabled
    ?? process.env.NODE_TEST_CONTEXT === undefined)
    ? createChromeBrowserNativeBroker({
        controller: chromeBrowserSessions,
        workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
        ...(dependencies.chromeBrowserHostPath ?? process.env.LING_BROWSER_HOST_PATH
          ? { hostPath: dependencies.chromeBrowserHostPath ?? process.env.LING_BROWSER_HOST_PATH }
          : {}),
        ...(dependencies.chromeBrowserRuntimeDescriptorPath ?? process.env.LING_BROWSER_HOST_RUNTIME_DESCRIPTOR
          ? { descriptorPath: dependencies.chromeBrowserRuntimeDescriptorPath ?? process.env.LING_BROWSER_HOST_RUNTIME_DESCRIPTOR }
          : {}),
      })
    : undefined;

  let networkShutdown: Promise<void> | undefined;
  let remoteAccessShutdown: Promise<void> | undefined;
  let providerImportShutdown: Promise<void> | undefined;
  const runShutdown = createRunShutdownCoordinator({ activeRuns, delegations: delegationRuntimeRegistry,
    mediaExecutions: storeRegistry.mediaLocalExecutions });
  const harnessLifecycle = new HarnessLifecycleCoordinator({
    stopExternalAdmission: () => {
      harnessShuttingDown = true;
      humanEvaluations.close();
      if (approvalRecoveryTimer) clearInterval(approvalRecoveryTimer);
      approvalRecoveryTimer = undefined;
      if (harnessProjectionTimer) clearInterval(harnessProjectionTimer);
      harnessProjectionTimer = undefined;
      harnessProjectionReconciler.beginShutdown();
      harnessArtifactRetention.beginShutdown();
      providerStartupRefresh.beginShutdown();
      channelTurnDispatchReady = false;
      // Initiate network close, but do not await active routes before their adapters receive abort.
      networkShutdown = new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        server.close(error => error ? reject(error) : resolve());
      });
      remoteAccessShutdown = remoteAccess.stop();
      // Preserve failures for the real settle stage without an unhandled rejection in the meantime.
      void networkShutdown.catch(() => undefined);
      void remoteAccessShutdown.catch(() => undefined);
    },
    closeResources: async () => {
      // Native engine disposal can still own local files/Stores. It must finish before lease/Store close.
      await engineManagement.close();
      runtimeSupervisor.releaseAll();
      storeRegistry.closeAll();
      harnessProjectionStores.clear();
    },
  });
  harnessLifecycle.register({
    domain: "continuation", enabled: true,
    stopAdmission: () => {
      daemonRunnerRecoveryCoordinator?.beginShutdown();
      userInputDeliveryWorker.beginShutdown();
      approvalAutoReviewRecoveryCoordinator?.beginShutdown();
      channelTurnDispatchWorker.beginShutdown();
      backgroundSchedulers.stopAdmission();
      automationSchedulers.stopAll();
    },
    abortOwned: () => {
      approvalAutoReviewRecoveryCoordinator?.abortOwned();
      harnessProjectionReconciler.abortOwned();
      harnessArtifactRetention.abortOwned();
    },
    settle: () => settleHarnessLifetimes([
      channelTurnDispatchWorker.close(), userInputDeliveryWorker.close(),
      daemonRunnerRecoveryCoordinator?.waitForIdle() ?? Promise.resolve(),
      approvalAutoReviewRecoveryCoordinator?.waitForIdle() ?? Promise.resolve(),
      automationSchedulers.waitForIdle(), backgroundSchedulers.waitForIdle(),
      providerStartupRefresh.waitForIdle(), harnessProjectionReconciler.waitForIdle(),
      harnessArtifactRetention.waitForIdle(),
      networkShutdown ?? Promise.resolve(), remoteAccessShutdown ?? Promise.resolve(),
    ]),
  });
  harnessLifecycle.register({
    domain: "tool_execution", enabled: true,
    stopAdmission: () => {
      activeRuns.stopAdmission();
      storeRegistry.mediaLocalExecutions.stopAdmission();
      cuaDriverActivationCoordinator.beginShutdown();
    },
    abortOwned: async () => {
      activeDirectReplies.cancelAll();
      channelReplyDispatchCoordinator.close();
      providerImportShutdown = providerImportPreflight.shutdown();
      void providerImportShutdown.catch(() => undefined);
      // Shared with the delegation domain. Persist/seal first, then wait for
      // actual SDK/tool/executor finalization; never race the old abort tree
      // against a source that is still producing its suspension checkpoint.
      await runShutdown.shutdown("daemon_restart");
      // Keep the established broker-before-controller shutdown order, even if the broker fails.
      await shutdownAfterNativeBroker(async () => { await chromeBrowserNativeBroker?.close(); }, async () => {
        controlPlaneEvents.closeAll();
        computerUsePreviews.closeAll();
        hostCapabilityBridge.close();
        cuaDriverDesktopBridgeAuthority.clear();
        lockedComputerControl?.close();
        chromeBrowserSessions.close();
        officeDriverController.close();
        chromeBrowserWebSocketServer.close();
        rpcWebSocketServer.close();
        server.closeAllConnections();
      });
    },
    settle: () => settleHarnessLifetimes([
      runShutdown.shutdown("daemon_restart"),
      cuaDriverActivationCoordinator.shutdown(), providerImportShutdown ?? Promise.resolve(),
      // The public stop observer owns the finite deadline; this barrier proves
      // actual completion, so a timed-out observer cannot poison later drain.
      storeRegistry.mediaLocalExecutions.waitForIdle(),
    ]),
  });
  harnessLifecycle.register({
    domain: "evaluation", enabled: resolvedConfig.harness.evaluations.mode !== "off" || dependencies.runEvaluationQaTaskWorker !== undefined,
    stopAdmission: () => { runEvaluationTaskWorkers.stopAdmission(); runEvaluationScheduler?.beginShutdown(); },
    abortOwned: () => { runEvaluationTaskWorkers.abortOwned(); runEvaluationScheduler?.abortOwned(); },
    settle: () => settleHarnessLifetimes([runEvaluationTaskWorkers.waitForIdle(), runEvaluationScheduler?.waitForIdle() ?? Promise.resolve()]),
  });
  harnessLifecycle.register({
    // Ordinary installations stay closed; selected QA workflows use the same
    // production executor and keep actual child completion in this barrier.
    domain: "delegation", enabled: delegationRuntimeRegistry.isEnabled(),
    stopAdmission: () => delegationRuntimeRegistry!.stopAdmission(),
    abortOwned: () => runShutdown.shutdown("daemon_restart"),
    settle: () => delegationRuntimeRegistry!.settle(),
  });

  const daemon: DaemonServer = {
    server,
    config: resolvedConfig,
    extensionRegistry,
    startupState,
    computerUsePreviews,
    remoteAccessManagement: {
      capability: remoteAccessManagementCapability,
      csrfToken: remoteAccess.csrfToken,
    },
    engineManagement: engineManagement.credentials,
    start: async () => {
      if (harnessShuttingDown) throw new Error("runtime_shutting_down");
      cuaDriverActivationCoordinator.resetForDaemonStart();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(resolvedConfig.port, resolvedConfig.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await initializeDaemonWithCleanup(async () => {
        const defaultStore = storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd);
        runtimeSupervisor.getRuntime(resolvedConfig.defaultWorkspaceCwd, defaultStore);
        workspaceCustodyReady = true;
        for (const [store, cwd] of [...pendingOwnedStores]) initializeOwnedStore(cwd, store);
        chromeBrowserPlugin.sync(resolvedConfig.defaultWorkspaceCwd);
        officeDocumentsPlugin.sync(resolvedConfig.defaultWorkspaceCwd);
        await chromeBrowserNativeBroker?.start().catch(() => {
          chromeBrowserSessions.observeNativeState({
            cwd: resolvedConfig.defaultWorkspaceCwd,
            hostState: "missing",
          });
        });
        await warmDefaultWorkspaceStartup({
          cwd: resolvedConfig.defaultWorkspaceCwd,
          startupState,
          storeRegistry,
          runnerRegistry,
          secretResolver,
        });
        await approvalAutoReviewRecoveryCoordinator.recoverStore(
          storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd),
        );
        runEvaluationScheduler.registerStore(storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd));
        daemonRunnerRecoveryCoordinator.registerStore(storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd));
        daemonRunnerRecoveryCoordinator.start();
        userInputDeliveryWorker.start();
        // Ephemeral control-plane servers are used by tests and embedded fixtures.
        // They must never claim the installation-global Remote Gateway listener.
        if (resolvedConfig.port !== 0) {
          await remoteAccess.startIfEnabled();
        }
        startupOptionalWarmups.start(resolvedConfig.defaultWorkspaceCwd, storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd));
        channelTurnDispatchReady = true;
        channelTurnDispatchWorker.start(storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd));
        const mediaRecoveryHooks: Parameters<typeof resumePendingMediaJobExecutions>[0]["hooks"] = {
          startRuntimeWorkUnit: (input) => startRuntimeWorkUnit({ ...input, runtimeSupervisor }),
          recoverRuntimeWorkUnit: (input) => retryRuntimeWorkUnit({ ...input, runtimeSupervisor }),
          transitionRuntimeWorkUnitTerminal: (input) => {
            transitionWorkUnitTerminal(input.store, {
              workUnitId: input.workUnitId,
              attemptId: input.attemptId,
              event: input.event,
              attemptStatus: input.attemptStatus,
              runtimeEventType: input.runtimeEventType,
              actor: input.actor,
              now: input.now,
              errorCode: input.errorCode,
              errorMessage: input.errorMessage,
            });
          },
          transitionRuntimeWorkUnitCancelled: (input) => {
            transitionWorkUnitCancelled(
              input.store,
              input.workUnitId,
              input.attemptId,
              input.reason,
            );
          },
          onMediaJobProjectionChanged: (input) => {
            publishConversationMediaProjectionChange({
              store: storeRegistry.getStore(input.cwd),
              controlPlaneEvents,
              mediaJobId: input.mediaJobId,
              createdArtifactIds: input.createdArtifactIds,
            });
          },
        };
        const recoverApprovals = () => {
          for (const store of approvalRecoveryStores) {
            if (typeof store.listApprovalPostCommitEffects !== "function") continue;
            try {
              recoverApprovalPostCommitStore({
                store, cwd: store.paths.cwd, controlPlaneEvents,
                onOwnerResolved: (approval) => runApprovalPostCommitEffects({
                  resumeRun: () => {
                    if (!approval.runId) return;
                    if (approval.status !== "approved" && approval.status !== "denied") {
                      const run = store.getRun(approval.runId);
                      if (run?.status === "waiting_for_approval") throw new Error("approval_terminal_owner_pending");
                      return;
                    }
                    const result = approval.status === "denied"
                      ? approvalResumeCoordinator!.finalizeSuspendedApprovalDenial({ store, approval })
                      : approvalResumeCoordinator!.resumeAfterApproval({ store, approval });
                    if (result.status === "blocked") throw new Error(result.reason);
                    if (result.status === "not_applicable"
                      && store.getRun(approval.runId)?.status === "waiting_for_approval") {
                      throw new Error("approval_run_owner_unreconciled");
                    }
                  },
                  syncWorkflow: () => {
                    if (approval.payload.type !== "workflow_step") return;
                    const result = syncWorkflowApprovalDecision(store, approval);
                    if (result.status === "missing_owner") throw new Error("approval_workflow_owner_missing");
                    if (result.status === "stale_owner") throw new Error("approval_workflow_owner_stale");
                  },
                  syncMedia: () => syncMediaJobForApprovalDecision({
                    cwd: store.paths.cwd, store, storeRegistry, secretResolver, approval,
                    now: new Date().toISOString(), hooks: mediaRecoveryHooks,
                  }),
                }),
              });
            } catch {
              console.warn("approval_postcommit_recovery_failed: durable effects remain pending");
            }
          }
        };
        recoverApprovals();
        approvalRecoveryTimer = setInterval(recoverApprovals, 10_000);
        approvalRecoveryTimer.unref();
        harnessProjectionTimer = setInterval(() => {
          for (const store of harnessProjectionStores) reconcileHarnessProjections(store);
        }, 10_000);
        harnessProjectionTimer.unref();
        resumePendingMediaJobExecutions({
          cwd: resolvedConfig.defaultWorkspaceCwd,
          storeRegistry,
          secretResolver,
          hooks: mediaRecoveryHooks,
        });
      }, () => daemon.stop());
    },
    stop: async () => {
      // Observe the existing finite media deadline alongside the whole Host
      // drain. A parent may itself be waiting for this media writer, so a
      // deadline hidden in the later settle phase would never be reached.
      // Rejection ends only this caller's wait: the original single-flight
      // drain retains Stores/leases until real completion, including on retry.
      const [receipt] = await Promise.all([
        harnessLifecycle.shutdown(),
        storeRegistry.mediaLocalExecutions.waitForIdle(5_000),
      ]);
      if (receipt.status !== "closed") {
        throw new AggregateError(harnessLifecycle.getFailureCauses().map(failure => failure.error), "harness_shutdown_incomplete_stores_retained");
      }
    },
  };
  return daemon;
}

/** Await every actual tail even if another tail fails; keep the original errors for Host diagnosis. */
async function settleHarnessLifetimes(lifetimes: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(lifetimes);
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason as unknown);
  if (failures.length) throw new AggregateError(failures, "harness_owned_lifetime_settle_failed");
}

function readChromeBrowserExtensionIds(value: string | undefined): readonly string[] {
  const configured = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : CHROME_BROWSER_DEFAULT_EXTENSION_IDS;
}

function createLazyCuaDriverLeaseClientFactory(
  bridgeToken: string | undefined,
): CuaDriverPooledClientFactory<CuaDriverLeaseMcpClient> {
  let factory: DefaultCuaDriverLeaseMcpClientFactory | undefined;
  return {
    async connect(lease, signal) {
      const token = bridgeToken?.trim();
      if (!token) {
        throw new Error("cua_driver_desktop_bridge_token_missing");
      }
      factory ??= new DefaultCuaDriverLeaseMcpClientFactory({ bridgeToken: token });
      return factory.connect(lease, signal);
    },
  };
}

export const LOCAL_CHANNEL_SOURCE_EXTENSION_ID = "channel-source:local";

export function createDefaultRunnerRegistry(
  runner: RunnerAdapter = createPiRunner(),
  config: (Pick<ResolvedDaemonConfig, "runners" | "runtimeTools"> | Pick<DaemonConfig, "runners" | "runtimeTools">) = {},
): RunnerRegistry {
  const extension = getPiRunnerExtension();
  const piToolHydration = resolvePiRunnerToolHydrationCapability(config);
  const piSandboxBindingEnabled = config.runners?.pi?.sandboxBinding?.enabled === true;
  const piAdapterRevision = `${extension.runnerId}:${extension.manifest.version}:adapter-v1`;
  const piCapabilities = [
    ...extension.manifest.capabilities,
    ...(config.runtimeTools?.requestPermissions ? ["runtime:request-permissions"] : []),
    ...(config.runtimeTools?.unifiedExec ? ["runtime:unified-exec"] : []),
    ...(config.runtimeTools?.shellSnapshot ? ["runtime:shell-snapshot"] : []),
    ...(piToolHydration.mode === "daemon_hydrated" ? ["runtime:tool-hydration"] : []),
    ...(piSandboxBindingEnabled ? ["runtime:platform-native-sandbox"] : []),
  ];
  return createRunnerRegistry([
    {
      id: extension.runnerId,
      displayName: extension.manifest.name,
      status: "enabled",
      adapter: runner,
      executionBoundary: "embedded",
      adapterRevision: piAdapterRevision,
      aliases: [LEGACY_PI_RUNNER_ID],
      supportedProviderApis: extension.supportedProviderApis,
      supportedTools: extension.supportedTools,
      toolSideEffects: {
        read: "workspace_read",
        grep: "workspace_read",
        find: "workspace_read",
        ls: "workspace_read",
        bash: "shell",
        edit: "workspace_write",
        write: "workspace_write",
      },
      toolExecutionConformance: {
        adapterRevision: piAdapterRevision,
        curatedTools: extension.supportedTools,
        toolSideEffects: {
          read: "workspace_read",
          grep: "workspace_read",
          find: "workspace_read",
          ls: "workspace_read",
          bash: "shell",
          edit: "workspace_write",
          write: "workspace_write",
        },
        allowedSideEffects: ["workspace_read", "workspace_write", "shell"],
        nativeSideEffectMode: "daemon_brokered",
        toolSurfaceCurated: true,
        approvalBridgeVerified: true,
        sandboxBindingVerified: true,
        evidenceCommitVerified: true,
        abortPropagationVerified: true,
        attemptFencingVerified: true,
        workspaceBoundaryVerified: true,
        artifactImportVerified: true,
      },
      capabilities: piCapabilities,
      resumeCapabilities: extension.resumeCapabilities,
      nativeResumeConformance: {
        revision: `${extension.runnerId}:${extension.manifest.version}:resume-v1`,
        readinessPassed: true,
        conformancePassed: true,
        abortPropagationVerified: true,
        approvalBridgeVerified: true,
      },
      toolHydration: piToolHydration,
    },
    ...listNativeRunnerRegistrations(),
  ], DEFAULT_RUNNER_ID);
}

function resolvePiRunnerToolHydrationCapability(
  config: (Pick<ResolvedDaemonConfig, "runners"> | Pick<DaemonConfig, "runners">) = {},
) {
  const toolHydration = config.runners?.pi?.toolHydration;
  const maxHydratedToolsPerRun = readPositiveInteger(toolHydration?.maxHydratedToolsPerRun) ?? 64;
  if (toolHydration?.enabled === true && toolHydration.conformancePassed === true) {
    return {
      mode: "daemon_hydrated" as const,
      supportsNamespaceSearch: true,
      supportsToolHydration: true,
      conformance: "verified" as const,
      maxHydratedToolsPerRun,
    };
  }
  return {
    mode: "unsupported" as const,
    supportsNamespaceSearch: false,
    supportsToolHydration: false,
    conformance: "unverified" as const,
    maxHydratedToolsPerRun: 0,
  };
}

function readPositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function createDefaultLingExtensionRegistry(): LingExtensionRegistry {
  const registry = createLingExtensionRegistry();
  registry.register(getLocalChannelSourceExtension());
  registry.register(getPiRunnerExtension());
  for (const extension of listBuiltinToolExtensions()) {
    registry.register(extension);
  }
  for (const extension of listBuiltinSkillPackExtensions()) {
    registry.register(extension);
  }
  for (const extension of listBuiltinProviderExtensions()) {
    registry.register(extension);
  }
  return registry;
}

export function getLocalChannelSourceExtension(): ChannelSourceExtensionMetadata {
  return {
    manifest: {
      id: LOCAL_CHANNEL_SOURCE_EXTENSION_ID,
      name: "Local Channel Source",
      version: "0.1.0",
      kind: "channel-source",
      trustLevel: "internal",
      capabilities: ["channel-source:local", "source:web", "source:cli"],
    },
    sourceKind: "local",
    eventTypes: ["web", "cli", "local"],
  };
}

export async function startDaemon(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): Promise<DaemonServer> {
  const daemon = createDaemonServer(config, dependencies);
  await daemon.start();
  return daemon;
}
import { configureNormalNarrationPublication, recoverNormalNarrationPublications } from "./features/conversations/normal-narration-publication.js";
