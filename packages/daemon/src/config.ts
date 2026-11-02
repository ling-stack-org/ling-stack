import { resolve as resolvePath } from "node:path";
import { delegationBudget, resolveDelegationPriceForBudget,
  type LingSandboxPolicyProfileId, type DelegationTokenPriceSnapshot } from "@ling-stack/core";
import type { DelegationBudgetV1 } from "@ling-stack/contracts";
import type { RestrictedCommandRuntimeConfig } from "./runtime/sandbox/restricted-command-runtime.js";

export interface DaemonConfig {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly defaultWorkspaceCwd?: string;
  /** Bearer token required on every request when bound to a non-loopback host. */
  readonly authToken?: string;
  readonly runners?: RunnerFeatureConfig;
  readonly sandbox?: SandboxFeatureConfig;
  readonly runtimeTools?: RuntimeToolFeatureConfig;
  readonly transports?: TransportFeatureConfig;
  readonly channels?: ChannelFeatureConfig;
  readonly cuaDriver?: CuaDriverFeatureConfig;
  readonly remoteAccess?: RemoteAccessFeatureConfig;
  readonly workspaceSnapshots?: WorkspaceSnapshotFeatureConfig;
  readonly harness?: HarnessFeatureConfig;
}

export interface HarnessFeatureConfig {
  readonly continuations?: { readonly mode?: "off" | "shadow" | "enforce" };
  readonly toolBroker?: { readonly mode?: "off" | "shadow" | "enforce" };
  readonly evaluations?: {
    readonly mode?: "off" | "shadow" | "enforce";
    readonly modelGate?: "shadow" | "enforce";
  };
  readonly delegations?: {
    readonly mode?: "off" | "shadow" | "enforce";
    readonly maxDepth?: number;
    /** Explicit Host-selected accepted workflows. Model request metadata cannot opt in. */
    readonly selectedWorkflowIds?: readonly string[];
    /** Trusted Host startup configuration; never read from a Goal or model request. */
    readonly rootBudget?: DelegationBudgetV1;
    readonly currency?: string;
    readonly prices?: readonly DelegationTokenPriceSnapshot[];
  };
}

export interface WorkspaceSnapshotFeatureConfig {
  readonly captureEnabled?: boolean;
  readonly restoreEnabled?: boolean;
  readonly restoreUiEnabled?: boolean;
  readonly gcEnabled?: boolean;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxSnapshots?: number;
  readonly retentionDays?: number;
}

export interface RemoteAccessFeatureConfig {
  readonly listenerPort?: number;
  readonly managementAllowedOrigins?: readonly string[];
}

/**
 * Bundled Cua Driver gates are intentionally opt-in per platform. A platform
 * gate may be enabled only after its packaged provider and acceptance baseline
 * have passed; the default keeps the existing external-local path active.
 */
export interface CuaDriverFeatureConfig {
  readonly bundledEmbedded?: {
    readonly darwin?: boolean;
    readonly win32?: boolean;
  };
  /** Set only by a packaged Desktop after its provider resource assertion. */
  readonly packagedProvider?: {
    readonly darwin?: boolean;
    readonly win32?: boolean;
  };
}

export interface ChannelFeatureConfig {
  readonly autoRoute?: boolean;
  readonly intentSelector?: boolean;
  readonly teamObserverBus?: boolean;
  readonly terminalReports?: boolean;
}

export interface RuntimeToolFeatureConfig {
  readonly requestPermissions?: boolean;
  readonly unifiedExec?: boolean;
  readonly shellSnapshot?: boolean;
}

export interface TransportFeatureConfig {
  readonly providerWebSocketFallback?: boolean;
  readonly localWebSocketRpc?: boolean;
}

export interface RunnerFeatureConfig {
  readonly pi?: PiRunnerFeatureConfig;
  readonly codexAppServer?: CodexAppServerRunnerConfig;
  readonly openclawAcp?: OpenClawAcpRunnerConfig;
}

export interface SandboxFeatureConfig {
  /** Supplied only by the trusted Host bootstrap, never by workspace/runtime HTTP settings. */
  readonly restrictedCommands?: RestrictedCommandRuntimeConfig;
  readonly platformNative?: PlatformNativeSandboxFeatureConfig;
  readonly docker?: DockerSandboxFeatureConfig;
}

export type SandboxNetworkPolicyConfig =
  | { readonly mode: "disabled" }
  | { readonly mode: "allowlist"; readonly allowedHosts: readonly string[] };

export type DockerSandboxNetworkPolicy = SandboxNetworkPolicyConfig;
export type PlatformNativeSandboxNetworkPolicy = SandboxNetworkPolicyConfig;

export interface PlatformNativeSandboxFeatureConfig {
  readonly enabled?: boolean;
  readonly policyProfileId?: LingSandboxPolicyProfileId;
  readonly policyVerified?: boolean;
  readonly executionWrapperVerified?: boolean;
  readonly executionWrapperEvidenceRef?: string;
  readonly artifactImportRoot?: string;
  readonly networkPolicy?: PlatformNativeSandboxNetworkPolicy;
  readonly macosSandboxExecPath?: string;
}

export interface DockerSandboxFeatureConfig {
  readonly enabled?: boolean;
  readonly dockerBinary?: string;
  readonly image?: string;
  readonly artifactImportRoot?: string;
  readonly networkPolicy?: DockerSandboxNetworkPolicy;
  readonly cpus?: number;
  readonly memoryMb?: number;
}

export interface PiRunnerToolHydrationFeatureConfig {
  readonly enabled?: boolean;
  readonly conformancePassed?: boolean;
  readonly maxHydratedToolsPerRun?: number;
}

export interface PiRunnerSandboxBindingFeatureConfig {
  readonly enabled?: boolean;
}

export interface PiRunnerFeatureConfig {
  readonly toolHydration?: PiRunnerToolHydrationFeatureConfig;
  readonly sandboxBinding?: PiRunnerSandboxBindingFeatureConfig;
}

export interface CodexAppServerRunnerConfig {
  readonly enabled?: boolean;
  readonly baseUrl?: string;
  readonly launchMode?: "external";
  /** Legacy test flags are parsed for compatibility but never authorize external execution. */
  readonly readinessPassed?: boolean;
}

export interface OpenClawAcpRunnerConfig {
  readonly enabled?: boolean;
  readonly endpoint?: string;
  readonly workspaceMode?: "bound_path";
  /** Legacy test flags are parsed for compatibility but never authorize external execution. */
  readonly readinessPassed?: boolean;
}

export interface ResolvedDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly authToken: string | undefined;
  readonly defaultWorkspaceCwd: string;
  readonly runners: RunnerFeatureConfig;
  readonly sandbox: SandboxFeatureConfig;
  readonly runtimeTools: RuntimeToolFeatureConfig;
  readonly transports: Required<TransportFeatureConfig>;
  readonly channels: ChannelFeatureConfig;
  readonly cuaDriver: {
    readonly bundledEmbedded: {
      readonly darwin: boolean;
      readonly win32: boolean;
    };
    readonly packagedProvider: {
      readonly darwin: boolean;
      readonly win32: boolean;
    };
  };
  readonly remoteAccess: {
    readonly listenerPort: number;
    readonly managementAllowedOrigins: readonly string[];
  };
  readonly workspaceSnapshots: Required<WorkspaceSnapshotFeatureConfig>;
  readonly harness: {
    readonly continuations: { readonly mode: "off" | "shadow" | "enforce" };
    readonly toolBroker: { readonly mode: "off" | "shadow" | "enforce" };
    readonly evaluations: {
      readonly mode: "off" | "shadow" | "enforce";
      readonly modelGate: "shadow" | "enforce";
    };
    readonly delegations: {
      readonly mode: "off" | "shadow" | "enforce";
      readonly maxDepth: number;
      readonly selectedWorkflowIds: readonly string[];
      readonly rootBudget?: DelegationBudgetV1;
      readonly currency?: string;
      readonly prices?: readonly DelegationTokenPriceSnapshot[];
    };
  };
}

export const defaultDaemonConfig: DaemonConfig = {
  host: "127.0.0.1",
  port: 17891,
  maxBodyBytes: 1024 * 1024,
};

export function resolveConfig(config: DaemonConfig): ResolvedDaemonConfig {
  const port = config.port ?? 17891;
  return {
    host: config.host ?? "127.0.0.1",
    port,
    maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
    authToken: config.authToken ?? process.env.LING_STACK_AUTH_TOKEN ?? undefined,
    defaultWorkspaceCwd: resolvePath(config.defaultWorkspaceCwd ?? process.env.LING_STACK_DEFAULT_WORKSPACE_CWD ?? process.cwd()),
    runners: config.runners ?? {},
    sandbox: config.sandbox ?? {},
    runtimeTools: {
      requestPermissions: config.runtimeTools?.requestPermissions ??
        readBooleanEnv(process.env.LING_STACK_RUNTIME_REQUEST_PERMISSIONS, false),
      unifiedExec: config.runtimeTools?.unifiedExec ??
        readBooleanEnv(process.env.LING_STACK_RUNTIME_UNIFIED_EXEC, true),
      shellSnapshot: config.runtimeTools?.shellSnapshot ??
        readBooleanEnv(process.env.LING_STACK_RUNTIME_SHELL_SNAPSHOT, false),
    },
    transports: {
      providerWebSocketFallback: config.transports?.providerWebSocketFallback ??
        readBooleanEnv(process.env.LING_STACK_PROVIDER_WS_FALLBACK, true),
      localWebSocketRpc: config.transports?.localWebSocketRpc ??
        readBooleanEnv(process.env.LING_STACK_LOCAL_WS_RPC, true),
    },
    channels: {
      autoRoute: config.channels?.autoRoute ?? readBooleanEnv(process.env.LING_STACK_CHANNEL_AUTO_ROUTE, false),
      intentSelector: config.channels?.intentSelector ?? readBooleanEnv(process.env.LING_STACK_CHANNEL_INTENT_SELECTOR, true),
      teamObserverBus: config.channels?.teamObserverBus ?? readBooleanEnv(process.env.LING_STACK_CHANNEL_TEAM_OBSERVER_BUS, false),
      terminalReports: config.channels?.terminalReports ?? readBooleanEnv(process.env.LING_STACK_CHANNEL_TERMINAL_REPORTS, true),
    },
    cuaDriver: {
      bundledEmbedded: {
        darwin: config.cuaDriver?.bundledEmbedded?.darwin
          ?? readBooleanEnv(process.env.LING_STACK_CUA_DRIVER_BUNDLED_EMBEDDED_DARWIN, false),
        win32: config.cuaDriver?.bundledEmbedded?.win32
          ?? readBooleanEnv(process.env.LING_STACK_CUA_DRIVER_BUNDLED_EMBEDDED_WIN32, false),
      },
      packagedProvider: {
        darwin: config.cuaDriver?.packagedProvider?.darwin
          ?? readBooleanEnv(process.env.LING_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_DARWIN, false),
        win32: config.cuaDriver?.packagedProvider?.win32
          ?? readBooleanEnv(process.env.LING_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_WIN32, false),
      },
    },
    remoteAccess: {
      listenerPort: config.remoteAccess?.listenerPort ?? readIntegerEnv(process.env.LING_MOBILE_GATEWAY_PORT, 17892),
      managementAllowedOrigins: config.remoteAccess?.managementAllowedOrigins ?? [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        "app://ling",
      ],
    },
    workspaceSnapshots: {
      captureEnabled: config.workspaceSnapshots?.captureEnabled ?? readBooleanEnv(process.env.LING_STACK_WORKSPACE_SNAPSHOT_CAPTURE, false),
      restoreEnabled: config.workspaceSnapshots?.restoreEnabled ?? readBooleanEnv(process.env.LING_STACK_WORKSPACE_SNAPSHOT_RESTORE, false),
      restoreUiEnabled: config.workspaceSnapshots?.restoreUiEnabled ?? readBooleanEnv(process.env.LING_STACK_WORKSPACE_SNAPSHOT_UI, false),
      gcEnabled: config.workspaceSnapshots?.gcEnabled ?? readBooleanEnv(process.env.LING_STACK_WORKSPACE_SNAPSHOT_GC, false),
      maxEntries: boundedPositive(config.workspaceSnapshots?.maxEntries, 200_000, 200_000),
      maxBytes: boundedPositive(config.workspaceSnapshots?.maxBytes, 2 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
      maxFileBytes: boundedPositive(config.workspaceSnapshots?.maxFileBytes, 256 * 1024 * 1024, 256 * 1024 * 1024),
      maxSnapshots: boundedPositive(config.workspaceSnapshots?.maxSnapshots, 8, 8),
      retentionDays: boundedPositive(config.workspaceSnapshots?.retentionDays, 30, 3650),
    },
    harness: {
      continuations: {
        mode: resolveHarnessMode(config.harness?.continuations?.mode, process.env.LING_STACK_HARNESS_CONTINUATIONS_MODE),
      },
      toolBroker: {
        mode: resolveHarnessMode(config.harness?.toolBroker?.mode, process.env.LING_STACK_HARNESS_TOOL_BROKER_MODE),
      },
      evaluations: {
        mode: resolveHarnessMode(config.harness?.evaluations?.mode, process.env.LING_STACK_HARNESS_EVALUATIONS_MODE),
        modelGate: resolveHarnessModelGate(config.harness?.evaluations?.modelGate, process.env.LING_STACK_HARNESS_EVALUATION_MODEL_GATE),
      },
      delegations: {
        mode: resolveHarnessMode(config.harness?.delegations?.mode, process.env.LING_STACK_HARNESS_DELEGATIONS_MODE),
        selectedWorkflowIds: captureDelegationWorkflowIds(config.harness?.delegations?.selectedWorkflowIds),
        maxDepth: resolveHarnessDelegationMaxDepth(
          config.harness?.delegations?.maxDepth,
          process.env.LING_STACK_HARNESS_DELEGATION_MAX_DEPTH,
        ),
        ...captureDelegationBudgetConfiguration(config.harness?.delegations),
      },
    },
  };
}

function captureDelegationWorkflowIds(input: readonly string[] | undefined): readonly string[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > 100 || input.some(id => typeof id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(id)) || new Set(input).size !== input.length) {
    throw new Error("delegation.workflow_selection_invalid");
  }
  return Object.freeze([...input]);
}

/** Capture startup values by value. An absent price is not a guessed free rate. */
function captureDelegationBudgetConfiguration(input: HarnessFeatureConfig["delegations"]): {
  readonly rootBudget?: DelegationBudgetV1;
  readonly currency?: string;
  readonly prices?: readonly DelegationTokenPriceSnapshot[];
} {
  const rootBudget = input?.rootBudget === undefined ? undefined : delegationBudget(input.rootBudget);
  const currency = input?.currency;
  if (currency !== undefined && (typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency))) {
    throw new Error("delegation.invalid_currency");
  }
  const source = input?.prices;
  if (source !== undefined && (!Array.isArray(source) || source.length > 1000)) throw new Error("delegation.price_registry_invalid");
  const seen = new Set<string>();
  const prices = source?.map(entry => {
    const price = resolveDelegationPriceForBudget({ currency: entry.currency, scope: entry.scope, price: entry })!;
    const key = JSON.stringify([price.currency, price.scope]);
    if (seen.has(key)) throw new Error("delegation.price_registry_scope_duplicate");
    seen.add(key);
    return price;
  });
  return Object.freeze({ ...(rootBudget ? { rootBudget } : {}), ...(currency ? { currency } : {}),
    ...(prices ? { prices: Object.freeze(prices) } : {}) });
}

function resolveHarnessMode(
  explicit: "off" | "shadow" | "enforce" | undefined,
  environment: string | undefined,
): "off" | "shadow" | "enforce" {
  const candidate: unknown = explicit ?? environment;
  return candidate === "shadow" || candidate === "enforce" ? candidate : "off";
}

function resolveHarnessModelGate(
  explicit: "shadow" | "enforce" | undefined,
  environment: string | undefined,
): "shadow" | "enforce" {
  const candidate: unknown = explicit ?? environment;
  return candidate === "enforce" ? "enforce" : "shadow";
}

function resolveHarnessDelegationMaxDepth(explicit: number | undefined, environment: string | undefined): number {
  if (explicit !== undefined) {
    return boundedPositive(explicit, 4, 16);
  }
  if (environment === undefined) {
    return 4;
  }
  const parsed = Number(environment);
  return boundedPositive(parsed, 4, 16);
}

function boundedPositive(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, hardMax);
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function readIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}
