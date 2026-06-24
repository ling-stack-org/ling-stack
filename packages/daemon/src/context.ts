import type {
  McpServer,
  McpRuntimeStatusSnapshot,
  ReplaceMcpServerToolInput,
  SecretPurpose,
  SecretResolver,
  SecretStatus,
} from "@ling-stack/core";
import type {
  PiRunnerMcpToolCallResult,
  PiRunnerResult,
  PiRunnerRunOptions,
} from "@ling-stack/runner-pi";
import type { LingExtensionRegistry } from "@ling-stack/plugin-sdk";
import type { ResolvedDaemonConfig } from "./config.js";
import type { AutomationSchedulerRegistry } from "./features/automations/scheduler.js";
import type { LingImageVisionSummarizer } from "./features/channels/materialization/registry.js";
import type { ExternalWorkBackgroundSchedulerRegistry } from "./features/external-work/background-scheduler.js";
import type { ProviderStartupRefreshService } from "./features/providers/startup-refresh.js";
import type { ControlPlaneEventHub } from "./features/control-plane/events.js";
import type { ActiveDirectReplyRegistry } from "./features/teammates/direct-reply-active-registry.js";
import type { ActiveRunRegistry } from "./runtime/active-runs.js";
import type { RunStoreFactory } from "./runtime/store-registry.js";
import type { RunStoreRegistry } from "./runtime/store-registry.js";
import type { RunnerRegistry } from "./runtime/runners.js";
import type { RuntimeSupervisor } from "./runtime/supervisor.js";
import type { StartupOptionalWarmupCoordinator } from "./startup/optional-warmups.js";
import type { StartupStateRegistry } from "./startup/state.js";

export interface RunnerAdapter {
  runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult>;
}

export interface McpBroker {
  checkServer(
    server: McpServer,
    options: McpBrokerOptions,
  ): Promise<{ readonly statusSnapshot: McpRuntimeStatusSnapshot }>;
  listTools(
    server: McpServer,
    options: McpBrokerOptions,
  ): Promise<{
    readonly statusSnapshot: McpRuntimeStatusSnapshot;
    readonly tools: readonly ReplaceMcpServerToolInput[];
  }>;
  callTool(
    server: McpServer,
    options: McpBrokerOptions,
    toolName: string,
    input: unknown,
  ): Promise<PiRunnerMcpToolCallResult>;
}

export interface McpBrokerOptions {
  readonly secretResolver: SecretResolver;
  readonly now?: () => string;
}

export interface ExternalSecretStore extends SecretResolver {
  setSecret(ref: string, value: string, purpose?: SecretPurpose): SecretStatus;
  deleteSecret(ref: string, purpose?: SecretPurpose): SecretStatus;
}

export interface DaemonDependencies {
  readonly runner?: RunnerAdapter;
  readonly runnerRegistry?: RunnerRegistry;
  readonly storeFactory?: RunStoreFactory;
  readonly extensionRegistry?: LingExtensionRegistry;
  readonly secretResolver?: SecretResolver;
  readonly externalSecretStore?: ExternalSecretStore;
  readonly externalWorkFetch?: typeof globalThis.fetch;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly channelWebFetch?: typeof globalThis.fetch;
  readonly channelWebResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly mcpBroker?: McpBroker;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
}

export interface DaemonContext {
  readonly config: ResolvedDaemonConfig;
  readonly runnerRegistry: RunnerRegistry;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly storeRegistry: RunStoreRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly activeDirectReplies: ActiveDirectReplyRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly externalSecretStore: ExternalSecretStore;
  readonly mcpBroker: McpBroker;
  readonly externalWorkFetch?: typeof globalThis.fetch;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
  readonly backgroundSchedulers: ExternalWorkBackgroundSchedulerRegistry;
  readonly automationSchedulers: AutomationSchedulerRegistry;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly providerStartupRefresh: ProviderStartupRefreshService;
  readonly startupState: StartupStateRegistry;
  readonly startupOptionalWarmups: StartupOptionalWarmupCoordinator;
}
