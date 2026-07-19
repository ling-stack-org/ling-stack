import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import type { CuaDriverProviderProcessLifecycle } from "../provider-host.js";

export type DarwinDirectSpawn = (
  executablePath: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class DarwinCuaDriverLifecycleError extends Error {
  readonly code = "cua_driver_darwin_lifecycle_failed" as const;

  constructor(readonly lifecycleCode: "spawn_invalid" | "terminate_failed") {
    super(`darwin_provider_${lifecycleCode}`);
    this.name = "DarwinCuaDriverLifecycleError";
  }
}

/**
 * Direct Electron-child ownership keeps the provider in Ling's macOS TCC
 * responsibility chain. No shell, LaunchServices, `open`, detached process,
 * or reconstructed PID is involved.
 */
export function createDarwinCuaDriverProcessLifecycle(options: {
  readonly spawn?: DarwinDirectSpawn;
} = {}): CuaDriverProviderProcessLifecycle & Readonly<{
  readonly lifetimeBoundary: "darwin-direct-child";
}> {
  const spawn = options.spawn ?? nodeSpawn as DarwinDirectSpawn;
  return Object.freeze({
    lifetimeBoundary: "darwin-direct-child" as const,
    spawn(input: Parameters<CuaDriverProviderProcessLifecycle["spawn"]>[0]) {
      if (!input.executablePath.startsWith("/") || input.args.length === 0) {
        throw new DarwinCuaDriverLifecycleError("spawn_invalid");
      }
      return spawn(input.executablePath, [...input.args], {
        cwd: input.cwd,
        env: input.environment,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: false,
        windowsHide: true,
      });
    },
    async terminate(child: ChildProcess) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (!child.kill("SIGTERM")) {
        throw new DarwinCuaDriverLifecycleError("terminate_failed");
      }
    },
  });
}
