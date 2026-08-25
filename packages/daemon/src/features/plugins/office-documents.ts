import {
  OFFICE_DOCUMENTS_MCP_SERVER_ID,
  OFFICE_DOCUMENTS_PLUGIN_ID,
  officeDriverCapabilities,
  type ManagedPluginSetupView,
  type OfficeDocumentsSetupState,
  type OfficeDriverCapability,
} from "@ling-stack/contracts";
import type {
  ManagedPluginDescriptor,
  ManagedPluginHealthSnapshot,
  ManagedPluginStoreFacet,
  McpServer,
  McpStoreFacet,
} from "@ling-stack/core";
import type { OfficeDriverController } from "../office-documents/driver-controller.js";
import { officeAllTools, officeToolsForCapabilities } from "./office-documents-generation-broker.js";

type OfficePluginStore = ManagedPluginStoreFacet & McpStoreFacet;

export function createOfficeDocumentsDescriptor(): ManagedPluginDescriptor {
  return {
    id: OFFICE_DOCUMENTS_PLUGIN_ID,
    displayName: "Office Documents",
    version: "0.1.0",
    sourceKind: "built-in",
    description: "Create and edit Office files locally, with native live Excel control in Ling Desktop.",
    trustSummary: "Office file processing and live control run locally. Content returned to the conversation follows the selected model's data path.",
    contributions: [{
      kind: "mcp-server",
      id: OFFICE_DOCUMENTS_MCP_SERVER_ID,
      label: "Office document tools",
      capabilities: ["office:xlsx", "office:docx", "office:pptx", "office:excel-live"],
      sideEffectLevel: "write",
      defaultApproval: "ask",
    }],
    defaultApprovals: [{
      contributionId: OFFICE_DOCUMENTS_MCP_SERVER_ID,
      decision: "ask",
      reason: "Office writes can change local documents; read-only tools retain their tool-level allow default.",
    }],
    healthChecks: [{ id: "office-documents-runtime", label: "Office document runtime", kind: "descriptor" }],
    defaultEnabled: false,
  };
}

export class OfficeDocumentsPluginService {
  readonly descriptor = createOfficeDocumentsDescriptor();

  constructor(private readonly options: {
    readonly controller: OfficeDriverController;
    readonly getStore: (cwd: string) => OfficePluginStore;
  }) {}

  sync(cwd: string, now = new Date().toISOString()): ManagedPluginHealthSnapshot {
    const store = this.options.getStore(cwd);
    const pluginRecord = store.getManagedPlugin(OFFICE_DOCUMENTS_PLUGIN_ID);
    const enabled = pluginRecord?.enabled === true;
    if (!pluginRecord) {
      return officeHealthSnapshot(this.options.controller, { installed: false, enabled: false }, now);
    }
    const server = this.ensureLogicalRuntime(store, enabled, now);
    if (server.enabled !== enabled) store.updateMcpServer(server.id, { enabled }, now);
    const contribution = store.listManagedPluginContributions(OFFICE_DOCUMENTS_PLUGIN_ID)
      .find((candidate) => candidate.contributionId === OFFICE_DOCUMENTS_MCP_SERVER_ID);
    if (!contribution || contribution.linkedResourceId !== server.id || contribution.enabled !== enabled) {
      store.replaceManagedPluginContributions(OFFICE_DOCUMENTS_PLUGIN_ID, [{
        contributionKind: "mcp-server",
        contributionId: OFFICE_DOCUMENTS_MCP_SERVER_ID,
        linkedResourceId: server.id,
        enabled,
      }], now);
    }
    ensureLingAgentBinding(store, enabled, now);
    const health = officeHealthSnapshot(this.options.controller, {
      installed: pluginRecord !== undefined,
      enabled,
    }, now);
    store.upsertManagedPluginHealthSnapshot(health, now);
    const driverSnapshot = this.options.controller.snapshot();
    const capabilities = driverSnapshot.connected
      && driverSnapshot.availability
      && (driverSnapshot.availability.state === "ready" || driverSnapshot.availability.state === "limited")
      ? driverSnapshot.availability.capabilities
      : [];
    const projectedTools = officeToolsForCapabilities(capabilities, driverSnapshot.availability?.platform);
    const projectedByName = new Map(projectedTools.map((tool) => [tool.rawName, tool]));
    store.replaceMcpServerTools(server.id, officeAllTools.map((tool) => ({
      ...(projectedByName.get(tool.rawName) ?? tool),
      enabled: enabled && projectedByName.has(tool.rawName),
    })), now);
    return health;
  }

  enable(cwd: string, now = new Date().toISOString()): ManagedPluginHealthSnapshot {
    const store = this.options.getStore(cwd);
    store.upsertManagedPlugin({ id: this.descriptor.id, sourceKind: "built-in", version: this.descriptor.version, enabled: true, descriptor: this.descriptor }, now);
    store.appendManagedPluginEvent({ pluginId: this.descriptor.id, type: "enabled", actor: "local-user", message: "Office Documents enabled." }, now);
    return this.sync(cwd, now);
  }

  disable(cwd: string, reason?: string, now = new Date().toISOString()): ManagedPluginHealthSnapshot {
    const store = this.options.getStore(cwd);
    store.upsertManagedPlugin({ id: this.descriptor.id, sourceKind: "built-in", version: this.descriptor.version, enabled: false, disabledReason: reason, descriptor: this.descriptor }, now);
    store.appendManagedPluginEvent({ pluginId: this.descriptor.id, type: "disabled", actor: "local-user", message: reason ? `Office Documents disabled: ${reason}` : "Office Documents disabled." }, now);
    return this.sync(cwd, now);
  }

  handleDriverStateChange(cwd: string): void {
    this.sync(cwd);
  }

  private ensureLogicalRuntime(store: OfficePluginStore, enabled: boolean, now: string): McpServer {
    return store.getMcpServer(OFFICE_DOCUMENTS_MCP_SERVER_ID) ?? store.createMcpServer({
      id: OFFICE_DOCUMENTS_MCP_SERVER_ID,
      displayName: "Office Documents",
      enabled: false,
      transport: { type: "streamable-http", url: "http://127.0.0.1:1/ling-internal/office-documents", headers: {}, secretHeaderRefs: {} },
    }, now);
  }
}

export function buildOfficeDocumentsSetupView(health: ManagedPluginHealthSnapshot): ManagedPluginSetupView {
  const details = isRecord(health.details) ? health.details : {};
  const officeState = readOfficeState(details.officeState);
  return {
    kind: "office_documents",
    state: officeState === "ready" || officeState === "limited" ? "ready"
      : officeState === "disabled" ? "connected"
      : officeState === "desktop_required" || officeState === "not_installed" ? "missing"
      : "detected",
    checkedAt: health.checkedAt,
    officeState,
    ...(details.platform === "darwin" || details.platform === "win32" ? { officePlatform: details.platform } : {}),
    ...(readOfficeCapabilities(details.capabilities).length > 0
      ? { officeCapabilities: readOfficeCapabilities(details.capabilities) }
      : {}),
    ...(typeof details.officeInstalled === "boolean" ? { officeInstalled: details.officeInstalled } : {}),
    ...(typeof details.applicationRunning === "boolean" ? { officeApplicationRunning: details.applicationRunning } : {}),
    ...(typeof details.permissionGranted === "boolean" ? { officePermissionGranted: details.permissionGranted } : {}),
    ...(typeof details.helperVersion === "string" ? { officeHelperVersion: details.helperVersion } : {}),
  };
}

function officeHealthSnapshot(
  controller: OfficeDriverController,
  activation: { readonly installed: boolean; readonly enabled: boolean },
  now: string,
): ManagedPluginHealthSnapshot {
  const snapshot = controller.snapshot();
  const availability = snapshot.availability;
  const officeState: OfficeDocumentsSetupState = !activation.installed ? "not_installed"
    : !activation.enabled ? "disabled"
    : !snapshot.connected || !availability ? "desktop_required"
    : availability.state;
  return {
    pluginId: OFFICE_DOCUMENTS_PLUGIN_ID,
    checkedAt: now,
    expiresAt: new Date(Date.parse(now) + 5 * 60 * 1000).toISOString(),
    status: !activation.enabled ? "disabled" : officeState === "driver_error" ? "failed" : "ready",
    message: !activation.installed ? "Office Documents is not installed."
      : !activation.enabled ? "Office Documents is disabled."
      : officeState === "ready" ? "Office file tools and native Excel control are ready."
      : officeState === "limited" ? "Office file tools are ready; live Excel capabilities are limited on this platform."
      : officeState === "office_missing" ? "Office file tools are ready. Microsoft Excel was not detected."
      : officeState === "permission_required" ? "Allow Ling to control Microsoft Excel in macOS Automation settings."
      : officeState === "application_not_running" ? "Office file tools are ready. Open Microsoft Excel for live control."
      : officeState === "driver_error" ? "Office file tools are ready, but the native Excel driver needs repair."
      : "Office file tools are ready. Live Excel control requires Ling Desktop.",
    details: {
      officeState,
      ...(availability ? {
        platform: availability.platform,
        capabilities: availability.capabilities,
        officeInstalled: availability.officeInstalled,
        applicationRunning: availability.applicationRunning,
        permissionGranted: availability.permissionGranted,
        helperVersion: availability.helperVersion,
        errorCode: availability.errorCode,
      } : {}),
    },
  };
}

function readOfficeState(value: unknown): OfficeDocumentsSetupState {
  return value === "not_installed" || value === "disabled" || value === "office_missing" || value === "permission_required"
    || value === "application_not_running" || value === "ready" || value === "limited" || value === "driver_error"
    ? value
    : "desktop_required";
}

function readOfficeCapabilities(value: unknown): readonly OfficeDriverCapability[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(officeDriverCapabilities);
  return value.filter((item): item is OfficeDriverCapability => typeof item === "string" && allowed.has(item));
}

function ensureLingAgentBinding(store: OfficePluginStore, enabled: boolean, now: string): void {
  const existing = store.listTeammateMcpBindings("ling_agent").find((binding) => binding.serverId === OFFICE_DOCUMENTS_MCP_SERVER_ID);
  if (!existing && !enabled) return;
  if (existing && existing.enabled === enabled && existing.mode === "all_current_tools") return;
  store.upsertLingAgentBuiltInMcpBinding(OFFICE_DOCUMENTS_MCP_SERVER_ID, enabled, now);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
