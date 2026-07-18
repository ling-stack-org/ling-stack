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
import { createDefaultMcpBroker } from "./features/mcp/broker.js";
import { createSystemKeychainSecretStore } from "./features/providers/keychain-secret-store.js";
import { ProviderStartupRefreshService } from "./features/providers/startup-refresh.js";
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

export interface DaemonServer {
  readonly server: Server;
  readonly config: ResolvedDaemonConfig;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly startupState: StartupStateRegistry;
  readonly computerUsePreviews: ComputerUseProjectionRegistry;
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
  const mcpBroker = dependencies.mcpBroker ?? createDefaultMcpBroker();
  const controlPlaneEvents = new ControlPlaneEventHub();
  const startupState = new StartupStateRegistry();
  const computerUsePreviews = new ComputerUseProjectionRegistry(dependencies.computerUseProjectionOptions);
  const providerStartupRefresh = new ProviderStartupRefreshService({ secretResolver, controlPlaneEvents, startupState });
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
  const context: DaemonContext = {
    config: resolvedConfig,
    runnerRegistry,
    extensionRegistry,
    storeRegistry,
    activeRuns,
    activeDirectReplies,
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
    startupState,
    startupOptionalWarmups,
    computerUsePreviews,
    computerUseStop: dependencies.computerUseStop,
    desktopBridgeToken: dependencies.desktopBridgeToken ?? process.env.LING_DESKTOP_BRIDGE_TOKEN,
    computerUseRouteToken:
      dependencies.computerUseRouteToken
      ?? process.env.LING_COMPUTER_USE_ROUTE_TOKEN
      ?? dependencies.desktopBridgeToken
      ?? process.env.LING_DESKTOP_BRIDGE_TOKEN,
    computerUseTargetOwnershipTimeoutMs: dependencies.computerUseTargetOwnershipTimeoutMs,
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
    start: async () => {
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
      await new Promise<void>((resolve, reject) => {
        activeRuns.cancelAll();
        activeDirectReplies.cancelAll();
        runtimeSupervisor.releaseAll();
        backgroundSchedulers.stopAll();
        automationSchedulers.stopAll();
        controlPlaneEvents.closeAll();
        computerUsePreviews.closeAll();
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
      storeRegistry.closeAll();
    },
  };
}

function createDefaultRunStore(cwd: string) {
  return createSqliteRunStore(cwd, resolveStoragePaths(cwd).workspace);
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
