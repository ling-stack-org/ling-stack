import {
  WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
  WINDOWS_PROVIDER_RELATIVE_PATH,
  WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
} from "./windows-release-evidence-contracts.mjs";
import { WINDOWS_CUA_DRIVER_RELEASE } from "./verify-windows-cua-driver-provider.mjs";

export const WINDOWS_TEST_COMMIT = "d".repeat(40);
export const WINDOWS_TEST_POLICY_SHA256 = "8".repeat(64);
export const WINDOWS_TEST_LING_CERTIFICATE_SHA256 = "c".repeat(64);
export const WINDOWS_TEST_PROVIDER_CERTIFICATE_SHA256 = "d".repeat(64);
export const WINDOWS_TEST_CATALOG_CERTIFICATE_SHA256 = "e".repeat(64);
export const WINDOWS_TEST_PROVIDER_SHA256 = "3".repeat(64);
export const WINDOWS_TEST_PROVIDER_SEAL_SHA256 = "4".repeat(64);
export const WINDOWS_TEST_PROVIDER_CATALOG_SHA256 = "5".repeat(64);
export const WINDOWS_TEST_UIACCESS_AUDIT_SHA256 =
  WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver-uia.exe"].sha256;
export const WINDOWS_TEST_BUILD = "Windows 11 24H2 build 26100.4652";

export function windowsAcceptanceCellFixture({
  id = "win11-24h2-dual-100-150",
  displayTopology = "dual",
  displayScalePercents = [100, 150],
  windowsBuild = WINDOWS_TEST_BUILD,
} = {}) {
  return {
    id,
    windowsBuild,
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

export function windowsReleasePolicyFixture(options = {}) {
  const production = options.production === true;
  return {
    schemaVersion: 3,
    kind: "ling.windows.release-policy",
    policyVersion: 3,
    status: "approved",
    approvedBy: options.approvedBy ?? "release-owner",
    approvedAt: options.approvedAt ?? "2026-07-17T11:00:00.000Z",
    windowsAcceptanceOwner:
      options.windowsAcceptanceOwner ?? "windows-acceptance-owner",
    requiredSigningTier: production
      ? "production_signed"
      : "test_signed_internal",
    requiredDistributionChannel: production ? "production" : "internal",
    requiredProductionEligible: production,
    requiredTestAuthorityKind: production
      ? null
      : (options.testAuthorityKind ?? "ephemeral-ci"),
    lingSignerSubject:
      options.lingSignerSubject ?? "CN=Ling Stack Test Publisher",
    providerSignerSubject:
      options.providerSignerSubject ?? "CN=Ling Cua Driver Test Publisher",
    catalogSignerSubject:
      options.catalogSignerSubject ??
      "CN=Ling Cua Driver Catalog Test Publisher",
    lingSignerCertificateSha256:
      options.lingSignerCertificateSha256 ??
      WINDOWS_TEST_LING_CERTIFICATE_SHA256,
    providerSignerCertificateSha256:
      options.providerSignerCertificateSha256 ??
      WINDOWS_TEST_PROVIDER_CERTIFICATE_SHA256,
    catalogSignerCertificateSha256:
      options.catalogSignerCertificateSha256 ??
      WINDOWS_TEST_CATALOG_CERTIFICATE_SHA256,
    supportedWindowsBuilds: options.supportedWindowsBuilds ?? [
      WINDOWS_TEST_BUILD,
    ],
    requiredAcceptanceCells: options.requiredAcceptanceCells ?? [
      windowsAcceptanceCellFixture(),
      windowsAcceptanceCellFixture({
        id: "win11-24h2-single-100",
        displayTopology: "single",
        displayScalePercents: [100],
      }),
    ],
    manualEvidenceReviewers: options.manualEvidenceReviewers ?? [
      "manual-reviewer",
    ],
    reviewerKeys: options.reviewerKeys ?? [
      windowsAttestorKeyFixture(
        "manual-reviewer",
        "review-key",
        "1".repeat(64),
      ),
    ],
    candidateBuildAttestors: options.candidateBuildAttestors ?? [
      windowsAttestorKeyFixture(
        "build-service",
        "build-key",
        "2".repeat(64),
      ),
    ],
  };
}

export function windowsCandidateManifestFixture({
  policy,
  bindings,
  commit = WINDOWS_TEST_COMMIT,
  releasePolicySha256 = WINDOWS_TEST_POLICY_SHA256,
  production = false,
} = {}) {
  const resolvedPolicy = policy ?? windowsReleasePolicyFixture({ production });
  const timestampPolicy = production
    ? "rfc3161-required"
    : "internal-policy";
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
  const providerSha256 =
    bindings?.provider?.sha256 ?? WINDOWS_TEST_PROVIDER_SHA256;
  const providerSealSha256 =
    bindings?.providerSeal?.sha256 ?? WINDOWS_TEST_PROVIDER_SEAL_SHA256;
  const providerCatalogSha256 =
    bindings?.providerCatalog?.sha256 ??
    WINDOWS_TEST_PROVIDER_CATALOG_SHA256;
  const provider = governed(
    WINDOWS_PROVIDER_RELATIVE_PATH,
    providerSha256,
    resolvedPolicy.providerSignerSubject,
    resolvedPolicy.providerSignerCertificateSha256,
  );
  const providerCatalog = governed(
    WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
    providerCatalogSha256,
    resolvedPolicy.catalogSignerSubject,
    resolvedPolicy.catalogSignerCertificateSha256,
  );
  return {
    schemaVersion: 4,
    kind: "ling.windows.candidate-manifest",
    commit,
    releasePolicySha256,
    signingTier: production
      ? "production_signed"
      : "test_signed_internal",
    distributionChannel: production ? "production" : "internal",
    productionEligible: production,
    testAuthorityKind: production ? null : "ephemeral-ci",
    preSignPayloadSha256: "6".repeat(64),
    providerRelease: {
      repository: WINDOWS_CUA_DRIVER_RELEASE.repository,
      component: WINDOWS_CUA_DRIVER_RELEASE.component,
      version: WINDOWS_CUA_DRIVER_RELEASE.version,
      tag: WINDOWS_CUA_DRIVER_RELEASE.tag,
      assetName: WINDOWS_CUA_DRIVER_RELEASE.assetName,
      assetBytes: WINDOWS_CUA_DRIVER_RELEASE.assetBytes,
      archiveSha256: WINDOWS_CUA_DRIVER_RELEASE.sha256,
      providerSha256:
        WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver.exe"].sha256,
      providerHelperSha256:
        WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver-uia.exe"].sha256,
    },
    daemonPayload: {
      sourceCommit: commit,
      strategy: "signed-candidate-embedded-daemon",
      treeSha256: "7".repeat(64),
    },
    packagedProvider: {
      providerRelativePath: WINDOWS_PROVIDER_RELATIVE_PATH,
      providerSealRelativePath: WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
      providerSealSha256,
      providerCatalogRelativePath: WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
      providerCatalogSha256,
      auditOnlyUiAccessSha256: WINDOWS_TEST_UIACCESS_AUDIT_SHA256,
      providerAuthenticodeSignerSubject: provider.signerSubject,
      providerAuthenticodeCertificateSha256: provider.certificateSha256,
    },
    tierGovernedArtifacts: {
      lingApp: governed(
        "Ling Stack.exe",
        bindings?.lingApp?.sha256 ?? "a".repeat(64),
        resolvedPolicy.lingSignerSubject,
        resolvedPolicy.lingSignerCertificateSha256,
      ),
      lingInstaller: governed(
        "Ling Stack Setup.exe",
        bindings?.lingInstaller?.sha256 ?? "b".repeat(64),
        resolvedPolicy.lingSignerSubject,
        resolvedPolicy.lingSignerCertificateSha256,
      ),
      lingUninstaller: governed(
        "Uninstall Ling Stack.exe",
        bindings?.lingUninstaller?.sha256 ?? "9".repeat(64),
        resolvedPolicy.lingSignerSubject,
        resolvedPolicy.lingSignerCertificateSha256,
      ),
      provider,
      providerCatalog,
    },
    vendorNativeInventory: [
      {
        relativePath: "resources/vendor/native.dll",
        sha256: "f".repeat(64),
        authenticodeStatus: "Valid",
        signerSubject: "CN=Electron Vendor",
        certificateSha256: "0".repeat(64),
      },
    ],
  };
}

export function windowsReleasePolicyReferenceFixture(
  policy,
  { path = "C:\\candidate\\windows-release-policy.json", sha256 } = {},
) {
  return {
    path,
    sha256: sha256 ?? WINDOWS_TEST_POLICY_SHA256,
    verified: true,
    ...structuredClone(policy),
    error: null,
  };
}

export function windowsCandidateManifestReferenceFixture(
  candidate,
  { path = "C:\\candidate\\candidate-manifest.json", sha256 } = {},
) {
  return {
    path,
    sha256: sha256 ?? "f".repeat(64),
    verified: true,
    ...structuredClone(candidate),
    error: null,
  };
}

export function windowsProviderVerificationReportFixture({
  candidate,
  provider,
  providerSeal,
  providerCatalog,
  providerLockSha256 = "1".repeat(64),
}) {
  const governedProvider = candidate.tierGovernedArtifacts.provider;
  const governedCatalog = candidate.tierGovernedArtifacts.providerCatalog;
  const providerLockPath = provider.path
    .replaceAll("\\", "/")
    .replace(
      /\/win32-x64\/payload\/ling-cua-driver\.exe$/u,
      "/provider-lock.json",
    );
  return {
    schemaVersion: 2,
    mode: "installed_bundled_provider_read_only",
    versionProbe: {
      checked: true,
      expectedVersion: "0.8.3",
      output: "cua-driver 0.8.3",
    },
    provider: {
      name: "ling-cua-driver.exe",
      path: provider.path,
      sha256: provider.sha256,
    },
    providerLock: {
      path: providerLockPath,
      sha256: providerLockSha256,
      componentId: "cua-driver-win32-x64",
      sourceTarget: "x86_64-pc-windows-msvc",
      sourceBuild: {
        target: "x86_64-pc-windows-msvc",
        binariesSha256BeforeSigning: {
          main: candidate.preSignPayloadSha256,
        },
      },
    },
    providerSeal: {
      path: providerSeal.path,
      sha256: providerSeal.sha256,
      schemaVersion: 2,
      componentId: "cua-driver-win32-x64",
      lockSha256: providerLockSha256,
      signingTier: candidate.signingTier,
      distributionChannel: candidate.distributionChannel,
      productionEligible: candidate.productionEligible,
      ...(candidate.testAuthorityKind === null
        ? {}
        : { testAuthorityKind: candidate.testAuthorityKind }),
      main: {
        relativePath: "payload/ling-cua-driver.exe",
        architecture: "x86_64",
        sha256: provider.sha256,
        peManifestCanonicalSha256: "a".repeat(64),
        authenticodeStatus: governedProvider.authenticodeStatus,
        signerSubject: governedProvider.signerSubject,
        certificateSha256: governedProvider.certificateSha256,
        timestampPolicy: governedProvider.timestampPolicy,
        timestampStatus: governedProvider.timestampStatus,
      },
    },
    providerCatalog: {
      path: providerCatalog.path,
      sha256: providerCatalog.sha256,
      membership: {
        checked: true,
        validationStatus: "Valid",
        members: [
          {
            relativePath: "payload/ling-cua-driver.exe",
            sha256: provider.sha256,
          },
          {
            relativePath: "payload/provider-seal.json",
            sha256: providerSeal.sha256,
          },
        ],
      },
    },
    uiAccessHelper: {
      path: provider.path.replace(/ling-cua-driver\.exe$/u, "cua-driver-uia.exe"),
      packaged: false,
      exists: false,
    },
    packageLayout: {
      distributionRootEntryNames: ["provider-lock.json", "win32-x64"],
      platformRootEntryNames: ["payload", "provider-integrity.cat"],
      payloadFileNames: ["ling-cua-driver.exe", "provider-seal.json"],
      unexpectedPaths: [],
    },
    authenticode: {
      checked: true,
      trustRequired: true,
      files: [
        {
          path: provider.path,
          status: governedProvider.authenticodeStatus,
          signerSubject: governedProvider.signerSubject,
          certificateSha256: governedProvider.certificateSha256,
          timestampStatus: governedProvider.timestampStatus,
        },
        {
          path: providerCatalog.path,
          status: governedCatalog.authenticodeStatus,
          signerSubject: governedCatalog.signerSubject,
          certificateSha256: governedCatalog.certificateSha256,
          timestampStatus: governedCatalog.timestampStatus,
        },
      ],
    },
  };
}

export function windowsAttestorKeyFixture(id, keyId, publicKeySpkiSha256) {
  return { id, keyId, algorithm: "RSA-SHA256", publicKeySpkiSha256 };
}
