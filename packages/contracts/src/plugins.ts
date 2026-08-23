import type { McpRuntimeStatusSnapshot, McpServer, McpServerTransport, McpTool } from "./mcp.js";
import type {
  CuaDriverBridgeStatus,
  CuaDriverDistribution,
  CuaDriverExternalOverride,
  CuaDriverIntegrityCoverage,
  CuaDriverIntegrityStatus,
  CuaDriverLimitation,
  CuaDriverPermissionSnapshot,
  CuaDriverPlatform,
  CuaDriverProviderState,
  CuaDriverWindowsReadinessSnapshot,
} from "./cua-driver-bundled.js";
import type { LockedComputerControlProjectionV1 } from "./locked-computer-control.js";
import type { ChromeBrowserSetupState } from "./chrome-browser.js";
import type {
  OfficeDocumentsSetupState,
  OfficeDriverCapability,
  OfficeDriverPlatform,
} from "./office-documents.js";

export type ManagedPluginSourceKind = "built-in" | "bundled" | "trusted-local-preset";

export type ManagedPluginStatus = "available" | "enabled" | "disabled" | "blocked";

export type ManagedPluginHealthStatus = "unknown" | "ready" | "failed" | "disabled" | "expired";

export type ManagedPluginPackageStatus = "installed" | "uninstalled";

export type ManagedPluginRuntimePreviewStatus = "injectable" | "blocked" | "disabled";

export type ManagedPluginSetupState = "detected" | "missing" | "unsupported" | "connected" | "ready";

export interface ManagedPluginSetupGuide {
  readonly documentationUrl: string;
  readonly installCommand: string;
  readonly supportsCustomCommand: boolean;
}

export interface ManagedPluginSetupView {
  readonly kind: "local_binary" | "browser_extension" | "office_documents";
  readonly state: ManagedPluginSetupState;
  readonly checkedAt: string;
  readonly detectedCommand?: string;
  readonly guide?: ManagedPluginSetupGuide;
  /** Present on the opt-in Cua Driver V2 projection. */
  readonly schemaVersion?: 2;
  readonly distribution?: CuaDriverDistribution;
  readonly platform?: CuaDriverPlatform;
  readonly providerState?: CuaDriverProviderState;
  readonly requestedEnabled?: boolean;
  readonly effectiveEnabled?: boolean;
  readonly integrityCoverage?: CuaDriverIntegrityCoverage;
  readonly limitations?: readonly CuaDriverLimitation[];
  readonly providerVersion?: string;
  readonly providerDistributionRevision?: string;
  readonly providerRevision?: string;
  readonly providerDisplayVersion?: string;
  readonly expectedProviderVersion?: string;
  readonly providerSealDigest?: string;
  readonly providerCatalogDigest?: string;
  readonly sealDigest?: string;
  readonly catalogDigest?: string;
  readonly integrity?: CuaDriverIntegrityStatus;
  readonly bridge?: CuaDriverBridgeStatus;
  readonly permissions?: CuaDriverPermissionSnapshot;
  readonly windowsReadiness?: CuaDriverWindowsReadinessSnapshot;
  readonly externalOverride?: CuaDriverExternalOverride;
  /** Optional V1 projection. Older Desktop/daemon pairs ignore it and remain fixed Off. */
  readonly lockedControl?: LockedComputerControlProjectionV1;
  readonly browserFamily?: "chrome";
  readonly browserState?: ChromeBrowserSetupState;
  readonly paired?: boolean;
  readonly connected?: boolean;
  readonly extensionVersion?: string;
  readonly browserVersion?: string;
  readonly lastSeenAt?: string;
  readonly storeUrl?: string;
  readonly officeState?: OfficeDocumentsSetupState;
  readonly officePlatform?: OfficeDriverPlatform;
  readonly officeCapabilities?: readonly OfficeDriverCapability[];
  readonly officeInstalled?: boolean;
  readonly officeApplicationRunning?: boolean;
  readonly officePermissionGranted?: boolean;
  readonly officeHelperVersion?: string;
}

/**
 * Detailed Cua Driver wire projection. It refines, rather than replaces, the
 * legacy local_binary setup fields so old clients always see known values.
 */
export interface CuaDriverSetupView extends ManagedPluginSetupView {
  readonly kind: "local_binary";
  readonly schemaVersion: 2;
  readonly distribution: CuaDriverDistribution;
  readonly platform: CuaDriverPlatform;
  readonly providerState: CuaDriverProviderState;
  readonly requestedEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly limitations: readonly CuaDriverLimitation[];
  readonly lockedControl?: LockedComputerControlProjectionV1;
}

export interface ChromeBrowserSetupView extends ManagedPluginSetupView {
  readonly kind: "browser_extension";
  readonly browserFamily: "chrome";
  readonly browserState: ChromeBrowserSetupState;
  readonly paired: boolean;
  readonly connected: boolean;
}

export type ManagedPluginContributionKind =
  | "mcp-server"
  | "tool"
  | "skill-pack"
  | "runner"
  | "provider"
  | "channel-source"
  | "memory"
  | "automation"
  | "ui-feature";

export type ManagedPluginSideEffectLevel = "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";

export type ManagedPluginDefaultApproval = "allow" | "ask" | "deny";

export interface ManagedPluginSecretRequirement {
  readonly ref: string;
  readonly label: string;
  readonly purpose?: string;
  readonly required?: boolean;
}

export interface ManagedPluginApprovalDefault {
  readonly contributionId: string;
  readonly decision: ManagedPluginDefaultApproval;
  readonly reason?: string;
}

export interface ManagedPluginContributionView {
  readonly kind: ManagedPluginContributionKind;
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly sideEffectLevel?: ManagedPluginSideEffectLevel;
  readonly defaultApproval?: ManagedPluginDefaultApproval;
  readonly linkedResourceId?: string;
  readonly linkedResourcePresent?: boolean;
  readonly enabled: boolean;
}

export interface ManagedPluginHealthSnapshot {
  readonly pluginId: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly status: ManagedPluginHealthStatus;
  readonly message?: string;
  readonly details?: unknown;
}

export interface ManagedPluginEvent {
  readonly id: string;
  readonly pluginId: string;
  readonly type:
    | "enabled"
    | "disabled"
    | "preset_applied"
    | "checked"
    | "contribution_linked"
    | "contribution_disabled"
    | "connected"
    | "access_revoked"
    | "installed"
    | "uninstalled"
    | "package_refreshed"
    | "runtime_previewed";
  readonly actor: "local-user" | "system";
  readonly message?: string;
  readonly data?: unknown;
  readonly createdAt: string;
}

export interface ManagedPluginLinkedResource {
  readonly kind: ManagedPluginContributionKind;
  readonly id: string;
  readonly present: boolean;
  readonly enabled?: boolean;
  readonly displayName?: string;
}

export interface ManagedPluginPackageView {
  readonly pluginId: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly version: string;
  readonly status: ManagedPluginPackageStatus;
  readonly cacheRef: string;
  readonly packageHash?: string;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly uninstalledAt?: string;
}

export interface ManagedPluginPolicyOverlayView {
  readonly id: string;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly targetKind: "mcp-server" | "mcp-tool" | "app" | "hook";
  readonly targetId: string;
  readonly defaultApproval: ManagedPluginDefaultApproval;
  readonly sideEffectLevel: ManagedPluginSideEffectLevel;
  readonly reason: string;
}

export interface ManagedPluginRuntimePreview {
  readonly pluginId: string;
  readonly status: ManagedPluginRuntimePreviewStatus;
  readonly package?: ManagedPluginPackageView;
  readonly mcpServers: readonly ManagedPluginLinkedResource[];
  readonly skillPacks: readonly ManagedPluginLinkedResource[];
  readonly apps: readonly ManagedPluginLinkedResource[];
  readonly hooks: readonly ManagedPluginLinkedResource[];
  readonly policyOverlays: readonly ManagedPluginPolicyOverlayView[];
  readonly blockers: readonly string[];
}

export interface ManagedPluginView {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly status: ManagedPluginStatus;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly contributions: readonly ManagedPluginContributionView[];
  readonly requiredSecrets?: readonly ManagedPluginSecretRequirement[];
  readonly defaultApprovals?: readonly ManagedPluginApprovalDefault[];
  readonly health?: ManagedPluginHealthSnapshot;
  readonly package?: ManagedPluginPackageView;
  readonly runtimePreview?: ManagedPluginRuntimePreview;
  readonly setup?: ManagedPluginSetupView;
  readonly linkedResources: readonly ManagedPluginLinkedResource[];
  readonly events?: readonly ManagedPluginEvent[];
  readonly disabledReason?: string;
  readonly actions: {
    readonly canEnable: boolean;
    readonly canDisable: boolean;
    readonly canCheck: boolean;
    readonly canApplyPreset: boolean;
    readonly canInstall: boolean;
    readonly canUninstall: boolean;
    readonly canRefreshPackage: boolean;
    readonly canRuntimePreview: boolean;
  };
}

export interface ManagedPluginListResponse {
  readonly cwd: string;
  readonly plugins: readonly ManagedPluginView[];
}

export interface ManagedPluginCreateRequest {
  readonly displayName: string;
  readonly description: string;
  readonly transport: McpServerTransport;
}

export interface ManagedPluginCreateResponse {
  readonly cwd: string;
  readonly plugin: ManagedPluginView;
}

export interface ManagedPluginDetailResponse {
  readonly plugin: ManagedPluginView;
}

export interface ManagedPluginMutationResponse {
  readonly plugin: ManagedPluginView;
}

export interface ManagedPluginCheckResponse {
  readonly plugin: ManagedPluginView;
  readonly health: ManagedPluginHealthSnapshot;
}

export interface ManagedPluginApplyPresetRequest {
  readonly options?: Record<string, unknown>;
}

export interface ManagedPluginConnectRequest {
  readonly command?: string;
}

export interface ManagedPluginConnectResponse {
  readonly plugin: ManagedPluginView;
  readonly linkedMcpServer?: McpServer;
}

export interface ManagedPluginDisableRequest {
  readonly reason?: string;
}

export interface ManagedPluginApplyPresetResponse {
  readonly plugin: ManagedPluginView;
  readonly linkedMcpServer?: McpServer;
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
}

export interface ManagedPluginInstallRequest {
  readonly options?: Record<string, unknown>;
}

export interface ManagedPluginInstallResponse {
  readonly plugin: ManagedPluginView;
  readonly package: ManagedPluginPackageView;
}

export interface ManagedPluginUninstallRequest {
  readonly reason?: string;
}

export interface ManagedPluginUninstallResponse {
  readonly plugin: ManagedPluginView;
  readonly package?: ManagedPluginPackageView;
}

export interface ManagedPluginRefreshPackageResponse {
  readonly plugin: ManagedPluginView;
  readonly package: ManagedPluginPackageView;
}

export interface ManagedPluginRuntimePreviewResponse {
  readonly cwd: string;
  readonly plugin: ManagedPluginView;
  readonly preview: ManagedPluginRuntimePreview;
}

export type LingPluginPackageSourceKind = "bundled" | "trusted-local";

export type LingPluginPackageTrustLevel = "internal" | "internal-isolated" | "trusted-local-preset";

export type LingPluginPackageContributionKind = "mcp-server" | "skill-pack" | "runner" | "provider" | "ui-feature";

export interface LingPluginPackageContribution {
  readonly kind: LingPluginPackageContributionKind;
  readonly id: string;
  readonly path: string;
}

export interface LingPluginPackageSecretRequirement {
  readonly ref: string;
  readonly label: string;
  readonly purpose?: string;
  readonly required?: boolean;
}

export interface LingPluginPackageApprovalDefault {
  readonly contributionId: string;
  readonly decision: ManagedPluginDefaultApproval;
  readonly reason?: string;
}

export interface LingPluginPackageHealthCheck {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

export interface LingPluginPackageManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly lingInterfaceVersion: string;
  readonly sourceKind: LingPluginPackageSourceKind;
  readonly trustLevel: LingPluginPackageTrustLevel;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly platforms?: readonly ("darwin" | "linux" | "win32")[];
  readonly contributions: readonly LingPluginPackageContribution[];
  readonly requiredSecrets?: readonly LingPluginPackageSecretRequirement[];
  readonly defaultApprovals?: readonly LingPluginPackageApprovalDefault[];
  readonly healthChecks?: readonly LingPluginPackageHealthCheck[];
}

export interface PluginPackageValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly contributionId?: string;
}

export type PluginPackageValidationMessage = string | PluginPackageValidationIssue;

export interface PluginPackageValidationResult {
  readonly ok: boolean;
  readonly errors: readonly PluginPackageValidationMessage[];
  readonly warnings: readonly PluginPackageValidationMessage[];
  readonly compiledDescriptor?: ManagedPluginDescriptorDto;
}

export interface ManagedPluginContributionDescriptorDto {
  readonly kind: ManagedPluginContributionKind;
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly sideEffectLevel?: ManagedPluginSideEffectLevel;
  readonly defaultApproval?: ManagedPluginDefaultApproval;
}

export interface ManagedPluginHealthCheckDto {
  readonly id: string;
  readonly label: string;
  readonly kind: "descriptor" | "binary" | "mcp";
}

export interface ManagedPluginDescriptorDto {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly contributions: readonly ManagedPluginContributionDescriptorDto[];
  readonly requiredSecrets?: readonly ManagedPluginSecretRequirement[];
  readonly defaultApprovals?: readonly ManagedPluginApprovalDefault[];
  readonly healthChecks?: readonly ManagedPluginHealthCheckDto[];
  readonly defaultEnabled?: boolean;
}

export interface PluginSourceView {
  readonly id: string;
  readonly sourceKind: "bundled";
  readonly displayName: string;
  readonly pluginCount: number;
  readonly pluginIds: readonly string[];
}

export interface PluginPackageView {
  readonly id: string;
  readonly sourceKind?: LingPluginPackageSourceKind;
  readonly manifest?: LingPluginPackageManifest;
}

export interface PluginSourceListResponse {
  readonly cwd: string;
  readonly sources: readonly PluginSourceView[];
}

export interface PluginPackageDetailResponse {
  readonly cwd: string;
  readonly package: PluginPackageView;
  readonly validation: PluginPackageValidationResult;
}

export interface PluginPackageValidationResponse {
  readonly cwd?: string;
  readonly package?: PluginPackageView;
  readonly plugin?: ManagedPluginView;
  readonly validation: PluginPackageValidationResult;
}
