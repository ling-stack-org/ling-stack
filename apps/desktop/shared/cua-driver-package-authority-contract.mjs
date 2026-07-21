/**
 * @typedef {"unsigned_dev" | "test_signed_internal" | "production_signed"} CuaDriverSigningTier
 * @typedef {"development" | "internal" | "production"} CuaDriverDistributionChannel
 * @typedef {{
 *   schemaVersion: 1,
 *   componentId: "cua-driver",
 *   distributionRevision: "0.8.3-ling.1",
 *   providerExpected: false,
 * } | {
 *   schemaVersion: 1,
 *   componentId: "cua-driver",
 *   distributionRevision: "0.8.3-ling.1",
 *   providerExpected: true,
 *   platform: "darwin" | "win32",
 *   signingTier: CuaDriverSigningTier,
 *   distributionChannel: CuaDriverDistributionChannel,
 *   capabilitiesSha256: string,
 *   runtimeTrustPolicySha256: string,
 * }} CuaDriverPackageAuthorityV1
 */

export const CUA_DRIVER_PACKAGE_AUTHORITY_METADATA_KEY =
  "lingCuaDriverPackageAuthority";

export class CuaDriverPackageAuthorityContractError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "CuaDriverPackageAuthorityContractError";
    this.code = code;
  }
}

/** @returns {CuaDriverPackageAuthorityV1} */
export function createExternalOnlyCuaDriverPackageAuthority() {
  return Object.freeze({
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    providerExpected: false,
  });
}

/**
 * @param {unknown} value
 * @returns {CuaDriverPackageAuthorityV1}
 */
export function validateCuaDriverPackageAuthority(value) {
  if (!isRecord(value)) {
    fail("cua_driver_package_authority_not_object");
  }
  if (
    value.schemaVersion !== 1
    || value.componentId !== "cua-driver"
    || value.distributionRevision !== "0.8.3-ling.1"
    || typeof value.providerExpected !== "boolean"
  ) {
    fail("cua_driver_package_authority_identity_invalid");
  }
  if (value.providerExpected === false) {
    assertExactKeys(value, [
      "schemaVersion",
      "componentId",
      "distributionRevision",
      "providerExpected",
    ]);
    return createExternalOnlyCuaDriverPackageAuthority();
  }

  assertExactKeys(value, [
    "schemaVersion",
    "componentId",
    "distributionRevision",
    "providerExpected",
    "platform",
    "signingTier",
    "distributionChannel",
    "capabilitiesSha256",
    "runtimeTrustPolicySha256",
  ]);
  if (value.platform !== "darwin" && value.platform !== "win32") {
    fail("cua_driver_package_authority_platform_invalid");
  }
  if (!validSigningPair(value.signingTier, value.distributionChannel)) {
    fail("cua_driver_package_authority_signing_pair_invalid");
  }
  if (!isSha256(value.capabilitiesSha256) || !isSha256(value.runtimeTrustPolicySha256)) {
    fail("cua_driver_package_authority_digest_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    providerExpected: true,
    platform: value.platform,
    signingTier: value.signingTier,
    distributionChannel: value.distributionChannel,
    capabilitiesSha256: value.capabilitiesSha256,
    runtimeTrustPolicySha256: value.runtimeTrustPolicySha256,
  });
}

/**
 * @param {unknown} signingTier
 * @param {unknown} distributionChannel
 */
function validSigningPair(signingTier, distributionChannel) {
  return (
    (signingTier === "unsigned_dev" && distributionChannel === "development")
    || (signingTier === "test_signed_internal" && distributionChannel === "internal")
    || (signingTier === "production_signed" && distributionChannel === "production")
  );
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isSha256(value) {
  return typeof value === "string"
    && /^[a-f0-9]{64}$/u.test(value)
    && !/^0{64}$/u.test(value);
}

/**
 * @param {Readonly<Record<string, unknown>>} value
 * @param {readonly string[]} expected
 */
function assertExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (actual.length !== exact.length || actual.some((key, index) => key !== exact[index])) {
    fail("cua_driver_package_authority_shape_invalid");
  }
}

/** @param {string} code */
function fail(code) {
  throw new CuaDriverPackageAuthorityContractError(code);
}
