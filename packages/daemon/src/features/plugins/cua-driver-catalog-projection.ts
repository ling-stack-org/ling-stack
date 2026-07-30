import type {
  CuaDriverIntegrityCoverage,
  CuaDriverIntegrityStatus,
  CuaDriverLimitation,
  CuaDriverPermissionSnapshot,
  CuaDriverWindowsReadinessSnapshot,
} from "@ling-stack/contracts";

export interface BundledCuaDriverSetupMetadata {
  readonly integrityCoverage?: CuaDriverIntegrityCoverage;
  readonly limitations?: readonly CuaDriverLimitation[];
  readonly providerVersion?: string;
  readonly providerDistributionRevision?: string;
  readonly providerSealDigest?: string;
  readonly providerCatalogDigest?: string;
  readonly integrity?: CuaDriverIntegrityStatus;
  readonly permissions?: CuaDriverPermissionSnapshot;
  readonly windowsReadiness?: CuaDriverWindowsReadinessSnapshot;
}

/** Read only display metadata from the trusted, persisted activation snapshot. */
export function readBundledCuaDriverSetupMetadata(
  details: unknown,
  platform: NodeJS.Platform,
): BundledCuaDriverSetupMetadata {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const record = details as Readonly<Record<string, unknown>>;
  const candidateCoverage = platform === "win32"
    && (record.integrityCoverage === "standard" || record.integrityCoverage === "uiaccess")
    ? record.integrityCoverage
    : undefined;
  const candidateLimitations = platform === "win32" && Array.isArray(record.limitations)
    && record.limitations.every((value) => value === "elevated_pixel_input" || value === "uwp_send_input")
    && new Set(record.limitations).size === record.limitations.length
    ? record.limitations as readonly CuaDriverLimitation[]
    : undefined;
  const validCoverageTuple = candidateCoverage === "standard"
    ? candidateLimitations?.length === 2
      && candidateLimitations.includes("elevated_pixel_input")
      && candidateLimitations.includes("uwp_send_input")
    : candidateCoverage === "uiaccess" && candidateLimitations !== undefined;
  return {
    ...(validCoverageTuple ? { integrityCoverage: candidateCoverage } : {}),
    ...(validCoverageTuple ? { limitations: candidateLimitations } : {}),
    ...readBoundedDisplayField(record, "providerVersion"),
    ...readBoundedDisplayField(record, "providerDistributionRevision"),
    ...readSha256DisplayField(record, "providerSealDigest"),
    ...readSha256DisplayField(record, "providerCatalogDigest"),
    ...(record.integrity === "verified" || record.integrity === "failed" || record.integrity === "unknown"
      ? { integrity: record.integrity }
      : {}),
    ...(platform === "darwin" && isPermissionSnapshot(record.permissions)
      ? { permissions: record.permissions }
      : {}),
    ...(platform === "win32" && isWindowsReadinessSnapshot(record.windowsReadiness)
      ? { windowsReadiness: record.windowsReadiness }
      : {}),
  };
}

function isPermissionSnapshot(value: unknown): value is CuaDriverPermissionSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  const status = (candidate: unknown): boolean => candidate === "granted"
    || candidate === "denied"
    || candidate === "prompt"
    || candidate === "unknown";
  return Object.keys(value).every((key) => key === "accessibility" || key === "screenRecording" || key === "capturable")
    && status(value.accessibility)
    && status(value.screenRecording)
    && (value.capturable === undefined || typeof value.capturable === "boolean");
}

function isWindowsReadinessSnapshot(value: unknown): value is CuaDriverWindowsReadinessSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).every((key) => [
    "interactiveSession", "wgcApi", "d3d11", "uiaRuntime", "contentObserved",
    "integrityCoverage", "uiaHelper",
  ].includes(key))
    && ["ready", "session_zero", "locked", "unknown"].includes(String(value.interactiveSession))
    && ["supported", "unsupported", "unavailable", "unknown"].includes(String(value.wgcApi))
    && ["available", "unavailable", "unknown"].includes(String(value.d3d11))
    && ["available", "unavailable", "unknown"].includes(String(value.uiaRuntime))
    && value.contentObserved === false
    && ["standard", "uiaccess", "unknown"].includes(String(value.integrityCoverage))
    && ["not_required", "ready", "unavailable", "invalid"].includes(String(value.uiaHelper));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedDisplayField<Key extends "providerVersion" | "providerDistributionRevision">(
  record: Readonly<Record<string, unknown>>,
  key: Key,
): Partial<Record<Key, string>> {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? { [key]: value } as Partial<Record<Key, string>>
    : {};
}

function readSha256DisplayField<Key extends "providerSealDigest" | "providerCatalogDigest">(
  record: Readonly<Record<string, unknown>>,
  key: Key,
): Partial<Record<Key, string>> {
  const value = record[key];
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    ? { [key]: value } as Partial<Record<Key, string>>
    : {};
}
