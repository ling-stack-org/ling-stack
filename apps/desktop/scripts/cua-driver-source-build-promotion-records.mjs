import { verifyDistributionLockV2 } from "./cua-driver-source-build-lib.mjs";
import {
  canonicalJson,
  sha256Bytes,
} from "./cua-driver-signing/signing-contract.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PLATFORM_ORDER = Object.freeze(["darwin", "win32-x64"]);
const DARWIN_ENTITLEMENTS = Object.freeze({
  "com.apple.security.automation.apple-events": true,
  "com.apple.security.device.screen-capture": true,
});
const DARWIN_ENTITLEMENTS_SHA256 =
  "5c301f02f6b64d3feb13c1b0f29f4135174132b33a828b85264aee8b8a5ac7ac";
const DARWIN_CELLS = Object.freeze(["13", "14", "15", "26"]);

export class CuaDriverSourceBuildPromotionError extends Error {
  constructor(code, message) {
    super(`${code}:${message}`);
    this.name = "CuaDriverSourceBuildPromotionError";
    this.code = code;
  }
}

export function createPlatformRecord({ evidence, platform, sourceInputs }) {
  const normalizedPlatform = normalizePlatform(platform);
  const sourceBuild = evidence.promotion.sourceBuild;
  if (sourceBuild.rustcVersion !== sourceInputs.toolchain.rustcVersion
    || sourceBuild.cargoVersion !== sourceInputs.toolchain.cargoVersion
    || sourceBuild.cargoLockSha256 !== sourceInputs.upstreamBuild.cargoLockSha256) {
    fail("promotion_toolchain_binding_invalid", "promotion source build does not match committed toolchain inputs");
  }
  const patchSet = {
    id: sourceBuild.patchSet.id,
    sha256: sourceBuild.patchSet.sha256,
    patches: sourceBuild.patchSet.patches.map(({ id, sha256 }) => ({ id, sha256 })),
    touchedPaths: [...sourceBuild.patchSet.touchedPaths],
  };
  const compatibility = {
    mcpClientSdk: sourceInputs.compatibility.mcpClientSdk,
    clientInitializeProtocolVersion: sourceBuild.clientInitializeProtocolVersion,
    serverInitializeProtocolVersion: sourceBuild.serverInitializeProtocolVersion,
    healthSchemaVersion: sourceBuild.healthSchemaVersion,
    toolsListSha256: requireSha256(
      sourceBuild.toolsListCanonicalSha256,
      "promotion_tools_digest_invalid",
    ),
  };
  if (normalizedPlatform === "darwin") {
    const reference = sourceInputs.referenceArtifacts.darwin;
    const mainDigest = requireSha256(
      sourceBuild.binariesSha256BeforeSigning?.main,
      "promotion_darwin_binary_digest_invalid",
    );
    assertDarwinBinaryIdentity(sourceBuild.binaryIdentity, sourceInputs.toolchain.darwin);
    const entitlementsSha256 = sha256Bytes(canonicalJson(DARWIN_ENTITLEMENTS));
    if (entitlementsSha256 !== DARWIN_ENTITLEMENTS_SHA256) {
      fail("promotion_entitlements_policy_invalid", "frozen Darwin entitlement digest changed");
    }
    return {
      schemaVersion: 1,
      componentId: "cua-driver-darwin",
      integrationMode: "embedded-stdio",
      distributionRevision: "ling.1",
      productVersionLabel: sourceInputs.productVersionLabel,
      referenceReleaseArtifact: {
        filename: reference.filename,
        sizeBytes: reference.sizeBytes,
        sha256: reference.sha256,
        binaryArchivePath: reference.member,
        teamId: reference.teamId,
        authority: reference.authority,
        hardenedRuntime: true,
        entitlementsCanonicalSha256: entitlementsSha256,
      },
      sourceBuild: {
        cargoLockSha256: sourceInputs.upstreamBuild.cargoLockSha256,
        rustcVersion: sourceBuild.rustcVersion,
        cargoVersion: sourceBuild.cargoVersion,
        xcodeBuildVersion: sourceInputs.toolchain.darwin.xcodeBuildVersion,
        macOSSDKVersion: sourceInputs.toolchain.darwin.macOSSDKVersion,
        targets: [...sourceInputs.toolchain.darwin.targets],
        patchSet,
        binarySha256BeforeSigning: mainDigest,
      },
      binary: {
        architectures: ["arm64"],
        minimumMacOS: sourceInputs.toolchain.darwin.deploymentTarget,
        supportedMacOSCells: DARWIN_CELLS.map((major) => ({
          major,
          architectures: ["arm64"],
        })),
        expectedUpstreamVersion: "0.8.3",
        lingBuild: 1,
        hardenedRuntime: true,
        requiredEntitlements: cloneJson(DARWIN_ENTITLEMENTS),
        requiredEntitlementsCanonicalSha256: entitlementsSha256,
      },
      runtime: {
        args: [...sourceInputs.runtime.args],
        stateHomeEnvironmentVariable: sourceInputs.runtime.stateHomeEnvironmentVariable,
        stateSchemaVersion: sourceInputs.runtime.stateSchemaVersion,
        stateHomeRequiredInEmbeddedMode: true,
        telemetryEnabled: sourceInputs.runtime.telemetryEnabled,
        startupUpdateCheckEnabled: sourceInputs.runtime.startupUpdateCheckEnabled,
        managedUpdaterToolsAllowed: sourceInputs.runtime.managedUpdaterToolsAllowed,
      },
      compatibility: {
        ...compatibility,
        embeddedHealthSkipChecks: ["bundle_identity"],
      },
    };
  }

  const reference = sourceInputs.referenceArtifacts.win32X64;
  const mainIdentity = findWindowsIdentity(sourceBuild.binaryIdentity, "main", false);
  const uiaIdentity = findWindowsIdentity(sourceBuild.binaryIdentity, "uia-audit", true);
  return {
    schemaVersion: 1,
    componentId: "cua-driver-win32-x64",
    integrationMode: "embedded-stdio",
    distributionRevision: "ling.1",
    productVersionLabel: sourceInputs.productVersionLabel,
    referenceReleaseArtifact: {
      filename: reference.filename,
      sizeBytes: reference.sizeBytes,
      sha256: reference.sha256,
      binaries: {
        "cua-driver.exe": { sha256: reference.mainSha256 },
        "cua-driver-uia.exe": { sha256: reference.uiaSha256 },
      },
      authenticodeStatus: "unsigned-reference",
    },
    sourceBuild: {
      cargoLockSha256: sourceInputs.upstreamBuild.cargoLockSha256,
      rustcVersion: sourceBuild.rustcVersion,
      cargoVersion: sourceBuild.cargoVersion,
      windowsSdkVersion: sourceInputs.toolchain.win32X64.windowsSdkVersion,
      msvcToolsetVersion: sourceInputs.toolchain.win32X64.msvcToolsetVersion,
      target: sourceInputs.toolchain.win32X64.target,
      patchSet,
      binariesSha256BeforeSigning: {
        main: requireSha256(
          sourceBuild.binariesSha256BeforeSigning?.main,
          "promotion_windows_main_digest_invalid",
        ),
        uiaAuditArtifact: requireSha256(
          sourceBuild.binariesSha256BeforeSigning?.["uia-audit"],
          "promotion_windows_uia_digest_invalid",
        ),
      },
    },
    binary: {
      architecture: "x86_64",
      expectedUpstreamVersion: "0.8.3",
      lingBuild: 1,
      mainRelativePath: "payload/cua-driver.exe",
      providerSealRelativePath: "payload/provider-seal.json",
      mainManifestCanonicalSha256: mainIdentity.manifest.sha256,
      integrityCatalogRelativePathBySigningTier: {
        unsigned_dev: null,
        test_signed_internal: "provider-integrity.cat",
        production_signed: "provider-integrity.cat",
      },
      packagedFilesBySigningTier: {
        unsigned_dev: ["payload/cua-driver.exe", "payload/provider-seal.json"],
        test_signed_internal: [
          "provider-integrity.cat",
          "payload/cua-driver.exe",
          "payload/provider-seal.json",
        ],
        production_signed: [
          "provider-integrity.cat",
          "payload/cua-driver.exe",
          "payload/provider-seal.json",
        ],
      },
      uiaAuditArtifact: {
        packaged: false,
        relativeBuildOutput: "cua-driver-uia.exe",
        manifestCanonicalSha256: uiaIdentity.manifest.sha256,
        requestedExecutionLevel: "asInvoker",
        uiAccess: true,
      },
    },
    runtime: {
      args: [...sourceInputs.runtime.args],
      requiredSession: "interactive-user",
      rejectSessionZero: true,
      stateHomeEnvironmentVariable: sourceInputs.runtime.stateHomeEnvironmentVariable,
      stateSchemaVersion: sourceInputs.runtime.stateSchemaVersion,
      telemetryEnabled: sourceInputs.runtime.telemetryEnabled,
      startupUpdateCheckEnabled: sourceInputs.runtime.startupUpdateCheckEnabled,
      managedUpdaterToolsAllowed: sourceInputs.runtime.managedUpdaterToolsAllowed,
      defaultIntegrityCoverage: sourceInputs.runtime.defaultIntegrityCoverage,
      managedReadinessMethod: sourceInputs.runtime.managedReadinessMethod,
      managedReadinessChangedNotification: sourceInputs.runtime.managedReadinessChangedNotification,
      childInstanceNonceEnvironmentVariable: sourceInputs.runtime.childInstanceNonceEnvironmentVariable,
      leaseGenerationEnvironmentVariable: sourceInputs.runtime.leaseGenerationEnvironmentVariable,
      readinessHeartbeatMs: sourceInputs.runtime.readinessHeartbeatMs,
      requiredHostIntegrityLevel: sourceInputs.runtime.requiredHostIntegrityLevel,
      requiredProviderIntegrityLevel: sourceInputs.runtime.requiredProviderIntegrityLevel,
      killOnJobCloseRequired: sourceInputs.runtime.killOnJobCloseRequired,
      limitations: [...sourceInputs.runtime.limitations],
      uiaHelperActivation: sourceInputs.runtime.uiaHelperActivation,
    },
    compatibility,
  };
}

export function createProposedProviderLock({ baseLock, platform, platformRecord }) {
  const normalizedPlatform = normalizePlatform(platform);
  const platformKey = normalizedPlatform === "darwin" ? "darwin" : "win32X64";
  if (baseLock.enabledPlatforms.includes(normalizedPlatform)
    || baseLock.platforms?.[platformKey] !== undefined) {
    fail(
      "platform_already_promoted",
      `${normalizedPlatform} already has a committed platform record; promotion cannot overwrite it`,
    );
  }
  const nextRecords = {
    ...(baseLock.platforms?.darwin ? { darwin: cloneJson(baseLock.platforms.darwin) } : {}),
    ...(normalizedPlatform === "darwin" ? { darwin: platformRecord } : {}),
    ...(baseLock.platforms?.win32X64 ? { win32X64: cloneJson(baseLock.platforms.win32X64) } : {}),
    ...(normalizedPlatform === "win32-x64" ? { win32X64: platformRecord } : {}),
  };
  const enabled = PLATFORM_ORDER.filter((value) =>
    baseLock.enabledPlatforms.includes(value) || value === normalizedPlatform);
  const proposed = {
    ...cloneJson(baseLock),
    enabledPlatforms: enabled,
    platforms: nextRecords,
  };
  verifyDistributionLockV2(proposed);
  return proposed;
}

export function normalizePlatform(value) {
  if (!PLATFORM_ORDER.includes(value)) {
    fail("promotion_platform_invalid", "--platform must be darwin or win32-x64");
  }
  return value;
}

export function requireSha256(value, code) {
  if (!SHA256_PATTERN.test(value ?? "") || /^0{64}$/u.test(value)) {
    fail(code, "value is not a non-zero lowercase SHA-256 digest");
  }
  return value;
}

export function assertDeepEqual(actual, expected, code, message) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(code, message);
  }
}

export function fail(code, message) {
  throw new CuaDriverSourceBuildPromotionError(code, message);
}

function assertDarwinBinaryIdentity(value, toolchain) {
  const binary = value?.binaries?.find((entry) => entry?.role === "main");
  if (!binary
    || binary.format !== "Mach-O 64-bit"
    || binary.architecture !== "arm64") {
    fail("promotion_darwin_binary_identity_invalid", "Darwin binary identity is incomplete");
  }
  if (binary.minimumOSVersion !== toolchain.deploymentTarget
    || binary.sdkVersion !== toolchain.macOSSDKVersion) {
    fail("promotion_darwin_binary_identity_invalid", "Darwin binary identity does not match the locked toolchain");
  }
}

function findWindowsIdentity(value, role, uiAccess) {
  const binary = value?.binaries?.find((entry) => entry?.role === role);
  if (!binary
    || binary.format !== "PE32+"
    || binary.architecture !== "x86_64"
    || binary.embeddedCertificateTablePresent !== false
    || binary.manifest?.executionLevel !== "asInvoker"
    || binary.manifest?.uiAccess !== uiAccess
    || !SHA256_PATTERN.test(binary.manifest?.sha256 ?? "")) {
    fail("promotion_windows_binary_identity_invalid", `Windows ${role} identity is invalid`);
  }
  return binary;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
