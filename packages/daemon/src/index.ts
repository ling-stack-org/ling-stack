import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  createSqliteRunStore,
  listBuiltinSkillPackExtensions,
  listBuiltinToolExtensions,
  createCompositeSecretResolver,
  resolveStoragePaths,
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
import { createDefaultMcpBroker } from "./features/mcp/broker.js";
import { createSystemKeychainSecretStore } from "./features/providers/keychain-secret-store.js";
import { ProviderStartupRefreshService } from "./features/providers/startup-refresh.js";
import { ProviderImportPreflightService } from "./features/providers/import-preflight.js";
import { ActiveDirectReplyRegistry } from "./features/teammates/direct-reply-active-registry.js";
import { resumePendingMediaJobExecutions } from "./features/media/executor.js";
import { ActiveRunRegistry } from "./runtime/active-runs.js";
import { createRunnerRegistry, DEFAULT_RUNNER_ID, LEGACY_PI_RUNNER_ID, type RunnerRegistry } from "./runtime/runners.js";
import { listExternalRunnerRegistrations } from "./runtime/external-runners.js";
import { RunStoreRegistry, type RunStoreFactory } from "./runtime/store-registry.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startRuntimeWorkUnit, transitionWorkUnitTerminal } from "./runtime/work-units.js";
import { routeRequest } from "./server/router.js";
import { attachRpcWebSocketServer } from "./server/rpc.js";
import { writeJson } from "./shared/response.js";
import { StartupOptionalWarmupCoordinator } from "./startup/optional-warmups.js";
import { StartupStateRegistry } from "./startup/state.js";
import { warmDefaultWorkspaceStartup } from "./startup/warmup.js";
import { ComputerUseProjectionRegistry } from "./features/computer-use/registry.js";
import { CuaDriverDesktopBridgeAuthority } from "./features/computer-use/desktop-bridge-authority.js";
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
import { createCuaDriverDescriptor } from "./features/plugins/presets.js";
import { RemoteAccessController } from "./features/remote-access/controller.js";
import { DefaultRemoteReplyDispatcher } from "./features/remote-access/default-reply-dispatcher.js";

export { defaultDaemonConfig } from "./config.js";
export type { DaemonConfig, ResolvedDaemonConfig } from "./config.js";
export type { DaemonDependencies, ExternalSecretStore, McpBroker, RunnerAdapter } from "./context.js";
export {
  createRunnerRegistry,
  DEFAULT_RUNNER_ID,
  LEGACY_PI_RUNNER_ID,
  UnsupportedRunnerError,
  normalizeRunnerId,
  type RegisteredRunner,
  type RunnerRegistry,
  type RunnerResolution,
  type RunnerResolutionInput,
} from "./runtime/runners.js";
export type { RunnerFallbackReason } from "@ling-stack/core";
export { ActiveRunRegistry } from "./runtime/active-runs.js";
export { ActiveDirectReplyRegistry } from "./features/teammates/direct-reply-active-registry.js";
export { ChannelReplyDispatchCoordinator } from "./features/channels/channel-reply-dispatch-coordinator.js";
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
  const secretResolver = dependencies.secretResolver ?? createCompositeSecretResolver({ keychainResolver: externalSecretStore });
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
  const providerStartupRefresh = new ProviderStartupRefreshService({ secretResolver, controlPlaneEvents, startupState });
  const providerImportPreflight = new ProviderImportPreflightService({ secretResolver, controlPlaneEvents });
  let automationSchedulers: AutomationSchedulerRegistry;
  let startupOptionalWarmups: StartupOptionalWarmupCoordinator;
  const storeRegistry = new RunStoreRegistry(dependencies.storeFactory ?? createDefaultRunStore, {
    trustedWorkspaceRoots: [resolvedConfig.defaultWorkspaceCwd],
    onStoreInitialized: (cwd, store) => {
      configureTerminalReportStore(store, {
        enabled: resolvedConfig.channels.terminalReports === true,
        runnerRegistry,
        secretResolver,
      });
      startupOptionalWarmups?.start(cwd, store);
      if (resolvedConfig.channels.terminalReports === true) {
        void recoverTerminalReports(store).catch(() => undefined);
      }
    },
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
  const mcpBroker = createCuaDriverGenerationBroker({
    baseBroker: baseMcpBroker,
    bundledEnabled: bundledCuaDriverEnabled,
    workspaceCwd: resolvedConfig.defaultWorkspaceCwd,
    leaseRegistry: cuaDriverDesktopBridgeAuthority.leaseRegistry,
    clientPool: cuaDriverClientPool,
    ...(lockedComputerControl ? { lockedControlRegistry: lockedComputerControl } : {}),
  });
  const backgroundSchedulers = new ExternalWorkBackgroundSchedulerRegistry(storeRegistry, secretResolver, externalWorkFetch);
  const activeRuns = new ActiveRunRegistry();
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
  });
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
  );
  startupOptionalWarmups = new StartupOptionalWarmupCoordinator({
    startupState,
    providerStartupRefresh,
    automationSchedulers,
  });
  const activeDirectReplies = new ActiveDirectReplyRegistry();
  const channelReplyDispatchCoordinator = new ChannelReplyDispatchCoordinator();
  const remoteAccessManagementCapability = dependencies.remoteAccessManagementCapability
    ?? process.env.LING_MOBILE_ACCESS_MANAGEMENT_CAPABILITY
    ?? randomBytes(32).toString("base64url");
  const defaultStoragePaths = resolveStoragePaths(resolvedConfig.defaultWorkspaceCwd);
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
  const context: DaemonContext = {
    config: resolvedConfig,
    runnerRegistry,
    extensionRegistry,
    storeRegistry,
    activeRuns,
    activeDirectReplies,
    channelReplyDispatchCoordinator,
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
  };
  const server = createServer(async (request, response) => {
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
  const rpcWebSocketServer = attachRpcWebSocketServer(server, context);

  return {
    server,
    config: resolvedConfig,
    extensionRegistry,
    startupState,
    computerUsePreviews,
    remoteAccessManagement: {
      capability: remoteAccessManagementCapability,
      csrfToken: remoteAccess.csrfToken,
    },
    start: async () => {
      cuaDriverActivationCoordinator.resetForDaemonStart();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(resolvedConfig.port, resolvedConfig.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await warmDefaultWorkspaceStartup({
        cwd: resolvedConfig.defaultWorkspaceCwd,
        startupState,
        storeRegistry,
        runnerRegistry,
        secretResolver,
      });
      // Ephemeral control-plane servers are used by tests and embedded fixtures.
      // They must never claim the installation-global Remote Gateway listener.
      if (resolvedConfig.port !== 0) {
        await remoteAccess.startIfEnabled();
      }
      startupOptionalWarmups.start(resolvedConfig.defaultWorkspaceCwd, storeRegistry.getStore(resolvedConfig.defaultWorkspaceCwd));
      resumePendingMediaJobExecutions({
        cwd: resolvedConfig.defaultWorkspaceCwd,
        storeRegistry,
        secretResolver,
        hooks: {
          startRuntimeWorkUnit: (input) => startRuntimeWorkUnit({ ...input, runtimeSupervisor }),
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
        },
      });
    },
    stop: async () => {
      cuaDriverActivationCoordinator.beginShutdown();
      const providerImportShutdown = providerImportPreflight.shutdown();
      await remoteAccess.stop();
      await new Promise<void>((resolve, reject) => {
        activeRuns.cancelAll();
        activeDirectReplies.cancelAll();
        channelReplyDispatchCoordinator.close();
        runtimeSupervisor.releaseAll();
        backgroundSchedulers.stopAll();
        automationSchedulers.stopAll();
        controlPlaneEvents.closeAll();
        computerUsePreviews.closeAll();
        cuaDriverDesktopBridgeAuthority.clear();
        lockedComputerControl?.close();
        rpcWebSocketServer.close();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      });
      await activeRuns.waitForIdle();
      await automationSchedulers.waitForIdle();
      await providerImportShutdown;
      await cuaDriverActivationCoordinator.shutdown();
      storeRegistry.closeAll();
    },
  };
}

function createDefaultRunStore(cwd: string) {
  return createSqliteRunStore(cwd, resolveStoragePaths(cwd).workspace);
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
      aliases: [LEGACY_PI_RUNNER_ID],
      supportedProviderApis: extension.supportedProviderApis,
      supportedTools: extension.supportedTools,
      capabilities: piCapabilities,
      toolHydration: piToolHydration,
    },
    ...listExternalRunnerRegistrations(config),
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
