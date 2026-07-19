import type { DarwinCuaDriverPlatformBinding } from "../platform-binding.js";
import {
  DarwinCuaDriverIdentityVerifier,
  type DarwinIdentityCommandRunner,
} from "./darwin-identity.js";
import {
  createDarwinCuaDriverProcessLifecycle,
  type DarwinDirectSpawn,
} from "./darwin-lifecycle.js";
import {
  DarwinCuaDriverPermissionController,
  DarwinCuaDriverReadinessController,
  type DarwinHostPermissionPort,
  type DarwinHostPermissionSnapshot,
  type DarwinPermissionMonitorScheduler,
} from "./darwin-permissions.js";

export interface DarwinCuaDriverAdapter {
  readonly binding: DarwinCuaDriverPlatformBinding;
  readonly permissionController: DarwinCuaDriverPermissionController;
  dispose(): void;
}

/**
 * Assemble one coherent macOS adapter. The permission controller remains a
 * platform-owned side channel so future DesktopRuntime composition can start
 * and stop monitoring with requested enablement, then rotate the provider
 * generation from `onPermissionChanged`.
 */
export function createDarwinCuaDriverAdapter(options: {
  readonly expectedTeamId: string;
  readonly identityCommandRunner?: DarwinIdentityCommandRunner;
  readonly spawn?: DarwinDirectSpawn;
  readonly permissionPort?: DarwinHostPermissionPort;
  readonly permissionScheduler?: DarwinPermissionMonitorScheduler;
  readonly permissionPollIntervalMs?: number;
  readonly onPermissionChanged?: (
    current: DarwinHostPermissionSnapshot,
    previous: DarwinHostPermissionSnapshot,
  ) => void | Promise<void>;
}): DarwinCuaDriverAdapter {
  const permissionController = new DarwinCuaDriverPermissionController({
    ...(options.permissionPort ? { port: options.permissionPort } : {}),
    ...(options.permissionScheduler ? { scheduler: options.permissionScheduler } : {}),
    ...(options.permissionPollIntervalMs !== undefined
      ? { pollIntervalMs: options.permissionPollIntervalMs }
      : {}),
    ...(options.onPermissionChanged ? { onChanged: options.onPermissionChanged } : {}),
  });
  const binding: DarwinCuaDriverPlatformBinding = Object.freeze({
    platform: "darwin",
    availability: Object.freeze({ status: "available" as const }),
    platformIdentityVerifier: new DarwinCuaDriverIdentityVerifier({
      expectedTeamId: options.expectedTeamId,
      ...(options.identityCommandRunner ? { runner: options.identityCommandRunner } : {}),
    }),
    processLifecycle: createDarwinCuaDriverProcessLifecycle({
      ...(options.spawn ? { spawn: options.spawn } : {}),
    }),
    readinessController: new DarwinCuaDriverReadinessController(permissionController),
    metadata: Object.freeze({ limitations: Object.freeze([] as const) }),
  });
  let disposed = false;
  return Object.freeze({
    binding,
    permissionController,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      permissionController.dispose();
    },
  });
}

export * from "./darwin-identity.js";
export * from "./darwin-lifecycle.js";
export * from "./darwin-permissions.js";
