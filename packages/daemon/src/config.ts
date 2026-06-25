import { resolve as resolvePath } from "node:path";
import type { LingSandboxPolicyProfileId } from "@ling-stack/core";

export interface DaemonConfig {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly defaultWorkspaceCwd?: string;
  readonly runners?: RunnerFeatureConfig;
  readonly sandbox?: SandboxFeatureConfig;
  readonly runtimeTools?: RuntimeToolFeatureConfig;
  readonly transports?: TransportFeatureConfig;
  readonly channels?: ChannelFeatureConfig;
}

export interface ChannelFeatureConfig {
  readonly autoRoute?: boolean;
  readonly intentSelector?: boolean;
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
  readonly readinessPassed?: boolean;
  readonly conformancePassed?: boolean;
}

export interface OpenClawAcpRunnerConfig {
  readonly enabled?: boolean;
  readonly endpoint?: string;
  readonly workspaceMode?: "bound_path";
  readonly readinessPassed?: boolean;
  readonly conformancePassed?: boolean;
}

export interface ResolvedDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly defaultWorkspaceCwd: string;
  readonly runners: RunnerFeatureConfig;
  readonly sandbox: SandboxFeatureConfig;
  readonly runtimeTools: RuntimeToolFeatureConfig;
  readonly transports: Required<TransportFeatureConfig>;
  readonly channels: ChannelFeatureConfig;
}

export const defaultDaemonConfig: DaemonConfig = {
  host: "127.0.0.1",
  port: 17891,
  maxBodyBytes: 1024 * 1024,
};

export function resolveConfig(config: DaemonConfig): ResolvedDaemonConfig {
  return {
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 17891,
    maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
    defaultWorkspaceCwd: resolvePath(config.defaultWorkspaceCwd ?? process.env.LING_STACK_DEFAULT_WORKSPACE_CWD ?? process.cwd()),
    runners: config.runners ?? {},
    sandbox: config.sandbox ?? {},
    runtimeTools: config.runtimeTools ?? {},
    transports: {
      providerWebSocketFallback: config.transports?.providerWebSocketFallback ??
        readBooleanEnv(process.env.LING_STACK_PROVIDER_WS_FALLBACK, true),
      localWebSocketRpc: config.transports?.localWebSocketRpc ??
        readBooleanEnv(process.env.LING_STACK_LOCAL_WS_RPC, true),
    },
    channels: {
      autoRoute: config.channels?.autoRoute ?? readBooleanEnv(process.env.LING_STACK_CHANNEL_AUTO_ROUTE, false),
      intentSelector: config.channels?.intentSelector ?? readBooleanEnv(process.env.LING_STACK_CHANNEL_INTENT_SELECTOR, true),
    },
  };
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
