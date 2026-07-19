import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { win32 } from "node:path";
import type { CuaDriverProviderProcessLifecycle } from "../provider-host.js";

export type Win32DirectSpawn = (
  executablePath: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class Win32CuaDriverLifecycleError extends Error {
  readonly code = "cua_driver_win32_lifecycle_failed" as const;

  constructor(readonly lifecycleCode: "spawn_invalid" | "terminate_failed") {
    super(`win32_provider_${lifecycleCode}`);
    this.name = "Win32CuaDriverLifecycleError";
  }
}

/**
 * Desktop retains the direct ChildProcess handle. The patched Rust child owns
 * the private KILL_ON_JOB_CLOSE Job Object for itself and every descendant.
 * No reconstructed PID, shell, detached process or taskkill tree is involved.
 */
export function createWin32CuaDriverProcessLifecycle(options: {
  readonly spawn?: Win32DirectSpawn;
} = {}): CuaDriverProviderProcessLifecycle & Readonly<{
  readonly lifetimeBoundary: "windows-job-object";
}> {
  const spawn = options.spawn ?? nodeSpawn as Win32DirectSpawn;
  return Object.freeze({
    lifetimeBoundary: "windows-job-object" as const,
    spawn(input: Parameters<CuaDriverProviderProcessLifecycle["spawn"]>[0]) {
      if (!win32.isAbsolute(input.executablePath)
        || win32.basename(input.executablePath).toLowerCase() !== "cua-driver.exe"
        || !win32.isAbsolute(input.cwd)
        || input.args.length === 0
        || Object.keys(input.environment).some((key) => key.toUpperCase() === "PATH")) {
        throw new Win32CuaDriverLifecycleError("spawn_invalid");
      }
      let child: ChildProcess;
      try {
        child = spawn(input.executablePath, [...input.args], {
          cwd: input.cwd,
          env: input.environment,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: false,
          windowsHide: true,
        });
      } catch {
        throw new Win32CuaDriverLifecycleError("spawn_invalid");
      }
      if (!child || typeof child.kill !== "function") {
        throw new Win32CuaDriverLifecycleError("spawn_invalid");
      }
      return child;
    },
    async terminate(child: ChildProcess) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (!child.kill("SIGTERM")) {
        throw new Win32CuaDriverLifecycleError("terminate_failed");
      }
    },
  });
}
