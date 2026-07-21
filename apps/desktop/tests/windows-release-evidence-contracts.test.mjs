import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
  WINDOWS_PROVIDER_RELATIVE_PATH,
  WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
  validateWindowsCandidateManifestDocument,
  validateWindowsReleasePolicyDocument,
} from "./windows-release-evidence-contracts.mjs";
import { WINDOWS_CUA_DRIVER_RELEASE } from "./verify-windows-cua-driver-provider.mjs";

const COMMIT = "a".repeat(40);
const POLICY_SHA = "b".repeat(64);
const LING_CERT = "c".repeat(64);
const PROVIDER_CERT = "d".repeat(64);
const CATALOG_CERT = "e".repeat(64);

test("internal policy and candidate bind the exact signed standard tuple", () => {
  const policy = policyFixture();
  const candidate = candidateFixture({ policy });

  assert.equal(validateWindowsReleasePolicyDocument(policy), policy);
  assert.equal(validateWindowsCandidateManifestDocument(candidate, {
    policy,
    expectedCommit: COMMIT,
    expectedReleasePolicySha256: POLICY_SHA,
  }), candidate);
});

test("policy and candidate JSON Schemas accept the runtime fixtures and reject tuple drift", async () => {
  const policy = policyFixture();
  const candidate = candidateFixture({ policy });
  const validatePolicy = await schemaValidator("windows-release-policy.schema.json");
  const validateCandidate = await schemaValidator("windows-candidate-manifest.schema.json");
  assert.equal(validatePolicy(policy), true, JSON.stringify(validatePolicy.errors));
  assert.equal(
    validateCandidate(candidate),
    true,
    JSON.stringify(validateCandidate.errors),
  );

  const crossedPolicy = structuredClone(policy);
  crossedPolicy.requiredDistributionChannel = "production";
  assert.equal(validatePolicy(crossedPolicy), false);
  const crossedCandidate = structuredClone(candidate);
  crossedCandidate.productionEligible = true;
  assert.equal(validateCandidate(crossedCandidate), false);
});

test("production policy requires production tier, eligibility, and RFC 3161 timestamps", () => {
  const policy = policyFixture({ production: true });
  const candidate = candidateFixture({ policy, production: true });
  validateWindowsReleasePolicyDocument(policy);
  validateWindowsCandidateManifestDocument(candidate, { policy });

  const wrongTimestamp = structuredClone(candidate);
  wrongTimestamp.tierGovernedArtifacts.provider.timestampStatus = "NotRequired";
  assert.throws(
    () => validateWindowsCandidateManifestDocument(wrongTimestamp, { policy }),
    /governed_artifact_signature_invalid/u,
  );
});

test("policy requires a single-display and 100-plus mixed-DPI dual cell per build", () => {
  const missingMixedDpi = policyFixture();
  missingMixedDpi.requiredAcceptanceCells[0].displayScalePercents = [150, 200];
  assert.throws(
    () => validateWindowsReleasePolicyDocument(missingMixedDpi),
    /build_matrix_incomplete/u,
  );

  const unsupported = policyFixture();
  unsupported.requiredAcceptanceCells[0].windowsBuild = "Windows 10 unsupported";
  assert.throws(
    () => validateWindowsReleasePolicyDocument(unsupported),
    /cell_build_unsupported/u,
  );

  const misspelledEvidenceKind = policyFixture();
  misspelledEvidenceKind.requiredAcceptanceCells[0].requiredEvidenceKinds[0] =
    "accessibilty";
  assert.throws(
    () => validateWindowsReleasePolicyDocument(misspelledEvidenceKind),
    /evidence_kinds_invalid/u,
  );
});

test("candidate cannot cross an internal policy into another tier or channel", () => {
  const policy = policyFixture();
  for (const mutate of [
    (candidate) => { candidate.signingTier = "production_signed"; },
    (candidate) => { candidate.distributionChannel = "production"; },
    (candidate) => { candidate.productionEligible = true; },
    (candidate) => { candidate.testAuthorityKind = null; },
  ]) {
    const candidate = candidateFixture({ policy });
    mutate(candidate);
    assert.throws(
      () => validateWindowsCandidateManifestDocument(candidate, { policy }),
      /signing_tuple_invalid|policy_tuple_mismatch/u,
    );
  }
});

test("candidate validation requires caller-fixed commit and policy digest anchors", () => {
  const policy = policyFixture();
  const candidate = candidateFixture({ policy });
  assert.throws(
    () => validateWindowsCandidateManifestDocument(candidate, {
      policy,
      expectedCommit: "0".repeat(40),
      expectedReleasePolicySha256: POLICY_SHA,
    }),
    /windows_candidate_manifest_commit_mismatch/u,
  );
  assert.throws(
    () => validateWindowsCandidateManifestDocument(candidate, {
      policy,
      expectedCommit: COMMIT,
      expectedReleasePolicySha256: "0".repeat(64),
    }),
    /windows_candidate_manifest_policy_digest_mismatch/u,
  );
});

test("candidate binds final provider and catalog identity to policy signers", () => {
  const policy = policyFixture();
  const wrongProvider = candidateFixture({ policy });
  wrongProvider.tierGovernedArtifacts.provider.certificateSha256 = "0".repeat(64);
  wrongProvider.packagedProvider.providerAuthenticodeCertificateSha256 = "0".repeat(64);
  assert.throws(
    () => validateWindowsCandidateManifestDocument(wrongProvider, { policy }),
    /signer_policy_mismatch/u,
  );

  const wrongCatalog = candidateFixture({ policy });
  wrongCatalog.packagedProvider.providerCatalogSha256 = "0".repeat(64);
  assert.throws(
    () => validateWindowsCandidateManifestDocument(wrongCatalog, { policy }),
    /governed_provider_binding_invalid/u,
  );
});

test("signed candidate cannot reuse clean pre-sign bytes as its final PE", () => {
  const policy = policyFixture();
  const candidate = candidateFixture({ policy });
  candidate.preSignPayloadSha256 = candidate.tierGovernedArtifacts.provider.sha256;
  assert.throws(
    () => validateWindowsCandidateManifestDocument(candidate, { policy }),
    /governed_provider_binding_invalid/u,
  );
});

test("vendor native inventory is canonical, relative, and signer-coherent", () => {
  const policy = policyFixture();
  const traversal = candidateFixture({ policy });
  traversal.vendorNativeInventory[0].relativePath = "../outside.dll";
  assert.throws(
    () => validateWindowsCandidateManifestDocument(traversal, { policy }),
    /vendor_inventory_entry_invalid/u,
  );

  const unsignedWithSigner = candidateFixture({ policy });
  unsignedWithSigner.vendorNativeInventory[0].authenticodeStatus = "NotSigned";
  assert.throws(
    () => validateWindowsCandidateManifestDocument(unsignedWithSigner, { policy }),
    /vendor_inventory_entry_invalid/u,
  );

  const governedPathCollision = candidateFixture({ policy });
  governedPathCollision.vendorNativeInventory[0].relativePath =
    "ling stack.exe";
  assert.throws(
    () => validateWindowsCandidateManifestDocument(governedPathCollision, { policy }),
    /vendor_inventory_entry_invalid/u,
  );

  const caseInsensitiveDuplicate = candidateFixture({ policy });
  caseInsensitiveDuplicate.vendorNativeInventory.push({
    ...structuredClone(caseInsensitiveDuplicate.vendorNativeInventory[0]),
    relativePath: "resources/VENDOR/native.dll",
  });
  assert.throws(
    () => validateWindowsCandidateManifestDocument(caseInsensitiveDuplicate, { policy }),
    /vendor_inventory_order_invalid/u,
  );
});

function policyFixture({ production = false } = {}) {
  return {
    schemaVersion: 3,
    kind: "ling.windows.release-policy",
    policyVersion: 3,
    status: "approved",
    approvedBy: "release-owner",
    approvedAt: "2026-07-21T00:00:00.000Z",
    windowsAcceptanceOwner: "windows-acceptance-owner",
    requiredSigningTier: production ? "production_signed" : "test_signed_internal",
    requiredDistributionChannel: production ? "production" : "internal",
    requiredProductionEligible: production,
    requiredTestAuthorityKind: production ? null : "ephemeral-ci",
    lingSignerSubject: "CN=Ling Stack Test Publisher",
    providerSignerSubject: "CN=Ling Cua Driver Test Publisher",
    catalogSignerSubject: "CN=Ling Cua Driver Catalog Test Publisher",
    lingSignerCertificateSha256: LING_CERT,
    providerSignerCertificateSha256: PROVIDER_CERT,
    catalogSignerCertificateSha256: CATALOG_CERT,
    supportedWindowsBuilds: ["Windows 11 24H2 build 26100.4652"],
    requiredAcceptanceCells: [
      acceptanceCell("win11-24h2-dual-100-150", "dual", [100, 150]),
      acceptanceCell("win11-24h2-single-100", "single", [100]),
    ],
    manualEvidenceReviewers: ["manual-reviewer"],
    reviewerKeys: [attestorKey("manual-reviewer", "review-key", "1".repeat(64))],
    candidateBuildAttestors: [attestorKey("build-service", "build-key", "2".repeat(64))],
  };
}

function acceptanceCell(id, displayTopology, displayScalePercents) {
  return {
    id,
    windowsBuild: "Windows 11 24H2 build 26100.4652",
    architecture: "x64",
    displayTopology,
    displayScalePercents,
    requiredEvidenceKinds: [
      "accessibility",
      "display",
      "install-lifecycle",
      "provider-runtime",
    ],
  };
}

function attestorKey(id, keyId, publicKeySpkiSha256) {
  return { id, keyId, algorithm: "RSA-SHA256", publicKeySpkiSha256 };
}

function candidateFixture({ policy, production = false }) {
  const timestampPolicy = production ? "rfc3161-required" : "internal-policy";
  const timestampStatus = production ? "Valid" : "NotRequired";
  const governed = (relativePath, sha256, signerSubject, certificateSha256) => ({
    relativePath,
    sha256,
    authenticodeStatus: "Valid",
    signerSubject,
    certificateSha256,
    timestampPolicy,
    timestampStatus,
  });
  const provider = governed(
    WINDOWS_PROVIDER_RELATIVE_PATH,
    "3".repeat(64),
    policy.providerSignerSubject,
    policy.providerSignerCertificateSha256,
  );
  const catalog = governed(
    WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
    "4".repeat(64),
    policy.catalogSignerSubject,
    policy.catalogSignerCertificateSha256,
  );
  return {
    schemaVersion: 4,
    kind: "ling.windows.candidate-manifest",
    commit: COMMIT,
    releasePolicySha256: POLICY_SHA,
    signingTier: production ? "production_signed" : "test_signed_internal",
    distributionChannel: production ? "production" : "internal",
    productionEligible: production,
    testAuthorityKind: production ? null : "ephemeral-ci",
    preSignPayloadSha256: "5".repeat(64),
    providerRelease: {
      repository: WINDOWS_CUA_DRIVER_RELEASE.repository,
      component: WINDOWS_CUA_DRIVER_RELEASE.component,
      version: WINDOWS_CUA_DRIVER_RELEASE.version,
      tag: WINDOWS_CUA_DRIVER_RELEASE.tag,
      assetName: WINDOWS_CUA_DRIVER_RELEASE.assetName,
      assetBytes: WINDOWS_CUA_DRIVER_RELEASE.assetBytes,
      archiveSha256: WINDOWS_CUA_DRIVER_RELEASE.sha256,
      providerSha256: WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver.exe"].sha256,
      providerHelperSha256: WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver-uia.exe"].sha256,
    },
    daemonPayload: {
      sourceCommit: COMMIT,
      strategy: "signed-candidate-embedded-daemon",
      treeSha256: "6".repeat(64),
    },
    packagedProvider: {
      providerRelativePath: WINDOWS_PROVIDER_RELATIVE_PATH,
      providerSealRelativePath: WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
      providerSealSha256: "7".repeat(64),
      providerCatalogRelativePath: WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
      providerCatalogSha256: catalog.sha256,
      auditOnlyUiAccessSha256: "8".repeat(64),
      providerAuthenticodeSignerSubject: provider.signerSubject,
      providerAuthenticodeCertificateSha256: provider.certificateSha256,
    },
    tierGovernedArtifacts: {
      lingApp: governed(
        "Ling Stack.exe",
        "9".repeat(64),
        policy.lingSignerSubject,
        policy.lingSignerCertificateSha256,
      ),
      lingInstaller: governed(
        "Ling Stack Setup.exe",
        "a".repeat(64),
        policy.lingSignerSubject,
        policy.lingSignerCertificateSha256,
      ),
      lingUninstaller: governed(
        "Uninstall Ling Stack.exe",
        "b".repeat(64),
        policy.lingSignerSubject,
        policy.lingSignerCertificateSha256,
      ),
      provider,
      providerCatalog: catalog,
    },
    vendorNativeInventory: [
      {
        relativePath: "resources/vendor/native.dll",
        sha256: "c".repeat(64),
        authenticodeStatus: "Valid",
        signerSubject: "CN=Vendor",
        certificateSha256: "d".repeat(64),
      },
    ],
  };
}

async function schemaValidator(name) {
  const schema = JSON.parse(
    await readFile(
      new URL(`../../../docs/release/evidence/${name}`, import.meta.url),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}
