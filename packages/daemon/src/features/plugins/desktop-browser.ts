import { DESKTOP_BROWSER_PLUGIN_ID, DESKTOP_BROWSER_MCP_SERVER_ID, DESKTOP_BROWSER_PROTOCOL } from "@ling-stack/contracts";
import type { ManagedPluginDescriptor, ManagedPluginHealthSnapshot, ManagedPluginStoreFacet, McpStoreFacet } from "@ling-stack/core";
import type { DesktopBrowserController } from "../desktop-browser/controller.js";
import { desktopBrowserTools } from "./desktop-browser-generation-broker.js";
import { createMcpStatusSnapshot, createMcpAuthStatus, deriveMcpServerStatus } from "../mcp/status.js";

type Store = ManagedPluginStoreFacet & McpStoreFacet;
export function createDesktopBrowserDescriptor(): ManagedPluginDescriptor {
  return { id: DESKTOP_BROWSER_PLUGIN_ID, displayName: "Ling Browser", version: "0.1.0", sourceKind: "built-in",
    description: "Browse websites and local development pages inside Ling Desktop.",
    trustSummary: "Uses an isolated workspace browser profile and existing MCP approvals. Page content cannot authorize actions.",
    contributions: [{ kind: "mcp-server", id: DESKTOP_BROWSER_MCP_SERVER_ID, label: "Ling browser tools",
      capabilities: ["browser:tabs", "browser:read", "browser:interact", "browser:screenshot"], sideEffectLevel: "external", defaultApproval: "ask" }],
    defaultApprovals: [{ contributionId: DESKTOP_BROWSER_MCP_SERVER_ID, decision: "ask", reason: "Websites may have signed-in accounts and external effects." }],
    healthChecks: [{ id: "desktop-browser-runtime", label: "Desktop browser", kind: "descriptor" }], defaultEnabled: false };
}

export class DesktopBrowserPluginService {
  readonly descriptor = createDesktopBrowserDescriptor();
  constructor(private readonly options: { readonly controller: DesktopBrowserController; readonly getStore: (cwd: string) => Store }) {}

  sync(cwd: string, now = new Date().toISOString()): ManagedPluginHealthSnapshot {
    const store = this.options.getStore(cwd), descriptor = this.descriptor;
    if (!store.getManagedPlugin(descriptor.id)) store.upsertManagedPlugin({ id: descriptor.id, sourceKind: "built-in", version: descriptor.version, enabled: false, descriptor }, now);
    const enabled = store.getManagedPlugin(descriptor.id)?.enabled === true;
    const connected = cwd === this.options.controller.workspaceCwd && this.options.controller.snapshot().connected;
    const effective = enabled && connected;
    let server = store.getMcpServer(DESKTOP_BROWSER_MCP_SERVER_ID) ?? store.createMcpServer({ id: DESKTOP_BROWSER_MCP_SERVER_ID,
      displayName: "Ling Browser", enabled: false, transport: { type: "streamable-http", url: "http://127.0.0.1:1/ling-internal/desktop-browser", headers: {}, secretHeaderRefs: {} } }, now);
    if (server.enabled !== effective) server = store.updateMcpServer(server.id, { enabled: effective }, now)!;
    const contribution = store.listManagedPluginContributions(descriptor.id)[0];
    if (!contribution || contribution.enabled !== effective) store.replaceManagedPluginContributions(descriptor.id, [{ contributionKind: "mcp-server", contributionId: server.id, linkedResourceId: server.id, enabled: effective }], now);
    const tools = store.listMcpTools({ serverId: server.id, limit: 100 });
    if (tools.length !== desktopBrowserTools.length || tools.some(tool => tool.enabled !== effective)) {
      store.replaceMcpServerTools(server.id, desktopBrowserTools.map(tool => ({ ...tool, enabled: effective })), now);
    }
    const status = createMcpStatusSnapshot({ server, now, status: !enabled ? "disabled" : connected ? "ready" : "failed",
      authStatus: createMcpAuthStatus([]), protocolVersion: DESKTOP_BROWSER_PROTOCOL, toolCount: effective ? desktopBrowserTools.length : 0,
      serverInfo: { name: "ling-desktop-browser", version: descriptor.version },
      message: !enabled ? "Ling Browser tools are disabled." : connected ? "Ling Browser is ready." : "Open Ling Desktop to use Browser tools.",
      ...(!enabled || connected ? {} : { errorCode: "browser_desktop_required" }) });
    store.upsertMcpStatusSnapshot(status, now);
    const projected = deriveMcpServerStatus(status, server.status);
    if (server.status.kind !== projected.kind || server.status.message !== projected.message) store.updateMcpServerStatus(server.id, projected, now);
    return store.upsertManagedPluginHealthSnapshot({ pluginId: descriptor.id, checkedAt: now,
      expiresAt: new Date(Date.parse(now) + 12_000).toISOString(), status: status.status === "ready" ? "ready" : !enabled ? "disabled" : "failed",
      message: status.message, details: { browserFamily: "ling", connected, browserState: connected ? "ready" : "desktop_required" } }, now);
  }

  setEnabled(cwd: string, enabled: boolean, reason?: string): ManagedPluginHealthSnapshot {
    if (cwd !== this.options.controller.workspaceCwd) throw new Error("browser_workspace_mismatch");
    const store = this.options.getStore(cwd), now = new Date().toISOString();
    store.upsertManagedPlugin({ id: this.descriptor.id, sourceKind: "built-in", version: this.descriptor.version, enabled,
      descriptor: this.descriptor, ...(!enabled && reason ? { disabledReason: reason } : {}) }, now);
    if (!enabled) this.options.controller.cancelAll();
    store.appendManagedPluginEvent({ pluginId: this.descriptor.id, actor: "local-user", type: enabled ? "enabled" : "disabled", message: enabled ? "Ling Browser tools enabled." : "Ling Browser tools disabled." }, now);
    if ("getAiTeammate" in store && "upsertLingAgentBuiltInMcpBinding" in store) {
      const bindingStore = store as Store & Pick<import("@ling-stack/core").RunStore, "getAiTeammate" | "upsertLingAgentBuiltInMcpBinding">;
      this.sync(cwd, now);
      if (bindingStore.getAiTeammate("ling_agent")) bindingStore.upsertLingAgentBuiltInMcpBinding(DESKTOP_BROWSER_MCP_SERVER_ID, enabled, now);
    }
    return this.sync(cwd, now);
  }
}
