import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type {
  CreateMcpServerInput,
  ManagedPluginDescriptor,
  ReplaceMcpServerToolInput,
} from "@ling-stack/core";

export const CUA_DRIVER_PLUGIN_ID = "trusted-local:cua-driver";
export const CUA_DRIVER_MCP_SERVER_ID = "mcp_cua_driver";

const cuaDriverReadOnlyTools = new Set([
  "check_permissions",
  "get_config",
  "get_agent_cursor_state",
  "get_recording_state",
  "get_screen_size",
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
    description: "Trusted local macOS computer-use driver exposed through MCP.",
    trustSummary: "Runs a user-installed local binary through MCP. GUI input and screen capture remain approval-gated.",
    contributions: [
      {
        kind: "mcp-server",
        id: CUA_DRIVER_MCP_SERVER_ID,
        label: "Cua Driver MCP server",
        capabilities: ["mcp:stdio", "computer-use:macos"],
        sideEffectLevel: "external",
        defaultApproval: "ask",
      },
    ],
    healthChecks: [
      { id: "platform", label: "macOS platform", kind: "descriptor" },
      { id: "binary", label: "cua-driver binary", kind: "binary" },
      { id: "mcp", label: "MCP server check", kind: "mcp" },
    ],
    defaultEnabled: false,
  };
}

export interface CuaDriverCommandResolution {
  readonly ok: boolean;
  readonly command?: string;
  readonly message?: string;
  readonly attempted: readonly string[];
}

export function resolveCuaDriverCommand(options: Readonly<Record<string, unknown>> = {}): CuaDriverCommandResolution {
  const explicitCommand = typeof options.command === "string" ? options.command.trim() : "";
  const attempted: string[] = [];
  if (explicitCommand) {
    const resolvedExplicit = resolveCommandCandidate(explicitCommand);
    attempted.push(resolvedExplicit);
    if (isExecutableFile(resolvedExplicit)) {
      return { ok: true, command: resolvedExplicit, attempted };
    }
    if (!explicitCommand.includes("/") && !explicitCommand.includes("\\")) {
      const pathResolved = resolveFromPath(explicitCommand, attempted);
      if (pathResolved) {
        return { ok: true, command: pathResolved, attempted };
      }
    }
    return {
      ok: false,
      message: "Configured cua-driver command is not executable.",
      attempted,
    };
  }

  const pathResolved = resolveFromPath("cua-driver", attempted);
  if (pathResolved) {
    return { ok: true, command: pathResolved, attempted };
  }

  for (const candidate of [
    join(homedir(), ".local/bin/cua-driver"),
    "/opt/homebrew/bin/cua-driver",
    "/usr/local/bin/cua-driver",
  ]) {
    attempted.push(candidate);
    if (isExecutableFile(candidate)) {
      return { ok: true, command: candidate, attempted };
    }
  }

  return {
    ok: false,
    message: "cua-driver binary was not found. Install Cua Driver or pass options.command with an absolute executable path.",
    attempted,
  };
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

function resolveFromPath(command: string, attempted: string[]): string | undefined {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = resolve(entry, command);
    attempted.push(candidate);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveCommandCandidate(command: string): string {
  const expanded = command.startsWith("~/") ? join(homedir(), command.slice(2)) : command;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
