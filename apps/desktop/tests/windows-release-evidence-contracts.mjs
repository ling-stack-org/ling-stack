import { isDeepStrictEqual } from "node:util";

import { WINDOWS_CUA_DRIVER_RELEASE } from "./verify-windows-cua-driver-provider.mjs";

export const WINDOWS_CANDIDATE_MANIFEST_KIND = "ling.windows.candidate-manifest";
export const WINDOWS_CANDIDATE_MANIFEST_VERSION = 4;
export const WINDOWS_RELEASE_POLICY_KIND = "ling.windows.release-policy";
export const WINDOWS_RELEASE_POLICY_SCHEMA_VERSION = 3;
export const WINDOWS_RELEASE_POLICY_VERSION = 3;

export const WINDOWS_PROVIDER_RELATIVE_PATH =
  "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/cua-driver.exe";
export const WINDOWS_PROVIDER_SEAL_RELATIVE_PATH =
  "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/provider-seal.json";
export const WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH =
  "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/provider-integrity.cat";
export const WINDOWS_PROVIDER_LOCK_RELATIVE_PATH =
  "resources/providers/cua-driver/0.8.3-ling.1/provider-lock.json";
export const WINDOWS_LING_APP_RELATIVE_PATH = "Ling Stack.exe";
export const WINDOWS_LING_INSTALLER_RELATIVE_PATH = "Ling Stack Setup.exe";
export const WINDOWS_LING_UNINSTALLER_RELATIVE_PATH =
  "Uninstall Ling Stack.exe";
export const WINDOWS_REQUIRED_ACCEPTANCE_EVIDENCE_KINDS = Object.freeze([
  "accessibility",
  "display",
  "install-lifecycle",
  "provider-runtime",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const CELL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SIGNING_TUPLES = Object.freeze({
  unsigned_dev: Object.freeze({
    distributionChannel: "development",
    productionEligible: false,
    timestampPolicy: null,
  }),
  test_signed_internal: Object.freeze({
    distributionChannel: "internal",
    productionEligible: false,
    timestampPolicy: "internal-policy",
  }),
  production_signed: Object.freeze({
    distributionChannel: "production",
    productionEligible: true,
    timestampPolicy: "rfc3161-required",
  }),
});

export function validateWindowsReleasePolicyDocument(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "policyVersion",
    "status",
    "approvedBy",
    "approvedAt",
    "windowsAcceptanceOwner",
    "requiredSigningTier",
    "requiredDistributionChannel",
    "requiredProductionEligible",
    "requiredTestAuthorityKind",
    "lingSignerSubject",
    "providerSignerSubject",
    "catalogSignerSubject",
    "lingSignerCertificateSha256",
    "providerSignerCertificateSha256",
    "catalogSignerCertificateSha256",
    "supportedWindowsBuilds",
    "requiredAcceptanceCells",
    "manualEvidenceReviewers",
    "reviewerKeys",
    "candidateBuildAttestors",
  ], "windows_release_policy_shape_invalid");
  if (
    value.schemaVersion !== WINDOWS_RELEASE_POLICY_SCHEMA_VERSION
    || value.kind !== WINDOWS_RELEASE_POLICY_KIND
    || value.policyVersion !== WINDOWS_RELEASE_POLICY_VERSION
    || value.status !== "approved"
    || !nonEmpty(value.approvedBy)
    || !isIsoTimestamp(value.approvedAt)
    || !nonEmpty(value.windowsAcceptanceOwner)
    || !nonEmpty(value.lingSignerSubject)
    || !nonEmpty(value.providerSignerSubject)
    || !nonEmpty(value.catalogSignerSubject)
    || !isSha256(value.lingSignerCertificateSha256)
    || !isSha256(value.providerSignerCertificateSha256)
    || !isSha256(value.catalogSignerCertificateSha256)
  ) {
    throw new TypeError("windows_release_policy_identity_invalid");
  }
  assertSigningTuple({
    signingTier: value.requiredSigningTier,
    distributionChannel: value.requiredDistributionChannel,
    productionEligible: value.requiredProductionEligible,
    testAuthorityKind: value.requiredTestAuthorityKind,
  }, { allowUnsigned: false, code: "windows_release_policy_signing_tuple_invalid" });
  assertSortedUniqueStrings(value.supportedWindowsBuilds, "windows_release_policy_builds_invalid");
  assertSortedUniqueStrings(value.manualEvidenceReviewers, "windows_release_policy_reviewers_invalid");
  const reviewerKeys = validateAttestorKeys(value.reviewerKeys, "windows_release_policy_reviewer_keys_invalid");
  const buildKeys = validateAttestorKeys(
    value.candidateBuildAttestors,
    "windows_release_policy_build_keys_invalid",
  );
  if (
    !isDeepStrictEqual(value.manualEvidenceReviewers, reviewerKeys.map((entry) => entry.id))
    || reviewerKeys.some((reviewer) => buildKeys.some((builder) =>
      reviewer.id === builder.id
      || reviewer.keyId === builder.keyId
      || reviewer.publicKeySpkiSha256 === builder.publicKeySpkiSha256))
  ) {
    throw new TypeError("windows_release_policy_attestor_roles_invalid");
  }
  validateAcceptanceCells(value.requiredAcceptanceCells, value.supportedWindowsBuilds);
  return value;
}

export function validateWindowsCandidateManifestDocument(value, options = {}) {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "commit",
    "releasePolicySha256",
    "signingTier",
    "distributionChannel",
    "productionEligible",
    "testAuthorityKind",
    "preSignPayloadSha256",
    "providerRelease",
    "daemonPayload",
    "packagedProvider",
    "tierGovernedArtifacts",
    "vendorNativeInventory",
  ], "windows_candidate_manifest_shape_invalid");
  if (
    value.schemaVersion !== WINDOWS_CANDIDATE_MANIFEST_VERSION
    || value.kind !== WINDOWS_CANDIDATE_MANIFEST_KIND
    || !GIT_COMMIT_PATTERN.test(value.commit ?? "")
    || !isSha256(value.releasePolicySha256)
    || !isSha256(value.preSignPayloadSha256)
  ) {
    throw new TypeError("windows_candidate_manifest_identity_invalid");
  }
  if (options.expectedCommit && value.commit !== options.expectedCommit) {
    throw new TypeError("windows_candidate_manifest_commit_mismatch");
  }
  if (
    options.expectedReleasePolicySha256
    && value.releasePolicySha256 !== options.expectedReleasePolicySha256
  ) {
    throw new TypeError("windows_candidate_manifest_policy_digest_mismatch");
  }
  const tuple = assertSigningTuple(value, {
    allowUnsigned: true,
    code: "windows_candidate_manifest_signing_tuple_invalid",
  });
  if (options.policy) {
    validateWindowsReleasePolicyDocument(options.policy);
    if (
      value.signingTier !== options.policy.requiredSigningTier
      || value.distributionChannel !== options.policy.requiredDistributionChannel
      || value.productionEligible !== options.policy.requiredProductionEligible
      || value.testAuthorityKind !== options.policy.requiredTestAuthorityKind
    ) {
      throw new TypeError("windows_candidate_manifest_policy_tuple_mismatch");
    }
  }
  validateProviderRelease(value.providerRelease);
  validateDaemonPayload(value.daemonPayload, value.commit);
  validatePackagedProvider(value.packagedProvider, value, tuple);
  validateTierGovernedArtifacts(value.tierGovernedArtifacts, value, tuple, options.policy);
  validateVendorNativeInventory(
    value.vendorNativeInventory,
    new Set([
      WINDOWS_LING_APP_RELATIVE_PATH,
      WINDOWS_LING_INSTALLER_RELATIVE_PATH,
      WINDOWS_LING_UNINSTALLER_RELATIVE_PATH,
      WINDOWS_PROVIDER_RELATIVE_PATH,
      WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
      WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
    ].map(normalizeWindowsRelativePath)),
  );
  return value;
}

export function validateWindowsAcceptanceCell(value) {
  assertExactKeys(value, [
    "id",
    "windowsBuild",
    "architecture",
    "displayTopology",
    "displayScalePercents",
    "requiredEvidenceKinds",
  ], "windows_acceptance_cell_shape_invalid");
  if (
    !CELL_ID_PATTERN.test(value.id ?? "")
    || !nonEmpty(value.windowsBuild)
    || value.architecture !== "x64"
    || !["single", "dual"].includes(value.displayTopology)
  ) {
    throw new TypeError("windows_acceptance_cell_identity_invalid");
  }
  const scales = value.displayScalePercents;
  if (
    !Array.isArray(scales)
    || !scales.every((scale) => [100, 150, 200].includes(scale))
    || !isDeepStrictEqual(scales, [...new Set(scales)].sort((left, right) => left - right))
    || (value.displayTopology === "single" && scales.length !== 1)
    || (value.displayTopology === "dual" && scales.length !== 2)
  ) {
    throw new TypeError("windows_acceptance_cell_display_invalid");
  }
  if (
    !isDeepStrictEqual(
      value.requiredEvidenceKinds,
      WINDOWS_REQUIRED_ACCEPTANCE_EVIDENCE_KINDS,
    )
  ) {
    throw new TypeError("windows_acceptance_cell_evidence_kinds_invalid");
  }
  return value;
}

function validateAcceptanceCells(cells, supportedWindowsBuilds) {
  if (!Array.isArray(cells) || cells.length < supportedWindowsBuilds.length * 2) {
    throw new TypeError("windows_release_policy_acceptance_cells_missing");
  }
  const ids = [];
  for (const cell of cells) {
    validateWindowsAcceptanceCell(cell);
    if (!supportedWindowsBuilds.includes(cell.windowsBuild)) {
      throw new TypeError("windows_release_policy_cell_build_unsupported");
    }
    ids.push(cell.id);
  }
  if (!isDeepStrictEqual(ids, [...new Set(ids)].sort())) {
    throw new TypeError("windows_release_policy_cell_ids_invalid");
  }
  for (const windowsBuild of supportedWindowsBuilds) {
    const buildCells = cells.filter((cell) => cell.windowsBuild === windowsBuild);
    const hasSingle = buildCells.some((cell) => cell.displayTopology === "single");
    const hasRequiredMixedDpi = buildCells.some((cell) =>
      cell.displayTopology === "dual"
      && cell.displayScalePercents.includes(100)
      && cell.displayScalePercents.some((scale) => scale === 150 || scale === 200));
    if (!hasSingle || !hasRequiredMixedDpi) {
      throw new TypeError("windows_release_policy_build_matrix_incomplete");
    }
  }
}

function validateProviderRelease(value) {
  assertExactKeys(value, [
    "repository",
    "component",
    "version",
    "tag",
    "assetName",
    "assetBytes",
    "archiveSha256",
    "providerSha256",
    "providerHelperSha256",
  ], "windows_candidate_provider_release_shape_invalid");
  if (
    value.repository !== WINDOWS_CUA_DRIVER_RELEASE.repository
    || value.component !== WINDOWS_CUA_DRIVER_RELEASE.component
    || value.version !== WINDOWS_CUA_DRIVER_RELEASE.version
    || value.tag !== WINDOWS_CUA_DRIVER_RELEASE.tag
    || value.assetName !== WINDOWS_CUA_DRIVER_RELEASE.assetName
    || value.assetBytes !== WINDOWS_CUA_DRIVER_RELEASE.assetBytes
    || value.archiveSha256 !== WINDOWS_CUA_DRIVER_RELEASE.sha256
    || value.providerSha256 !== WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver.exe"].sha256
    || value.providerHelperSha256 !== WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver-uia.exe"].sha256
  ) {
    throw new TypeError("windows_candidate_provider_release_invalid");
  }
}

function validateDaemonPayload(value, commit) {
  assertExactKeys(
    value,
    ["sourceCommit", "strategy", "treeSha256"],
    "windows_candidate_daemon_payload_shape_invalid",
  );
  if (
    value.sourceCommit !== commit
    || !["deterministic-rebuild", "signed-candidate-embedded-daemon"].includes(value.strategy)
    || !isSha256(value.treeSha256)
  ) {
    throw new TypeError("windows_candidate_daemon_payload_invalid");
  }
}

function validatePackagedProvider(packaged, candidate, tuple) {
  assertExactKeys(packaged, [
    "providerRelativePath",
    "providerSealRelativePath",
    "providerSealSha256",
    "providerCatalogRelativePath",
    "providerCatalogSha256",
    "auditOnlyUiAccessSha256",
    "providerAuthenticodeSignerSubject",
    "providerAuthenticodeCertificateSha256",
  ], "windows_candidate_packaged_provider_shape_invalid");
  const signed = candidate.signingTier !== "unsigned_dev";
  if (
    packaged.providerRelativePath !== WINDOWS_PROVIDER_RELATIVE_PATH
    || packaged.providerSealRelativePath !== WINDOWS_PROVIDER_SEAL_RELATIVE_PATH
    || !isSha256(packaged.providerSealSha256)
    || !isSha256(packaged.auditOnlyUiAccessSha256)
    || (signed && (
      packaged.providerCatalogRelativePath !== WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH
      || !isSha256(packaged.providerCatalogSha256)
      || !nonEmpty(packaged.providerAuthenticodeSignerSubject)
      || !isSha256(packaged.providerAuthenticodeCertificateSha256)
    ))
    || (!signed && (
      packaged.providerCatalogRelativePath !== null
      || packaged.providerCatalogSha256 !== null
      || packaged.providerAuthenticodeSignerSubject !== null
      || packaged.providerAuthenticodeCertificateSha256 !== null
    ))
  ) {
    throw new TypeError("windows_candidate_packaged_provider_invalid");
  }
  if (signed && !tuple.timestampPolicy) {
    throw new TypeError("windows_candidate_packaged_provider_tier_invalid");
  }
}

function validateTierGovernedArtifacts(artifacts, candidate, tuple, policy) {
  assertExactKeys(
    artifacts,
    ["lingApp", "lingInstaller", "lingUninstaller", "provider", "providerCatalog"],
    "windows_candidate_governed_artifacts_shape_invalid",
  );
  const signed = candidate.signingTier !== "unsigned_dev";
  for (const role of ["lingApp", "lingInstaller", "lingUninstaller", "provider"]) {
    validateGovernedArtifact(artifacts[role], { signed, timestampPolicy: tuple.timestampPolicy });
  }
  if (signed) {
    validateGovernedArtifact(artifacts.providerCatalog, {
      signed: true,
      timestampPolicy: tuple.timestampPolicy,
    });
  } else if (artifacts.providerCatalog !== null) {
    throw new TypeError("windows_candidate_unsigned_catalog_present");
  }
  const providerMatchesPreSign =
    artifacts.provider.sha256 === candidate.preSignPayloadSha256;
  if (
    artifacts.lingApp.relativePath !== WINDOWS_LING_APP_RELATIVE_PATH
    || artifacts.lingInstaller.relativePath !==
      WINDOWS_LING_INSTALLER_RELATIVE_PATH
    || artifacts.lingUninstaller.relativePath !==
      WINDOWS_LING_UNINSTALLER_RELATIVE_PATH
    || artifacts.provider.relativePath !== candidate.packagedProvider.providerRelativePath
    || providerMatchesPreSign !== !signed
    || (signed && (
      artifacts.provider.signerSubject !== candidate.packagedProvider.providerAuthenticodeSignerSubject
      || artifacts.provider.certificateSha256 !== candidate.packagedProvider.providerAuthenticodeCertificateSha256
      || artifacts.providerCatalog.relativePath !== candidate.packagedProvider.providerCatalogRelativePath
      || artifacts.providerCatalog.sha256 !== candidate.packagedProvider.providerCatalogSha256
    ))
  ) {
    throw new TypeError("windows_candidate_governed_provider_binding_invalid");
  }
  if (policy) {
    for (const role of ["lingApp", "lingInstaller", "lingUninstaller"]) {
      assertSigner(artifacts[role], policy.lingSignerSubject, policy.lingSignerCertificateSha256);
    }
    assertSigner(artifacts.provider, policy.providerSignerSubject, policy.providerSignerCertificateSha256);
    assertSigner(
      artifacts.providerCatalog,
      policy.catalogSignerSubject,
      policy.catalogSignerCertificateSha256,
    );
  }
}

function validateGovernedArtifact(value, { signed, timestampPolicy }) {
  const expectedKeys = signed
    ? [
        "relativePath",
        "sha256",
        "authenticodeStatus",
        "signerSubject",
        "certificateSha256",
        "timestampPolicy",
        "timestampStatus",
      ]
    : ["relativePath", "sha256", "authenticodeStatus"];
  assertExactKeys(value, expectedKeys, "windows_candidate_governed_artifact_shape_invalid");
  if (!safeRelativePath(value.relativePath) || !isSha256(value.sha256)) {
    throw new TypeError("windows_candidate_governed_artifact_identity_invalid");
  }
  if (signed) {
    if (
      value.authenticodeStatus !== "Valid"
      || !nonEmpty(value.signerSubject)
      || !isSha256(value.certificateSha256)
      || value.timestampPolicy !== timestampPolicy
      || !["NotRequired", "Valid"].includes(value.timestampStatus)
      || (timestampPolicy === "rfc3161-required" && value.timestampStatus !== "Valid")
    ) {
      throw new TypeError("windows_candidate_governed_artifact_signature_invalid");
    }
  } else if (value.authenticodeStatus !== "NotSigned") {
    throw new TypeError("windows_candidate_unsigned_artifact_invalid");
  }
}

function validateVendorNativeInventory(value, reservedPaths) {
  if (!Array.isArray(value)) {
    throw new TypeError("windows_candidate_vendor_inventory_invalid");
  }
  const paths = [];
  const normalizedPaths = [];
  for (const entry of value) {
    assertExactKeys(
      entry,
      ["relativePath", "sha256", "authenticodeStatus", "signerSubject", "certificateSha256"],
      "windows_candidate_vendor_inventory_entry_shape_invalid",
    );
    if (
      !safeRelativePath(entry.relativePath)
      || reservedPaths.has(normalizeWindowsRelativePath(entry.relativePath))
      || !isSha256(entry.sha256)
      || !["Valid", "NotSigned"].includes(entry.authenticodeStatus)
      || (entry.authenticodeStatus === "Valid"
        ? !nonEmpty(entry.signerSubject) || !isSha256(entry.certificateSha256)
        : entry.signerSubject !== null || entry.certificateSha256 !== null)
    ) {
      throw new TypeError("windows_candidate_vendor_inventory_entry_invalid");
    }
    paths.push(entry.relativePath);
    normalizedPaths.push(normalizeWindowsRelativePath(entry.relativePath));
  }
  if (
    !isDeepStrictEqual(paths, [...new Set(paths)].sort())
    || new Set(normalizedPaths).size !== normalizedPaths.length
  ) {
    throw new TypeError("windows_candidate_vendor_inventory_order_invalid");
  }
}

function assertSigningTuple(value, { allowUnsigned, code }) {
  const tuple = SIGNING_TUPLES[value?.signingTier];
  if (
    !tuple
    || (!allowUnsigned && value.signingTier === "unsigned_dev")
    || value.distributionChannel !== tuple.distributionChannel
    || value.productionEligible !== tuple.productionEligible
    || (value.signingTier === "test_signed_internal"
      ? !["ephemeral-ci", "managed-internal"].includes(value.testAuthorityKind)
      : value.testAuthorityKind !== null)
  ) {
    throw new TypeError(code);
  }
  return tuple;
}

function validateAttestorKeys(value, code) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(code);
  }
  for (const entry of value) {
    assertExactKeys(entry, ["id", "keyId", "algorithm", "publicKeySpkiSha256"], code);
    if (
      !nonEmpty(entry.id)
      || !nonEmpty(entry.keyId)
      || entry.algorithm !== "RSA-SHA256"
      || !isSha256(entry.publicKeySpkiSha256)
    ) {
      throw new TypeError(code);
    }
  }
  const sorted = [...value].sort((left, right) =>
    `${left.id}\0${left.keyId}`.localeCompare(`${right.id}\0${right.keyId}`));
  const ids = value.map((entry) => entry.id);
  const keyIds = value.map((entry) => entry.keyId);
  if (
    !isDeepStrictEqual(value, sorted)
    || new Set(ids).size !== ids.length
    || new Set(keyIds).size !== keyIds.length
  ) {
    throw new TypeError(code);
  }
  return value;
}

function assertSigner(artifact, subject, certificateSha256) {
  if (artifact?.signerSubject !== subject || artifact?.certificateSha256 !== certificateSha256) {
    throw new TypeError("windows_candidate_governed_artifact_signer_policy_mismatch");
  }
}

function assertSortedUniqueStrings(value, code) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || !value.every(nonEmpty)
    || !isDeepStrictEqual(value, [...new Set(value)].sort())
  ) {
    throw new TypeError(code);
  }
}

function assertExactKeys(value, expected, code) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  ) {
    throw new TypeError(code);
  }
}

function safeRelativePath(value) {
  return nonEmpty(value)
    && !value.includes("\0")
    && !/^(?:[A-Za-z]:|[/\\])/u.test(value)
    && !value.split(/[\\/]/u).includes("..");
}

function normalizeWindowsRelativePath(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
