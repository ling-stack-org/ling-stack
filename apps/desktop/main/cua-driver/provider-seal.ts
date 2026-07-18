import { lstat, readFile, stat } from "node:fs/promises";
import type {
  BundledCuaDriverDistributionLockV2,
  BundledCuaDriverPlatform,
  BundledCuaDriverProviderSeal,
  CuaDriverArchitecture,
  DarwinBundledProviderSealV1,
  WindowsBundledProviderSealV2,
} from "@ling-stack/contracts";
import { sha256Bytes } from "./artifact-lock.js";
import type { CuaDriverResourcePaths } from "./resource-path.js";
import { assertCuaDriverResourceTree } from "./resource-path.js";

export const CUA_DRIVER_PROVIDER_SEAL_MAX_BYTES = 256 * 1024;

export class CuaDriverProviderSealError extends Error {
  readonly code = "cua_driver_provider_seal_invalid" as const;

  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "CuaDriverProviderSealError";
  }
}

export interface CuaDriverPlatformIdentityVerificationInput {
  readonly platform: BundledCuaDriverPlatform;
  readonly architecture: CuaDriverArchitecture;
  readonly paths: CuaDriverResourcePaths;
  readonly lock: BundledCuaDriverDistributionLockV2;
  readonly seal: BundledCuaDriverProviderSeal;
  readonly lockDigest: string;
  readonly executableDigest: string;
  readonly sealDigest: string;
  readonly catalogDigest?: string;
}

export interface CuaDriverPlatformIdentityVerifier {
  verify(input: CuaDriverPlatformIdentityVerificationInput): Promise<void>;
}

export type CuaDriverPlatformIdentityFailureKind = "invalid" | "unavailable";

export class CuaDriverPlatformIdentityVerificationError extends Error {
  readonly code = "cua_driver_platform_identity_verification_failed" as const;

  constructor(readonly failureKind: CuaDriverPlatformIdentityFailureKind) {
    super(`platform_identity_${failureKind}`);
    this.name = "CuaDriverPlatformIdentityVerificationError";
  }
}

export interface VerifiedCuaDriverArtifacts extends CuaDriverPlatformIdentityVerificationInput {
  readonly executablePath: string;
  readonly signingTier?: WindowsBundledProviderSealV2["signingTier"];
}

export async function readCuaDriverProviderSeal(
  filePath: string,
  platform: BundledCuaDriverPlatform,
  maxBytes = CUA_DRIVER_PROVIDER_SEAL_MAX_BYTES,
): Promise<BundledCuaDriverProviderSeal> {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new CuaDriverProviderSealError("provider_seal_oversized", filePath);
  }
  const bytes = await readFile(filePath);
  if (bytes.byteLength > maxBytes) {
    throw new CuaDriverProviderSealError("provider_seal_oversized", filePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new CuaDriverProviderSealError("provider_seal_json_invalid", filePath);
  }
  try {
    return validateCuaDriverProviderSeal(parsed, platform);
  } catch (error) {
    if (error instanceof CuaDriverProviderSealError) {
      throw new CuaDriverProviderSealError(error.message, filePath);
    }
    throw error;
  }
}

export function validateCuaDriverProviderSeal(
  value: unknown,
  platform: BundledCuaDriverPlatform,
): BundledCuaDriverProviderSeal {
  if (!isRecord(value)) {
    throw new CuaDriverProviderSealError("provider_seal_not_object");
  }
  assertCommonSeal(value);
  if (platform === "darwin") {
    assertDarwinSeal(value);
  } else {
    assertWindowsSeal(value);
  }
  return JSON.parse(JSON.stringify(value)) as BundledCuaDriverProviderSeal;
}

export interface VerifyCuaDriverProviderArtifactsInput {
  readonly platform: BundledCuaDriverPlatform;
  readonly architecture: CuaDriverArchitecture;
  readonly paths: CuaDriverResourcePaths;
  readonly lock: BundledCuaDriverDistributionLockV2;
  readonly platformIdentityVerifier?: CuaDriverPlatformIdentityVerifier;
  /** Packaged gates set this true; fixture-only core tests may inspect bytes without native tools. */
  readonly requirePlatformIdentityVerification?: boolean;
}

/**
 * Re-read the exact installed tuple before spawn. Candidate manifests and PATH
 * executables are intentionally absent from this API.
 */
export async function verifyCuaDriverProviderArtifacts(
  input: VerifyCuaDriverProviderArtifactsInput,
): Promise<VerifiedCuaDriverArtifacts> {
  const seal = await readCuaDriverProviderSeal(input.paths.sealPath, input.platform);
  const windowsSeal = input.platform === "win32" ? seal as WindowsBundledProviderSealV2 : undefined;
  const requiresCatalog = windowsSeal !== undefined && windowsSeal.signingTier !== "unsigned_dev";
  await assertCuaDriverResourceTree(input.paths, { requireCatalog: requiresCatalog });
  if (windowsSeal?.signingTier === "unsigned_dev" && input.paths.catalogPath && await pathExists(input.paths.catalogPath)) {
    throw new CuaDriverProviderSealError("unsigned_provider_catalog_forbidden", input.paths.catalogPath);
  }
  const [lockBytes, licenseBytes, noticesBytes, executableBytes, sealBytes, catalogBytes] = await Promise.all([
    readFile(input.paths.lockPath),
    readFile(input.paths.licensePath),
    readFile(input.paths.noticesPath),
    readFile(input.paths.executablePath),
    readFile(input.paths.sealPath),
    requiresCatalog && input.paths.catalogPath ? readFile(input.paths.catalogPath) : Promise.resolve(undefined),
  ]);
  const lockDigest = sha256Bytes(lockBytes);
  if (sha256Bytes(licenseBytes) !== input.lock.upstream.licenseSha256) {
    throw new CuaDriverProviderSealError("provider_license_digest_mismatch", input.paths.licensePath);
  }
  if (noticesBytes.byteLength === 0 || noticesBytes.byteLength > 4 * 1024 * 1024) {
    throw new CuaDriverProviderSealError("provider_notices_invalid", input.paths.noticesPath);
  }
  const executableDigest = sha256Bytes(executableBytes);
  const sealDigest = sha256Bytes(sealBytes);
  const catalogDigest = catalogBytes ? sha256Bytes(catalogBytes) : undefined;
  if (seal.lockSha256 !== lockDigest) {
    throw new CuaDriverProviderSealError("provider_seal_lock_digest_mismatch", input.paths.sealPath);
  }
  if (input.platform === "darwin") {
    const darwinSeal = seal as DarwinBundledProviderSealV1;
    if (darwinSeal.executableSha256 !== executableDigest || darwinSeal.executableRelativePath !== "cua-driver") {
      throw new CuaDriverProviderSealError("provider_seal_executable_digest_mismatch", input.paths.executablePath);
    }
  } else {
    if (!windowsSeal || windowsSeal.main.sha256 !== executableDigest || windowsSeal.main.relativePath !== "payload/cua-driver.exe") {
      throw new CuaDriverProviderSealError("provider_seal_executable_digest_mismatch", input.paths.executablePath);
    }
  }
  const identityInput: CuaDriverPlatformIdentityVerificationInput = {
    platform: input.platform,
    architecture: input.architecture,
    paths: input.paths,
    lock: input.lock,
    seal,
    lockDigest,
    executableDigest,
    sealDigest,
    ...(catalogDigest ? { catalogDigest } : {}),
  };
  if (input.platformIdentityVerifier) {
    await input.platformIdentityVerifier.verify(identityInput);
  } else if (input.requirePlatformIdentityVerification) {
    throw new CuaDriverProviderSealError("platform_identity_verifier_required", input.paths.executablePath);
  }
  return {
    ...identityInput,
    executablePath: input.paths.executablePath,
    ...(windowsSeal ? { signingTier: windowsSeal.signingTier } : {}),
  };
}

function assertCommonSeal(value: Readonly<Record<string, unknown>>): void {
  if (value.distributionRevision !== "ling.1" || value.providerVersion !== "0.8.3") {
    throw new CuaDriverProviderSealError("provider_seal_version_mismatch");
  }
  if (!isSha256(value.lockSha256) || !isSha256(value.toolsListCanonicalSha256)) {
    throw new CuaDriverProviderSealError("provider_seal_digest_invalid");
  }
  if (value.serverInitializeProtocolVersion !== "2025-06-18" || value.healthSchemaVersion !== "1" || value.stateSchemaVersion !== 1) {
    throw new CuaDriverProviderSealError("provider_seal_protocol_mismatch");
  }
}

function assertDarwinSeal(value: Readonly<Record<string, any>>): void {
  if (value.schemaVersion !== 1 || value.componentId !== "cua-driver-darwin" || value.executableRelativePath !== "cua-driver") {
    throw new CuaDriverProviderSealError("provider_seal_darwin_identity_mismatch");
  }
  if (!isSha256(value.executableSha256) || !Array.isArray(value.architectures) || value.architectures.join(",") !== "arm64,x86_64") {
    throw new CuaDriverProviderSealError("provider_seal_darwin_binary_mismatch");
  }
  if (value.hardenedRuntime !== true || !hasText(value.codeIdentifier) || !hasText(value.teamId) || !hasText(value.designatedRequirement)) {
    throw new CuaDriverProviderSealError("provider_seal_darwin_signing_mismatch");
  }
  if (!isSha256(value.designatedRequirementSha256) || !isSha256(value.entitlementsCanonicalSha256)) {
    throw new CuaDriverProviderSealError("provider_seal_darwin_signing_digest_invalid");
  }
}

function assertWindowsSeal(value: Readonly<Record<string, any>>): void {
  if (value.schemaVersion !== 2 || value.componentId !== "cua-driver-win32-x64") {
    throw new CuaDriverProviderSealError("provider_seal_windows_identity_mismatch");
  }
  if (!Array.isArray(value.limitations) || value.limitations.join(",") !== "elevated_pixel_input,uwp_send_input") {
    throw new CuaDriverProviderSealError("provider_seal_windows_limitations_mismatch");
  }
  if (!isRecord(value.main) || value.main.relativePath !== "payload/cua-driver.exe" || value.main.architecture !== "x86_64" || !isSha256(value.main.sha256) || !isSha256(value.main.peManifestCanonicalSha256)) {
    throw new CuaDriverProviderSealError("provider_seal_windows_binary_mismatch");
  }
  if (value.signingTier === "unsigned_dev") {
    if (value.distributionChannel !== "development" || value.productionEligible !== false || value.integrityCatalogRelativePath !== null || value.main.authenticodeStatus !== "NotSigned") {
      throw new CuaDriverProviderSealError("provider_seal_windows_unsigned_tuple_mismatch");
    }
    return;
  }
  if (value.signingTier !== "test_signed_internal" && value.signingTier !== "production_signed") {
    throw new CuaDriverProviderSealError("provider_seal_windows_signing_tier_invalid");
  }
  const expectedChannel = value.signingTier === "test_signed_internal" ? "internal" : "production";
  const expectedEligible = value.signingTier === "production_signed";
  if (value.distributionChannel !== expectedChannel || value.productionEligible !== expectedEligible || value.integrityCatalogRelativePath !== "provider-integrity.cat") {
    throw new CuaDriverProviderSealError("provider_seal_windows_signed_tuple_mismatch");
  }
  if (value.main.authenticodeStatus !== "Valid" || !hasText(value.main.signerSubject) || !isSha256(value.main.certificateSha256)) {
    throw new CuaDriverProviderSealError("provider_seal_windows_signature_invalid");
  }
  if (value.signingTier === "test_signed_internal") {
    if ((value.testAuthorityKind !== "ephemeral-ci" && value.testAuthorityKind !== "managed-internal") || value.main.timestampPolicy !== "internal-policy") {
      throw new CuaDriverProviderSealError("provider_seal_windows_internal_policy_mismatch");
    }
  } else if (value.main.timestampPolicy !== "rfc3161-required" || value.main.timestampStatus !== "Valid") {
    throw new CuaDriverProviderSealError("provider_seal_windows_production_policy_mismatch");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) && !/^0{64}$/u.test(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}
