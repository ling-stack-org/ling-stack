import { readFile, writeFile, rename, mkdir, lstat, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  SigningContractError,
  assertSha256,
  canonicalJson,
  normalizeSigningPlatform,
  resolveSigningProfile,
  sha256Bytes,
  sha256File,
} from "./signing-contract.mjs";
import { readFixtureFileSignature, verifyFixtureCatalog } from "./fixture-signer.mjs";

const PROVIDER_VERSION = "0.8.3";
const DISTRIBUTION_REVISION = "ling.1";
const INITIALIZE_PROTOCOL_VERSION = "2025-06-18";
const HEALTH_SCHEMA_VERSION = "1";
const STATE_SCHEMA_VERSION = 1;

export async function createProviderSeal(input = {}) {
  const platform = normalizeSigningPlatform(input.platform);
  const profile = resolveSigningProfile(input.profile);
  const providerPath = resolve(input.providerPath);
  const providerRoot = resolve(input.providerRoot);
  const lockPath = resolve(input.lockPath);
  const executableSha256 = await sha256File(providerPath);
  const lockSha256 = assertSha256(await sha256File(lockPath), "lockSha256");
  const relativeExecutablePath = relative(providerRoot, providerPath).replaceAll("\\", "/");
  const fixtureIdentity = readFixtureFileSignature(await readFile(providerPath));
  const signerIdentity = input.signerIdentity ?? fixtureIdentity;

  if (platform === "win32") {
    return Object.freeze({
      schemaVersion: 2,
      componentId: "cua-driver-win32-x64",
      platform,
      lockSha256,
      distributionRevision: DISTRIBUTION_REVISION,
      providerVersion: PROVIDER_VERSION,
      serverInitializeProtocolVersion: INITIALIZE_PROTOCOL_VERSION,
      healthSchemaVersion: HEALTH_SCHEMA_VERSION,
      toolsListCanonicalSha256: sha256Bytes("fixture-tools-list-pending"),
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      limitations: ["elevated_pixel_input", "uwp_send_input"],
      signingTier: profile.signingTier,
      distributionChannel: profile.distributionChannel,
      productionEligible: profile.productionEligible,
      ...(profile.signingTier === "test_signed_internal"
        ? { testAuthorityKind: profile.testAuthorityKind }
        : {}),
      main: buildWindowsMainIdentity({
        relativeExecutablePath,
        executableSha256,
        profile,
        signerIdentity,
      }),
      integrityCatalogRelativePath:
        profile.signingTier === "unsigned_dev" ? null : "provider-integrity.cat",
      evidenceKind: evidenceKindForSigner(signerIdentity),
    });
  }

  const darwinIdentity = darwinSealIdentity(profile, signerIdentity, executableSha256);
  return Object.freeze({
    schemaVersion: 1,
    componentId: "cua-driver-darwin",
    platform,
    lockSha256,
    distributionRevision: DISTRIBUTION_REVISION,
    executableRelativePath: relativeExecutablePath,
    executableSha256,
    architectures: ["arm64"],
    cdhashes: { arm64: darwinIdentity.cdhash },
    codeIdentifier: darwinIdentity.codeIdentifier,
    teamId: darwinIdentity.teamId,
    designatedRequirement: darwinIdentity.designatedRequirement,
    designatedRequirementSha256: darwinIdentity.designatedRequirementSha256,
    hardenedRuntime: darwinIdentity.hardenedRuntime,
    entitlementsCanonicalSha256: darwinIdentity.entitlementsCanonicalSha256,
    providerVersion: PROVIDER_VERSION,
    serverInitializeProtocolVersion: INITIALIZE_PROTOCOL_VERSION,
    healthSchemaVersion: HEALTH_SCHEMA_VERSION,
    toolsListCanonicalSha256: sha256Bytes("fixture-tools-list-pending"),
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    signingTier: profile.signingTier,
    distributionChannel: profile.distributionChannel,
    productionEligible: profile.productionEligible,
    ...(profile.signingTier === "test_signed_internal"
      ? { testAuthorityKind: profile.testAuthorityKind }
      : {}),
    evidenceKind: evidenceKindForSigner(signerIdentity),
    identity: buildMacIdentity({ profile, signerIdentity }),
  });
}

export async function writeProviderSeal(sealPath, seal) {
  await writeJsonAtomically(sealPath, seal, { exclusive: true });
  return Object.freeze({
    path: resolve(sealPath),
    sha256: await sha256File(sealPath),
  });
}

export async function readProviderSeal(sealPath) {
  let payload;
  try {
    payload = JSON.parse(await readFile(sealPath, "utf8"));
  } catch (error) {
    throw new SigningContractError(
      "provider_seal_invalid",
      `Unable to parse provider seal: ${sealPath}`,
      { cause: error },
    );
  }
  if (!payload || typeof payload !== "object" || !Number.isInteger(payload.schemaVersion)) {
    throw new SigningContractError("provider_seal_invalid", `Invalid provider seal: ${sealPath}`);
  }
  return payload;
}

/**
 * Re-read the final provider tuple.  This is intentionally independent from
 * candidate-manifest JSON: the bytes, lock and (for Windows signed tiers)
 * catalog are the trust inputs used by the runtime.
 */
export async function verifyProviderTuple(input = {}) {
  const platform = normalizeSigningPlatform(input.platform);
  const profile = resolveSigningProfile(input.profile);
  const providerPath = resolve(input.providerPath);
  const sealPath = resolve(input.sealPath);
  const lockPath = resolve(input.lockPath);
  const providerRoot = resolve(input.providerRoot);
  const seal = await readProviderSeal(sealPath);
  verifyProviderSealShape(seal, platform, profile);
  const actualProviderSha256 = await sha256File(providerPath);
  const actualLockSha256 = await sha256File(lockPath);
  if (seal.lockSha256 !== actualLockSha256) {
    throw new SigningContractError(
      "provider_lock_digest_mismatch",
      `Seal lock digest ${seal.lockSha256} does not match ${actualLockSha256}`,
    );
  }
  if (profile.signingTier === "test_signed_internal" && seal.evidenceKind === "disposable-fixture") {
    const fixtureIdentity = readFixtureFileSignature(await readFile(providerPath));
    if (
      !fixtureIdentity
      || fixtureIdentity.authorityKind !== profile.testAuthorityKind
      || fixtureIdentity.signingTier !== profile.signingTier
      || fixtureIdentity.distributionChannel !== profile.distributionChannel
    ) {
      throw new SigningContractError(
        "provider_fixture_authority_mismatch",
        "Provider fixture signature does not match the sealed test authority",
      );
    }
  }
  if (platform === "win32") {
    if (seal.main.sha256 !== actualProviderSha256) {
      throw new SigningContractError(
        "provider_post_seal_mutation",
        `Windows provider bytes changed after sealing: ${providerPath}`,
      );
    }
    const expectedRelative = relative(providerRoot, providerPath).replaceAll("\\", "/");
    if (seal.main.relativePath !== expectedRelative) {
      throw new SigningContractError("provider_seal_path_mismatch", "Windows provider path changed");
    }
    if (profile.signingTier === "unsigned_dev") {
      if (input.catalogPath) {
        await assertCatalogAbsent(input.catalogPath);
      }
      if (seal.main.authenticodeStatus !== "NotSigned") {
        throw new SigningContractError(
          "unsigned_provider_claims_signature",
          "unsigned_dev provider must record NotSigned",
        );
      }
    } else {
      if (!input.catalogPath) {
        throw new SigningContractError("provider_catalog_missing", "Signed Windows tier requires a catalog");
      }
      const catalog = await verifyFixtureCatalog(input.catalogPath, {
        signingTier: profile.signingTier,
        distributionChannel: profile.distributionChannel,
        authorityKind: profile.testAuthorityKind,
      });
      const members = catalog.document.members;
      const expectedMembers = [
        { relativePath: "payload/ling-cua-driver.exe", sha256: actualProviderSha256 },
        { relativePath: "payload/provider-seal.json", sha256: await sha256File(sealPath) },
      ];
      if (canonicalJson(members) !== canonicalJson(expectedMembers)) {
        throw new SigningContractError(
          "provider_catalog_membership_mismatch",
          "Windows catalog does not cover exactly the sealed provider and seal",
        );
      }
      if (seal.integrityCatalogRelativePath !== "provider-integrity.cat") {
        throw new SigningContractError("provider_catalog_claim_mismatch", "Seal does not claim the catalog");
      }
    }
  } else {
    if (seal.executableSha256 !== actualProviderSha256) {
      throw new SigningContractError(
        "provider_post_seal_mutation",
        `macOS provider bytes changed after sealing: ${providerPath}`,
      );
    }
    const expectedRelative = relative(providerRoot, providerPath).replaceAll("\\", "/");
    if (seal.executableRelativePath !== expectedRelative) {
      throw new SigningContractError("provider_seal_path_mismatch", "macOS provider path changed");
    }
  }
  return Object.freeze({
    seal,
    providerSha256: actualProviderSha256,
    sealSha256: await sha256File(sealPath),
    catalogSha256:
      profile.signingTier === "unsigned_dev" || !input.catalogPath
        ? null
        : await sha256File(input.catalogPath),
  });
}

async function writeJsonAtomically(path, value, options = {}) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: "wx" });
    if (options.exclusive) {
      try {
        await lstat(destination);
        throw new SigningContractError(
          "provider_seal_already_exists",
          `Refusing to overwrite ${destination}`,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function buildWindowsMainIdentity({ relativeExecutablePath, executableSha256, profile, signerIdentity }) {
  if (profile.signingTier === "unsigned_dev") {
    return {
      relativePath: relativeExecutablePath,
      sha256: executableSha256,
      architecture: "x86_64",
      peManifestCanonicalSha256: sha256Bytes("fixture-win32-standard-asInvoker"),
      authenticodeStatus: "NotSigned",
    };
  }
  if (!signerIdentity || signerIdentity.testOnly !== true) {
    return {
      relativePath: relativeExecutablePath,
      sha256: executableSha256,
      architecture: "x86_64",
      peManifestCanonicalSha256: sha256Bytes("fixture-win32-standard-asInvoker"),
      authenticodeStatus: "Valid",
      signerSubject: signerIdentity?.signerSubject ?? "unknown",
      certificateSha256: signerIdentity?.certificateSha256 ?? "0".repeat(64),
      timestampPolicy:
        profile.signingTier === "production_signed" ? "rfc3161-required" : "internal-policy",
      timestampStatus: profile.signingTier === "production_signed" ? "Valid" : "NotRequired",
    };
  }
  return {
    relativePath: relativeExecutablePath,
    sha256: executableSha256,
    architecture: "x86_64",
    peManifestCanonicalSha256: sha256Bytes("fixture-win32-standard-asInvoker"),
    authenticodeStatus: "FixtureOnly",
    signerSubject: signerIdentity.signerSubject,
    certificateSha256: signerIdentity.certificateSha256,
    timestampPolicy: "fixture-no-timestamp",
    timestampStatus: "NotRequired",
  };
}

function evidenceKindForSigner(signerIdentity) {
  return signerIdentity?.scheme === "ling-disposable-signing-fixture-v1"
    ? "disposable-fixture"
    : "platform-signer";
}

function darwinSealIdentity(profile, signerIdentity, executableSha256) {
  if (
    signerIdentity
    && typeof signerIdentity.codeIdentifier === "string"
    && typeof signerIdentity.teamId === "string"
    && typeof signerIdentity.cdhash === "string"
    && /^[0-9a-f]{40}$/u.test(signerIdentity.cdhash)
    && typeof signerIdentity.designatedRequirement === "string"
    && /^[0-9a-f]{64}$/u.test(signerIdentity.designatedRequirementSha256)
    && /^[0-9a-f]{64}$/u.test(signerIdentity.entitlementsCanonicalSha256)
    && signerIdentity.hardenedRuntime === true
  ) {
    return Object.freeze({
      codeIdentifier: signerIdentity.codeIdentifier,
      teamId: signerIdentity.teamId,
      cdhash: signerIdentity.cdhash,
      designatedRequirement: signerIdentity.designatedRequirement,
      designatedRequirementSha256: signerIdentity.designatedRequirementSha256,
      hardenedRuntime: true,
      entitlementsCanonicalSha256: signerIdentity.entitlementsCanonicalSha256,
    });
  }
  if (profile.signingTier === "unsigned_dev") {
    const designatedRequirement =
      "unsigned-development-only; not accepted by packaged Darwin runtime";
    return Object.freeze({
      codeIdentifier: "ling-cua-driver-unsigned-dev",
      teamId: "NotSigned",
      cdhash: sha256Bytes(`${executableSha256}:arm64`).slice(0, 40),
      designatedRequirement,
      designatedRequirementSha256: sha256Bytes(designatedRequirement),
      hardenedRuntime: false,
      entitlementsCanonicalSha256: sha256Bytes("unsigned-development-entitlements"),
    });
  }
  if (profile.signingTier !== "test_signed_internal" || signerIdentity?.testOnly !== true) {
    throw new SigningContractError(
      "darwin_final_identity_missing",
      "Signed Darwin packages require a codesign-derived provider identity",
    );
  }
  const designatedRequirement =
    "fixture-only; replaced by platform identity in release build";
  return Object.freeze({
    codeIdentifier: "ling-cua-driver-fixture",
    teamId: signerIdentity.teamId ?? signerIdentity.signerSubject,
    cdhash: sha256Bytes(`${executableSha256}:arm64`).slice(0, 40),
    designatedRequirement,
    designatedRequirementSha256: sha256Bytes(designatedRequirement),
    hardenedRuntime: true,
    entitlementsCanonicalSha256: sha256Bytes("fixture-entitlements-pending"),
  });
}

function buildMacIdentity({ profile, signerIdentity }) {
  if (profile.signingTier === "unsigned_dev") {
    return {
      codeSigningStatus: "NotSigned",
      signerSubject: null,
      certificateSha256: null,
    };
  }
  return {
    codeSigningStatus: signerIdentity?.testOnly ? "FixtureOnly" : "Valid",
    signerSubject: signerIdentity?.signerSubject ?? null,
    certificateSha256: signerIdentity?.certificateSha256 ?? null,
  };
}

function verifyProviderSealShape(seal, platform, profile) {
  if (
    seal.schemaVersion !== (platform === "win32" ? 2 : 1) ||
    seal.componentId !== (platform === "win32" ? "cua-driver-win32-x64" : "cua-driver-darwin") ||
    seal.platform !== platform ||
    seal.signingTier !== profile.signingTier ||
    seal.distributionChannel !== profile.distributionChannel ||
    seal.productionEligible !== profile.productionEligible
  ) {
    throw new SigningContractError(
      "provider_seal_profile_mismatch",
      `${platform} seal tier/channel is not current`,
    );
  }
  if (profile.signingTier === "test_signed_internal" && seal.testAuthorityKind !== profile.testAuthorityKind) {
    throw new SigningContractError("provider_seal_authority_mismatch", `${platform} test authority kind changed`);
  }
  if (profile.signingTier !== "test_signed_internal" && seal.testAuthorityKind !== undefined) {
    throw new SigningContractError(
      "provider_seal_authority_mismatch",
      `${platform} non-test seal unexpectedly claims a test authority kind`,
    );
  }
}

async function assertCatalogAbsent(path) {
  try {
    const stats = await lstat(path);
    if (stats.isFile()) {
      throw new SigningContractError(
        "unsigned_catalog_present",
        `unsigned_dev cannot ship a catalog: ${path}`,
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}
