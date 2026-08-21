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
import type { ChannelReplyDispatchCoordinator } from "./features/channels/channel-reply-dispatch-coordinator.js";
import type { ExternalWorkBackgroundSchedulerRegistry } from "./features/external-work/background-scheduler.js";
import type { ProviderStartupRefreshService } from "./features/providers/startup-refresh.js";
import type { ProviderImportPreflightService } from "./features/providers/import-preflight.js";
import type { ControlPlaneEventHub } from "./features/control-plane/events.js";
import type { ComputerUsePreviewProjection } from "@ling-stack/contracts";
import type {
  ComputerUseProjectionRegistry,
  ComputerUseProjectionRegistryOptions,
} from "./features/computer-use/registry.js";
import type { CuaDriverDesktopBridgeAuthority } from "./features/computer-use/desktop-bridge-authority.js";
import type { LockedComputerControlRegistry } from "./features/computer-use/locked-control-registry.js";
import type { ActiveDirectReplyRegistry } from "./features/teammates/direct-reply-active-registry.js";
import type { ActiveRunRegistry } from "./runtime/active-runs.js";
import type { RunStoreFactory } from "./runtime/store-registry.js";
import type { RunStoreRegistry } from "./runtime/store-registry.js";
import type { RunnerRegistry } from "./runtime/runners.js";
import type { RuntimeSupervisor } from "./runtime/supervisor.js";
import type { StartupOptionalWarmupCoordinator } from "./startup/optional-warmups.js";
import type { StartupStateRegistry } from "./startup/state.js";
import type { BundledCuaDriverActivationService } from "./features/plugins/cua-driver-bundled-activation.js";
import type { CuaDriverPooledClientFactory } from "./features/plugins/cua-driver-client-pool.js";
import type { CuaDriverLeaseMcpClient } from "./features/plugins/cua-driver-lease-client.js";
import type { CuaDriverDaemonActivationCoordinator } from "./features/plugins/cua-driver-daemon-composition.js";
import type { RemoteAccessController } from "./features/remote-access/controller.js";
import type { RemoteReplyDispatcher } from "./features/remote-access/dispatch-worker.js";
import type { ChromeBrowserSessionController } from "./features/browser-extension/session-controller.js";
import type { ChromeBrowserPluginService } from "./features/plugins/chrome-browser.js";

export interface RunnerAdapter {
  runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult>;
}

export interface McpBroker {
  /** Immutable daemon authority for deciding whether persisted Cua state is bundled. */
  readonly cuaDriverRuntimeAuthority?: {
    readonly enabled: boolean;
    readonly workspaceCwd: string;
    readonly platform: NodeJS.Platform;
    readonly hasCurrentLease: () => boolean;
    readonly assertLockedApprovalAllowed?: (input: {
      readonly serverId: string;
      readonly runId: string;
      readonly computerUseSessionId: string;
      readonly toolId: string;
      readonly toolCallId: string;
      readonly defaultApproval: "allow" | "ask" | "deny";
    }) => void;
  };
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
  /** Workspace authority for generation-scoped bundled providers. */
  readonly workspaceCwd?: string;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
  /** Synchronous authorization fence run after transport completion. */
  readonly assertResultCurrent?: () => void;
  readonly lockedControlExecution?: {
    readonly runId: string;
    readonly computerUseSessionId: string;
    readonly toolCallId: string;
    readonly defaultApproval: "allow" | "ask" | "deny";
    readonly approvalId?: string;
  };
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
  readonly cuaDriverLeaseClientFactory?: CuaDriverPooledClientFactory<CuaDriverLeaseMcpClient>;
  /** Deterministic lease deadline adapter for integration tests. */
  readonly cuaDriverLeaseScheduleDeadline?: (
    callback: () => void,
    delayMs: number,
  ) => { cancel(): void };
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
  readonly computerUseStop?: (input: {
    readonly cwd: string;
    readonly projection: ComputerUsePreviewProjection;
    readonly reason?: string;
  }) => Promise<{
    readonly accepted: boolean;
    readonly acknowledged: boolean;
    readonly reason?: string;
    readonly terminalStatus?: Extract<
      ComputerUsePreviewProjection["status"],
      "succeeded" | "failed" | "cancelled"
    >;
  }>;
  readonly desktopBridgeToken?: string;
  /**
   * Installation-scoped token for native Computer Use list/events/stream/stop
   * requests that cannot carry a browser Origin. Kept separate from the
   * descriptor bridge header at the HTTP boundary even when the alpha Desktop
   * passes the same generated secret for both capabilities.
   */
  readonly computerUseRouteToken?: string;
  readonly computerUseProjectionOptions?: ComputerUseProjectionRegistryOptions;
  readonly computerUseTargetOwnershipTimeoutMs?: number;
  readonly remoteAccessManagementCapability?: string;
  readonly remoteAccessStateDir?: string;
  /** Pass null only for fail-closed embedding/tests that intentionally disable Mobile send. */
  readonly remoteReplyDispatcher?: RemoteReplyDispatcher | null;
  readonly chromeBrowserExtensionIds?: readonly string[];
  readonly chromeBrowserNativeMessagingEnabled?: boolean;
  readonly chromeBrowserHostPath?: string;
  readonly chromeBrowserRuntimeDescriptorPath?: string;
}

export interface DaemonContext {
  readonly config: ResolvedDaemonConfig;
  readonly runnerRegistry: RunnerRegistry;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly storeRegistry: RunStoreRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly activeDirectReplies: ActiveDirectReplyRegistry;
  readonly channelReplyDispatchCoordinator: ChannelReplyDispatchCoordinator;
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
  readonly providerImportPreflight: ProviderImportPreflightService;
  readonly startupState: StartupStateRegistry;
  readonly startupOptionalWarmups: StartupOptionalWarmupCoordinator;
  readonly computerUsePreviews: ComputerUseProjectionRegistry;
  readonly cuaDriverDesktopBridgeAuthority: CuaDriverDesktopBridgeAuthority;
  readonly lockedComputerControl?: LockedComputerControlRegistry;
  readonly cuaDriverActivationService: BundledCuaDriverActivationService;
  readonly cuaDriverActivationCoordinator: CuaDriverDaemonActivationCoordinator;
  readonly computerUseStop?: DaemonDependencies["computerUseStop"];
  readonly desktopBridgeToken?: string;
  readonly computerUseRouteToken?: string;
  readonly computerUseTargetOwnershipTimeoutMs?: number;
  readonly remoteAccess: RemoteAccessController;
  readonly chromeBrowserSessions: ChromeBrowserSessionController;
  readonly chromeBrowserPlugin: ChromeBrowserPluginService;
}
