import type {
  ManagedPluginDescriptor,
  ManagedPluginStoreFacet,
  McpServerTransport,
  McpStoreFacet,
} from "@ling-stack/core";
import { ensureManagedPluginRecord } from "./catalog.js";

type LocalPluginStore = ManagedPluginStoreFacet & McpStoreFacet;

export function createTrustedLocalMcpPlugin(input: {
  readonly store: LocalPluginStore;
  readonly displayName: string;
  readonly description: string;
  readonly transport: McpServerTransport;
  readonly now: string;
}): { readonly pluginId: string; readonly mcpServerId: string } {
  const server = input.store.createMcpServer({
    displayName: input.displayName,
    transport: input.transport,
    enabled: false,
    required: false,
  }, input.now);
  const pluginId = `trusted-local:${server.id}`;
  const descriptor: ManagedPluginDescriptor = {
    id: pluginId,
    displayName: input.displayName,
    version: "1.0.0",
    sourceKind: "trusted-local-preset",
    description: input.description,
    trustSummary: input.transport.type === "stdio"
      ? "Runs a user-configured local command through the MCP broker and existing approval policy."
      : "Connects to a user-configured MCP endpoint through the MCP broker and existing approval policy.",
    contributions: [{
      kind: "mcp-server",
      id: server.id,
      label: input.displayName,
      capabilities: [input.transport.type === "stdio" ? "mcp:stdio" : "mcp:streamable-http"],
      sideEffectLevel: "external",
      defaultApproval: "ask",
    }],
    healthChecks: [{ id: `${server.id}:mcp`, label: "MCP connection", kind: "mcp" }],
    defaultEnabled: false,
  };
  ensureManagedPluginRecord({ store: input.store, descriptor, enabled: false, now: input.now });
  input.store.replaceManagedPluginContributions(pluginId, [{
    contributionKind: "mcp-server",
    contributionId: server.id,
    linkedResourceId: server.id,
    enabled: false,
  }], input.now);
  input.store.appendManagedPluginEvent({
    pluginId,
    type: "connected",
    actor: "local-user",
    message: `Linked local MCP server ${server.id}.`,
    data: { linkedResourceId: server.id, transport: input.transport.type },
  }, input.now);
  return { pluginId, mcpServerId: server.id };
}
