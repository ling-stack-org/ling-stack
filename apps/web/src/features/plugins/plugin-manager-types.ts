import type { ManagedPluginCreateRequest, ManagedPluginView } from "../../types.js";
import type {
  PluginActionError,
  PluginActionErrorFilter,
  PluginActionOwner as DomainPluginActionOwner,
  PluginActionRequest,
  PluginBusyAction,
  PluginPendingAction,
} from "../../domains/plugins/use-plugins-domain.js";
import type { StatusTone } from "../../shared/ui/index.js";

export type PluginSourceFilter = "all" | ManagedPluginView["sourceKind"];
export type PluginStatusFilter = "all" | "needs-action" | "enabled" | "disabled" | "unavailable";

export interface PluginManagerFilters {
  readonly query: string;
  readonly source: PluginSourceFilter;
  readonly status: PluginStatusFilter;
}

export type PluginPrimaryStateId =
  | "included"
  | "desktop-required"
  | "permissions-required"
  | "interactive-session-required"
  | "repair-required"
  | "platform-blocked"
  | "provider-incompatible"
  | "restart-required"
  | "provider-unavailable"
  | "failed"
  | "setup-missing"
  | "package-missing"
  | "busy"
  | "connecting"
  | "stale"
  | "needs-check"
  | "disabled"
  | "ready"
  | "unknown";

export interface PluginPrimaryStateView {
  readonly id: PluginPrimaryStateId;
  readonly label: string;
  readonly tone: StatusTone;
}

export type PluginActionId =
  | "apply"
  | "connect-chrome"
  | "revoke-chrome"
  | "guide"
  | "install"
  | "check"
  | "enable"
  | "disable"
  | "details"
  | "runtime-preview"
  | "refresh-package"
  | "validate"
  | "uninstall";

export type PluginActionOwner = DomainPluginActionOwner;

export interface PluginActionFailure {
  readonly pluginId: string;
  readonly action: PluginBusyAction;
  readonly owner: PluginActionOwner;
  readonly message: string;
  readonly detail: string;
  readonly retryAction?: PluginActionId;
}

export interface PluginActionView {
  readonly id: PluginActionId;
  readonly label: string;
  readonly tone: "primary" | "secondary" | "danger";
}

export interface PluginRowView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourceKind: ManagedPluginView["sourceKind"];
  readonly sourceLabel: string;
  readonly settledPrimaryState: PluginPrimaryStateView;
  readonly primaryState: PluginPrimaryStateView;
  readonly filterGroup: Exclude<PluginStatusFilter, "all"> | "other";
  readonly primaryAction?: PluginActionView;
  readonly checkActionLabel?: string;
  readonly showCheckAction: boolean;
  readonly showDisableAction: boolean;
  readonly showDetailsAction: boolean;
  readonly menuActions: readonly PluginActionView[];
  readonly busyAction?: PluginBusyAction;
  readonly actionFailure?: PluginActionFailure;
  readonly icon?: "chrome" | "office";
}

export interface PluginDetailFieldView {
  readonly label: string;
  readonly value: string;
}

export interface PluginCapabilityView {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly capabilities: readonly string[];
}

export interface PluginResourceGroupView {
  readonly label: string;
  readonly items: readonly PluginDetailFieldView[];
}

export interface PluginRuntimeView {
  readonly statusLabel: string;
  readonly tone: StatusTone;
  readonly summary: string;
  readonly blocker?: string;
  readonly groups: readonly PluginResourceGroupView[];
  readonly policySummary?: string;
}

export interface PluginDetailView {
  readonly sourceVersion: string;
  readonly description: string;
  readonly overviewFields: readonly PluginDetailFieldView[];
  readonly failureReason?: string;
  readonly repairHint?: string;
  readonly capabilities: readonly PluginCapabilityView[];
  readonly capabilitySummary: string;
  readonly trustSummary: string;
  readonly trustFields: readonly PluginDetailFieldView[];
  readonly runtime?: PluginRuntimeView;
  readonly technicalFields: readonly PluginDetailFieldView[];
  readonly hasLinkedMcp: boolean;
}

export interface PluginActionHandlers {
  readonly onApplyPreset: (pluginId: string) => void;
  readonly onOpenInstallGuide: (pluginId: string) => void;
  readonly onOpenDetails: (pluginId: string) => void;
  readonly onCheck: (pluginId: string) => void;
  readonly onValidatePackage: (pluginId: string) => void;
  readonly onInstall: (pluginId: string) => void;
  readonly onRequestUninstall: (pluginId: string) => void;
  readonly onRefreshPackage: (pluginId: string) => void;
  readonly onRuntimePreview: (pluginId: string) => void;
  readonly onEnable: (pluginId: string) => void;
  readonly onDisable: (pluginId: string) => void;
  readonly onOpenChromeConnect: (pluginId: string) => void;
  readonly onRevokeChrome: (pluginId: string) => void;
}

export interface PluginManagerPageProps {
  readonly plugins: readonly ManagedPluginView[];
  readonly isLoading: boolean;
  readonly loadError: string;
  readonly pendingActions: readonly PluginPendingAction[];
  readonly actionErrors: readonly PluginActionError[];
  readonly onRefresh: () => void;
  readonly onCreate: (input: ManagedPluginCreateRequest, request: PluginActionRequest) => Promise<ManagedPluginView | undefined>;
  readonly onApplyPreset: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onConnect: (pluginId: string, request: PluginActionRequest, command?: string) => Promise<ManagedPluginView | undefined>;
  readonly onCheck: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onValidatePackage: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onInstall: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onUninstall: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onRefreshPackage: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onRuntimePreview: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onEnable: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onDisable: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onStartChromePairing: (pluginId: string, request: PluginActionRequest) => Promise<import("../../types.js").ChromeBrowserPairingStartResponse | undefined>;
  readonly onRevokeChrome: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly onClearActionErrors: (filter: PluginActionErrorFilter) => void;
  readonly onOpenMcpSettings: () => void;
}
