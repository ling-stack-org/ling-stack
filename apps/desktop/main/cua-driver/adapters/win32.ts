import { WindowsActiveChildReadinessController } from "../readiness-controller.js";
import type { Win32CuaDriverPlatformBinding } from "../platform-binding.js";
import {
  createWin32CuaDriverIdentityVerifier,
  type Win32CuaDriverSigningPolicy,
} from "./win32-identity.js";
import {
  createWin32CuaDriverProcessLifecycle,
  type Win32DirectSpawn,
} from "./win32-lifecycle.js";
import {
  createWin32CuaDriverSessionRecoveryObserver,
  type Win32PowerMonitorPort,
} from "./win32-session-observer.js";
import {
  createWin32CuaDriverStateRootProtector,
  type Win32StateRootFileSystem,
} from "./win32-state-root.js";
import type { Win32CommandRunner } from "./win32-command.js";

export interface CreateWin32CuaDriverPlatformBindingOptions {
  /** Compile-time channel policy; installed seals cannot select their own trust tier. */
  readonly signingPolicy: Win32CuaDriverSigningPolicy;
  /** Inject Electron main's powerMonitor. Its events are recovery hints only. */
  readonly powerMonitor: Win32PowerMonitorPort;
  readonly systemRoot?: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly commandRunner?: Win32CommandRunner;
  readonly stateRootFileSystem?: Win32StateRootFileSystem;
  readonly spawn?: Win32DirectSpawn;
  readonly commandTimeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

/** Assemble the complete Windows x64 standard-integrity platform binding. */
export function createWin32CuaDriverPlatformBinding(
  options: CreateWin32CuaDriverPlatformBindingOptions,
): Win32CuaDriverPlatformBinding {
  const sharedCommandOptions = {
    ...(options.systemRoot !== undefined ? { systemRoot: options.systemRoot } : {}),
    ...(options.baseEnvironment !== undefined ? { baseEnvironment: options.baseEnvironment } : {}),
    ...(options.commandRunner !== undefined ? { commandRunner: options.commandRunner } : {}),
    ...(options.commandTimeoutMs !== undefined ? { timeoutMs: options.commandTimeoutMs } : {}),
    ...(options.maxStdoutBytes !== undefined ? { maxStdoutBytes: options.maxStdoutBytes } : {}),
    ...(options.maxStderrBytes !== undefined ? { maxStderrBytes: options.maxStderrBytes } : {}),
  };
  return Object.freeze({
    platform: "win32",
    availability: Object.freeze({ status: "available" as const }),
    platformIdentityVerifier: createWin32CuaDriverIdentityVerifier({
      policy: options.signingPolicy,
      ...sharedCommandOptions,
    }),
    stateRootProtector: createWin32CuaDriverStateRootProtector({
      ...sharedCommandOptions,
      ...(options.stateRootFileSystem !== undefined
        ? { fileSystem: options.stateRootFileSystem }
        : {}),
    }),
    processLifecycle: createWin32CuaDriverProcessLifecycle({
      ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    }),
    readinessController: new WindowsActiveChildReadinessController(),
    windowsSessionRecoveryObserver: createWin32CuaDriverSessionRecoveryObserver(
      options.powerMonitor,
    ),
    metadata: Object.freeze({
      integrityCoverage: "standard" as const,
      limitations: Object.freeze([
        "elevated_pixel_input",
        "uwp_send_input",
      ] as const),
    }),
  });
}
