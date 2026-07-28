import type { CuaDriverIntegrityCoverage, CuaDriverLimitation } from "@ling-stack/contracts";

export interface BundledCuaDriverSetupMetadata {
  readonly integrityCoverage?: CuaDriverIntegrityCoverage;
  readonly limitations?: readonly CuaDriverLimitation[];
  readonly providerVersion?: string;
  readonly providerDistributionRevision?: string;
  readonly providerSealDigest?: string;
  readonly providerCatalogDigest?: string;
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
  };
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
