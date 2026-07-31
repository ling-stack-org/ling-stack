import type { BundledCuaDriverPlatform } from "@ling-stack/contracts";
import {
  createDarwinCuaDriverAdapter,
  type DarwinCuaDriverAdapter,
  type DarwinDirectSpawn,
  type DarwinHostPermissionPort,
  type DarwinPermissionMonitorScheduler,
} from "./adapters/darwin.js";
import type { DarwinIdentityCommandRunner } from "./adapters/darwin-identity.js";
import {
  createWin32CuaDriverPlatformBinding,
  type CreateWin32CuaDriverPlatformBindingOptions,
} from "./adapters/win32.js";
import type { CuaDriverPlatformBinding } from "./platform-binding.js";
import type { CuaDriverRuntimeTrustPolicyV1 } from "./runtime-trust-policy.js";

export type CuaDriverDesktopPlatformOwnerErrorCode =
  | "disposed"
  | "platform_mismatch"
  | "system_root_missing"
  | "win32_power_monitor_missing";

export class CuaDriverDesktopPlatformOwnerError extends Error {
  readonly code = "cua_driver_desktop_platform_owner_failed" as const;

  constructor(
    readonly ownerCode: CuaDriverDesktopPlatformOwnerErrorCode,
    readonly platform: string,
  ) {
    super(`cua_driver_desktop_platform_owner_${ownerCode}:${platform}`);
    this.name = "CuaDriverDesktopPlatformOwnerError";
  }
}

export interface CuaDriverDesktopPlatformOwner {
  readonly platform: Exclude<BundledCuaDriverPlatform, "unsupported">;
  readonly binding: CuaDriverPlatformBinding;
  /** Idempotently starts process-wide observers owned outside one authority tuple. */
  start(): Promise<void>;
  /** Idempotently releases observers after every coordinator has stopped. */
  dispose(): Promise<void>;
  /** Explicit user action only; never invoked by activation or startup. */
  requestPermissions?(): Promise<void>;
}

interface CreateCuaDriverDesktopPlatformOwnerBaseOptions {
  readonly platform: Exclude<BundledCuaDriverPlatform, "unsupported">;
  readonly policy: CuaDriverRuntimeTrustPolicyV1;
}

export interface CreateDarwinCuaDriverDesktopPlatformOwnerOptions
  extends CreateCuaDriverDesktopPlatformOwnerBaseOptions {
  readonly platform: "darwin";
  readonly identityCommandRunner?: DarwinIdentityCommandRunner;
  readonly spawn?: DarwinDirectSpawn;
  readonly permissionPort?: DarwinHostPermissionPort;
  readonly permissionScheduler?: DarwinPermissionMonitorScheduler;
  readonly permissionPollIntervalMs?: number;
  readonly onPermissionChanged?: Parameters<typeof createDarwinCuaDriverAdapter>[0]["onPermissionChanged"];
}

export interface CreateWin32CuaDriverDesktopPlatformOwnerOptions
  extends CreateCuaDriverDesktopPlatformOwnerBaseOptions {
  readonly platform: "win32";
  /** Supplied by a trusted platform fact provider, never by process.env. */
  readonly systemRoot?: string;
  readonly powerMonitor?: CreateWin32CuaDriverPlatformBindingOptions["powerMonitor"];
  readonly baseEnvironment?: CreateWin32CuaDriverPlatformBindingOptions["baseEnvironment"];
  readonly commandRunner?: CreateWin32CuaDriverPlatformBindingOptions["commandRunner"];
  readonly stateRootFileSystem?: CreateWin32CuaDriverPlatformBindingOptions["stateRootFileSystem"];
  readonly spawn?: CreateWin32CuaDriverPlatformBindingOptions["spawn"];
  readonly commandTimeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export type CreateCuaDriverDesktopPlatformOwnerOptions =
  | CreateDarwinCuaDriverDesktopPlatformOwnerOptions
  | CreateWin32CuaDriverDesktopPlatformOwnerOptions;

/** Assemble exactly one host adapter for the lifetime of the Electron main process. */
export function createCuaDriverDesktopPlatformOwner(
  options: CreateCuaDriverDesktopPlatformOwnerOptions,
): CuaDriverDesktopPlatformOwner {
  if (options.policy.platform !== options.platform) {
    throw new CuaDriverDesktopPlatformOwnerError("platform_mismatch", options.platform);
  }
  if (options.platform === "darwin") {
    if (options.policy.platform !== "darwin") {
      throw new CuaDriverDesktopPlatformOwnerError("platform_mismatch", options.platform);
    }
    const adapter = createDarwinCuaDriverAdapter({
      expectedTeamId: options.policy.expectedTeamId,
      ...(options.identityCommandRunner ? { identityCommandRunner: options.identityCommandRunner } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.permissionPort ? { permissionPort: options.permissionPort } : {}),
      ...(options.permissionScheduler ? { permissionScheduler: options.permissionScheduler } : {}),
      ...(options.permissionPollIntervalMs !== undefined
        ? { permissionPollIntervalMs: options.permissionPollIntervalMs }
        : {}),
      ...(options.onPermissionChanged ? { onPermissionChanged: options.onPermissionChanged } : {}),
    });
    return new DarwinCuaDriverDesktopPlatformOwner(adapter);
  }
  if (options.policy.platform !== "win32") {
    throw new CuaDriverDesktopPlatformOwnerError("platform_mismatch", options.platform);
  }
  if (!options.systemRoot) {
    throw new CuaDriverDesktopPlatformOwnerError("system_root_missing", options.platform);
  }
  if (!options.powerMonitor) {
    throw new CuaDriverDesktopPlatformOwnerError("win32_power_monitor_missing", options.platform);
  }
  const binding = createWin32CuaDriverPlatformBinding({
    signingPolicy: options.policy.signingPolicy,
    systemRoot: options.systemRoot,
    powerMonitor: options.powerMonitor,
    ...(options.baseEnvironment !== undefined ? { baseEnvironment: options.baseEnvironment } : {}),
    ...(options.commandRunner !== undefined ? { commandRunner: options.commandRunner } : {}),
    ...(options.stateRootFileSystem !== undefined
      ? { stateRootFileSystem: options.stateRootFileSystem }
      : {}),
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    ...(options.commandTimeoutMs !== undefined ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
    ...(options.maxStdoutBytes !== undefined ? { maxStdoutBytes: options.maxStdoutBytes } : {}),
    ...(options.maxStderrBytes !== undefined ? { maxStderrBytes: options.maxStderrBytes } : {}),
  });
  return new Win32CuaDriverDesktopPlatformOwner(binding);
}

class DarwinCuaDriverDesktopPlatformOwner implements CuaDriverDesktopPlatformOwner {
  readonly platform = "darwin" as const;
  readonly binding: CuaDriverPlatformBinding;

  private startPromise: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly adapter: DarwinCuaDriverAdapter) {
    this.binding = adapter.binding;
  }

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new CuaDriverDesktopPlatformOwnerError("disposed", this.platform));
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const pending = this.adapter.permissionController.startMonitoring();
    this.startPromise = pending;
    void pending.catch(() => {
      if (this.startPromise === pending) {
        this.startPromise = undefined;
      }
    });
    return pending;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.disposePromise = Promise.resolve().then(() => {
      this.adapter.dispose();
    });
    return this.disposePromise;
  }

  async requestPermissions(): Promise<void> {
    await this.adapter.permissionController.requestHostPermissions();
  }
}

class Win32CuaDriverDesktopPlatformOwner implements CuaDriverDesktopPlatformOwner {
  readonly platform = "win32" as const;
  private disposed = false;

  constructor(readonly binding: CuaDriverPlatformBinding) {}

  start(): Promise<void> {
    return this.disposed
      ? Promise.reject(new CuaDriverDesktopPlatformOwnerError("disposed", this.platform))
      : Promise.resolve();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}
