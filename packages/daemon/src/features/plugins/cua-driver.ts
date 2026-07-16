import { isAbsolute } from "node:path";
import type {
  ManagedPluginDescriptor,
  ManagedPluginSetupView,
  ManagedPluginStoreFacet,
  McpServer,
  McpStoreFacet,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import {
  createCuaDriverMcpServerInput,
  CUA_DRIVER_DOCUMENTATION_URL,
  CUA_DRIVER_INSTALL_COMMAND,
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_PLUGIN_ID,
  resolveCuaDriverCommand,
} from "./presets.js";

type CuaDriverStore = ManagedPluginStoreFacet & McpStoreFacet;

export function buildCuaDriverSetupView(input: {
  readonly store: CuaDriverStore;
  readonly now: string;
  readonly platform?: NodeJS.Platform;
}): ManagedPluginSetupView {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      kind: "local_binary",
      state: "unsupported",
      checkedAt: input.now,
    };
  }

  const server = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  const command = resolveCuaDriverCommand(readCuaDriverCommandOptions(server));
  if (!command.ok || !command.command) {
    return {
      kind: "local_binary",
      state: "missing",
      checkedAt: input.now,
      guide: {
        documentationUrl: CUA_DRIVER_DOCUMENTATION_URL,
        installCommand: CUA_DRIVER_INSTALL_COMMAND,
        supportsCustomCommand: true,
      },
    };
  }

  const record = input.store.getManagedPlugin(CUA_DRIVER_PLUGIN_ID);
  const contribution = input.store.listManagedPluginContributions(CUA_DRIVER_PLUGIN_ID)
    .find((item) => item.contributionKind === "mcp-server" && item.linkedResourceId === CUA_DRIVER_MCP_SERVER_ID);
  if (!server || !record || !contribution) {
    return {
      kind: "local_binary",
      state: "detected",
      checkedAt: input.now,
      detectedCommand: command.command,
    };
  }

  return {
    kind: "local_binary",
    state: server.enabled && record.enabled && contribution.enabled ? "ready" : "connected",
    checkedAt: input.now,
    detectedCommand: command.command,
  };
}

export function connectCuaDriver(input: {
  readonly store: CuaDriverStore;
  readonly descriptor: ManagedPluginDescriptor;
  readonly command?: string;
  readonly now: string;
  readonly platform?: NodeJS.Platform;
}): McpServer {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new HttpError(400, "plugin_platform_blocked", "Cua Driver is only supported on macOS.");
  }
  if (input.command && !isAbsolute(input.command.trim())) {
    throw new HttpError(400, "plugin_command_not_executable", "Configured cua-driver command must be an absolute executable path.");
  }
  const existingServer = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  const command = resolveCuaDriverCommand(
    input.command
      ? { command: input.command }
      : readCuaDriverCommandOptions(existingServer),
  );
  if (!command.ok || !command.command) {
    throw new HttpError(400, command.errorCode ?? "plugin_binary_not_found", command.message ?? "cua-driver binary was not found.");
  }

  const existingRecord = input.store.getManagedPlugin(CUA_DRIVER_PLUGIN_ID);
  const existingContribution = input.store.listManagedPluginContributions(CUA_DRIVER_PLUGIN_ID)
    .find((item) => item.contributionKind === "mcp-server" && item.linkedResourceId === CUA_DRIVER_MCP_SERVER_ID);
  const preserveEnabled = existingServer?.enabled === true
    && existingRecord?.enabled === true
    && existingContribution?.enabled === true;
  upsertCuaDriverRecord(input.store, input.descriptor, preserveEnabled, undefined, input.now);
  const mcpInput = createCuaDriverMcpServerInput(command.command, preserveEnabled);
  const linkedServer = existingServer
    ? input.store.updateMcpServer(CUA_DRIVER_MCP_SERVER_ID, mcpInput, input.now) ?? existingServer
    : input.store.createMcpServer(mcpInput, input.now);
  input.store.replaceManagedPluginContributions(CUA_DRIVER_PLUGIN_ID, [
    {
      contributionKind: "mcp-server",
      contributionId: CUA_DRIVER_MCP_SERVER_ID,
      linkedResourceId: linkedServer.id,
      enabled: preserveEnabled,
    },
  ], input.now);
  input.store.appendManagedPluginEvent({
    pluginId: CUA_DRIVER_PLUGIN_ID,
    type: "connected",
    actor: "system",
    message: `Connected MCP server ${linkedServer.id}.`,
    data: { linkedResourceId: linkedServer.id },
  }, input.now);
  return linkedServer;
}

export function configuredCuaDriverCommand(store: CuaDriverStore): string | undefined {
  const server = store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  return server?.transport.type === "stdio" ? server.transport.command : undefined;
}

export function rollbackCuaDriverEnable(input: {
  readonly store: CuaDriverStore;
  readonly descriptor: ManagedPluginDescriptor;
  readonly reason: string;
  readonly now: string;
}): void {
  upsertCuaDriverRecord(input.store, input.descriptor, false, input.reason, input.now);
  const contributions = input.store.listManagedPluginContributions(CUA_DRIVER_PLUGIN_ID);
  input.store.replaceManagedPluginContributions(
    CUA_DRIVER_PLUGIN_ID,
    contributions.map((contribution) => ({
      contributionKind: contribution.contributionKind,
      contributionId: contribution.contributionId,
      linkedResourceId: contribution.linkedResourceId,
      enabled: false,
    })),
    input.now,
  );
  const server = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  if (server) {
    input.store.updateMcpServer(server.id, { enabled: false }, input.now);
  }
}

function readCuaDriverCommandOptions(server: McpServer | undefined): Readonly<Record<string, unknown>> {
  return server?.transport.type === "stdio" ? { command: server.transport.command } : {};
}

function upsertCuaDriverRecord(
  store: ManagedPluginStoreFacet,
  descriptor: ManagedPluginDescriptor,
  enabled: boolean,
  disabledReason: string | undefined,
  now: string,
): void {
  store.upsertManagedPlugin({
    id: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled,
    disabledReason,
    descriptor,
  }, now);
}
