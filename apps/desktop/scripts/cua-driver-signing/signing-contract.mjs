import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * The three Windows signing tiers are deliberately represented as a closed
 * mapping.  A caller cannot opt into a channel by setting only one half of
 * the pair, which is important while the real certificate service is still
 * owned by the release harness.
 */
export const SIGNING_PROFILES = Object.freeze({
  unsigned_dev: Object.freeze({
    signingTier: "unsigned_dev",
    distributionChannel: "development",
    productionEligible: false,
  }),
  test_signed_internal: Object.freeze({
    signingTier: "test_signed_internal",
    distributionChannel: "internal",
    productionEligible: false,
  }),
  production_signed: Object.freeze({
    signingTier: "production_signed",
    distributionChannel: "production",
    productionEligible: true,
  }),
});

export const SUPPORTED_SIGNING_PLATFORMS = Object.freeze(["darwin", "win32"]);

export function normalizeSigningPlatform(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["darwin", "mac", "macos", "osx"].includes(normalized)) {
    return "darwin";
  }
  if (["win32", "win", "windows"].includes(normalized)) {
    return "win32";
  }
  throw new SigningContractError(
    "unsupported_signing_platform",
    `Electron Builder signing feasibility only supports macOS and Windows (received ${String(value)})`,
  );
}

/**
 * Resolve and validate a tier/channel pair.  Defaults intentionally select
 * the development lane so existing unsigned Desktop builds remain unchanged
 * until a release harness explicitly injects a signer.
 */
export function resolveSigningProfile(input = {}) {
  const signingTier = String(
    input.signingTier ?? process.env.LING_CUA_SIGNING_TIER ?? "unsigned_dev",
  ).trim();
  const expected = SIGNING_PROFILES[signingTier];
  if (!expected) {
    throw new SigningContractError(
      "unknown_signing_tier",
      `Unknown Cua Driver signing tier: ${signingTier}`,
    );
  }
  const distributionChannel = String(
    input.distributionChannel ??
      process.env.LING_CUA_DISTRIBUTION_CHANNEL ??
      expected.distributionChannel,
  ).trim();
  if (distributionChannel !== expected.distributionChannel) {
    throw new SigningContractError(
      "signing_tier_channel_mismatch",
      `${signingTier} can only use ${expected.distributionChannel}, not ${distributionChannel}`,
    );
  }
  const productionEligible = expected.productionEligible;
  if (input.productionEligible !== undefined && input.productionEligible !== productionEligible) {
    throw new SigningContractError(
      "signing_profile_production_eligibility_mismatch",
      `productionEligible must be ${String(productionEligible)} for ${signingTier}`,
    );
  }
  const testAuthorityKind =
    signingTier === "test_signed_internal"
      ? String(input.testAuthorityKind ?? process.env.LING_CUA_TEST_AUTHORITY_KIND ?? "ephemeral-ci")
      : undefined;
  if (
    testAuthorityKind !== undefined &&
    !["ephemeral-ci", "managed-internal"].includes(testAuthorityKind)
  ) {
    throw new SigningContractError(
      "test_authority_kind_invalid",
      `Unknown internal test authority kind: ${testAuthorityKind}`,
    );
  }
  return Object.freeze({
    signingTier,
    distributionChannel,
    productionEligible,
    testAuthorityKind,
  });
}

export function assertSupportedSigningPlatform(value) {
  const platform = normalizeSigningPlatform(value);
  if (!SUPPORTED_SIGNING_PLATFORMS.includes(platform)) {
    throw new SigningContractError("unsupported_signing_platform", platform);
  }
  return platform;
}

export function canonicalJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

export function assertSha256(value, fieldName = "sha256") {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new SigningContractError("invalid_sha256", `${fieldName} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export class SigningContractError extends Error {
  constructor(code, message, options = {}) {
    super(`${code}:${message}`, options);
    this.name = "SigningContractError";
    this.code = code;
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}
