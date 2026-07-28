import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { win32 } from "node:path";
import { cuaDriverArtifactLayoutFor } from "../../../shared/cua-driver-artifact-layout.mjs";
import type {
  CuaDriverPreparedProviderSpawn,
  CuaDriverProviderProcessLifecycle,
} from "../provider-host.js";
import { WIN32_KERNEL_SYSTEM_ROOT } from "./win32-command.js";
import { createWin32ExecutableSpawnLeaseAcquirer } from "./win32-executable-lease.js";

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
  readonly systemRoot?: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly acquireSpawnLease?: (input: {
    readonly executablePath: string;
    readonly executableDigest: string;
    readonly signal: AbortSignal;
  }) => Promise<CuaDriverPreparedProviderSpawn>;
} = {}): CuaDriverProviderProcessLifecycle & Readonly<{
  readonly lifetimeBoundary: "windows-job-object";
}> {
  const spawn = options.spawn ?? nodeSpawn as Win32DirectSpawn;
  const acquireSpawnLease = options.acquireSpawnLease
    ?? createWin32ExecutableSpawnLeaseAcquirer({
      systemRoot: options.systemRoot ?? WIN32_KERNEL_SYSTEM_ROOT,
      ...(options.baseEnvironment ? { baseEnvironment: options.baseEnvironment } : {}),
    });
  const preparedSpawns = new WeakSet<CuaDriverPreparedProviderSpawn>();
  return Object.freeze({
    lifetimeBoundary: "windows-job-object" as const,
    async prepareSpawn(input: {
      readonly executablePath: string;
      readonly executableDigest: string;
      readonly signal: AbortSignal;
    }) {
      const prepared = await acquireSpawnLease(input);
      if (prepared.executablePath !== input.executablePath
        || prepared.executableDigest !== input.executableDigest) {
        await prepared.abort().catch(() => undefined);
        throw new Win32CuaDriverLifecycleError("spawn_invalid");
      }
      preparedSpawns.add(prepared);
      return prepared;
    },
    spawn(input: Parameters<CuaDriverProviderProcessLifecycle["spawn"]>[0]) {
      if (!win32.isAbsolute(input.executablePath)
        || win32.basename(input.executablePath).toLowerCase()
          !== cuaDriverArtifactLayoutFor("win32-x64").packagedExecutableName
        || !input.executableDigest
        || !input.preparedSpawn
        || !preparedSpawns.has(input.preparedSpawn)
        || input.preparedSpawn.executablePath !== input.executablePath
        || input.preparedSpawn.executableDigest !== input.executableDigest
        || !win32.isAbsolute(input.cwd)
        || input.args.length === 0
        || Object.keys(input.environment).some((key) => key.toUpperCase() === "PATH")) {
        throw new Win32CuaDriverLifecycleError("spawn_invalid");
      }
      preparedSpawns.delete(input.preparedSpawn);
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
      try {
        // The provider host owns the exit deadline and retained-handle residue
        // check. A false return or a synchronous throw must not race a close
        // event that has already happened but has not reached Node yet.
        child.kill("SIGTERM");
      } catch {
        // Let provider-host.ts observe the retained child until its deadline.
      }
    },
  });
}
