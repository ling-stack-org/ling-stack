import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BundledCuaDriverPlatform } from "@ling-stack/contracts";
import type {
  Win32CuaDriverSigningPolicy,
  Win32PinnedSignerIdentity,
} from "./adapters/win32-identity.js";
import { CUA_DRIVER_DISTRIBUTION_REVISION } from "./resource-path.js";

export const CUA_DRIVER_RUNTIME_TRUST_POLICY_MAX_BYTES = 64 * 1024;
export const CUA_DRIVER_RUNTIME_TRUST_POLICY_RESOURCE_SEGMENTS = Object.freeze([
  "providers",
  "cua-driver",
  "runtime-trust-policy.json",
] as const);

interface CuaDriverRuntimeTrustPolicyBaseV1 {
  readonly schemaVersion: 1;
  readonly componentId: "cua-driver";
  readonly distributionRevision: typeof CUA_DRIVER_DISTRIBUTION_REVISION;
  readonly platform: Exclude<BundledCuaDriverPlatform, "unsupported">;
}

export interface DarwinCuaDriverRuntimeTrustPolicyV1
  extends CuaDriverRuntimeTrustPolicyBaseV1 {
  readonly platform: "darwin";
  readonly expectedTeamId: string;
}

export interface Win32CuaDriverRuntimeTrustPolicyV1
  extends CuaDriverRuntimeTrustPolicyBaseV1 {
  readonly platform: "win32";
  readonly signingPolicy: Win32CuaDriverSigningPolicy;
}

export type CuaDriverRuntimeTrustPolicyV1 =
  | DarwinCuaDriverRuntimeTrustPolicyV1
  | Win32CuaDriverRuntimeTrustPolicyV1;

export type CuaDriverRuntimeTrustPolicyErrorCode =
  | "json_invalid"
  | "oversized"
  | "path_escape"
  | "path_invalid"
  | "platform_mismatch"
  | "schema_invalid"
  | "unavailable";

export class CuaDriverRuntimeTrustPolicyError extends Error {
  readonly code = "cua_driver_runtime_trust_policy_invalid" as const;

  constructor(
    readonly policyCode: CuaDriverRuntimeTrustPolicyErrorCode,
    readonly path?: string,
  ) {
    super(`cua_driver_runtime_trust_policy_${policyCode}`);
    this.name = "CuaDriverRuntimeTrustPolicyError";
  }
}

export interface LoadCuaDriverRuntimeTrustPolicyOptions {
  readonly resourcesPath: string;
  readonly platform: Exclude<BundledCuaDriverPlatform, "unsupported">;
  readonly maxBytes?: number;
}

/**
 * Read the build-carried trust anchor from one deterministic resources path.
 *
 * The provider lock, seal, candidate manifest and process environment are
 * deliberately absent from this API: package bytes may prove that they match
 * policy, but they cannot choose the policy used to trust themselves.
 */
export async function loadCuaDriverRuntimeTrustPolicy(
  options: LoadCuaDriverRuntimeTrustPolicyOptions,
): Promise<CuaDriverRuntimeTrustPolicyV1> {
  if (!isAbsolute(options.resourcesPath)) {
    throw new CuaDriverRuntimeTrustPolicyError("path_invalid", options.resourcesPath);
  }
  const resourcesPath = resolve(options.resourcesPath);
  const policyPath = join(resourcesPath, ...CUA_DRIVER_RUNTIME_TRUST_POLICY_RESOURCE_SEGMENTS);
  const maxBytes = boundedMaxBytes(options.maxBytes);

  let metadata;
  try {
    metadata = await lstat(policyPath);
  } catch {
    throw new CuaDriverRuntimeTrustPolicyError("unavailable", policyPath);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CuaDriverRuntimeTrustPolicyError("path_invalid", policyPath);
  }
  if (metadata.size > maxBytes) {
    throw new CuaDriverRuntimeTrustPolicyError("oversized", policyPath);
  }

  let policyRealPath: string;
  let resourcesRealPath: string;
  try {
    [policyRealPath, resourcesRealPath] = await Promise.all([
      realpath(policyPath),
      realpath(resourcesPath),
    ]);
  } catch {
    throw new CuaDriverRuntimeTrustPolicyError("unavailable", policyPath);
  }
  const relativePolicyPath = relative(resourcesRealPath, policyRealPath);
  if (
    relativePolicyPath === ""
    || relativePolicyPath === ".."
    || relativePolicyPath.startsWith(`..${sep}`)
    || isAbsolute(relativePolicyPath)
  ) {
    throw new CuaDriverRuntimeTrustPolicyError("path_escape", policyPath);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(policyPath);
  } catch {
    throw new CuaDriverRuntimeTrustPolicyError("unavailable", policyPath);
  }
  if (bytes.byteLength > maxBytes) {
    throw new CuaDriverRuntimeTrustPolicyError("oversized", policyPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new CuaDriverRuntimeTrustPolicyError("json_invalid", policyPath);
  }
  try {
    return validateCuaDriverRuntimeTrustPolicy(parsed, options.platform);
  } catch (error) {
    if (error instanceof CuaDriverRuntimeTrustPolicyError) {
      throw new CuaDriverRuntimeTrustPolicyError(error.policyCode, policyPath);
    }
    throw error;
  }
}

export function validateCuaDriverRuntimeTrustPolicy(
  value: unknown,
  platform: Exclude<BundledCuaDriverPlatform, "unsupported">,
): CuaDriverRuntimeTrustPolicyV1 {
  if (!isRecord(value)) {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
  if (
    value.schemaVersion !== 1
    || value.componentId !== "cua-driver"
    || value.distributionRevision !== CUA_DRIVER_DISTRIBUTION_REVISION
    || (value.platform !== "darwin" && value.platform !== "win32")
  ) {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
  if (value.platform !== platform) {
    throw new CuaDriverRuntimeTrustPolicyError("platform_mismatch");
  }

  if (platform === "darwin") {
    assertExactKeys(value, [
      "schemaVersion",
      "componentId",
      "distributionRevision",
      "platform",
      "expectedTeamId",
    ]);
    if (typeof value.expectedTeamId !== "string" || !/^[A-Z0-9]{10}$/u.test(value.expectedTeamId)) {
      throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
    }
    return Object.freeze({
      schemaVersion: 1,
      componentId: "cua-driver",
      distributionRevision: CUA_DRIVER_DISTRIBUTION_REVISION,
      platform: "darwin",
      expectedTeamId: value.expectedTeamId,
    });
  }

  assertExactKeys(value, [
    "schemaVersion",
    "componentId",
    "distributionRevision",
    "platform",
    "signingPolicy",
  ]);
  return Object.freeze({
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: CUA_DRIVER_DISTRIBUTION_REVISION,
    platform: "win32",
    signingPolicy: validateWin32SigningPolicy(value.signingPolicy),
  });
}

function validateWin32SigningPolicy(value: unknown): Win32CuaDriverSigningPolicy {
  if (!isRecord(value)) {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
  if (value.signingTier === "unsigned_dev") {
    assertExactKeys(value, ["signingTier", "distributionChannel"]);
    if (value.distributionChannel !== "development") {
      throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
    }
    return Object.freeze({
      signingTier: "unsigned_dev",
      distributionChannel: "development",
    });
  }
  if (value.signingTier !== "test_signed_internal" && value.signingTier !== "production_signed") {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
  assertExactKeys(value, [
    "signingTier",
    "distributionChannel",
    "providerSigner",
    "catalogSigner",
    "catalogTimestampStatus",
  ]);
  const providerSigner = validateSigner(value.providerSigner);
  const catalogSigner = validateSigner(value.catalogSigner);
  if (value.signingTier === "test_signed_internal") {
    if (
      value.distributionChannel !== "internal"
      || (value.catalogTimestampStatus !== "NotRequired" && value.catalogTimestampStatus !== "Valid")
    ) {
      throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
    }
    return Object.freeze({
      signingTier: "test_signed_internal",
      distributionChannel: "internal",
      providerSigner,
      catalogSigner,
      catalogTimestampStatus: value.catalogTimestampStatus,
    });
  }
  if (value.distributionChannel !== "production" || value.catalogTimestampStatus !== "Valid") {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
  return Object.freeze({
    signingTier: "production_signed",
    distributionChannel: "production",
    providerSigner,
    catalogSigner,
    catalogTimestampStatus: "Valid",
  });
}

function validateSigner(value: unknown): Win32PinnedSignerIdentity {
  if (!isRecord(value)) {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
  assertExactKeys(value, ["subject", "certificateSha256"]);
  if (
    typeof value.subject !== "string"
    || value.subject !== value.subject.trim()
    || value.subject.length === 0
    || value.subject.length > 1_024
    || typeof value.certificateSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.certificateSha256)
    || /^0{64}$/u.test(value.certificateSha256)
  ) {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
  return Object.freeze({
    subject: value.subject,
    certificateSha256: value.certificateSha256,
  });
}

function boundedMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? CUA_DRIVER_RUNTIME_TRUST_POLICY_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024) {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
  return maxBytes;
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (actual.length !== exact.length || actual.some((key, index) => key !== exact[index])) {
    throw new CuaDriverRuntimeTrustPolicyError("schema_invalid");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
