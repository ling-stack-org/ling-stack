/**
 * Cross-platform contracts for Ling's Desktop-owned Cua Driver distribution.
 *
 * These types deliberately keep distribution, Windows integrity coverage and
 * Windows signing tier as independent axes. Runtime code must derive signing
 * identity from the installed artifact; candidate metadata is never an
 * authority to promote a build.
 */

export const CUA_DRIVER_SETUP_SCHEMA_VERSION = 2 as const;
export const CUA_DRIVER_PROVIDER_LOCK_SCHEMA_VERSION = 2 as const;
export const DESKTOP_CUA_DRIVER_LEASE_SCHEMA_VERSION = 1 as const;
export const CUA_DRIVER_PROVIDER_VERSION = "0.8.3" as const;
export const CUA_DRIVER_DISTRIBUTION_REVISION = "ling.1" as const;

export const CUA_DRIVER_PROVIDER_STATES = [
  "included",
  "desktop_unavailable",
  "permission_required",
  "interactive_session_required",
  "platform_unavailable",
  "ready",
  "incompatible",
  "corrupt",
  "external_missing",
  "external_detected",
  "external_connected",
  "unsupported",
] as const;

export type CuaDriverDistribution = "bundled_embedded" | "external_local";
export type CuaDriverPlatform = "darwin" | "win32" | "unsupported";
export type BundledCuaDriverPlatform = Exclude<CuaDriverPlatform, "unsupported">;
export type BundledCuaDriverResourcePlatform = "darwin" | "win32-x64";
export type CuaDriverArchitecture = "arm64" | "x86_64";
export type CuaDriverProviderState = (typeof CUA_DRIVER_PROVIDER_STATES)[number];
export type CuaDriverIntegrityCoverage = "standard" | "uiaccess";
export type CuaDriverLimitation = "elevated_pixel_input" | "uwp_send_input";
export type CuaDriverIntegrityStatus = "verified" | "failed" | "unknown";
export type CuaDriverBridgeStatus = "available" | "missing" | "incompatible";

export type LegacyManagedPluginSetupState =
  | "detected"
  | "missing"
  | "unsupported"
  | "connected"
  | "ready";

export interface CuaDriverPermissionSnapshot {
  readonly accessibility: "granted" | "denied" | "prompt" | "unknown";
  readonly screenRecording: "granted" | "denied" | "prompt" | "unknown";
  readonly capturable?: boolean;
}

export interface CuaDriverWindowsReadinessSnapshot {
  readonly interactiveSession: "ready" | "session_zero" | "locked" | "unknown";
  readonly wgcApi: "supported" | "unsupported" | "unavailable" | "unknown";
  readonly d3d11: "available" | "unavailable" | "unknown";
  readonly uiaRuntime: "available" | "unavailable" | "unknown";
  readonly contentObserved: false;
  readonly integrityCoverage: CuaDriverIntegrityCoverage | "unknown";
  readonly uiaHelper: "not_required" | "ready" | "unavailable" | "invalid";
}

export interface CuaDriverExternalOverride {
  readonly command: string;
  readonly explicit: true;
}

export function isCuaDriverProviderState(value: unknown): value is CuaDriverProviderState {
  return typeof value === "string" && (CUA_DRIVER_PROVIDER_STATES as readonly string[]).includes(value);
}

/** Deterministic compatibility projection for pre-V2 Plugin Manager clients. */
export function legacySetupStateForCuaDriverProviderState(
  providerState: CuaDriverProviderState,
): LegacyManagedPluginSetupState {
  switch (providerState) {
    case "external_missing":
      return "missing";
    case "external_detected":
      return "detected";
    case "ready":
      return "ready";
    case "unsupported":
      return "unsupported";
    default:
      return "connected";
  }
}

export interface CuaDriverFeatureFlags {
  /** Daemon-side opt-in. It cannot enable a provider the Desktop did not package. */
  readonly bundledEmbedded: {
    readonly darwin: boolean;
    readonly win32: boolean;
  };
  /** Desktop-owned compile/package assertion for validated provider resources. */
  readonly packagedProvider?: {
    readonly darwin: boolean;
    readonly win32: boolean;
  };
}

export const DEFAULT_CUA_DRIVER_FEATURE_FLAGS: CuaDriverFeatureFlags = Object.freeze({
  bundledEmbedded: Object.freeze({
    darwin: false,
    win32: false,
  }),
  packagedProvider: Object.freeze({
    darwin: false,
    win32: false,
  }),
});

export function isBundledEmbeddedCuaDriverEnabled(
  flags: CuaDriverFeatureFlags,
  platform: string,
): boolean {
  const packagedProvider = flags.packagedProvider ?? { darwin: false, win32: false };
  return platform === "darwin"
    ? flags.bundledEmbedded.darwin && packagedProvider.darwin
    : platform === "win32"
      ? flags.bundledEmbedded.win32 && packagedProvider.win32
      : false;
}

export type WindowsSigningTier =
  | "unsigned_dev"
  | "test_signed_internal"
  | "production_signed";

export type WindowsDistributionChannel = "development" | "internal" | "production";
export type WindowsTestAuthorityKind = "ephemeral-ci" | "managed-internal";
export type WindowsPromotionStatus =
  | "BLOCKED"
  | "MANUAL_REVIEW_REQUIRED"
  | "INTERNAL_TEST_PASS"
  | "RELEASE_PASS";
export type WindowsVerdictCeiling = "DEVELOPMENT_ONLY" | "INTERNAL_TEST_PASS" | "RELEASE_PASS";
export type CuaDriverPromotionStatus = WindowsPromotionStatus;
export type CuaDriverSigningTier = WindowsSigningTier;
export type CuaDriverDistributionChannel = WindowsDistributionChannel;

interface WindowsSigningPromotionCommon {
  readonly signingTier: WindowsSigningTier;
  readonly distributionChannel: WindowsDistributionChannel;
  readonly productionEligible: boolean;
  readonly verdictCeiling: WindowsVerdictCeiling;
  readonly promotionStatus: WindowsPromotionStatus;
  readonly releaseReady: boolean;
}

export type WindowsSigningPromotionContract =
  | (WindowsSigningPromotionCommon & {
      readonly signingTier: "unsigned_dev";
      readonly distributionChannel: "development";
      readonly productionEligible: false;
      readonly verdictCeiling: "DEVELOPMENT_ONLY";
      readonly promotionStatus: "BLOCKED" | "MANUAL_REVIEW_REQUIRED";
      readonly releaseReady: false;
    })
  | (WindowsSigningPromotionCommon & {
      readonly signingTier: "test_signed_internal";
      readonly distributionChannel: "internal";
      readonly productionEligible: false;
      readonly testAuthorityKind: WindowsTestAuthorityKind;
      readonly verdictCeiling: "INTERNAL_TEST_PASS";
      readonly promotionStatus: "BLOCKED" | "MANUAL_REVIEW_REQUIRED" | "INTERNAL_TEST_PASS";
      readonly releaseReady: false;
    })
  | (WindowsSigningPromotionCommon & {
      readonly signingTier: "production_signed";
      readonly distributionChannel: "production";
      readonly productionEligible: true;
      readonly verdictCeiling: "RELEASE_PASS";
      readonly promotionStatus: "BLOCKED" | "MANUAL_REVIEW_REQUIRED";
      readonly releaseReady: false;
    })
  | (WindowsSigningPromotionCommon & {
      readonly signingTier: "production_signed";
      readonly distributionChannel: "production";
      readonly productionEligible: true;
      readonly verdictCeiling: "RELEASE_PASS";
      readonly promotionStatus: "RELEASE_PASS";
      readonly releaseReady: true;
    });
export type WindowsSigningTuple = WindowsSigningPromotionContract;

export function windowsVerdictCeilingForSigningTier(
  signingTier: WindowsSigningTier,
): WindowsVerdictCeiling {
  switch (signingTier) {
    case "unsigned_dev":
      return "DEVELOPMENT_ONLY";
    case "test_signed_internal":
      return "INTERNAL_TEST_PASS";
    case "production_signed":
      return "RELEASE_PASS";
  }
}

/**
 * Runtime guard for release-evidence producers. It rejects tier/channel
 * mismatches and makes releaseReady=true impossible outside RELEASE_PASS.
 */
export function isWindowsSigningPromotionContract(
  value: unknown,
): value is WindowsSigningPromotionContract {
  if (!isUnknownRecord(value)) {
    return false;
  }
  const commonStatus = value.promotionStatus === "BLOCKED"
    || value.promotionStatus === "MANUAL_REVIEW_REQUIRED";
  if (value.signingTier === "unsigned_dev") {
    return value.distributionChannel === "development"
      && value.productionEligible === false
      && value.verdictCeiling === "DEVELOPMENT_ONLY"
      && commonStatus
      && value.releaseReady === false;
  }
  if (value.signingTier === "test_signed_internal") {
    return value.distributionChannel === "internal"
      && value.productionEligible === false
      && (value.testAuthorityKind === "ephemeral-ci" || value.testAuthorityKind === "managed-internal")
      && value.verdictCeiling === "INTERNAL_TEST_PASS"
      && (commonStatus || value.promotionStatus === "INTERNAL_TEST_PASS")
      && value.releaseReady === false;
  }
  if (value.signingTier === "production_signed") {
    return value.distributionChannel === "production"
      && value.productionEligible === true
      && value.verdictCeiling === "RELEASE_PASS"
      && (
        (commonStatus && value.releaseReady === false)
        || (value.promotionStatus === "RELEASE_PASS" && value.releaseReady === true)
      );
  }
  return false;
}

export interface WindowsUnsignedPeIdentity {
  readonly relativePath: string;
  readonly sha256: string;
  readonly architecture: "x86_64";
  readonly peManifestCanonicalSha256: string;
  readonly authenticodeStatus: "NotSigned";
}

export interface WindowsSignedPeIdentity {
  readonly relativePath: string;
  readonly sha256: string;
  readonly architecture: "x86_64";
  readonly peManifestCanonicalSha256: string;
  readonly authenticodeStatus: "Valid";
  readonly signerSubject: string;
  readonly certificateSha256: string;
  readonly timestampPolicy: "internal-policy" | "rfc3161-required";
  readonly timestampStatus: "NotRequired" | "Valid";
}

export interface WindowsInternalSignedPeIdentity extends WindowsSignedPeIdentity {
  readonly timestampPolicy: "internal-policy";
}

export interface WindowsProductionSignedPeIdentity extends WindowsSignedPeIdentity {
  readonly timestampPolicy: "rfc3161-required";
  readonly timestampStatus: "Valid";
}

export interface WindowsBundledProviderSealCommonV2 {
  readonly schemaVersion: 2;
  readonly componentId: "cua-driver-win32-x64";
  readonly lockSha256: string;
  readonly distributionRevision: "ling.1";
  readonly providerVersion: "0.8.3";
  readonly serverInitializeProtocolVersion: "2025-06-18";
  readonly healthSchemaVersion: "1";
  readonly toolsListCanonicalSha256: string;
  readonly stateSchemaVersion: 1;
  readonly limitations: readonly ["elevated_pixel_input", "uwp_send_input"];
}

export type WindowsBundledProviderSealV2 =
  | (WindowsBundledProviderSealCommonV2 & {
      readonly signingTier: "unsigned_dev";
      readonly distributionChannel: "development";
      readonly productionEligible: false;
      readonly main: WindowsUnsignedPeIdentity;
      readonly integrityCatalogRelativePath: null;
    })
  | (WindowsBundledProviderSealCommonV2 & {
      readonly signingTier: "test_signed_internal";
      readonly distributionChannel: "internal";
      readonly productionEligible: false;
      readonly testAuthorityKind: WindowsTestAuthorityKind;
      readonly main: WindowsInternalSignedPeIdentity;
      readonly integrityCatalogRelativePath: "provider-integrity.cat";
    })
  | (WindowsBundledProviderSealCommonV2 & {
      readonly signingTier: "production_signed";
      readonly distributionChannel: "production";
      readonly productionEligible: true;
      readonly main: WindowsProductionSignedPeIdentity;
      readonly integrityCatalogRelativePath: "provider-integrity.cat";
    });

export interface WindowsBundledIntegrityCatalogEvidenceCommonV2 {
  readonly catalogRelativePath: "provider-integrity.cat";
  readonly authenticodeStatus: "Valid";
  readonly signerSubject: string;
  readonly certificateSha256: string;
  readonly members: readonly {
    readonly relativePath: string;
    readonly sha256: string;
  }[];
}

export type WindowsBundledIntegrityCatalogEvidenceV2 =
  | (WindowsBundledIntegrityCatalogEvidenceCommonV2 & {
      readonly signingTier: "test_signed_internal";
      readonly distributionChannel: "internal";
      readonly timestampPolicy: "internal-policy";
      readonly timestampStatus: "NotRequired" | "Valid";
    })
  | (WindowsBundledIntegrityCatalogEvidenceCommonV2 & {
      readonly signingTier: "production_signed";
      readonly distributionChannel: "production";
      readonly timestampPolicy: "rfc3161-required";
      readonly timestampStatus: "Valid";
    });

export interface DarwinBundledProviderSealV1 {
  readonly schemaVersion: 1;
  readonly componentId: "cua-driver-darwin";
  readonly lockSha256: string;
  readonly distributionRevision: "ling.1";
  readonly executableRelativePath: "cua-driver";
  readonly executableSha256: string;
  readonly architectures: readonly ["arm64", "x86_64"];
  readonly cdhashes: {
    readonly arm64: string;
    readonly x86_64: string;
  };
  readonly codeIdentifier: string;
  readonly teamId: string;
  readonly designatedRequirement: string;
  readonly designatedRequirementSha256: string;
  readonly hardenedRuntime: true;
  readonly entitlementsCanonicalSha256: string;
  readonly providerVersion: "0.8.3";
  readonly serverInitializeProtocolVersion: "2025-06-18";
  readonly healthSchemaVersion: "1";
  readonly toolsListCanonicalSha256: string;
  readonly stateSchemaVersion: 1;
}

export type BundledCuaDriverProviderSeal = DarwinBundledProviderSealV1 | WindowsBundledProviderSealV2;

export interface BundledCuaDriverUpstreamV1 {
  readonly repository: "https://github.com/trycua/cua";
  readonly tag: "cua-driver-rs-v0.8.3";
  readonly commit: "0612c26b2c7b8556f6de7f6b4f3927ecac914e4f";
  readonly tree: "831819eaf2b79c4d81c2b68773cd5920772e91e9";
  readonly version: "0.8.3";
  readonly releaseStage: "prerelease";
  readonly license: "MIT";
  readonly licenseSha256: string;
}

export interface LingManagedEmbeddedPatchSetV1 {
  readonly id: "ling-managed-embedded-v1";
  readonly sha256: string;
  readonly patches: readonly [
    { readonly id: "ling-embedded-state-home-v1"; readonly sha256: string },
    { readonly id: "ling-managed-readiness-v1"; readonly sha256: string },
    { readonly id: "ling-managed-lifetime-v1"; readonly sha256: string },
    { readonly id: "ling-windows-capability-errors-v1"; readonly sha256: string },
  ];
  readonly touchedPaths: readonly string[];
}

export interface DarwinBundledCuaDriverLockV1 {
  readonly schemaVersion: 1;
  readonly componentId: "cua-driver-darwin";
  readonly integrationMode: "embedded-stdio";
  readonly distributionRevision: "ling.1";
  readonly productVersionLabel: "0.8.3 (Ling build 1)";
  readonly referenceReleaseArtifact: {
    readonly filename: "cua-driver-rs-0.8.3-darwin-universal-binary.tar.gz";
    readonly sizeBytes: 15320898;
    readonly sha256: "a2a29f3ccbd45989819df639d60fa68ac6f28b844f74d7d2b0a1495e4359c6a1";
    readonly binaryArchivePath: "cua-driver";
    readonly teamId: "YCK386LBJ7";
    readonly authority: "Developer ID Application: Cua AI, Inc. (YCK386LBJ7)";
    readonly hardenedRuntime: true;
    readonly entitlementsCanonicalSha256: string;
  };
  readonly sourceBuild: {
    readonly cargoLockSha256: string;
    readonly rustcVersion: string;
    readonly cargoVersion: string;
    readonly xcodeBuildVersion: string;
    readonly macOSSDKVersion: string;
    readonly targets: readonly ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    readonly patchSet: LingManagedEmbeddedPatchSetV1;
    readonly universalBinarySha256BeforeSigning: string;
  };
  readonly binary: {
    readonly architectures: readonly ["arm64", "x86_64"];
    readonly minimumMacOS: "13.0";
    readonly supportedMacOSCells: readonly {
      readonly major: "13" | "14" | "15" | "26";
      readonly architectures: readonly ("arm64" | "x86_64")[];
    }[];
    readonly expectedUpstreamVersion: "0.8.3";
    readonly lingBuild: 1;
    readonly hardenedRuntime: true;
    readonly requiredEntitlements: {
      readonly "com.apple.security.automation.apple-events": true;
      readonly "com.apple.security.device.screen-capture": true;
    };
    readonly requiredEntitlementsCanonicalSha256: string;
  };
  readonly runtime: {
    readonly args: readonly ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"];
    readonly stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME";
    readonly stateSchemaVersion: 1;
    readonly stateHomeRequiredInEmbeddedMode: true;
    readonly telemetryEnabled: false;
    readonly startupUpdateCheckEnabled: false;
    readonly managedUpdaterToolsAllowed: false;
  };
  readonly compatibility: BundledCuaDriverCompatibilityV1 & {
    readonly embeddedHealthSkipChecks: readonly ["bundle_identity"];
  };
}

export interface WindowsBundledCuaDriverLockV1 {
  readonly schemaVersion: 1;
  readonly componentId: "cua-driver-win32-x64";
  readonly integrationMode: "embedded-stdio";
  readonly distributionRevision: "ling.1";
  readonly productVersionLabel: "0.8.3 (Ling build 1)";
  readonly referenceReleaseArtifact: {
    readonly filename: "cua-driver-rs-0.8.3-windows-x86_64.zip";
    readonly sizeBytes: 10585087;
    readonly sha256: "6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0";
    readonly binaries: {
      readonly "cua-driver.exe": { readonly sha256: string };
      readonly "cua-driver-uia.exe": { readonly sha256: string };
    };
    readonly authenticodeStatus: "unsigned-reference";
  };
  readonly sourceBuild: {
    readonly cargoLockSha256: string;
    readonly rustcVersion: string;
    readonly cargoVersion: string;
    readonly windowsSdkVersion: string;
    readonly msvcToolsetVersion: string;
    readonly target: "x86_64-pc-windows-msvc";
    readonly patchSet: LingManagedEmbeddedPatchSetV1;
    readonly binariesSha256BeforeSigning: {
      readonly main: string;
      readonly uiaAuditArtifact: string;
    };
  };
  readonly binary: {
    readonly architecture: "x86_64";
    readonly expectedUpstreamVersion: "0.8.3";
    readonly lingBuild: 1;
    readonly mainRelativePath: "payload/cua-driver.exe";
    readonly providerSealRelativePath: "payload/provider-seal.json";
    readonly mainManifestCanonicalSha256: string;
    readonly integrityCatalogRelativePathBySigningTier: {
      readonly unsigned_dev: null;
      readonly test_signed_internal: "provider-integrity.cat";
      readonly production_signed: "provider-integrity.cat";
    };
    readonly packagedFilesBySigningTier: {
      readonly unsigned_dev: readonly ["payload/cua-driver.exe", "payload/provider-seal.json"];
      readonly test_signed_internal: readonly ["provider-integrity.cat", "payload/cua-driver.exe", "payload/provider-seal.json"];
      readonly production_signed: readonly ["provider-integrity.cat", "payload/cua-driver.exe", "payload/provider-seal.json"];
    };
    readonly uiaAuditArtifact: {
      readonly packaged: false;
      readonly relativeBuildOutput: "cua-driver-uia.exe";
      readonly manifestCanonicalSha256: string;
      readonly requestedExecutionLevel: "asInvoker";
      readonly uiAccess: true;
    };
  };
  readonly runtime: {
    readonly args: readonly ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"];
    readonly requiredSession: "interactive-user";
    readonly rejectSessionZero: true;
    readonly stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME";
    readonly stateSchemaVersion: 1;
    readonly telemetryEnabled: false;
    readonly startupUpdateCheckEnabled: false;
    readonly managedUpdaterToolsAllowed: false;
    readonly defaultIntegrityCoverage: "standard";
    readonly managedReadinessMethod: "ling/managed_readiness";
    readonly managedReadinessChangedNotification: "ling/managed_readiness_changed";
    readonly childInstanceNonceEnvironmentVariable: "CUA_DRIVER_CHILD_INSTANCE_NONCE";
    readonly leaseGenerationEnvironmentVariable: "CUA_DRIVER_LEASE_GENERATION";
    readonly readinessHeartbeatMs: 1000;
    readonly requiredHostIntegrityLevel: "medium";
    readonly requiredProviderIntegrityLevel: "medium";
    readonly killOnJobCloseRequired: true;
    readonly limitations: readonly ["elevated_pixel_input", "uwp_send_input"];
    readonly uiaHelperActivation: "not-packaged-until-secure-path-contract";
  };
  readonly compatibility: BundledCuaDriverCompatibilityV1;
}

export interface BundledCuaDriverCompatibilityV1 {
  readonly mcpClientSdk: "@modelcontextprotocol/sdk@1.29.0";
  readonly clientInitializeProtocolVersion: "2025-11-25";
  readonly serverInitializeProtocolVersion: "2025-06-18";
  readonly healthSchemaVersion: "1";
  readonly toolsListSha256: string;
}

export interface BundledCuaDriverDistributionLockV2 {
  readonly schemaVersion: 2;
  readonly componentId: "cua-driver";
  readonly distributionRevision: "ling.1";
  readonly upstream: BundledCuaDriverUpstreamV1;
  readonly enabledPlatforms: readonly BundledCuaDriverResourcePlatform[];
  readonly platforms: {
    readonly darwin?: DarwinBundledCuaDriverLockV1;
    readonly win32X64?: WindowsBundledCuaDriverLockV1;
  };
}

export interface DesktopCuaDriverLeaseV1 {
  readonly schemaVersion: 1;
  readonly providerId: "cua-driver";
  readonly desktopInstanceId: string;
  readonly desktopInstanceEpoch: number;
  readonly bridgeConnectionId: string;
  readonly generation: number;
  readonly daemonAuthorityEpoch: string;
  readonly workspaceCwd: string;
  readonly endpoint: string;
  readonly providerVersion: "0.8.3";
  readonly distributionRevision: "ling.1";
  readonly integrationMode: "embedded-stdio";
  readonly expiresAt: string;
  readonly lockDigest: string;
  readonly providerSealDigest: string;
  readonly providerCatalogDigest?: string;
  readonly platform: BundledCuaDriverPlatform;
  readonly architecture: CuaDriverArchitecture;
  readonly integrityCoverage?: CuaDriverIntegrityCoverage;
}

/** Compatibility alias used by the detailed design and later daemon slices. */
export type DesktopCuaDriverLease = DesktopCuaDriverLeaseV1;

export function isDesktopCuaDriverLeaseV1(value: unknown): value is DesktopCuaDriverLeaseV1 {
  if (!isUnknownRecord(value)) {
    return false;
  }
  const platformArchitectureValid = value.platform === "darwin"
    ? value.architecture === "arm64" || value.architecture === "x86_64"
    : value.platform === "win32" && value.architecture === "x86_64";
  return value.schemaVersion === 1
    && value.providerId === "cua-driver"
    && hasText(value.desktopInstanceId)
    && isPositiveSafeInteger(value.desktopInstanceEpoch)
    && hasText(value.bridgeConnectionId)
    && isPositiveSafeInteger(value.generation)
    && hasText(value.daemonAuthorityEpoch)
    && hasText(value.workspaceCwd)
    && isLoopbackHttpEndpoint(value.endpoint)
    && value.providerVersion === "0.8.3"
    && value.distributionRevision === "ling.1"
    && value.integrationMode === "embedded-stdio"
    && isDateTime(value.expiresAt)
    && isSha256(value.lockDigest)
    && isSha256(value.providerSealDigest)
    && (value.providerCatalogDigest === undefined || isSha256(value.providerCatalogDigest))
    && platformArchitectureValid
    && (
      value.integrityCoverage === undefined
      || value.integrityCoverage === "standard"
      || value.integrityCoverage === "uiaccess"
    );
}

export interface DesktopCuaDriverLeaseRevokeV1 {
  readonly schemaVersion: 1;
  readonly providerId: "cua-driver";
  readonly desktopInstanceId: string;
  readonly desktopInstanceEpoch: number;
  readonly bridgeConnectionId: string;
  readonly generation: number;
  readonly daemonAuthorityEpoch: string;
  readonly workspaceCwd: string;
}

export interface CuaDriverActivationFenceV1 {
  readonly schemaVersion: 1;
  readonly desktopInstanceId: string;
  readonly desktopInstanceEpoch: number;
  readonly bridgeConnectionId: string;
  readonly daemonAuthorityEpoch: string;
  readonly leaseGeneration: number;
  readonly lockDigest: string;
  readonly providerSealDigest: string;
  readonly providerCatalogDigest?: string;
  readonly activationEpoch: number;
  readonly requestedRevision: number;
}

export interface WindowsManagedPreflightV1 {
  readonly schemaVersion: 1;
  readonly evidenceOnly: true;
  readonly diagnosticProcessId: number;
  readonly diagnosticSessionId: number;
  readonly diagnosticIntegrityLevel: WindowsProcessIntegrityLevel;
  readonly inputDesktop: WindowsInputDesktopState;
  readonly jobObjectApiAvailable: boolean;
  readonly uiaRuntime: "available" | "unavailable";
  readonly d3d11: "available" | "unavailable";
  readonly wgcApi: "supported" | "unsupported" | "unavailable";
  readonly contentObserved: false;
}

export interface WindowsManagedReadinessRequestV1 {
  readonly schemaVersion: 1;
  readonly childInstanceNonce: string;
  readonly leaseGeneration: number;
}

export interface WindowsManagedReadinessV1 {
  readonly schemaVersion: 1;
  readonly childInstanceNonce: string;
  readonly leaseGeneration: number;
  readonly readinessSequence: number;
  readonly hostProcessId: number;
  readonly hostSessionId: number;
  readonly hostIntegrityLevel: WindowsProcessIntegrityLevel;
  readonly providerProcessId: number;
  readonly providerSessionId: number;
  readonly providerIntegrityLevel: WindowsProcessIntegrityLevel;
  readonly inputDesktop: WindowsInputDesktopState;
  readonly jobObjectAssigned: boolean;
  readonly killOnJobClose: boolean;
  readonly uiaRuntime: "available" | "unavailable";
  readonly d3d11: "available" | "unavailable";
  readonly wgcApi: "supported" | "unsupported" | "unavailable";
  readonly contentObserved: false;
}

export interface WindowsManagedReadinessChangedV1 extends WindowsManagedReadinessV1 {
  readonly reason:
    | "lock"
    | "unlock"
    | "disconnect"
    | "logoff"
    | "fast_user_switch"
    | "session_mismatch"
    | "input_desktop_changed"
    | "heartbeat";
}

export type WindowsProcessIntegrityLevel = "medium" | "high" | "system" | "unknown";
export type WindowsInputDesktopState = "default_unlocked" | "locked" | "non_default" | "unavailable";

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isLoopbackHttpEndpoint(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      && url.pathname === "/mcp"
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}
