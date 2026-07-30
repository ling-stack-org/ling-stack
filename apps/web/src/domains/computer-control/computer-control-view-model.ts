import type {
  CuaDriverLimitation,
  CuaDriverProviderState,
  ManagedPluginView,
} from "../../types.js";
import type { ComputerControlDesktopCapability } from "../../../../desktop/shared/desktop-capabilities.js";
import type { PluginActionError, PluginPendingAction } from "../plugins/use-plugins-domain.js";

export const CUA_DRIVER_PLUGIN_ID = "trusted-local:cua-driver" as const;
export const CUA_DRIVER_MCP_SERVER_ID = "mcp_cua_driver" as const;

export type ComputerControlSurfaceMode =
  | "computer_control"
  | "legacy_external"
  | "hidden_bundled"
  | "none";

export function resolveCuaDriverSurfaceMode(
  capability: ComputerControlDesktopCapability | undefined,
  plugin: ManagedPluginView | undefined,
): ComputerControlSurfaceMode {
  const setup = plugin?.setup;
  if (isValidExternalProjection(setup)) {
    return "legacy_external";
  }
  if (isValidBundledProjection(setup)) {
    return capability?.packagedBundledCapable === true
      ? "computer_control"
      : "hidden_bundled";
  }
  if (setup?.distribution === "bundled_embedded") {
    return capability?.packagedBundledCapable === true
      ? "computer_control"
      : "hidden_bundled";
  }
  return capability?.packagedBundledCapable === true ? "computer_control" : "none";
}

export function shouldHideCuaDriverInternalRows(mode: ComputerControlSurfaceMode): boolean {
  return mode === "computer_control" || mode === "hidden_bundled";
}

export function isValidBundledProjection(
  setup: ManagedPluginView["setup"],
): setup is NonNullable<ManagedPluginView["setup"]> & {
  readonly schemaVersion: 2;
  readonly distribution: "bundled_embedded";
  readonly providerState: NonNullable<NonNullable<ManagedPluginView["setup"]>["providerState"]>;
  readonly requestedEnabled: boolean;
  readonly effectiveEnabled: boolean;
} {
  if (
    setup?.schemaVersion !== 2
    || setup.distribution !== "bundled_embedded"
    || typeof setup.requestedEnabled !== "boolean"
    || typeof setup.effectiveEnabled !== "boolean"
    || !setup.providerState
    || setup.providerState.startsWith("external_")
  ) {
    return false;
  }
  if (setup.effectiveEnabled && (!setup.requestedEnabled || setup.providerState !== "ready")) {
    return false;
  }
  return setup.providerState !== "unsupported";
}

function isValidExternalProjection(setup: ManagedPluginView["setup"]): boolean {
  return setup?.schemaVersion === 2
    && setup.distribution === "external_local"
    && typeof setup.requestedEnabled === "boolean"
    && typeof setup.effectiveEnabled === "boolean";
}

export type ComputerControlPrimaryAction =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "request_permissions" }>
  | Readonly<{
      kind: "open_permission_settings";
      permission: "accessibility" | "screen_recording";
    }>
  | Readonly<{ kind: "update_ling" }>
  | Readonly<{ kind: "reinstall_ling" }>;

export interface ComputerControlStatusRow {
  readonly id: string;
  readonly label: string;
  readonly value: "ready" | "attention" | "unavailable" | "unknown";
  readonly detail?: string;
}

export type ComputerControlBusyAction = "enable" | "check" | "disable" | "request_permissions";

export type ComputerControlViewModel =
  | Readonly<{ kind: "hidden" }>
  | Readonly<{
      kind: "loading";
      checked: false;
      switchDisabled: true;
      primaryAction: Readonly<{ kind: "none" }>;
    }>
  | Readonly<{
      kind: "error";
      error: "load_failed" | "plugin_missing" | "projection_invalid";
      checked: false;
      switchDisabled: true;
      primaryAction: Readonly<{ kind: "retry" }>;
    }>
  | Readonly<{
      kind: "bundled";
      phase: "off" | "starting" | "waiting_desktop" | "waiting_permission" | "waiting_session" | "repair" | "ready" | "incompatible" | "corrupt";
      providerState: CuaDriverProviderState;
      checked: boolean;
      effectiveEnabled: boolean;
      switchDisabled: boolean;
      busyAction?: ComputerControlBusyAction;
      primaryAction: ComputerControlPrimaryAction;
      statusRows: readonly ComputerControlStatusRow[];
      limitations: readonly CuaDriverLimitation[];
      displayVersion?: string;
      lastCheckedAt?: string;
      integrity: "verified" | "failed" | "unknown";
      errorMessage?: string;
      platform?: "darwin" | "win32" | "unsupported";
      distributionRevision?: string;
    }>;

export function buildComputerControlViewModel(input: {
  readonly surfaceMode: ComputerControlSurfaceMode;
  readonly plugin?: ManagedPluginView;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly pendingActions: readonly PluginPendingAction[];
  readonly actionErrors: readonly PluginActionError[];
  readonly permissionPending: boolean;
  readonly permissionError?: string;
}): ComputerControlViewModel {
  if (input.surfaceMode !== "computer_control") {
    return { kind: "hidden" };
  }
  if (input.loading && !input.plugin) {
    return { kind: "loading", checked: false, switchDisabled: true, primaryAction: { kind: "none" } };
  }
  if (input.loadError && !input.plugin) {
    return { kind: "error", error: "load_failed", checked: false, switchDisabled: true, primaryAction: { kind: "retry" } };
  }
  if (!input.plugin) {
    return { kind: "error", error: "plugin_missing", checked: false, switchDisabled: true, primaryAction: { kind: "retry" } };
  }
  if (!isValidBundledProjection(input.plugin.setup)) {
    return { kind: "error", error: "projection_invalid", checked: false, switchDisabled: true, primaryAction: { kind: "retry" } };
  }

  const setup = input.plugin.setup;
  const pending = input.pendingActions.find((action) =>
    action.pluginId === CUA_DRIVER_PLUGIN_ID && action.owner === "computer-control");
  const busyAction: ComputerControlBusyAction | undefined = input.permissionPending
    ? "request_permissions"
    : pending?.action === "enable" || pending?.action === "disable" || pending?.action === "check"
      ? pending.action
      : undefined;
  const actionError = input.actionErrors.find((error) =>
    error.pluginId === CUA_DRIVER_PLUGIN_ID && error.owner === "computer-control");
  return {
    kind: "bundled",
    phase: phaseFor(setup.providerState, setup.requestedEnabled, setup.effectiveEnabled),
    providerState: setup.providerState,
    checked: setup.requestedEnabled,
    effectiveEnabled: setup.effectiveEnabled,
    switchDisabled: busyAction !== undefined,
    ...(busyAction ? { busyAction } : {}),
    primaryAction: primaryActionFor(setup.providerState, setup.permissions),
    statusRows: statusRowsFor(setup),
    limitations: setup.limitations ?? [],
    ...(displayVersion(setup) ? { displayVersion: displayVersion(setup) } : {}),
    ...(input.plugin.health?.checkedAt ? { lastCheckedAt: input.plugin.health.checkedAt } : {}),
    integrity: setup.integrity ?? "unknown",
    ...(input.permissionError || actionError?.message
      ? { errorMessage: input.permissionError ?? actionError?.message }
      : {}),
    ...(setup.platform ? { platform: setup.platform } : {}),
    ...(setup.providerDistributionRevision
      ? { distributionRevision: setup.providerDistributionRevision }
      : {}),
  };
}

function phaseFor(
  providerState: CuaDriverProviderState,
  requestedEnabled: boolean,
  effectiveEnabled: boolean,
): Extract<ComputerControlViewModel, { kind: "bundled" }>["phase"] {
  if (!requestedEnabled) return "off";
  if (providerState === "included") return "starting";
  if (providerState === "desktop_unavailable") return "waiting_desktop";
  if (providerState === "permission_required") return "waiting_permission";
  if (providerState === "interactive_session_required") return "waiting_session";
  if (providerState === "incompatible") return "incompatible";
  if (providerState === "corrupt") return "corrupt";
  if (providerState === "ready" && effectiveEnabled) return "ready";
  return "repair";
}

function primaryActionFor(
  providerState: CuaDriverProviderState,
  permissions: NonNullable<ManagedPluginView["setup"]>["permissions"],
): ComputerControlPrimaryAction {
  if (providerState === "permission_required") {
    if (permissions?.accessibility === "denied") {
      return { kind: "open_permission_settings", permission: "accessibility" };
    }
    if (permissions?.screenRecording === "denied") {
      return { kind: "open_permission_settings", permission: "screen_recording" };
    }
    return { kind: "request_permissions" };
  }
  if (providerState === "incompatible") return { kind: "update_ling" };
  if (providerState === "corrupt") return { kind: "reinstall_ling" };
  if (providerState === "desktop_unavailable" || providerState === "platform_unavailable" || providerState === "included") {
    return { kind: "retry" };
  }
  return { kind: "none" };
}

function statusRowsFor(setup: NonNullable<ManagedPluginView["setup"]>): readonly ComputerControlStatusRow[] {
  if (setup.platform === "darwin") {
    return [
      permissionRow("accessibility", "Accessibility", setup.permissions?.accessibility),
      permissionRow("screen-recording", "Screen Recording", setup.permissions?.screenRecording),
      {
        id: "capturable",
        label: "Live screen capture",
        value: setup.permissions?.capturable === true
          ? "ready"
          : setup.permissions?.capturable === false
            ? "attention"
            : "unknown",
      },
    ];
  }
  if (setup.platform === "win32") {
    const readiness = setup.windowsReadiness;
    return [
      enumRow("interactive-session", "Interactive session", readiness?.interactiveSession, "ready"),
      enumRow("wgc", "Windows Graphics Capture", readiness?.wgcApi, "supported"),
      enumRow("d3d11", "D3D11", readiness?.d3d11, "available"),
      enumRow("uia", "UI Automation", readiness?.uiaRuntime, "available"),
      enumRow("integrity-coverage", "Integrity coverage", readiness?.integrityCoverage, "standard"),
    ];
  }
  return [];
}

function permissionRow(
  id: string,
  label: string,
  status: "granted" | "denied" | "prompt" | "unknown" | undefined,
): ComputerControlStatusRow {
  return {
    id,
    label,
    value: status === "granted" ? "ready" : status === "denied" || status === "prompt" ? "attention" : "unknown",
    ...(status ? { detail: status } : {}),
  };
}

function enumRow(
  id: string,
  label: string,
  value: string | undefined,
  readyValue: string,
): ComputerControlStatusRow {
  return {
    id,
    label,
    value: value === readyValue ? "ready" : value === undefined || value === "unknown" ? "unknown" : "attention",
    ...(value ? { detail: value } : {}),
  };
}

function displayVersion(setup: NonNullable<ManagedPluginView["setup"]>): string | undefined {
  if (setup.providerDisplayVersion) return setup.providerDisplayVersion;
  if (!setup.providerVersion) return undefined;
  const match = /^ling\.(\d+)$/u.exec(setup.providerDistributionRevision ?? "");
  return match ? `${setup.providerVersion} (Ling build ${match[1]})` : setup.providerVersion;
}
