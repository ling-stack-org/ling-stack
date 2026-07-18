import { readFile, writeFile } from "node:fs/promises";

import {
  SigningContractError,
  canonicalJson,
  sha256Bytes,
  sha256File,
} from "./signing-contract.mjs";

const FIXTURE_SIGNATURE_MARKER = Buffer.from("\nLING-FIXTURE-SIGNATURE-V1\n", "utf8");
const FIXTURE_SIGNATURE_END = Buffer.from("\nLING-FIXTURE-SIGNATURE-END\n", "utf8");
const FIXTURE_CATALOG_FORMAT = "ling-fixture-catalog-v1";

/**
 * Create a deliberately non-production signer used by the hook-order spike.
 *
 * It appends a deterministic, inspectable fixture envelope to staged test
 * binaries.  It does not claim to be Authenticode or Developer ID, cannot be
 * selected for `production_signed`, and never imports a trust root or reads a
 * private key.  Hosted signing jobs replace this object with the real external
 * harness adapter; ordinary local tests use it to prove ordering and mutation
 * detection without distributing credentials.
 */
export function createDisposableFixtureSigner(input = {}) {
  const signerSubject = String(input.signerSubject ?? "CN=Ling Disposable CI Fixture");
  const certificateSha256 = String(
    input.certificateSha256 ?? sha256Bytes(`fixture-certificate:${signerSubject}`),
  );
  const signedPaths = new Set();

  return Object.freeze({
    kind: "disposable-fixture",
    testOnly: true,
    signerSubject,
    certificateSha256,
    async signFile({ filePath, platform, role, profile }) {
      assertFixtureProfile(profile);
      const bytes = await readFile(filePath);
      if (signedPaths.has(filePath) || findFixtureSignature(bytes)) {
        throw new SigningContractError(
          "provider_double_sign",
          `Fixture signer was asked to sign ${role} twice: ${filePath}`,
        );
      }
      const beforeSha256 = sha256Bytes(bytes);
      const identity = fixtureIdentity({
        platform,
        profile,
        role,
        signerSubject,
        certificateSha256,
        signedPayloadSha256: beforeSha256,
      });
      const envelope = Buffer.from(canonicalJson(identity), "utf8");
      await writeFile(
        filePath,
        Buffer.concat([bytes, FIXTURE_SIGNATURE_MARKER, envelope, FIXTURE_SIGNATURE_END]),
      );
      signedPaths.add(filePath);
      return Object.freeze({
        ...identity,
        beforeSha256,
        afterSha256: await sha256File(filePath),
      });
    },
    async signCatalog({ filePath, platform, role, profile, catalog }) {
      assertFixtureProfile(profile);
      if (signedPaths.has(filePath)) {
        throw new SigningContractError(
          "catalog_double_sign",
          `Fixture signer was asked to sign the catalog twice: ${filePath}`,
        );
      }
      const unsignedCatalog = Object.freeze({
        ...catalog,
        format: FIXTURE_CATALOG_FORMAT,
        testOnly: true,
      });
      const unsignedBytes = Buffer.from(canonicalJson(unsignedCatalog), "utf8");
      const identity = fixtureIdentity({
        platform,
        profile,
        role,
        signerSubject,
        certificateSha256,
        signedPayloadSha256: sha256Bytes(unsignedBytes),
      });
      await writeFile(
        filePath,
        `${canonicalJson({ ...unsignedCatalog, fixtureSignature: identity })}\n`,
        { flag: "wx" },
      );
      signedPaths.add(filePath);
      return Object.freeze({
        ...identity,
        beforeSha256: sha256Bytes(unsignedBytes),
        afterSha256: await sha256File(filePath),
      });
    },
  });
}

export function readFixtureFileSignature(bytes) {
  return findFixtureSignature(bytes);
}

export async function verifyFixtureCatalog(filePath, expected = {}) {
  let document;
  try {
    document = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new SigningContractError(
      "fixture_catalog_invalid",
      `Fixture catalog is not canonical JSON: ${filePath}`,
      { cause: error },
    );
  }
  if (
    !document ||
    typeof document !== "object" ||
    document.format !== FIXTURE_CATALOG_FORMAT ||
    document.testOnly !== true ||
    !document.fixtureSignature ||
    document.fixtureSignature.scheme !== "ling-disposable-signing-fixture-v1" ||
    document.fixtureSignature.testOnly !== true
  ) {
    throw new SigningContractError(
      "fixture_catalog_signature_missing",
      `Fixture catalog does not contain the disposable test envelope: ${filePath}`,
    );
  }
  const { fixtureSignature, ...unsignedCatalog } = document;
  const actualPayloadSha256 = sha256Bytes(canonicalJson(unsignedCatalog));
  if (fixtureSignature.signedPayloadSha256 !== actualPayloadSha256) {
    throw new SigningContractError(
      "fixture_catalog_signature_mismatch",
      `Fixture catalog payload changed after signing: ${filePath}`,
    );
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = field in fixtureSignature ? fixtureSignature[field] : document[field];
    if (expectedValue !== undefined && actualValue !== expectedValue) {
      throw new SigningContractError(
        "fixture_catalog_identity_mismatch",
        `Fixture catalog ${field} is ${String(actualValue)}, expected ${String(expectedValue)}`,
      );
    }
  }
  return Object.freeze({
    document,
    fixtureSignature,
    sha256: await sha256File(filePath),
  });
}

function fixtureIdentity({
  platform,
  profile,
  role,
  signerSubject,
  certificateSha256,
  signedPayloadSha256,
}) {
  return Object.freeze({
    scheme: "ling-disposable-signing-fixture-v1",
    testOnly: true,
    authorityKind: profile.testAuthorityKind ?? "ephemeral-ci",
    signingTier: profile.signingTier,
    distributionChannel: profile.distributionChannel,
    platform,
    role,
    signerSubject,
    certificateSha256,
    signedPayloadSha256,
    authenticodeStatus: platform === "win32" ? "FixtureOnly" : undefined,
    codeSigningStatus: platform === "darwin" ? "FixtureOnly" : undefined,
    timestampPolicy: "fixture-no-timestamp",
    timestampStatus: "NotRequired",
  });
}

function assertFixtureProfile(profile) {
  if (profile?.signingTier === "production_signed") {
    throw new SigningContractError(
      "fixture_signer_production_forbidden",
      "The disposable fixture signer cannot create or promote production-signed bytes",
    );
  }
  if (profile?.signingTier !== "test_signed_internal") {
    throw new SigningContractError(
      "fixture_signer_profile_invalid",
      "The disposable fixture signer is only valid for test_signed_internal + internal",
    );
  }
}

function findFixtureSignature(bytes) {
  const start = bytes.lastIndexOf(FIXTURE_SIGNATURE_MARKER);
  if (start === -1) {
    return undefined;
  }
  const payloadStart = start + FIXTURE_SIGNATURE_MARKER.length;
  const end = bytes.indexOf(FIXTURE_SIGNATURE_END, payloadStart);
  if (end === -1) {
    throw new SigningContractError(
      "fixture_signature_truncated",
      "The fixture signature marker exists without a complete envelope",
    );
  }
  try {
    const identity = JSON.parse(bytes.subarray(payloadStart, end).toString("utf8"));
    if (
      identity?.scheme !== "ling-disposable-signing-fixture-v1" ||
      identity?.testOnly !== true
    ) {
      throw new Error("fixture identity marker mismatch");
    }
    return Object.freeze(identity);
  } catch (error) {
    throw new SigningContractError(
      "fixture_signature_invalid",
      "The fixture signature envelope is malformed",
      { cause: error },
    );
  }
}
