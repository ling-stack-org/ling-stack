import type { BundledCuaDriverPlatform } from "@ling-stack/contracts";
import type { DarwinHostPermissionSnapshot } from "./adapters/darwin-permissions.js";
import type { Win32PowerMonitorPort } from "./adapters/win32-session-observer.js";
import {
  createCuaDriverDesktopPlatformOwner,
  CuaDriverDesktopPlatformOwnerError,
  type CuaDriverDesktopPlatformOwner,
} from "./platform-owner.js";
import { loadCuaDriverRuntimeTrustPolicy } from "./runtime-trust-policy.js";

export interface CreatePackagedCuaDriverDesktopPlatformOwnerOptions {
  readonly platform: string;
  readonly resourcesPath: string;
  readonly win32SystemRoot?: string;
  readonly win32PowerMonitor?: Win32PowerMonitorPort;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly onDarwinPermissionChanged?: (
    current: DarwinHostPermissionSnapshot,
    previous: DarwinHostPermissionSnapshot,
  ) => void | Promise<void>;
}

/**
 * Production composition boundary. Callers reach it only after the independent
 * packaged-provider gate is open for the current host.
 */
export async function createPackagedCuaDriverDesktopPlatformOwner(
  options: CreatePackagedCuaDriverDesktopPlatformOwnerOptions,
): Promise<CuaDriverDesktopPlatformOwner> {
  const platform = supportedPlatform(options.platform);
  const policy = await loadCuaDriverRuntimeTrustPolicy({
    resourcesPath: options.resourcesPath,
    platform,
  });
  if (platform === "darwin") {
    return createCuaDriverDesktopPlatformOwner({
      platform,
      policy,
      ...(options.onDarwinPermissionChanged
        ? { onPermissionChanged: options.onDarwinPermissionChanged }
        : {}),
    });
  }
  return createCuaDriverDesktopPlatformOwner({
    platform,
    policy,
    ...(options.win32SystemRoot ? { systemRoot: options.win32SystemRoot } : {}),
    ...(options.win32PowerMonitor ? { powerMonitor: options.win32PowerMonitor } : {}),
    ...(options.baseEnvironment ? { baseEnvironment: options.baseEnvironment } : {}),
  });
}

function supportedPlatform(platform: string): Exclude<BundledCuaDriverPlatform, "unsupported"> {
  if (platform !== "darwin" && platform !== "win32") {
    throw new CuaDriverDesktopPlatformOwnerError("platform_mismatch", platform);
  }
  return platform;
}
