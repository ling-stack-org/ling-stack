import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { validateCuaDriverPackageAuthority } from "../shared/cua-driver-package-authority-contract.mjs";
import { CUA_DRIVER_PACKAGE_REVISION } from "./cua-driver-package-staging-contract.mjs";
import {
  resolveSigningProfile,
  sha256Bytes,
} from "./cua-driver-signing/signing-contract.mjs";

export const CUA_DRIVER_RUNTIME_TRUST_POLICY_FILENAME = "runtime-trust-policy.json";
export const CUA_DRIVER_PACKAGED_CAPABILITIES_FILENAME = "packaged-provider-capabilities.json";

export class CuaDriverPackageRuntimePolicyError extends Error {
  constructor(code, message = code) {
    super(`${code}:${message}`);
    this.name = "CuaDriverPackageRuntimePolicyError";
    this.code = code;
  }
}

export function createCuaDriverPackageAuthorityDocuments(input) {
  const platform = normalizePlatform(input?.platform);
  const signingProfile = resolveSigningProfile(input?.signingProfile);
  const capabilities = Object.freeze({
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: CUA_DRIVER_PACKAGE_REVISION,
    resourcesValidated: true,
    darwin: platform === "darwin",
    win32: platform === "win32-x64",
  });
  if (platform === "darwin") {
    const expectedTeamId = requireTeamId(input?.expectedTeamId);
    return Object.freeze({
      capabilities,
      runtimeTrustPolicy: Object.freeze({
        schemaVersion: 1,
        componentId: "cua-driver",
        distributionRevision: CUA_DRIVER_PACKAGE_REVISION,
        platform: "darwin",
        expectedTeamId,
      }),
      signingProfile,
    });
  }

  let signingPolicy;
  if (signingProfile.signingTier === "unsigned_dev") {
    signingPolicy = Object.freeze({
      signingTier: "unsigned_dev",
      distributionChannel: "development",
    });
  } else {
    const providerSigner = requireSigner(input?.providerSigner, "provider_signer");
    const catalogSigner = requireSigner(input?.catalogSigner, "catalog_signer");
    const catalogTimestampStatus = input?.catalogTimestampStatus
      ?? (signingProfile.signingTier === "production_signed" ? "Valid" : "NotRequired");
    if (
      (signingProfile.signingTier === "production_signed" && catalogTimestampStatus !== "Valid")
      || (
        signingProfile.signingTier === "test_signed_internal"
        && catalogTimestampStatus !== "NotRequired"
        && catalogTimestampStatus !== "Valid"
      )
    ) {
      throw new CuaDriverPackageRuntimePolicyError(
        "catalog_timestamp_status_invalid",
        `invalid ${signingProfile.signingTier} catalog timestamp status`,
      );
    }
    signingPolicy = Object.freeze({
      signingTier: signingProfile.signingTier,
      distributionChannel: signingProfile.distributionChannel,
      providerSigner,
      catalogSigner,
      catalogTimestampStatus,
    });
  }
  return Object.freeze({
    capabilities,
    runtimeTrustPolicy: Object.freeze({
      schemaVersion: 1,
      componentId: "cua-driver",
      distributionRevision: CUA_DRIVER_PACKAGE_REVISION,
      platform: "win32",
      signingPolicy,
    }),
    signingProfile,
  });
}

export function packageAuthorityInputFromEnvironment(platformValue, environment = process.env) {
  const platform = normalizePlatform(platformValue);
  const signingProfile = resolveSigningProfile({
    signingTier: environment.LING_CUA_SIGNING_TIER,
    distributionChannel: environment.LING_CUA_DISTRIBUTION_CHANNEL,
    testAuthorityKind: environment.LING_CUA_TEST_AUTHORITY_KIND,
  });
  if (platform === "darwin") {
    return Object.freeze({
      platform,
      signingProfile,
      expectedTeamId: environment.LING_CUA_DARWIN_EXPECTED_TEAM_ID,
    });
  }
  if (signingProfile.signingTier === "unsigned_dev") {
    return Object.freeze({ platform, signingProfile });
  }
  const fixtureSubject = environment.LING_CUA_FIXTURE_SIGNER_SUBJECT
    ?? "CN=Ling Disposable CI Fixture";
  const fixtureCertificateSha256 = sha256Bytes(`fixture-certificate:${fixtureSubject}`);
  const providerSigner = signerFromEnvironment(
    environment,
    "PROVIDER",
    environment.LING_CUA_SIGNING_FIXTURE === "1"
      ? { subject: fixtureSubject, certificateSha256: fixtureCertificateSha256 }
      : undefined,
  );
  const catalogSigner = signerFromEnvironment(
    environment,
    "CATALOG",
    environment.LING_CUA_SIGNING_FIXTURE === "1"
      ? { subject: fixtureSubject, certificateSha256: fixtureCertificateSha256 }
      : undefined,
  );
  return Object.freeze({
    platform,
    signingProfile,
    providerSigner,
    catalogSigner,
    ...(environment.LING_CUA_CATALOG_TIMESTAMP_STATUS
      ? { catalogTimestampStatus: environment.LING_CUA_CATALOG_TIMESTAMP_STATUS }
      : {}),
  });
}

export async function writeCuaDriverPackageAuthorityFiles(input) {
  if (typeof input?.outputRoot !== "string" || !isAbsolute(input.outputRoot)) {
    throw new CuaDriverPackageRuntimePolicyError(
      "package_authority_output_invalid",
      "outputRoot must be absolute",
    );
  }
  const outputRoot = resolve(input.outputRoot);
  const documents = createCuaDriverPackageAuthorityDocuments(input);
  await mkdir(outputRoot, { recursive: true });
  const runtimeTrustPolicyPath = join(outputRoot, CUA_DRIVER_RUNTIME_TRUST_POLICY_FILENAME);
  const capabilitiesPath = join(outputRoot, CUA_DRIVER_PACKAGED_CAPABILITIES_FILENAME);
  const runtimeTrustPolicyBytes = `${JSON.stringify(documents.runtimeTrustPolicy, null, 2)}\n`;
  const capabilitiesBytes = `${JSON.stringify(documents.capabilities, null, 2)}\n`;
  await writeFile(
    runtimeTrustPolicyPath,
    runtimeTrustPolicyBytes,
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  await writeFile(
    capabilitiesPath,
    capabilitiesBytes,
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  const hostAuthority = validateCuaDriverPackageAuthority({
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: CUA_DRIVER_PACKAGE_REVISION,
    providerExpected: true,
    platform: input.platform === "darwin" ? "darwin" : "win32",
    signingTier: documents.signingProfile.signingTier,
    distributionChannel: documents.signingProfile.distributionChannel,
    capabilitiesSha256: sha256Bytes(capabilitiesBytes),
    runtimeTrustPolicySha256: sha256Bytes(runtimeTrustPolicyBytes),
  });
  return Object.freeze({
    ...documents,
    hostAuthority,
    outputRoot,
    runtimeTrustPolicyPath,
    capabilitiesPath,
  });
}

function normalizePlatform(value) {
  if (value !== "darwin" && value !== "win32-x64") {
    throw new CuaDriverPackageRuntimePolicyError(
      "package_authority_platform_invalid",
      `unsupported platform: ${String(value)}`,
    );
  }
  return value;
}

function requireTeamId(value) {
  if (typeof value !== "string" || !/^[A-Z0-9]{10}$/u.test(value)) {
    throw new CuaDriverPackageRuntimePolicyError(
      "darwin_team_id_invalid",
      "Darwin package authority requires one exact 10-character Team ID",
    );
  }
  return value;
}

function requireSigner(value, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "certificateSha256,subject"
    || typeof value.subject !== "string"
    || value.subject.trim() !== value.subject
    || value.subject.length === 0
    || value.subject.length > 1_024
    || typeof value.certificateSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.certificateSha256)
    || /^0{64}$/u.test(value.certificateSha256)
  ) {
    throw new CuaDriverPackageRuntimePolicyError(
      `${label}_invalid`,
      `${label} must contain an exact subject and lowercase certificate SHA-256`,
    );
  }
  return Object.freeze({
    subject: value.subject,
    certificateSha256: value.certificateSha256,
  });
}

function signerFromEnvironment(environment, prefix, fallback) {
  const subject = environment[`LING_CUA_${prefix}_SIGNER_SUBJECT`] ?? fallback?.subject;
  const certificateSha256 = environment[`LING_CUA_${prefix}_SIGNER_SHA256`]
    ?? fallback?.certificateSha256;
  return { subject, certificateSha256 };
}
