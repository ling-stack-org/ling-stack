import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, posix, resolve } from "node:path";
import type {
  CreateMcpServerInput,
  ManagedPluginDescriptor,
  ReplaceMcpServerToolInput,
} from "@ling-stack/core";

export const CUA_DRIVER_PLUGIN_ID = "trusted-local:cua-driver";
export const CUA_DRIVER_MCP_SERVER_ID = "mcp_cua_driver";
/**
 * Persisted placeholder for the logical MCP contribution in bundled mode.
 * Runtime code must resolve the current in-memory Desktop lease and must never
 * connect to this URL.
 */
export const CUA_DRIVER_BUNDLED_LOGICAL_ENDPOINT =
  "http://127.0.0.1/.ling/cua-driver-bundled-lease";
export const CUA_DRIVER_DOCUMENTATION_URL = "https://cua.ai/docs/cua-driver";
export const CUA_DRIVER_INSTALL_COMMAND = "/bin/bash -c \"$(curl -fsSL https://cua.ai/driver/install.sh)\"";

const CUA_DRIVER_SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "win32"]);
const WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS = new Set([".com", ".exe"]);
export const CUA_DRIVER_UNSUPPORTED_PLATFORM_MESSAGE =
  "Cua Driver preview integration is supported on macOS and Windows.";

const cuaDriverReadOnlyTools = new Set([
  "check_permissions",
  "get_config",
  "get_agent_cursor_state",
  "get_recording_state",
  "get_screen_size",
  "health_report",
  "list_apps",
  "list_windows",
]);

const cuaDriverBundledDeniedTools = new Set([
  "check_for_update",
  "install_ffmpeg",
]);

const cuaDriverBundledReviewedTools = new Set([
  "bring_to_front",
  "check_permissions",
  "click",
  "double_click",
  "drag",
  "end_session",
  "get_accessibility_tree",
  "get_agent_cursor_state",
  "get_config",
  "get_cursor_position",
  "get_desktop_state",
  "get_recording_state",
  "get_screen_size",
  "get_window_state",
  "health_report",
  "hotkey",
  "kill_app",
  "launch_app",
  "list_apps",
  "list_windows",
  "move_cursor",
  "page",
  "press_key",
  "replay_trajectory",
  "right_click",
  "scroll",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_style",
  "set_config",
  "set_value",
  "start_recording",
  "start_session",
  "stop_recording",
  "type_text",
  "zoom",
]);

export const CUA_DRIVER_LOCKED_TOOL_POLICY_REVISION = "locked-cua-tools-v1" as const;

export const CUA_DRIVER_LOCKED_ALLOWED_TOOL_IDS = Object.freeze([
  "bring_to_front",
  "check_permissions",
  "click",
  "double_click",
  "drag",
  "end_session",
  "get_accessibility_tree",
  "get_cursor_position",
  "get_desktop_state",
  "get_screen_size",
  "get_window_state",
  "health_report",
  "hotkey",
  "list_apps",
  "list_windows",
  "move_cursor",
  "page",
  "press_key",
  "right_click",
  "scroll",
  "set_value",
  "start_session",
  "type_text",
] as const);

export const CUA_DRIVER_LOCKED_DENIED_TOOL_IDS = Object.freeze([
  "check_for_update",
  "get_agent_cursor_state",
  "get_config",
  "get_recording_state",
  "install_ffmpeg",
  "kill_app",
  "launch_app",
  "replay_trajectory",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_style",
  "set_config",
  "start_recording",
  "stop_recording",
  "zoom",
] as const);

const cuaDriverLockedAllowedTools: ReadonlySet<string> = new Set(CUA_DRIVER_LOCKED_ALLOWED_TOOL_IDS);
const cuaDriverLockedDeniedTools: ReadonlySet<string> = new Set(CUA_DRIVER_LOCKED_DENIED_TOOL_IDS);

export const CUA_DRIVER_LOCKED_ALLOWED_TOOL_IDS_SHA256 = createHash("sha256")
  .update(JSON.stringify(CUA_DRIVER_LOCKED_ALLOWED_TOOL_IDS), "utf8")
  .digest("hex");

export type CuaDriverLockedToolDecision = "allow_to_existing_approval" | "deny";

/** Unknown and future provider tools fail closed while the session is locked. */
export function lockedCuaDriverToolDecision(toolId: string): CuaDriverLockedToolDecision {
  return cuaDriverLockedAllowedTools.has(toolId) && !cuaDriverLockedDeniedTools.has(toolId)
    ? "allow_to_existing_approval"
    : "deny";
}

export class BundledCuaDriverToolPolicyError extends Error {
  constructor(readonly unsupportedTools: readonly string[]) {
    super(`Bundled Cua Driver returned an unreviewed tool catalog: ${unsupportedTools.join(", ")}.`);
    this.name = "BundledCuaDriverToolPolicyError";
  }
}

export function listTrustedLocalPresetDescriptors(): readonly ManagedPluginDescriptor[] {
  return [createCuaDriverDescriptor()];
}

export function createCuaDriverDescriptor(): ManagedPluginDescriptor {
  return {
    id: CUA_DRIVER_PLUGIN_ID,
    displayName: "Cua Driver",
    version: "1.0.0",
    sourceKind: "trusted-local-preset",
    description: "Trusted local macOS and Windows computer-use driver exposed through MCP.",
    trustSummary: "Runs a user-installed local binary through MCP. GUI input and screen capture remain approval-gated on both platforms.",
    contributions: [
      {
        kind: "mcp-server",
        id: CUA_DRIVER_MCP_SERVER_ID,
        label: "Cua Driver MCP server",
        capabilities: ["mcp:stdio", "computer-use:macos", "computer-use:windows"],
        sideEffectLevel: "external",
        defaultApproval: "ask",
      },
    ],
    healthChecks: [
      { id: "platform", label: "Supported desktop platform", kind: "descriptor" },
      { id: "binary", label: "cua-driver binary", kind: "binary" },
      { id: "mcp", label: "MCP server check", kind: "mcp" },
    ],
    defaultEnabled: false,
  };
}

export interface CuaDriverCommandResolution {
  readonly ok: boolean;
  readonly command?: string;
  readonly errorCode?: "plugin_binary_not_found" | "plugin_command_not_executable";
  readonly message?: string;
  readonly attempted: readonly string[];
}

export interface CuaDriverCommandEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly path?: string;
  readonly pathExt?: string;
  readonly homeDir?: string;
  readonly localAppData?: string;
}

export function isCuaDriverPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return CUA_DRIVER_SUPPORTED_PLATFORMS.has(platform);
}

export function resolveCuaDriverCommand(
  options: Readonly<Record<string, unknown>> = {},
  environment: CuaDriverCommandEnvironment = {},
): CuaDriverCommandResolution {
  const platform = environment.platform ?? process.platform;
  const homeDir = environment.homeDir ?? homedir();
  const pathValue = environment.path ?? process.env.PATH ?? "";
  const pathExt = environment.pathExt ?? process.env.PATHEXT;
  const explicitCommand = typeof options.command === "string" ? options.command.trim() : "";
  const attempted: string[] = [];
  if (explicitCommand) {
    const resolvedExplicit = resolveCommandCandidate(explicitCommand, homeDir);
    const explicitResolved = resolveExecutableCandidate(resolvedExplicit, attempted, platform, pathExt);
    if (explicitResolved) {
      return { ok: true, command: explicitResolved, attempted };
    }
    if (!explicitCommand.includes("/") && !explicitCommand.includes("\\")) {
      const pathResolved = resolveFromPath(explicitCommand, attempted, platform, pathValue, pathExt);
      if (pathResolved) {
        return { ok: true, command: pathResolved, attempted };
      }
    }
    return {
      ok: false,
      errorCode: "plugin_command_not_executable",
      message: "Configured cua-driver command is not executable.",
      attempted,
    };
  }

  const pathResolved = resolveFromPath("cua-driver", attempted, platform, pathValue, pathExt);
  if (pathResolved) {
    return { ok: true, command: pathResolved, attempted };
  }

  const defaultCandidates = platform === "win32"
    ? [
        join(
          environment.localAppData ?? process.env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"),
          "Programs",
          "Cua",
          "cua-driver",
          "bin",
          "cua-driver.exe",
        ),
        join(homeDir, ".cua-driver", "packages", "current", "cua-driver.exe"),
        join(homeDir, ".local", "bin", "cua-driver.exe"),
      ]
    : platform === "darwin"
      ? defaultCuaDriverCommandCandidates(homeDir)
      : [
        join(homeDir, ".local/bin/cua-driver"),
        "/opt/homebrew/bin/cua-driver",
        "/usr/local/bin/cua-driver",
      ];
  for (const candidate of defaultCandidates) {
    const resolvedCandidate = resolveExecutableCandidate(candidate, attempted, platform, pathExt);
    if (resolvedCandidate) {
      return { ok: true, command: resolvedCandidate, attempted };
    }
  }

  return {
    ok: false,
    errorCode: "plugin_binary_not_found",
    message: "cua-driver binary was not found. Install Cua Driver or pass options.command with an absolute executable path.",
    attempted,
  };
}

export function defaultCuaDriverCommandCandidates(home = homedir()): readonly string[] {
  return [
    posix.join(home, ".local", "bin", "cua-driver"),
    "/opt/homebrew/bin/cua-driver",
    "/usr/local/bin/cua-driver",
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/Applications/Cua Driver.app/Contents/MacOS/cua-driver",
    posix.join(home, "Applications", "CuaDriver.app", "Contents", "MacOS", "cua-driver"),
    posix.join(home, "Applications", "Cua Driver.app", "Contents", "MacOS", "cua-driver"),
  ];
}

export function createCuaDriverMcpServerInput(command: string, enabled: boolean): CreateMcpServerInput {
  return {
    id: CUA_DRIVER_MCP_SERVER_ID,
    displayName: "Cua Driver",
    transport: {
      type: "stdio",
      command,
      args: ["mcp"],
      env: {},
      secretEnvRefs: {},
    },
    enabled,
    required: false,
    startupTimeoutSec: 30,
    toolTimeoutSec: 60,
    status: { kind: "unknown" },
  };
}

export function createBundledCuaDriverLogicalMcpServerInput(): CreateMcpServerInput {
  return {
    id: CUA_DRIVER_MCP_SERVER_ID,
    displayName: "Cua Driver",
    transport: {
      type: "streamable-http",
      url: CUA_DRIVER_BUNDLED_LOGICAL_ENDPOINT,
      headers: {},
      secretHeaderRefs: {},
    },
    enabled: false,
    required: false,
    startupTimeoutSec: 30,
    toolTimeoutSec: 60,
    status: { kind: "unknown" },
  };
}

export function applyCuaDriverToolApprovalOverrides(
  tools: readonly ReplaceMcpServerToolInput[],
): readonly ReplaceMcpServerToolInput[] {
  return tools.map((tool) => {
    if (!cuaDriverReadOnlyTools.has(tool.rawName)) {
      return {
        ...tool,
        defaultApproval: tool.defaultApproval === "allow" && tool.sideEffectLevel !== "read" ? "ask" : tool.defaultApproval,
      };
    }
    return {
      ...tool,
      sideEffectLevel: "read",
      defaultApproval: "allow",
    };
  });
}

/**
 * Fail-closed policy for the pinned embedded 0.8.3 tool surface.
 *
 * Provider annotations are advisory. A compromised or newer provider cannot
 * make an input/capture tool read-only, and updater/install tools never enter
 * the daemon catalog. Any other new tool requires an explicit reviewed update.
 */
export function applyBundledCuaDriverToolPolicy(
  tools: readonly ReplaceMcpServerToolInput[],
): readonly ReplaceMcpServerToolInput[] {
  const unsupportedTools = [...new Set(
    tools
      .map((tool) => tool.rawName)
      .filter((rawName) => (
        !cuaDriverBundledDeniedTools.has(rawName)
        && !cuaDriverBundledReviewedTools.has(rawName)
      )),
  )].sort();
  if (unsupportedTools.length > 0) {
    throw new BundledCuaDriverToolPolicyError(unsupportedTools);
  }
  return tools
    .filter((tool) => !cuaDriverBundledDeniedTools.has(tool.rawName))
    .map((tool) => {
      if (cuaDriverReadOnlyTools.has(tool.rawName)) {
        return {
          ...tool,
          sideEffectLevel: "read" as const,
          defaultApproval: "allow" as const,
        };
      }
      return {
        ...tool,
        sideEffectLevel: "external" as const,
        defaultApproval: tool.rawName === "replay_trajectory" ? "deny" as const : "ask" as const,
      };
    });
}

function resolveFromPath(
  command: string,
  attempted: string[],
  platform: NodeJS.Platform,
  pathValue: string,
  pathExt: string | undefined,
): string | undefined {
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathEntries = pathValue.split(pathDelimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = resolve(entry, command);
    const resolvedCandidate = resolveExecutableCandidate(candidate, attempted, platform, pathExt);
    if (resolvedCandidate) {
      return resolvedCandidate;
    }
  }
  return undefined;
}

function resolveExecutableCandidate(
  candidate: string,
  attempted: string[],
  platform: NodeJS.Platform,
  pathExt: string | undefined,
): string | undefined {
  for (const variant of executableCandidateVariants(candidate, platform, pathExt)) {
    attempted.push(variant);
    if (isExecutableFile(variant, platform, pathExt)) {
      return variant;
    }
  }
  return undefined;
}

function executableCandidateVariants(
  candidate: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
): readonly string[] {
  if (platform !== "win32") {
    return [candidate];
  }
  if (extname(candidate)) {
    return [candidate];
  }
  return windowsExecutableExtensions(pathExt)
    .map((extension) => `${candidate}${extension}`);
}

function resolveCommandCandidate(command: string, homeDir: string): string {
  const expanded = command.startsWith("~/") || command.startsWith("~\\")
    ? join(homeDir, command.slice(2))
    : command;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function windowsExecutableExtensions(pathExt: string | undefined): readonly string[] {
  return (pathExt || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`)
    .filter((extension) => WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.has(extension));
}

function isExecutableFile(
  path: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (platform === "win32") {
      return windowsExecutableExtensions(pathExt).includes(extname(path).toLowerCase());
    }
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
