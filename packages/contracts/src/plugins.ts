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
import type {
  ChromeBrowserExtensionState,
  ChromeBrowserHostState,
  ChromeBrowserSetupState,
  ChromeBrowserTransportKind,
} from "./chrome-browser.js";
import type {
  OfficeDocumentsSetupState,
  OfficeDriverCapability,
  OfficeDriverPlatform,
} from "./office-documents.js";

export type ManagedPluginSourceKind = "built-in" | "bundled" | "official-remote" | "trusted-local-preset";

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
  readonly transport?: ChromeBrowserTransportKind;
  readonly hostState?: ChromeBrowserHostState;
  readonly extensionState?: ChromeBrowserExtensionState;
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
  readonly hostState: ChromeBrowserHostState;
  readonly extensionState: ChromeBrowserExtensionState;
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
  readonly artifactId?: string;
  readonly platform?: "darwin" | "linux" | "win32";
  readonly arch?: "arm64" | "x64" | "ia32" | "universal";
  readonly sourceUrl?: string;
  readonly catalogVersion?: string;
  readonly previousVersion?: string;
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
  readonly license?: string;
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
    readonly canCheckUpdate?: boolean;
    readonly canApplyPreset: boolean;
    readonly canInstall: boolean;
    readonly canInstallRemote?: boolean;
    readonly canUninstall: boolean;
    readonly canRefreshPackage: boolean;
    readonly canRollback?: boolean;
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

export type ManagedPluginImportSource =
  | "codex-config-toml"
  | "claude-user-json"
  | "claude-plugin-mcp"
  | "dsh-cordis-patch"
  | "claude-commands";

export interface ManagedPluginImportSecretView {
  readonly field: string;
  readonly masked: string;
  readonly needsInput: boolean;
}

export interface ManagedPluginImportCandidate {
  readonly kind: "mcp";
  readonly source: ManagedPluginImportSource;
  readonly name: string;
  readonly displayName: string;
  readonly transportSummary: string;
  readonly status: "new" | "unchanged" | "conflict";
  readonly secrets: readonly ManagedPluginImportSecretView[];
  readonly warnings: readonly string[];
}

export interface ManagedPluginImportCommandCandidate {
  readonly kind: "command";
  readonly source: ManagedPluginImportSource;
  readonly name: string;
  readonly displayName: string;
  readonly status: "new" | "unchanged" | "conflict";
  readonly inlineExecutions: readonly string[];
  readonly warnings: readonly string[];
}

export type ManagedPluginImportPreviewCandidate =
  | ManagedPluginImportCandidate
  | ManagedPluginImportCommandCandidate;

export interface ManagedPluginImportPreviewRequest {
  readonly source: ManagedPluginImportSource;
}

export interface ManagedPluginImportPreviewResponse {
  readonly cwd: string;
  readonly source: ManagedPluginImportSource;
  readonly sourceFound: boolean;
  readonly candidates: readonly ManagedPluginImportPreviewCandidate[];
  readonly warnings: readonly string[];
}

export interface ManagedPluginImportApplyRequest {
  readonly source: ManagedPluginImportSource;
  readonly names: readonly string[];
}

export interface ManagedPluginImportedMcpEntry {
  readonly name: string;
  readonly pluginId: string;
  readonly mcpServerId: string;
  readonly check: "ready" | "failed" | "unknown";
  readonly checkMessage?: string;
}

export interface ManagedPluginImportedCommandEntry {
  readonly name: string;
  readonly draftId: string;
  readonly skillId: string;
}

export type ManagedPluginImportedEntry =
  | ManagedPluginImportedMcpEntry
  | ManagedPluginImportedCommandEntry;

export interface ManagedPluginImportSkippedEntry {
  readonly name: string;
  readonly reason: "unchanged" | "unknown_name";
}

export interface ManagedPluginImportApplyResponse {
  readonly cwd: string;
  readonly source: ManagedPluginImportSource;
  readonly imported: readonly ManagedPluginImportedEntry[];
  readonly skipped: readonly ManagedPluginImportSkippedEntry[];
  readonly secretsMigrated: number;
  readonly secretsNeedsInput: number;
  readonly degradations: readonly string[];
  readonly warnings: readonly string[];
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

export interface ManagedPluginRemoteInstallRequest {
  readonly version?: string;
  readonly channel?: "stable" | "beta" | "dev";
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

export interface ManagedPluginRollbackResponse {
  readonly plugin: ManagedPluginView;
  readonly package: ManagedPluginPackageView;
}

export interface ManagedPluginUpdateCheckResponse {
  readonly cwd: string;
  readonly pluginId: string;
  readonly currentVersion?: string;
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
  readonly catalogUrl?: string;
  readonly signatureVerified: boolean;
  readonly artifact?: ManagedPluginArtifactView;
}

export interface ManagedPluginRuntimePreviewResponse {
  readonly cwd: string;
  readonly plugin: ManagedPluginView;
  readonly preview: ManagedPluginRuntimePreview;
}

export type LingPluginPackageSourceKind = "built-in" | "bundled" | "official-remote" | "trusted-local";

export type LingPluginPackageTrustLevel = "official" | "internal" | "internal-isolated" | "trusted-local-preset";

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
  readonly manifestVersion?: 1 | 2;
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
  readonly minLingVersion?: string;
  readonly maxLingVersion?: string;
  readonly rollbackAllowed?: boolean;
  readonly artifactId?: string;
  readonly platform?: "darwin" | "linux" | "win32";
  readonly arch?: "arm64" | "x64" | "ia32" | "universal";
  readonly rollbackMinLingVersion?: string;
}

export interface ManagedPluginArtifactView {
  readonly artifactId: string;
  readonly pluginId: string;
  readonly version: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64" | "ia32" | "universal";
  readonly channel: "stable" | "beta" | "dev";
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly signature?: string;
  readonly minLingVersion?: string;
  readonly maxLingVersion?: string;
}

export interface ManagedPluginCatalogEntryView {
  readonly pluginId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly license?: string;
  readonly trustSummary: string;
  readonly latestStableVersion: string;
  readonly manifest: {
    readonly contributions: readonly LingPluginPackageContribution[];
    readonly requiredSecrets?: readonly LingPluginPackageSecretRequirement[];
    readonly defaultApprovals?: readonly LingPluginPackageApprovalDefault[];
    readonly healthChecks?: readonly LingPluginPackageHealthCheck[];
  };
  readonly artifacts: readonly ManagedPluginArtifactView[];
}

export interface ManagedPluginCatalogView {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly source: { readonly repository: string; readonly releaseTag: string; readonly sourceSha?: string };
  readonly plugins: readonly ManagedPluginCatalogEntryView[];
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
  readonly sourceKind: "bundled" | "official-remote" | "trusted-local";
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

export interface ManagedPluginCatalogResponse {
  readonly cwd: string;
  readonly catalog: ManagedPluginCatalogView;
  readonly catalogUrl?: string;
  readonly signatureVerified: boolean;
  readonly nextCursor?: string;
  readonly pageSize?: number;
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
