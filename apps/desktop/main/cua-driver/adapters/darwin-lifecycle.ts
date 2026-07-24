import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
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

interface DarwinPinnedExecutable {
  assertCurrentPath?(): void;
  release(): void;
}

type PinDarwinExecutable = (
  executablePath: string,
  expectedDigest?: string,
) => DarwinPinnedExecutable;

/**
 * Direct Electron-child ownership keeps the provider in Ling's macOS TCC
 * responsibility chain. No shell, LaunchServices, `open`, detached process,
 * or reconstructed PID is involved.
 */
export function createDarwinCuaDriverProcessLifecycle(options: {
  readonly spawn?: DarwinDirectSpawn;
  readonly pinExecutable?: PinDarwinExecutable;
} = {}): CuaDriverProviderProcessLifecycle & Readonly<{
  readonly lifetimeBoundary: "darwin-direct-child";
}> {
  const spawn = options.spawn ?? nodeSpawn as DarwinDirectSpawn;
  const pinExecutable = options.pinExecutable ?? pinDarwinExecutable;
  return Object.freeze({
    lifetimeBoundary: "darwin-direct-child" as const,
    spawn(input: Parameters<CuaDriverProviderProcessLifecycle["spawn"]>[0]) {
      if (!input.executablePath.startsWith("/") || input.args.length === 0) {
        throw new DarwinCuaDriverLifecycleError("spawn_invalid");
      }
      let pinned: DarwinPinnedExecutable;
      try {
        pinned = pinExecutable(input.executablePath, input.executableDigest);
      } catch {
        throw new DarwinCuaDriverLifecycleError("spawn_invalid");
      }
      try {
        // AppKit-backed providers crash when current_exe/NSBundle sees a
        // `/.vol` identity, so launch through the signed app-contained path.
        // Rechecking the held vnode on both sides catches installer/update
        // replacement races around the synchronous posix_spawn call.
        pinned.assertCurrentPath?.();
        const child = spawn(input.executablePath, [...input.args], {
          cwd: input.cwd,
          env: input.environment,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: false,
          windowsHide: true,
        });
        try {
          pinned.assertCurrentPath?.();
        } catch {
          child.kill("SIGKILL");
          throw new DarwinCuaDriverLifecycleError("spawn_invalid");
        }
        return child;
      } finally {
        pinned.release();
      }
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

/** Pin and re-hash the exact regular file until direct child spawn returns. */
function pinDarwinExecutable(
  executablePath: string,
  expectedDigest?: string,
): DarwinPinnedExecutable {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(executablePath, constants.O_RDONLY | noFollow);
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      closeSync(descriptor);
    }
  };
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n) {
      throw new DarwinCuaDriverLifecycleError("spawn_invalid");
    }
    if (expectedDigest !== undefined) {
      if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
        throw new DarwinCuaDriverLifecycleError("spawn_invalid");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (true) {
        const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) {
          break;
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (hash.digest("hex") !== expectedDigest) {
        throw new DarwinCuaDriverLifecycleError("spawn_invalid");
      }
    }
    return {
      assertCurrentPath() {
        const currentDescriptor = openSync(executablePath, constants.O_RDONLY | noFollow);
        try {
          const current = fstatSync(currentDescriptor, { bigint: true });
          if (
            !current.isFile()
            || current.nlink !== 1n
            || current.dev !== metadata.dev
            || current.ino !== metadata.ino
          ) {
            throw new DarwinCuaDriverLifecycleError("spawn_invalid");
          }
        } finally {
          closeSync(currentDescriptor);
        }
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
