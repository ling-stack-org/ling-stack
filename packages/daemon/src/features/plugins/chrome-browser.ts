import {
  CHROME_BROWSER_MCP_SERVER_ID,
  CHROME_BROWSER_PLUGIN_ID,
  CHROME_BROWSER_PROTOCOL,
  type ChromeBrowserSetupState,
} from "@ling-stack/contracts";
import type {
  ChromeBrowserCredentialStoreFacet,
  ManagedPluginDescriptor,
  ManagedPluginHealthSnapshot,
  ManagedPluginSetupView,
  ManagedPluginStoreFacet,
  McpServer,
  McpStoreFacet,
} from "@ling-stack/core";
import type { ChromeBrowserSessionController, ChromeBrowserSessionSnapshot } from "../browser-extension/session-controller.js";
import { createMcpAuthStatus, createMcpStatusSnapshot, deriveMcpServerStatus } from "../mcp/status.js";
import { chromeBrowserTools } from "./chrome-browser-generation-broker.js";

type ChromeBrowserPluginStore =
  ManagedPluginStoreFacet &
  McpStoreFacet &
  ChromeBrowserCredentialStoreFacet;

export function createChromeBrowserDescriptor(): ManagedPluginDescriptor {
  return {
    id: CHROME_BROWSER_PLUGIN_ID,
    displayName: "Chrome",
    version: "0.1.0",
    sourceKind: "built-in",
    description: "Control Chrome with Ling.",
    trustSummary: "Uses an explicitly paired Ling extension and existing MCP approvals.",
    contributions: [{
      kind: "mcp-server",
      id: CHROME_BROWSER_MCP_SERVER_ID,
      label: "Chrome browser tools",
      capabilities: ["browser:tabs", "browser:read", "browser:interact", "browser:screenshot"],
      sideEffectLevel: "external",
      defaultApproval: "ask",
    }],
    defaultApprovals: [{
      contributionId: CHROME_BROWSER_MCP_SERVER_ID,
      decision: "ask",
      reason: "Browser content and interactions may affect signed-in websites.",
    }],
    healthChecks: [{ id: "chrome-extension-session", label: "Chrome extension connection", kind: "descriptor" }],
    defaultEnabled: false,
  };
}

export class ChromeBrowserPluginService {
  readonly descriptor = createChromeBrowserDescriptor();

  constructor(private readonly options: {
    readonly controller: ChromeBrowserSessionController;
    readonly getStore: (cwd: string) => ChromeBrowserPluginStore;
    readonly storeUrl?: string;
  }) {}

  supportsWorkspace(cwd: string): boolean {
    return this.options.controller.supportsWorkspace(cwd);
  }

  sync(cwd: string, now = new Date().toISOString()): ManagedPluginHealthSnapshot {
    const store = this.options.getStore(cwd);
    const record = store.getManagedPlugin(CHROME_BROWSER_PLUGIN_ID);
    const enabled = record?.enabled === true;
    const server = this.ensureLogicalRuntime(store, enabled, now);
    const snapshot = this.options.controller.snapshot(cwd);
    const effective = enabled && snapshot.connected;
    if (server.enabled !== effective) store.updateMcpServer(server.id, { enabled: effective }, now);
    const contribution = store.listManagedPluginContributions(CHROME_BROWSER_PLUGIN_ID)
      .find((candidate) => candidate.contributionId === CHROME_BROWSER_MCP_SERVER_ID);
    if (!contribution || contribution.linkedResourceId !== server.id || contribution.enabled !== effective) {
      store.replaceManagedPluginContributions(CHROME_BROWSER_PLUGIN_ID, [{
        contributionKind: "mcp-server",
        contributionId: CHROME_BROWSER_MCP_SERVER_ID,
        linkedResourceId: server.id,
        enabled: effective,
      }], now);
    }
    const existingTools = store.listMcpTools({ serverId: server.id, limit: 500 });
    if (
      existingTools.length !== chromeBrowserTools.length
      || chromeBrowserTools.some((tool) => !existingTools.some((existing) =>
        existing.rawName === tool.rawName && existing.enabled === effective))
    ) {
      store.replaceMcpServerTools(server.id, chromeBrowserTools.map((tool) => ({ ...tool, enabled: effective })), now);
    }
    ensureLingAgentBinding(store, enabled, now);
    const currentServer = store.getMcpServer(server.id) ?? server;
    const statusSnapshot = createMcpStatusSnapshot({
      server: currentServer,
      now,
      status: !enabled ? "disabled" : effective ? "ready" : "failed",
      authStatus: createMcpAuthStatus([]),
      protocolVersion: CHROME_BROWSER_PROTOCOL,
      toolCount: effective ? chromeBrowserTools.length : 0,
      serverInfo: { name: "ling-chrome-browser", version: this.descriptor.version },
      message: !enabled
        ? "Chrome plugin is disabled."
        : snapshot.connected
          ? "Chrome extension is connected."
          : snapshot.paired
            ? "Open Chrome and enable the Ling extension."
            : "Install and pair the Ling Chrome extension.",
      ...(!enabled || effective
        ? {}
        : { errorCode: snapshot.paired ? "chrome_browser_disconnected" : "chrome_browser_extension_required" }),
    });
    store.upsertMcpStatusSnapshot(statusSnapshot, now);
    const projectedServerStatus = deriveMcpServerStatus(statusSnapshot, currentServer.status);
    if (
      currentServer.status.kind !== projectedServerStatus.kind
      || currentServer.status.message !== projectedServerStatus.message
    ) {
      store.updateMcpServerStatus(currentServer.id, projectedServerStatus, now);
    }
    const health = chromeHealthSnapshot(snapshot, enabled, now, this.options.storeUrl);
    return store.upsertManagedPluginHealthSnapshot(health, now);
  }

  enable(cwd: string, now = new Date().toISOString()): ManagedPluginHealthSnapshot {
    const store = this.options.getStore(cwd);
    store.upsertManagedPlugin({
      id: this.descriptor.id,
      sourceKind: this.descriptor.sourceKind,
      version: this.descriptor.version,
      enabled: true,
      descriptor: this.descriptor,
    }, now);
    store.appendManagedPluginEvent({
      pluginId: CHROME_BROWSER_PLUGIN_ID,
      type: "enabled",
      actor: "local-user",
      message: "Chrome plugin enabled.",
    }, now);
    return this.sync(cwd, now);
  }

  disable(cwd: string, reason?: string, now = new Date().toISOString()): ManagedPluginHealthSnapshot {
    const store = this.options.getStore(cwd);
    store.upsertManagedPlugin({
      id: this.descriptor.id,
      sourceKind: this.descriptor.sourceKind,
      version: this.descriptor.version,
      enabled: false,
      disabledReason: reason,
      descriptor: this.descriptor,
    }, now);
    this.options.controller.disconnect(cwd);
    store.appendManagedPluginEvent({
      pluginId: CHROME_BROWSER_PLUGIN_ID,
      type: "disabled",
      actor: "local-user",
      message: reason ? `Chrome plugin disabled: ${reason}` : "Chrome plugin disabled.",
    }, now);
    return this.sync(cwd, now);
  }

  revoke(cwd: string, now = new Date().toISOString()): ManagedPluginHealthSnapshot {
    const store = this.options.getStore(cwd);
    this.options.controller.revoke(cwd);
    store.appendManagedPluginEvent({
      pluginId: CHROME_BROWSER_PLUGIN_ID,
      type: "access_revoked",
      actor: "local-user",
      message: "Chrome access removed.",
    }, now);
    return this.sync(cwd, now);
  }

  createPairing(cwd: string) {
    return {
      ...this.options.controller.createPairing(cwd),
      ...(this.options.storeUrl ? { storeUrl: this.options.storeUrl } : {}),
    };
  }

  setup(cwd: string, now = new Date().toISOString()): ManagedPluginSetupView {
    const store = this.options.getStore(cwd);
    const enabled = store.getManagedPlugin(CHROME_BROWSER_PLUGIN_ID)?.enabled === true;
    return buildChromeBrowserSetupView(
      chromeHealthSnapshot(this.options.controller.snapshot(cwd), enabled, now, this.options.storeUrl),
    );
  }

  handleSessionStateChange(cwd: string): void {
    this.sync(cwd);
  }

  private ensureLogicalRuntime(store: ChromeBrowserPluginStore, enabled: boolean, now: string): McpServer {
    if (!store.getManagedPlugin(this.descriptor.id)) {
      store.upsertManagedPlugin({
        id: this.descriptor.id,
        sourceKind: this.descriptor.sourceKind,
        version: this.descriptor.version,
        enabled,
        descriptor: this.descriptor,
      }, now);
    }
    const input = {
      displayName: "Chrome browser",
      enabled: false,
      transport: {
        type: "streamable-http" as const,
        url: "http://127.0.0.1:1/ling-internal/chrome-browser",
        headers: {},
        secretHeaderRefs: {},
      },
    };
    return store.getMcpServer(CHROME_BROWSER_MCP_SERVER_ID)
      ?? store.createMcpServer({ id: CHROME_BROWSER_MCP_SERVER_ID, ...input }, now);
  }
}

export function normalizeChromeBrowserStoreUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "chromewebstore.google.com" || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function buildChromeBrowserSetupView(health: ManagedPluginHealthSnapshot): ManagedPluginSetupView {
  const details = isRecord(health.details) ? health.details : {};
  const browserState = readBrowserState(details.browserState);
  return {
    kind: "browser_extension",
    state: browserState === "ready" ? "ready" : browserState === "waiting_for_chrome" ? "connected" : "missing",
    checkedAt: health.checkedAt,
    browserFamily: "chrome",
    browserState,
    paired: details.paired === true,
    connected: details.connected === true,
    ...(typeof details.extensionVersion === "string" ? { extensionVersion: details.extensionVersion } : {}),
    ...(typeof details.browserVersion === "string" ? { browserVersion: details.browserVersion } : {}),
    ...(typeof details.lastSeenAt === "string" ? { lastSeenAt: details.lastSeenAt } : {}),
    ...(typeof details.storeUrl === "string" ? { storeUrl: details.storeUrl } : {}),
  };
}

function chromeHealthSnapshot(
  snapshot: ChromeBrowserSessionSnapshot,
  enabled: boolean,
  now: string,
  storeUrl?: string,
): ManagedPluginHealthSnapshot {
  const incompatible = snapshot.errorCode === "chrome_browser_protocol_invalid"
    || snapshot.errorCode === "chrome_browser_credential_invalid";
  const browserState: ChromeBrowserSetupState = snapshot.connected
    ? "ready"
    : incompatible
      ? "incompatible"
      : snapshot.paired
        ? "waiting_for_chrome"
        : "extension_required";
  return {
    pluginId: CHROME_BROWSER_PLUGIN_ID,
    checkedAt: now,
    expiresAt: new Date(Date.parse(now) + 5 * 60 * 1000).toISOString(),
    status: !enabled ? "disabled" : snapshot.connected ? "ready" : "failed",
    message: !enabled
      ? "Chrome plugin is disabled."
      : snapshot.connected
        ? "Chrome extension is connected."
        : incompatible
          ? "Chrome extension needs to be updated or paired again."
          : snapshot.paired
            ? "Open Chrome and enable the Ling extension."
            : "Install and pair the Ling Chrome extension.",
    details: {
      browserFamily: "chrome",
      browserState,
      paired: snapshot.paired,
      connected: snapshot.connected,
      ...(snapshot.extensionVersion ? { extensionVersion: snapshot.extensionVersion } : {}),
      ...(snapshot.browserVersion ? { browserVersion: snapshot.browserVersion } : {}),
      ...(snapshot.lastSeenAt ? { lastSeenAt: snapshot.lastSeenAt } : {}),
      ...(storeUrl ? { storeUrl } : {}),
      ...(!enabled || snapshot.connected
        ? {}
        : { errorCode: snapshot.errorCode ?? (snapshot.paired ? "chrome_browser_disconnected" : "chrome_browser_extension_required") }),
    },
  };
}

function readBrowserState(value: unknown): ChromeBrowserSetupState {
  return value === "ready" || value === "waiting_for_chrome" || value === "incompatible"
    ? value
    : "extension_required";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureLingAgentBinding(store: ChromeBrowserPluginStore, enabled: boolean, now: string): void {
  const existing = store.listTeammateMcpBindings("ling_agent")
    .find((binding) => binding.serverId === CHROME_BROWSER_MCP_SERVER_ID);
  if (!existing && !enabled) return;
  if (existing && existing.enabled === enabled && existing.mode === "all_current_tools") return;
  store.upsertLingAgentChromeBrowserBinding(enabled, now);
}
