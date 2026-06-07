import { resolve as resolvePath } from "node:path";

export interface DaemonConfig {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly defaultWorkspaceCwd?: string;
  readonly runners?: RunnerFeatureConfig;
  readonly runtimeTools?: RuntimeToolFeatureConfig;
}

export interface RuntimeToolFeatureConfig {
  readonly requestPermissions?: boolean;
  readonly unifiedExec?: boolean;
  readonly shellSnapshot?: boolean;
}

export interface RunnerFeatureConfig {
  readonly codexAppServer?: CodexAppServerRunnerConfig;
  readonly openclawAcp?: OpenClawAcpRunnerConfig;
}

export interface CodexAppServerRunnerConfig {
  readonly enabled?: boolean;
  readonly baseUrl?: string;
  readonly launchMode?: "external";
  readonly conformancePassed?: boolean;
}

export interface OpenClawAcpRunnerConfig {
  readonly enabled?: boolean;
  readonly endpoint?: string;
  readonly workspaceMode?: "bound_path";
  readonly conformancePassed?: boolean;
}

export interface ResolvedDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly defaultWorkspaceCwd: string;
  readonly runners: RunnerFeatureConfig;
  readonly runtimeTools: RuntimeToolFeatureConfig;
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
    runtimeTools: config.runtimeTools ?? {},
  };
}
