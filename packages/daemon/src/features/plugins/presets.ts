import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import type {
  CreateMcpServerInput,
  ManagedPluginDescriptor,
  ReplaceMcpServerToolInput,
} from "@ling-stack/core";

export const CUA_DRIVER_PLUGIN_ID = "trusted-local:cua-driver";
export const CUA_DRIVER_MCP_SERVER_ID = "mcp_cua_driver";
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
    join(home, ".local/bin/cua-driver"),
    "/opt/homebrew/bin/cua-driver",
    "/usr/local/bin/cua-driver",
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/Applications/Cua Driver.app/Contents/MacOS/cua-driver",
    join(home, "Applications/CuaDriver.app/Contents/MacOS/cua-driver"),
    join(home, "Applications/Cua Driver.app/Contents/MacOS/cua-driver"),
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
