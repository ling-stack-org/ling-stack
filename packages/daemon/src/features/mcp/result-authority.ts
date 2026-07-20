import type { McpServer, RunStore } from "@ling-stack/core";
import {
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_PLUGIN_ID,
} from "../plugins/presets.js";

export interface McpResultAuthority {
  readonly serverId: string;
  readonly serverRevision: number;
  readonly toolsRevision: number;
  readonly rawName?: string;
  readonly bundledActivation?: {
    readonly requestedRevision: number;
    readonly activationEpoch: number;
  };
}

export function captureMcpResultAuthority(
  store: RunStore,
  serverId: string,
  rawName: string,
): { readonly server: McpServer; readonly authority: McpResultAuthority } {
  const current = readCurrentToolAuthority(store, serverId, rawName);
  const revision = readCurrentAuthorityRevision(store, serverId);
  return {
    server: current.server,
    authority: {
      serverId,
      ...revision,
      rawName,
      ...captureBundledActivation(store, serverId),
    },
  };
}

export function captureMcpServerResultAuthority(
  store: RunStore,
  serverId: string,
): { readonly server: McpServer; readonly authority: McpResultAuthority } {
  const server = readCurrentServerAuthority(store, serverId);
  const revision = readCurrentAuthorityRevision(store, serverId);
  return {
    server,
    authority: {
      serverId,
      ...revision,
      ...captureBundledActivation(store, serverId),
    },
  };
}

export function assertMcpResultAuthorityCurrent(
  store: RunStore,
  authority: McpResultAuthority,
): McpServer {
  try {
    const server = readCurrentServerAuthority(store, authority.serverId);
    const revision = readCurrentAuthorityRevision(store, authority.serverId);
    if (revision.serverRevision !== authority.serverRevision) {
      throw new Error("revision_changed");
    }
    if (revision.toolsRevision !== authority.toolsRevision) {
      throw new Error("tools_revision_changed");
    }
    if (authority.rawName !== undefined) {
      readCurrentToolAuthority(store, authority.serverId, authority.rawName);
    }
    if (authority.bundledActivation) {
      const activation = store.getCuaDriverActivationState(CUA_DRIVER_PLUGIN_ID);
      if (
        !activation
        || activation.requestedRevision !== authority.bundledActivation.requestedRevision
        || activation.activationEpoch !== authority.bundledActivation.activationEpoch
      ) {
        throw new Error("activation_changed");
      }
    }
    return server;
  } catch {
    throw new Error("mcp_result_authority_stale");
  }
}

function readCurrentServerAuthority(store: RunStore, serverId: string): McpServer {
  const server = store.getMcpServer(serverId);
  if (!server?.enabled) {
    throw new Error(`MCP server is disabled or missing: ${serverId}`);
  }
  return server;
}

function readCurrentToolAuthority(
  store: RunStore,
  serverId: string,
  rawName: string,
): { readonly server: McpServer } {
  const server = readCurrentServerAuthority(store, serverId);
  const tool = store
    .listMcpTools({ serverId, enabled: true, limit: 500 })
    .find((candidate) => candidate.rawName === rawName);
  if (!tool || !isMcpToolEnabledForServer(server, tool)) {
    throw new Error(`MCP tool is disabled or missing: ${rawName}`);
  }
  return { server };
}

function readCurrentAuthorityRevision(
  store: RunStore,
  serverId: string,
): { readonly serverRevision: number; readonly toolsRevision: number } {
  const revision = store.getMcpAuthorityRevision(serverId);
  if (!revision) {
    throw new Error(`MCP authority revision is missing: ${serverId}`);
  }
  return revision;
}

function captureBundledActivation(
  store: RunStore,
  serverId: string,
): Pick<McpResultAuthority, "bundledActivation"> {
  if (serverId !== CUA_DRIVER_MCP_SERVER_ID) {
    return {};
  }
  const activation = store.getCuaDriverActivationState(CUA_DRIVER_PLUGIN_ID);
  return activation
    ? {
        bundledActivation: {
          requestedRevision: activation.requestedRevision,
          activationEpoch: activation.activationEpoch,
        },
      }
    : {};
}

function isMcpToolEnabledForServer(
  server: McpServer,
  tool: { readonly rawName: string; readonly enabled: boolean },
): boolean {
  if (!tool.enabled) {
    return false;
  }
  if (server.enabledTools && !server.enabledTools.includes(tool.rawName)) {
    return false;
  }
  return !server.disabledTools.includes(tool.rawName);
}
