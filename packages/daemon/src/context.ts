import type {
  McpServer,
  McpServerStatus,
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
import type { ExternalWorkBackgroundSchedulerRegistry } from "./features/external-work/background-scheduler.js";
import type { ActiveRunRegistry } from "./runtime/active-runs.js";
import type { RunStoreFactory } from "./runtime/store-registry.js";
import type { RunStoreRegistry } from "./runtime/store-registry.js";
import type { RuntimeSupervisor } from "./runtime/supervisor.js";

export interface RunnerAdapter {
  runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult>;
}

export interface McpBroker {
  checkServer(
    server: McpServer,
    secrets: Readonly<Record<string, string>>,
  ): Promise<{ readonly status: McpServerStatus }>;
  listTools(
    server: McpServer,
    secrets: Readonly<Record<string, string>>,
  ): Promise<readonly ReplaceMcpServerToolInput[]>;
  callTool(
    server: McpServer,
    secrets: Readonly<Record<string, string>>,
    toolName: string,
    input: unknown,
  ): Promise<PiRunnerMcpToolCallResult>;
}

export interface ExternalSecretStore extends SecretResolver {
  setSecret(ref: string, value: string, purpose?: SecretPurpose): SecretStatus;
  deleteSecret(ref: string, purpose?: SecretPurpose): SecretStatus;
}

export interface DaemonDependencies {
  readonly runner?: RunnerAdapter;
  readonly storeFactory?: RunStoreFactory;
  readonly extensionRegistry?: LingExtensionRegistry;
  readonly secretResolver?: SecretResolver;
  readonly externalSecretStore?: ExternalSecretStore;
  readonly externalWorkFetch?: typeof globalThis.fetch;
  readonly mcpBroker?: McpBroker;
}

export interface DaemonContext {
  readonly config: ResolvedDaemonConfig;
  readonly runner: RunnerAdapter;
  readonly storeRegistry: RunStoreRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly externalSecretStore: ExternalSecretStore;
  readonly mcpBroker: McpBroker;
  readonly externalWorkFetch?: typeof globalThis.fetch;
  readonly backgroundSchedulers: ExternalWorkBackgroundSchedulerRegistry;
}
