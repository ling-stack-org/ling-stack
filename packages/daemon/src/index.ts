import { createServer, type Server } from "node:http";
import {
  createSqliteRunStore,
  listBuiltinSkillPackExtensions,
  listBuiltinToolExtensions,
  createCompositeSecretResolver,
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
import { ExternalWorkBackgroundSchedulerRegistry } from "./features/external-work/background-scheduler.js";
import { createDefaultMcpBroker } from "./features/mcp/broker.js";
import { createSystemKeychainSecretStore } from "./features/providers/keychain-secret-store.js";
import { ActiveRunRegistry } from "./runtime/active-runs.js";
import { createRunnerRegistry, DEFAULT_RUNNER_ID, LEGACY_PI_RUNNER_ID, type RunnerRegistry } from "./runtime/runners.js";
import { RunStoreRegistry, type RunStoreFactory } from "./runtime/store-registry.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { routeRequest } from "./server/router.js";
import { writeJson } from "./shared/response.js";

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
export { RunStoreRegistry } from "./runtime/store-registry.js";
export { RuntimeSupervisor } from "./runtime/supervisor.js";
export type { RunStoreFactory } from "./runtime/store-registry.js";
export type { RunRequest } from "./features/runs/schemas.js";

export interface DaemonServer {
  readonly server: Server;
  readonly config: ResolvedDaemonConfig;
  readonly extensionRegistry: LingExtensionRegistry;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemonServer(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): DaemonServer {
  const resolvedConfig = resolveConfig(config);
  const runnerRegistry = dependencies.runnerRegistry ?? createDefaultRunnerRegistry(dependencies.runner);
  const extensionRegistry = dependencies.extensionRegistry ?? createDefaultLingExtensionRegistry();
  const externalSecretStore = dependencies.externalSecretStore ?? createSystemKeychainSecretStore();
  const secretResolver = dependencies.secretResolver ?? createCompositeSecretResolver({ keychainResolver: externalSecretStore });
  const externalWorkFetch = dependencies.externalWorkFetch;
  const mcpBroker = dependencies.mcpBroker ?? createDefaultMcpBroker();
  const storeRegistry = new RunStoreRegistry(dependencies.storeFactory ?? createSqliteRunStore);
  const backgroundSchedulers = new ExternalWorkBackgroundSchedulerRegistry(storeRegistry, secretResolver, externalWorkFetch);
  const activeRuns = new ActiveRunRegistry();
  const runtimeSupervisor = new RuntimeSupervisor(resolvedConfig);
  const context: DaemonContext = {
    config: resolvedConfig,
    runnerRegistry,
    storeRegistry,
    activeRuns,
    runtimeSupervisor,
    secretResolver,
    externalSecretStore,
    mcpBroker,
    externalWorkFetch,
    backgroundSchedulers,
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

  return {
    server,
    config: resolvedConfig,
    extensionRegistry,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(resolvedConfig.port, resolvedConfig.host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        activeRuns.cancelAll();
        runtimeSupervisor.releaseAll();
        backgroundSchedulers.stopAll();
        server.close((error) => {
          storeRegistry.closeAll();
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export const LOCAL_CHANNEL_SOURCE_EXTENSION_ID = "channel-source:local";

export function createDefaultRunnerRegistry(runner: RunnerAdapter = createPiRunner()): RunnerRegistry {
  const extension = getPiRunnerExtension();
  return createRunnerRegistry([
    {
      id: extension.runnerId,
      displayName: extension.manifest.name,
      status: "enabled",
      adapter: runner,
      aliases: [LEGACY_PI_RUNNER_ID],
      supportedProviderApis: extension.supportedProviderApis,
      supportedTools: extension.supportedTools,
    },
  ], DEFAULT_RUNNER_ID);
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
