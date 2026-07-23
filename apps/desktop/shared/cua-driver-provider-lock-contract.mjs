/**
 * @typedef {import("@ling-stack/contracts").BundledCuaDriverDistributionLockV2} BundledCuaDriverDistributionLockV2
 * @typedef {"darwin" | "win32"} CuaDriverProviderLockPlatform
 * @typedef {{
 *   platform: CuaDriverProviderLockPlatform,
 *   architecture?: "arm64" | "x86_64",
 *   requireReleaseEvidence?: boolean,
 * }} CuaDriverProviderLockContractOptions
 */

/** Pure provider-lock validation failure shared by build-time and runtime callers. */
export class CuaDriverProviderLockContractError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "CuaDriverProviderLockContractError";
    this.code = code;
  }
}

/**
 * Validate untrusted provider-lock JSON without consulting candidate metadata.
 * The returned value is a fresh JSON-shaped clone with no caller-owned prototype.
 *
 * @param {unknown} value
 * @param {CuaDriverProviderLockContractOptions} options
 * @returns {BundledCuaDriverDistributionLockV2}
 */
export function validateCuaDriverProviderLockContract(value, options) {
  if (!isRecord(value)) {
    fail("provider_lock_not_object");
  }
  if (value.schemaVersion !== 2
    || value.componentId !== "cua-driver"
    || value.distributionRevision !== "ling.1") {
    fail("provider_lock_identity_mismatch");
  }
  if (!isRecord(value.upstream)
    || value.upstream.repository !== "https://github.com/trycua/cua"
    || value.upstream.version !== "0.8.3"
    || value.upstream.tag !== "cua-driver-rs-v0.8.3"
    || value.upstream.commit !== "0612c26b2c7b8556f6de7f6b4f3927ecac914e4f"
    || value.upstream.tree !== "831819eaf2b79c4d81c2b68773cd5920772e91e9"
    || value.upstream.releaseStage !== "prerelease"
    || value.upstream.license !== "MIT"
    || !isSha256(value.upstream.licenseSha256)) {
    fail("provider_lock_upstream_mismatch");
  }
  if (!Array.isArray(value.enabledPlatforms) || value.enabledPlatforms.length === 0) {
    fail("provider_lock_enabled_platforms_missing");
  }
  if (new Set(value.enabledPlatforms).size !== value.enabledPlatforms.length
    || value.enabledPlatforms.some(
      (platform) => platform !== "darwin" && platform !== "win32-x64",
    )) {
    fail("provider_lock_enabled_platforms_invalid");
  }
  const expectedResource = options.platform === "darwin" ? "darwin" : "win32-x64";
  if (!value.enabledPlatforms.includes(expectedResource)) {
    fail("provider_lock_platform_not_enabled");
  }
  const platforms = value.platforms;
  if (!isRecord(platforms)) {
    fail("provider_lock_platform_records_missing");
  }
  if (value.enabledPlatforms.includes("darwin") && !isRecord(platforms.darwin)) {
    fail("provider_lock_darwin_record_missing");
  }
  if (value.enabledPlatforms.includes("win32-x64") && !isRecord(platforms.win32X64)) {
    fail("provider_lock_windows_record_missing");
  }
  const platformLock = options.platform === "darwin" ? platforms.darwin : platforms.win32X64;
  if (!isRecord(platformLock)) {
    fail("provider_lock_platform_record_missing");
  }
  validatePlatformLock(
    platformLock,
    options.platform,
    options.architecture,
    options.requireReleaseEvidence ?? true,
  );
  return /** @type {BundledCuaDriverDistributionLockV2} */ (cloneJson(value));
}

/**
 * @param {Readonly<Record<string, unknown>>} value
 * @param {CuaDriverProviderLockPlatform} platform
 * @param {"arm64" | "x86_64" | undefined} architecture
 * @param {boolean} requireReleaseEvidence
 */
function validatePlatformLock(value, platform, architecture, requireReleaseEvidence) {
  if (value.schemaVersion !== 1
    || value.integrationMode !== "embedded-stdio"
    || value.distributionRevision !== "ling.1") {
    fail("provider_lock_platform_identity_mismatch");
  }
  if (value.productVersionLabel !== "0.8.3 (Ling build 1)") {
    fail("provider_lock_product_version_mismatch");
  }
  if (!isRecord(value.referenceReleaseArtifact)
    || !isRecord(value.sourceBuild)
    || !isRecord(value.binary)
    || !isRecord(value.runtime)
    || !isRecord(value.compatibility)) {
    fail("provider_lock_platform_sections_missing");
  }
  if (!Array.isArray(value.runtime.args)
    || value.runtime.args.join("\u0000")
      !== "mcp\u0000--embedded\u0000--host-bundle-id\u0000com.lingstack.desktop") {
    fail("provider_lock_runtime_args_mismatch");
  }
  if (value.runtime.stateHomeEnvironmentVariable !== "CUA_DRIVER_STATE_HOME"
    || value.runtime.stateSchemaVersion !== 1) {
    fail("provider_lock_state_contract_missing");
  }
  if (value.compatibility.serverInitializeProtocolVersion !== "2025-06-18"
    || value.compatibility.clientInitializeProtocolVersion !== "2025-11-25") {
    fail("provider_lock_protocol_mismatch");
  }
  if (value.binary.expectedUpstreamVersion !== "0.8.3" || value.binary.lingBuild !== 1) {
    fail("provider_lock_binary_identity_mismatch");
  }
  if (platform === "darwin") {
    if (value.componentId !== "cua-driver-darwin") {
      fail("provider_lock_component_mismatch");
    }
    const architectures = value.binary.architectures;
    if (!Array.isArray(architectures)
      || architectures.join(",") !== "arm64") {
      fail("provider_lock_darwin_architectures_missing");
    }
    if (architecture && !architectures.includes(architecture)) {
      fail("provider_lock_darwin_architecture_unsupported");
    }
    validateDarwinEvidence(value, requireReleaseEvidence);
    return;
  }
  if (value.componentId !== "cua-driver-win32-x64"
    || value.binary.architecture !== "x86_64") {
    fail("provider_lock_windows_identity_mismatch");
  }
  if (value.binary.mainRelativePath !== "payload/cua-driver.exe"
    || value.binary.providerSealRelativePath !== "payload/provider-seal.json") {
    fail("provider_lock_windows_payload_layout_mismatch");
  }
  if (value.runtime.requiredSession !== "interactive-user"
    || value.runtime.rejectSessionZero !== true) {
    fail("provider_lock_windows_session_contract_missing");
  }
  if (requireReleaseEvidence
    && value.binary.integrityCatalogRelativePathBySigningTier === undefined) {
    fail("provider_lock_windows_signing_contract_missing");
  }
  validateWindowsEvidence(value, requireReleaseEvidence);
}

/**
 * @param {Readonly<Record<string, any>>} value
 * @param {boolean} _requireReleaseEvidence
 */
function validateDarwinEvidence(value, _requireReleaseEvidence) {
  const reference = value.referenceReleaseArtifact;
  if (!hasText(reference.filename)
    || !positiveInteger(reference.sizeBytes)
    || !isSha256(reference.sha256)
    || reference.binaryArchivePath !== "cua-driver"
    || !hasText(reference.teamId)
    || !hasText(reference.authority)
    || reference.hardenedRuntime !== true
    || !isSha256(reference.entitlementsCanonicalSha256)) {
    fail("provider_lock_darwin_reference_evidence_invalid");
  }
  const source = value.sourceBuild;
  if (!isSha256(source.cargoLockSha256)
    || !hasText(source.rustcVersion)
    || !hasText(source.cargoVersion)
    || !hasText(source.xcodeBuildVersion)
    || !hasText(source.macOSSDKVersion)
    || !Array.isArray(source.targets)
    || source.targets.join(",") !== "aarch64-apple-darwin"
    || !isSha256(source.binarySha256BeforeSigning)) {
    fail("provider_lock_darwin_source_build_invalid");
  }
  validatePatchSet(source.patchSet);
  const binary = value.binary;
  if (binary.minimumMacOS !== "13.0"
    || !isSha256(binary.requiredEntitlementsCanonicalSha256)
    || !isRecord(binary.requiredEntitlements)
    || binary.requiredEntitlements["com.apple.security.automation.apple-events"] !== true
    || binary.requiredEntitlements["com.apple.security.device.screen-capture"] !== true
    || Object.keys(binary.requiredEntitlements).length !== 2
    || !Array.isArray(binary.supportedMacOSCells)
    || binary.supportedMacOSCells.length === 0) {
    fail("provider_lock_darwin_binary_evidence_invalid");
  }
  const compatibility = value.compatibility;
  if (compatibility.mcpClientSdk !== "@modelcontextprotocol/sdk@1.29.0"
    || !Array.isArray(compatibility.embeddedHealthSkipChecks)
    || !compatibility.embeddedHealthSkipChecks.includes("bundle_identity")
    || !isSha256(compatibility.toolsListSha256)) {
    fail("provider_lock_darwin_compatibility_invalid");
  }
}

/**
 * @param {Readonly<Record<string, any>>} value
 * @param {boolean} _requireReleaseEvidence
 */
function validateWindowsEvidence(value, _requireReleaseEvidence) {
  const reference = value.referenceReleaseArtifact;
  if (!hasText(reference.filename)
    || !positiveInteger(reference.sizeBytes)
    || !isSha256(reference.sha256)
    || reference.authenticodeStatus !== "unsigned-reference"
    || !isRecord(reference.binaries)
    || !isSha256(reference.binaries["cua-driver.exe"]?.sha256)
    || !isSha256(reference.binaries["cua-driver-uia.exe"]?.sha256)) {
    fail("provider_lock_windows_reference_evidence_invalid");
  }
  const source = value.sourceBuild;
  if (!isSha256(source.cargoLockSha256)
    || !hasText(source.rustcVersion)
    || !hasText(source.cargoVersion)
    || !hasText(source.windowsSdkVersion)
    || !hasText(source.msvcToolsetVersion)
    || source.target !== "x86_64-pc-windows-msvc"
    || !isRecord(source.binariesSha256BeforeSigning)
    || !isSha256(source.binariesSha256BeforeSigning.main)
    || !isSha256(source.binariesSha256BeforeSigning.uiaAuditArtifact)) {
    fail("provider_lock_windows_source_build_invalid");
  }
  validatePatchSet(source.patchSet);
  const binary = value.binary;
  if (!isSha256(binary.mainManifestCanonicalSha256)
    || !isRecord(binary.integrityCatalogRelativePathBySigningTier)
    || binary.integrityCatalogRelativePathBySigningTier.unsigned_dev !== null
    || binary.integrityCatalogRelativePathBySigningTier.test_signed_internal
      !== "provider-integrity.cat"
    || binary.integrityCatalogRelativePathBySigningTier.production_signed
      !== "provider-integrity.cat"
    || !isRecord(binary.packagedFilesBySigningTier)
    || !Array.isArray(binary.packagedFilesBySigningTier.unsigned_dev)
    || binary.packagedFilesBySigningTier.unsigned_dev.join(",")
      !== "payload/cua-driver.exe,payload/provider-seal.json"
    || !isRecord(binary.uiaAuditArtifact)
    || binary.uiaAuditArtifact.packaged !== false
    || binary.uiaAuditArtifact.relativeBuildOutput !== "cua-driver-uia.exe"
    || binary.uiaAuditArtifact.requestedExecutionLevel !== "asInvoker"
    || binary.uiaAuditArtifact.uiAccess !== true
    || !isSha256(binary.uiaAuditArtifact.manifestCanonicalSha256)) {
    fail("provider_lock_windows_binary_evidence_invalid");
  }
  const runtime = value.runtime;
  if (runtime.managedReadinessMethod !== "ling/managed_readiness"
    || runtime.managedReadinessChangedNotification !== "ling/managed_readiness_changed"
    || runtime.childInstanceNonceEnvironmentVariable !== "CUA_DRIVER_CHILD_INSTANCE_NONCE"
    || runtime.leaseGenerationEnvironmentVariable !== "CUA_DRIVER_LEASE_GENERATION"
    || runtime.killOnJobCloseRequired !== true
    || runtime.defaultIntegrityCoverage !== "standard") {
    fail("provider_lock_windows_runtime_evidence_invalid");
  }
  const compatibility = value.compatibility;
  if (compatibility.mcpClientSdk !== "@modelcontextprotocol/sdk@1.29.0"
    || !isSha256(compatibility.toolsListSha256)) {
    fail("provider_lock_windows_compatibility_invalid");
  }
}

/** @param {unknown} value */
function validatePatchSet(value) {
  if (!isRecord(value)
    || value.id !== "ling-managed-embedded-v1"
    || !isSha256(value.sha256)
    || !Array.isArray(value.patches)
    || value.patches.length !== 4
    || !Array.isArray(value.touchedPaths)
    || value.touchedPaths.length === 0) {
    fail("provider_lock_patch_set_invalid");
  }
  const expected = [
    "ling-embedded-state-home-v1",
    "ling-managed-readiness-v1",
    "ling-managed-lifetime-v1",
    "ling-windows-capability-errors-v1",
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const patch = value.patches[index];
    if (!isRecord(patch)
      || patch.id !== expected[index]
      || !isSha256(patch.sha256)) {
      fail("provider_lock_patch_set_invalid");
    }
  }
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** @param {unknown} value */
function hasText(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/** @param {unknown} value */
function isSha256(value) {
  return typeof value === "string"
    && /^[0-9a-f]{64}$/u.test(value)
    && !/^0{64}$/u.test(value);
}

/** @param {unknown} value */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} code */
function fail(code) {
  throw new CuaDriverProviderLockContractError(code);
}
