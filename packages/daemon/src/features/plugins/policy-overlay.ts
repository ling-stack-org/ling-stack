import type {
  ManagedPluginDefaultApproval,
  ManagedPluginDescriptor,
  ManagedPluginPolicyOverlayView,
  ManagedPluginSideEffectLevel,
  McpStoreFacet,
} from "@ling-stack/core";
import { CUA_DRIVER_MCP_SERVER_ID } from "./presets.js";

const cuaReadOnlyTools = new Set([
  "check_permissions",
  "get_config",
  "get_agent_cursor_state",
  "get_recording_state",
  "get_screen_size",
  "health_report",
  "list_apps",
  "list_windows",
]);

const cuaDenyTools = new Set(["replay_trajectory"]);

export function buildManagedPluginPolicyOverlays(input: {
  readonly store: McpStoreFacet;
  readonly descriptor: ManagedPluginDescriptor;
  readonly bundledEmbedded?: boolean;
}): readonly ManagedPluginPolicyOverlayView[] {
  if (input.descriptor.id !== "bundled:cua-driver" && !input.bundledEmbedded) {
    return input.descriptor.defaultApprovals?.map((approval) => ({
      id: `${input.descriptor.id}:${approval.contributionId}`,
      pluginId: input.descriptor.id,
      contributionId: approval.contributionId,
      targetKind: "mcp-server",
      targetId: approval.contributionId,
      defaultApproval: approval.decision,
      sideEffectLevel: approval.decision === "allow" ? "read" : "external",
      reason: approval.reason ?? "Plugin package default approval.",
    })) ?? [];
  }

  const server = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  if (!server) {
    return [];
  }
  const tools = input.store.listMcpTools({ serverId: server.id, limit: 500 });
  if (tools.length === 0) {
    return [{
      id: `${input.descriptor.id}:${server.id}`,
      pluginId: input.descriptor.id,
      contributionId: CUA_DRIVER_MCP_SERVER_ID,
      targetKind: "mcp-server",
      targetId: server.id,
      defaultApproval: "ask",
      sideEffectLevel: "external",
      reason: "Cua Driver MCP server controls local apps and screen state.",
    }];
  }
  return tools.map((tool) => {
    const defaultApproval = cuaToolDefaultApproval(tool.rawName);
    return {
      id: `${input.descriptor.id}:${server.id}:${tool.rawName}`,
      pluginId: input.descriptor.id,
      contributionId: CUA_DRIVER_MCP_SERVER_ID,
      targetKind: "mcp-tool",
      targetId: `${server.id}:${tool.rawName}`,
      defaultApproval,
      sideEffectLevel: cuaToolSideEffectLevel(tool.rawName),
      reason: defaultApproval === "allow"
        ? "Read-only Cua Driver inspection tool."
        : "Cua Driver screen, app, or input action requires explicit approval.",
    };
  });
}

function cuaToolDefaultApproval(rawName: string): ManagedPluginDefaultApproval {
  if (cuaDenyTools.has(rawName)) {
    return "deny";
  }
  return cuaReadOnlyTools.has(rawName) ? "allow" : "ask";
}

function cuaToolSideEffectLevel(rawName: string): ManagedPluginSideEffectLevel {
  if (cuaReadOnlyTools.has(rawName)) {
    return "read";
  }
  if (rawName.includes("screenshot") || rawName.includes("screen")) {
    return "external";
  }
  if (rawName.includes("config") || rawName.includes("recording") || rawName.includes("replay")) {
    return "external";
  }
  return "external";
}
