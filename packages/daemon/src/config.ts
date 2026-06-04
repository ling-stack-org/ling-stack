import { resolve as resolvePath } from "node:path";

export interface DaemonConfig {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly defaultWorkspaceCwd?: string;
}

export interface ResolvedDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly defaultWorkspaceCwd: string;
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
  };
}
