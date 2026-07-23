import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";

import {
  WINDOWS_RELEASE_HARNESS_FILES,
} from "./windows-acceptance-report.mjs";
import {
  WINDOWS_HANDOFF_ARTIFACT_ROLES,
  validateWindowsCellHandoffDocument,
  validateWindowsHandoffIndexDocument,
} from "./windows-handoff-contracts.mjs";
import {
  WINDOWS_CANDIDATE_MANIFEST_KIND,
  WINDOWS_CANDIDATE_MANIFEST_VERSION,
  WINDOWS_LING_APP_RELATIVE_PATH,
  WINDOWS_LING_INSTALLER_RELATIVE_PATH,
  WINDOWS_LING_UNINSTALLER_RELATIVE_PATH,
  WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
  WINDOWS_PROVIDER_RELATIVE_PATH,
  WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
  validateWindowsCandidateManifestDocument,
  validateWindowsReleasePolicyDocument,
} from "./windows-release-evidence-contracts.mjs";
import { WINDOWS_CUA_DRIVER_RELEASE } from "./verify-windows-cua-driver-provider.mjs";

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const CANDIDATE_SOURCE_KIND = "ling.windows.candidate-production-input";
const EVIDENCE_MAP_KIND = "ling.windows.acceptance-evidence-map";
const SIGNED_ARTIFACT_ROLES = Object.freeze([
  "lingApp",
  "lingInstaller",
  "lingUninstaller",
  "provider",
  "providerCatalog",
]);
const MANUAL_EVIDENCE_ROLES = Object.freeze([
  "windowsVersion",
  "display",
  "narrator",
  "nvda",
  "smartScreen",
  "installLifecycle",
]);
const MANUAL_EVIDENCE_KINDS = Object.freeze({
  windowsVersion: "ling.windows.full-evidence.windows-version",
  display: "ling.windows.full-evidence.display",
  narrator: "ling.windows.full-evidence.narrator",
  nvda: "ling.windows.full-evidence.nvda",
  smartScreen: "ling.windows.full-evidence.smartscreen",
  installLifecycle: "ling.windows.full-evidence.install-lifecycle",
});
const HANDOFF_ARTIFACT_DESTINATIONS = Object.freeze({
  lingApp: `candidate/artifacts/${WINDOWS_LING_APP_RELATIVE_PATH}`,
  lingInstaller: `candidate/artifacts/${WINDOWS_LING_INSTALLER_RELATIVE_PATH}`,
  lingUninstaller:
    `candidate/artifacts/${WINDOWS_LING_UNINSTALLER_RELATIVE_PATH}`,
  provider:
    "candidate/artifacts/provider/0.8.3-ling.1/win32-x64/payload/cua-driver.exe",
  providerSeal:
    "candidate/artifacts/provider/0.8.3-ling.1/win32-x64/payload/provider-seal.json",
  providerCatalog:
    "candidate/artifacts/provider/0.8.3-ling.1/win32-x64/provider-integrity.cat",
});
const HANDOFF_PUBLICATION_DIRECTORIES = Object.freeze([
  "repository",
  "candidate",
  "evidence",
  "cells",
  "reports",
]);
const HANDOFF_READY_ENTRY = "handoff-index.json";

export const WINDOWS_HANDOFF_REQUIRED_TOOL_VERSIONS = Object.freeze({
  node: ">=22.0.0",
  powershell: ">=7.4.0",
  git: ">=2.45.0",
});

export async function writeWindowsCandidateManifest(input) {
  const prepared = await prepareWindowsCandidate(input);
  const outputPath = resolveRequiredPath(input?.outputPath, "candidate_output");
  await mkdir(dirname(outputPath), { recursive: true });
  const bytes = candidateBytes(prepared.candidate);
  await writeFile(outputPath, bytes, { encoding: "utf8", flag: "wx" });
  return Object.freeze({
    path: outputPath,
    sha256: sha256Bytes(bytes),
    candidate: prepared.candidate,
  });
}

export async function produceWindowsAcceptanceHandoff(input) {
  const outputRoot = resolveRequiredPath(input?.outputRoot, "handoff_output_root");
  await assertPathDoesNotExist(outputRoot, "windows_handoff_output_exists");
  const prepared = await prepareWindowsCandidate(input);
  const candidateFile = await readJsonFile(
    resolveRequiredPath(input?.candidateManifestPath, "candidate_manifest"),
    "candidate_manifest",
  );
  validateWindowsCandidateManifestDocument(candidateFile.document, {
    policy: prepared.policy,
    expectedCommit: prepared.commit,
    expectedReleasePolicySha256: prepared.policySha256,
  });
  if (!isDeepStrictEqual(candidateFile.document, prepared.candidate)) {
    throw new TypeError("windows_handoff_candidate_source_drift");
  }
  const evidenceMapFile = await readJsonFile(
    resolveRequiredPath(input?.evidenceMapPath, "evidence_map"),
    "evidence_map",
  );
  const evidenceMap = validateEvidenceMap(
    evidenceMapFile.document,
    prepared.policy,
  );
  const parent = dirname(outputRoot);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(
    join(parent, `.${basename(outputRoot)}.staging-`),
  );
  try {
    const repositoryRoot = join(stagingRoot, "repository");
    await cloneCandidateRepository({
      gitExecutable: prepared.gitExecutable,
      sourceRoot: prepared.repositoryRoot,
      destinationRoot: repositoryRoot,
      commit: prepared.commit,
    });
    const harnessFiles = await collectHarnessFiles(repositoryRoot);

    const candidateDirectory = join(stagingRoot, "candidate");
    await mkdir(candidateDirectory, { recursive: true });
    const policyPath = join(candidateDirectory, "windows-release-policy.json");
    const candidatePath = join(candidateDirectory, "candidate-manifest.json");
    await writeFile(policyPath, prepared.policyFile.bytes, { flag: "wx" });
    await writeFile(candidatePath, candidateFile.bytes, { flag: "wx" });

    const artifactReferences = {};
    for (const role of WINDOWS_HANDOFF_ARTIFACT_ROLES) {
      const destination = join(
        stagingRoot,
        ...HANDOFF_ARTIFACT_DESTINATIONS[role].split("/"),
      );
      await copyRegularFile(prepared.artifactPaths[role], destination);
      const sha256 = await sha256File(destination);
      if (sha256 !== prepared.artifactDigests[role]) {
        throw new TypeError(`windows_handoff_artifact_copy_mismatch:${role}`);
      }
      artifactReferences[role] = fileReference(stagingRoot, destination, sha256);
    }
    const candidateArtifactRoot = join(stagingRoot, "candidate", "artifacts");
    for (const entry of prepared.vendorNativeArtifacts) {
      const destination = resolve(candidateArtifactRoot, entry.relativePath);
      assertInside(
        candidateArtifactRoot,
        destination,
        `vendor_native_destination_${entry.relativePath}`,
      );
      await copyRegularFile(entry.path, destination);
      if ((await sha256File(destination)) !== entry.sha256) {
        throw new TypeError(
          `windows_handoff_vendor_native_copy_mismatch:${entry.relativePath}`,
        );
      }
    }

    const cellDirectory = join(stagingRoot, "cells");
    const reportDirectory = join(stagingRoot, "reports");
    const evidenceDirectory = join(stagingRoot, "evidence");
    await Promise.all([
      mkdir(cellDirectory),
      mkdir(reportDirectory),
      mkdir(evidenceDirectory),
    ]);

    const index = validateWindowsHandoffIndexDocument({
      schemaVersion: 1,
      kind: "ling.windows.handoff-index",
      createdAt: normalizeNow(input?.now),
      candidateCommit: prepared.commit,
      signingTier: prepared.candidate.signingTier,
      distributionChannel: prepared.candidate.distributionChannel,
      productionEligible: prepared.candidate.productionEligible,
      testAuthorityKind: prepared.candidate.testAuthorityKind,
      candidateManifest: fileReference(
        stagingRoot,
        candidatePath,
        candidateFile.sha256,
      ),
      releasePolicy: fileReference(
        stagingRoot,
        policyPath,
        prepared.policySha256,
      ),
      artifacts: artifactReferences,
      harness: { commit: prepared.commit, files: harnessFiles },
      cellManifestDirectory: "cells",
      reportDirectory: "reports",
      requiredAcceptanceCells: structuredClone(
        prepared.policy.requiredAcceptanceCells,
      ),
    });
    const indexPath = join(stagingRoot, "handoff-index.json");
    const indexBytes = jsonBytes(index);
    await writeFile(indexPath, indexBytes, { encoding: "utf8", flag: "wx" });
    const indexSha256 = sha256Bytes(indexBytes);

    const evidenceByCell = new Map(
      evidenceMap.cells.map((entry) => [entry.cellId, entry]),
    );
    const manifestPaths = [];
    const evidenceDigests = new Set();
    const attachmentDigests = new Set();
    for (const cell of prepared.policy.requiredAcceptanceCells) {
      const evidenceEntry = evidenceByCell.get(cell.id);
      const manualEvidence = {};
      for (const role of MANUAL_EVIDENCE_ROLES) {
        const sourceReference = evidenceEntry.manualEvidence[role];
        if (sourceReference === null) {
          manualEvidence[role] = null;
          continue;
        }
        const copied = await copyManualEvidence({
          role,
          sourcePath: await resolveSourceRegularFile(
            dirname(evidenceMapFile.path),
            sourceReference,
            `manual_evidence_${cell.id}_${role}`,
          ),
          destinationRoot: join(evidenceDirectory, cell.id, role),
          candidateManifestSha256: candidateFile.sha256,
          cell,
          policy: prepared.policy,
          evidenceDigests,
          attachmentDigests,
        });
        manualEvidence[role] = copied;
      }

      const runId = (input?.randomUUID ?? randomUUID)();
      const manifestPath = join(cellDirectory, `${cell.id}.json`);
      const outputReportPath = join(reportDirectory, `${cell.id}-${runId}.json`);
      const manifest = validateWindowsCellHandoffDocument({
        schemaVersion: 1,
        kind: "ling.windows.cell-handoff",
        runId,
        handoffIndex: manifestFileReference(
          manifestPath,
          indexPath,
          indexSha256,
        ),
        cell: structuredClone(cell),
        expected: {
          candidateCommit: prepared.commit,
          candidateManifestSha256: candidateFile.sha256,
          releasePolicySha256: prepared.policySha256,
          handoffIndexSha256: indexSha256,
          signingTier: prepared.candidate.signingTier,
          distributionChannel: prepared.candidate.distributionChannel,
          productionEligible: prepared.candidate.productionEligible,
          testAuthorityKind: prepared.candidate.testAuthorityKind,
          artifacts: Object.fromEntries(
            WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
              role,
              prepared.artifactDigests[role],
            ]),
          ),
          harnessCommit: prepared.commit,
        },
        inputs: {
          repositoryRoot: portableRelative(dirname(manifestPath), repositoryRoot),
          candidateManifest: manifestFileReference(
            manifestPath,
            candidatePath,
            candidateFile.sha256,
          ),
          releasePolicy: manifestFileReference(
            manifestPath,
            policyPath,
            prepared.policySha256,
          ),
          ...Object.fromEntries(
            WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
              role,
              manifestFileReference(
                manifestPath,
                join(
                  stagingRoot,
                  ...HANDOFF_ARTIFACT_DESTINATIONS[role].split("/"),
                ),
                prepared.artifactDigests[role],
              ),
            ]),
          ),
          manualEvidence: Object.fromEntries(
            Object.entries(manualEvidence).map(([role, reference]) => [
              role,
              reference
                ? manifestFileReference(
                    manifestPath,
                    reference.path,
                    reference.sha256,
                  )
                : null,
            ]),
          ),
        },
        outputReport: {
          path: portableRelative(dirname(manifestPath), outputReportPath),
        },
        requiredToolVersions: {
          ...WINDOWS_HANDOFF_REQUIRED_TOOL_VERSIONS,
        },
      });
      await writeFile(manifestPath, jsonBytes(manifest), {
        encoding: "utf8",
        flag: "wx",
      });
      manifestPaths.push(manifestPath);
    }

    await publishWindowsAcceptanceHandoffRoot(stagingRoot, outputRoot);
    return Object.freeze({
      root: outputRoot,
      indexPath: join(outputRoot, "handoff-index.json"),
      indexSha256,
      candidateManifestPath: join(
        outputRoot,
        "candidate",
        "candidate-manifest.json",
      ),
      candidateManifestSha256: candidateFile.sha256,
      releasePolicyPath: join(
        outputRoot,
        "candidate",
        "windows-release-policy.json",
      ),
      releasePolicySha256: prepared.policySha256,
      cellManifestPaths: manifestPaths.map((path) =>
        join(outputRoot, relative(stagingRoot, path))),
    });
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function publishWindowsAcceptanceHandoffRoot(
  stagingRoot,
  outputRoot,
) {
  const expectedEntries = [
    ...HANDOFF_PUBLICATION_DIRECTORIES,
    HANDOFF_READY_ENTRY,
  ].sort();
  const stagingEntries = (await readdir(stagingRoot)).sort();
  if (!isDeepStrictEqual(stagingEntries, expectedEntries)) {
    throw new TypeError("windows_handoff_staging_shape_invalid");
  }

  try {
    // mkdir is the cross-platform no-replace primitive. A plain directory
    // rename can replace a concurrently-created empty directory on POSIX.
    await mkdir(outputRoot);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new TypeError("windows_handoff_output_exists");
    }
    throw error;
  }

  try {
    for (const entry of HANDOFF_PUBLICATION_DIRECTORIES) {
      await rename(join(stagingRoot, entry), join(outputRoot, entry));
    }
    // Consumers require the index, so publishing it last is the ready boundary.
    await rename(
      join(stagingRoot, HANDOFF_READY_ENTRY),
      join(outputRoot, HANDOFF_READY_ENTRY),
    );
    await rm(stagingRoot, { recursive: true });
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

async function prepareWindowsCandidate(input) {
  const repositoryRoot = await realpath(
    resolveRequiredPath(input?.repositoryRoot, "repository_root"),
  );
  const gitExecutable = await resolveRegularFile(
    resolveRequiredPath(input?.gitExecutable, "git_executable"),
    "git_executable",
  );
  const commit = await readCleanRepositoryCommit(
    gitExecutable,
    repositoryRoot,
  );
  const policyFile = await readJsonFile(
    resolveRequiredPath(input?.releasePolicyPath, "release_policy"),
    "release_policy",
  );
  const policy = validateWindowsReleasePolicyDocument(policyFile.document);
  const sourceFile = await readJsonFile(
    resolveRequiredPath(input?.candidateSourcePath, "candidate_source"),
    "candidate_source",
  );
  const source = validateCandidateSource(sourceFile.document);
  const sourceDirectory = dirname(sourceFile.path);
  const policySha256 = policyFile.sha256;
  const artifactPaths = {};
  for (const role of WINDOWS_HANDOFF_ARTIFACT_ROLES) {
    artifactPaths[role] = await resolveSourceRegularFile(
      sourceDirectory,
      source.artifacts[role].path,
      `artifact_${role}`,
    );
  }
  const preSignProviderPath = await resolveSourceRegularFile(
    sourceDirectory,
    source.preSignProvider.path,
    "pre_sign_provider",
  );
  const auditOnlyUiAccessPath = await resolveSourceRegularFile(
    sourceDirectory,
    source.auditOnlyUiAccess.path,
    "audit_only_uiaccess",
  );
  const artifactDigests = Object.fromEntries(
    await Promise.all(
      WINDOWS_HANDOFF_ARTIFACT_ROLES.map(async (role) => [
        role,
        await sha256File(artifactPaths[role]),
      ]),
    ),
  );
  const preSignPayloadSha256 = await sha256File(preSignProviderPath);
  const auditOnlyUiAccessSha256 = await sha256File(auditOnlyUiAccessPath);
  const timestampPolicy = policy.requiredSigningTier === "production_signed"
    ? "rfc3161-required"
    : "internal-policy";

  const governedArtifacts = {};
  for (const role of SIGNED_ARTIFACT_ROLES) {
    const expectedSubject = role === "provider"
      ? policy.providerSignerSubject
      : role === "providerCatalog"
        ? policy.catalogSignerSubject
        : policy.lingSignerSubject;
    const expectedCertificateSha256 = role === "provider"
      ? policy.providerSignerCertificateSha256
      : role === "providerCatalog"
        ? policy.catalogSignerCertificateSha256
        : policy.lingSignerCertificateSha256;
    governedArtifacts[role] = governedArtifact(
      source.artifacts[role],
      artifactDigests[role],
      timestampPolicy,
      expectedSubject,
      expectedCertificateSha256,
      role,
    );
  }

  const vendorNativeInventory = [];
  const vendorNativeArtifacts = [];
  for (const [index, entry] of source.vendorNativeInventory.entries()) {
    const path = await resolveSourceRegularFile(
      sourceDirectory,
      entry.path,
      `vendor_native_${index}`,
    );
    const signature = validateObservedSignature(
      entry.signature,
      `vendor_native_${index}`,
      { allowUnsigned: true, timestampRequired: false },
    );
    const sha256 = await sha256File(path);
    vendorNativeInventory.push({
      relativePath: entry.relativePath,
      sha256,
      authenticodeStatus: signature.authenticodeStatus,
      signerSubject: signature.signerSubject,
      certificateSha256: signature.certificateSha256,
    });
    vendorNativeArtifacts.push({ path, relativePath: entry.relativePath, sha256 });
  }
  vendorNativeInventory.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath));

  const candidate = validateWindowsCandidateManifestDocument({
    schemaVersion: WINDOWS_CANDIDATE_MANIFEST_VERSION,
    kind: WINDOWS_CANDIDATE_MANIFEST_KIND,
    commit,
    releasePolicySha256: policySha256,
    signingTier: policy.requiredSigningTier,
    distributionChannel: policy.requiredDistributionChannel,
    productionEligible: policy.requiredProductionEligible,
    testAuthorityKind: policy.requiredTestAuthorityKind,
    preSignPayloadSha256,
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
      strategy: source.daemonPayload.strategy,
      treeSha256: source.daemonPayload.treeSha256,
    },
    packagedProvider: {
      providerRelativePath: WINDOWS_PROVIDER_RELATIVE_PATH,
      providerSealRelativePath: WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
      providerSealSha256: artifactDigests.providerSeal,
      providerCatalogRelativePath: WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
      providerCatalogSha256: artifactDigests.providerCatalog,
      auditOnlyUiAccessSha256,
      providerAuthenticodeSignerSubject:
        governedArtifacts.provider.signerSubject,
      providerAuthenticodeCertificateSha256:
        governedArtifacts.provider.certificateSha256,
    },
    tierGovernedArtifacts: governedArtifacts,
    vendorNativeInventory,
  }, {
    policy,
    expectedCommit: commit,
    expectedReleasePolicySha256: policySha256,
  });

  return {
    repositoryRoot,
    gitExecutable,
    commit,
    policy,
    policyFile,
    policySha256,
    source,
    sourceFile,
    candidate,
    artifactPaths,
    artifactDigests,
    vendorNativeArtifacts,
  };
}

function validateCandidateSource(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "preSignProvider",
      "auditOnlyUiAccess",
      "daemonPayload",
      "artifacts",
      "vendorNativeInventory",
    ],
    "windows_candidate_source_shape_invalid",
  );
  if (value.schemaVersion !== 1 || value.kind !== CANDIDATE_SOURCE_KIND) {
    throw new TypeError("windows_candidate_source_identity_invalid");
  }
  validatePathOnlyReference(value.preSignProvider, "pre_sign_provider");
  validatePathOnlyReference(value.auditOnlyUiAccess, "audit_only_uiaccess");
  assertExactKeys(
    value.daemonPayload,
    ["strategy", "treeSha256"],
    "windows_candidate_source_daemon_invalid",
  );
  if (
    !["deterministic-rebuild", "signed-candidate-embedded-daemon"].includes(
      value.daemonPayload.strategy,
    ) ||
    !isSha256(value.daemonPayload.treeSha256)
  ) {
    throw new TypeError("windows_candidate_source_daemon_invalid");
  }
  assertExactKeys(
    value.artifacts,
    WINDOWS_HANDOFF_ARTIFACT_ROLES,
    "windows_candidate_source_artifacts_invalid",
  );
  for (const role of WINDOWS_HANDOFF_ARTIFACT_ROLES) {
    const entry = value.artifacts[role];
    if (role === "providerSeal") {
      validatePathOnlyReference(entry, role);
      continue;
    }
    assertExactKeys(
      entry,
      ["path", "relativePath", "signature"],
      `windows_candidate_source_artifact_invalid:${role}`,
    );
    if (!safeRelativePath(entry.path) || !safeRelativePath(entry.relativePath)) {
      throw new TypeError(`windows_candidate_source_artifact_invalid:${role}`);
    }
    validateObservedSignature(entry.signature, role, {
      allowUnsigned: false,
      timestampRequired: true,
    });
  }
  if (
    value.artifacts.provider.relativePath !== WINDOWS_PROVIDER_RELATIVE_PATH ||
    value.artifacts.providerCatalog.relativePath !==
      WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH
  ) {
    throw new TypeError("windows_candidate_source_provider_path_invalid");
  }
  if (!Array.isArray(value.vendorNativeInventory)) {
    throw new TypeError("windows_candidate_source_vendor_inventory_invalid");
  }
  const vendorPaths = [];
  for (const [index, entry] of value.vendorNativeInventory.entries()) {
    assertExactKeys(
      entry,
      ["path", "relativePath", "signature"],
      `windows_candidate_source_vendor_invalid:${index}`,
    );
    if (!safeRelativePath(entry.path) || !safeRelativePath(entry.relativePath)) {
      throw new TypeError(`windows_candidate_source_vendor_invalid:${index}`);
    }
    validateObservedSignature(entry.signature, `vendor_native_${index}`, {
      allowUnsigned: true,
      timestampRequired: false,
    });
    vendorPaths.push(entry.relativePath);
  }
  if (!isDeepStrictEqual(vendorPaths, [...new Set(vendorPaths)].sort())) {
    throw new TypeError("windows_candidate_source_vendor_inventory_invalid");
  }
  return value;
}

function validateEvidenceMap(value, policy) {
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "cells"],
    "windows_evidence_map_shape_invalid",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== EVIDENCE_MAP_KIND ||
    !Array.isArray(value.cells)
  ) {
    throw new TypeError("windows_evidence_map_identity_invalid");
  }
  const expectedIds = policy.requiredAcceptanceCells.map((cell) => cell.id);
  const observedIds = [];
  for (const entry of value.cells) {
    assertExactKeys(
      entry,
      ["cellId", "manualEvidence"],
      "windows_evidence_map_cell_shape_invalid",
    );
    if (typeof entry.cellId !== "string") {
      throw new TypeError("windows_evidence_map_cell_invalid");
    }
    assertExactKeys(
      entry.manualEvidence,
      MANUAL_EVIDENCE_ROLES,
      "windows_evidence_map_manual_shape_invalid",
    );
    for (const role of MANUAL_EVIDENCE_ROLES) {
      const reference = entry.manualEvidence[role];
      if (
        role === "smartScreen" &&
        policy.requiredDistributionChannel === "internal" &&
        reference === null
      ) {
        continue;
      }
      if (typeof reference !== "string" || !safeRelativePath(reference)) {
        throw new TypeError(`windows_evidence_map_reference_invalid:${role}`);
      }
    }
    observedIds.push(entry.cellId);
  }
  if (!isDeepStrictEqual(observedIds, expectedIds)) {
    throw new TypeError("windows_evidence_map_cells_mismatch");
  }
  return value;
}

function governedArtifact(
  source,
  sha256,
  timestampPolicy,
  expectedSubject,
  expectedCertificateSha256,
  role,
) {
  const signature = validateObservedSignature(source.signature, role, {
    allowUnsigned: false,
    timestampRequired: true,
  });
  if (
    signature.signerSubject !== expectedSubject ||
    signature.certificateSha256 !== expectedCertificateSha256
  ) {
    throw new TypeError(`windows_candidate_source_signer_mismatch:${role}`);
  }
  return {
    relativePath: source.relativePath,
    sha256,
    authenticodeStatus: "Valid",
    signerSubject: signature.signerSubject,
    certificateSha256: signature.certificateSha256,
    timestampPolicy,
    timestampStatus: signature.timestampStatus,
  };
}

function validateObservedSignature(
  value,
  label,
  { allowUnsigned, timestampRequired },
) {
  const expectedKeys = timestampRequired
    ? [
        "authenticodeStatus",
        "signerSubject",
        "certificateSha256",
        "timestampStatus",
      ]
    : ["authenticodeStatus", "signerSubject", "certificateSha256"];
  assertExactKeys(
    value,
    expectedKeys,
    `windows_candidate_source_signature_invalid:${label}`,
  );
  if (value.authenticodeStatus === "NotSigned" && allowUnsigned) {
    if (value.signerSubject !== null || value.certificateSha256 !== null) {
      throw new TypeError(
        `windows_candidate_source_signature_invalid:${label}`,
      );
    }
    return value;
  }
  if (
    value.authenticodeStatus !== "Valid" ||
    typeof value.signerSubject !== "string" ||
    value.signerSubject.trim().length === 0 ||
    !isSha256(value.certificateSha256) ||
    (timestampRequired &&
      !["NotRequired", "Valid"].includes(value.timestampStatus))
  ) {
    throw new TypeError(`windows_candidate_source_signature_invalid:${label}`);
  }
  return value;
}

async function copyManualEvidence({
  role,
  sourcePath,
  destinationRoot,
  candidateManifestSha256,
  cell,
  policy,
  evidenceDigests,
  attachmentDigests,
}) {
  const sourceFile = await readJsonFile(sourcePath, `manual_evidence_${role}`);
  const document = sourceFile.document;
  if (
    document?.schemaVersion !== 3 ||
    document?.kind !== MANUAL_EVIDENCE_KINDS[role] ||
    document?.candidateManifestSha256 !== candidateManifestSha256 ||
    document?.host?.platform !== "win32" ||
    document?.host?.architecture !== "x64" ||
    document?.host?.windowsBuild !== cell.windowsBuild ||
    !policy.manualEvidenceReviewers.includes(document?.reviewer?.id) ||
    !Array.isArray(document?.attachments) ||
    document.attachments.length === 0
  ) {
    throw new TypeError(`windows_handoff_manual_evidence_invalid:${role}`);
  }
  if (
    role === "display" &&
    (document?.details?.displayTopology !== cell.displayTopology ||
      !isDeepStrictEqual(
        document?.details?.dpiProfiles,
        cell.displayScalePercents,
      ))
  ) {
    throw new TypeError("windows_handoff_manual_evidence_cell_mismatch:display");
  }
  assertUniqueDigest(
    sourceFile.sha256,
    evidenceDigests,
    `windows_handoff_manual_evidence_reused:${role}`,
  );
  await mkdir(destinationRoot, { recursive: true });
  const destinationDocument = join(destinationRoot, "evidence.json");
  await writeFile(destinationDocument, sourceFile.bytes, { flag: "wx" });
  const sourceDirectory = dirname(sourceFile.path);
  const copiedPaths = new Set([destinationDocument]);
  for (const [index, attachment] of document.attachments.entries()) {
    if (
      !attachment ||
      typeof attachment.path !== "string" ||
      !safeRelativePath(attachment.path) ||
      !isSha256(attachment.sha256)
    ) {
      throw new TypeError(
        `windows_handoff_manual_attachment_invalid:${role}:${index}`,
      );
    }
    const sourceAttachment = await resolveRegularFile(
      resolve(sourceDirectory, attachment.path),
      `manual_attachment_${role}_${index}`,
    );
    assertInside(
      sourceDirectory,
      sourceAttachment,
      `manual_attachment_${role}_${index}`,
    );
    const digest = await sha256File(sourceAttachment);
    if (digest !== attachment.sha256) {
      throw new TypeError(
        `windows_handoff_manual_attachment_hash_mismatch:${role}:${index}`,
      );
    }
    assertUniqueDigest(
      digest,
      attachmentDigests,
      `windows_handoff_manual_attachment_reused:${role}`,
    );
    const destinationAttachment = resolve(destinationRoot, attachment.path);
    assertInside(
      destinationRoot,
      destinationAttachment,
      `manual_attachment_destination_${role}_${index}`,
    );
    if (copiedPaths.has(destinationAttachment)) {
      throw new TypeError(`windows_handoff_manual_attachment_path_reused:${role}`);
    }
    copiedPaths.add(destinationAttachment);
    await copyRegularFile(sourceAttachment, destinationAttachment);
    if ((await sha256File(destinationAttachment)) !== digest) {
      throw new TypeError(
        `windows_handoff_manual_attachment_copy_mismatch:${role}:${index}`,
      );
    }
  }
  return { path: destinationDocument, sha256: sourceFile.sha256 };
}

async function cloneCandidateRepository({
  gitExecutable,
  sourceRoot,
  destinationRoot,
  commit,
}) {
  await execFileAsync(
    gitExecutable,
    [
      "clone",
      "--quiet",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      sourceRoot,
      destinationRoot,
    ],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  await execFileAsync(
    gitExecutable,
    ["-C", destinationRoot, "checkout", "--quiet", "--detach", commit],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const clonedCommit = await readCleanRepositoryCommit(
    gitExecutable,
    destinationRoot,
  );
  if (clonedCommit !== commit) {
    throw new TypeError("windows_handoff_repository_clone_commit_mismatch");
  }
}

async function collectHarnessFiles(repositoryRoot) {
  const canonicalRoot = await realpath(repositoryRoot);
  const files = [];
  for (const name of WINDOWS_RELEASE_HARNESS_FILES) {
    const path = await resolveRegularFile(
      resolve(repositoryRoot, name),
      `harness_${name}`,
    );
    assertInside(canonicalRoot, path, `harness_${name}`);
    files.push({ name, sha256: await sha256File(path) });
  }
  return files;
}

async function readCleanRepositoryCommit(gitExecutable, repositoryRoot) {
  const status = await execFileAsync(
    gitExecutable,
    ["-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (status.stdout.trim().length > 0) {
    throw new TypeError("windows_handoff_repository_dirty");
  }
  const head = await execFileAsync(
    gitExecutable,
    ["-C", repositoryRoot, "rev-parse", "HEAD"],
    { timeout: 30_000, maxBuffer: 1_024 * 1_024 },
  );
  const commit = head.stdout.trim().toLowerCase();
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new TypeError("windows_handoff_repository_commit_invalid");
  }
  return commit;
}

async function readJsonFile(path, label) {
  const resolvedPath = await resolveRegularFile(path, label);
  const bytes = await readFile(resolvedPath);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new TypeError(`${label}_json_invalid:${error?.message ?? error}`);
  }
  return {
    path: resolvedPath,
    bytes,
    sha256: sha256Bytes(bytes),
    document,
  };
}

async function copyRegularFile(source, destination) {
  const resolvedSource = await resolveRegularFile(source, "copy_source");
  await mkdir(dirname(destination), { recursive: true });
  await assertPathDoesNotExist(destination, "copy_destination_exists");
  await copyFile(resolvedSource, destination);
}

async function resolveRegularFile(path, label) {
  let directStat;
  try {
    directStat = await lstat(path);
  } catch {
    throw new TypeError(`windows_handoff_path_missing:${label}`);
  }
  if (!directStat.isFile() || directStat.isSymbolicLink()) {
    throw new TypeError(`windows_handoff_path_not_regular:${label}`);
  }
  return realpath(path);
}

async function resolveSourceRegularFile(ownerDirectory, path, label) {
  const resolvedPath = await resolveRegularFile(
    resolveManifestPath(ownerDirectory, path, label),
    label,
  );
  assertInside(ownerDirectory, resolvedPath, label);
  return resolvedPath;
}

function resolveManifestPath(ownerDirectory, path, label) {
  if (!safeRelativePath(path)) {
    throw new TypeError(`windows_handoff_source_path_invalid:${label}`);
  }
  return resolve(ownerDirectory, path);
}

function validatePathOnlyReference(value, label) {
  assertExactKeys(
    value,
    ["path"],
    `windows_candidate_source_path_invalid:${label}`,
  );
  if (!safeRelativePath(value.path)) {
    throw new TypeError(`windows_candidate_source_path_invalid:${label}`);
  }
}

function manifestFileReference(ownerPath, targetPath, sha256) {
  return {
    path: portableRelative(dirname(ownerPath), targetPath),
    sha256,
  };
}

function fileReference(ownerDirectory, targetPath, sha256) {
  return { path: portableRelative(ownerDirectory, targetPath), sha256 };
}

function portableRelative(owner, target) {
  const value = relative(owner, target).replaceAll("\\", "/");
  if (value.length === 0 || isAbsolute(value)) {
    throw new TypeError("windows_handoff_relative_path_invalid");
  }
  return value;
}

function assertInside(root, path, label) {
  const fromRoot = relative(resolve(root), resolve(path));
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new TypeError(`windows_handoff_path_escape:${label}`);
  }
}

async function assertPathDoesNotExist(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new TypeError(code);
}

function assertUniqueDigest(value, set, code) {
  if (set.has(value)) throw new TypeError(code);
  set.add(value);
}

function assertExactKeys(value, expected, code) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  ) {
    throw new TypeError(code);
  }
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`windows_handoff_${label}_required`);
  }
  return resolve(value);
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && !value.includes("\0")
    && !isAbsolute(value)
    && !/^[A-Za-z]:[\\/]/u.test(value)
    && !value.split(/[\\/]/u).includes("..");
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function normalizeNow(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("windows_handoff_created_at_invalid");
  }
  return date.toISOString();
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function candidateBytes(value) {
  return jsonBytes(value);
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const { values } = parseArgs({
    options: {
      "candidate-source": { type: "string" },
      "release-policy": { type: "string" },
      "repository-root": { type: "string" },
      "git-executable": { type: "string" },
      "candidate-output": { type: "string" },
      "candidate-manifest": { type: "string" },
      "evidence-map": { type: "string" },
      "output-root": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const commonRequired = [
    "candidate-source",
    "release-policy",
    "repository-root",
    "git-executable",
  ];
  const candidateOnly = Boolean(values["candidate-output"]);
  const handoff = Boolean(values["output-root"]);
  if (
    values.help ||
    candidateOnly === handoff ||
    commonRequired.some((name) => !values[name]) ||
    (handoff &&
      (!values["candidate-manifest"] || !values["evidence-map"]))
  ) {
    process.stdout.write(
      "Usage:\n"
      + "  node produce-windows-acceptance-handoff.mjs --candidate-source <source.json> --release-policy <policy.json> --repository-root <clean-repo> --git-executable <absolute-git.exe> --candidate-output <candidate.json>\n"
      + "  node produce-windows-acceptance-handoff.mjs --candidate-source <source.json> --release-policy <policy.json> --repository-root <clean-repo> --git-executable <absolute-git.exe> --candidate-manifest <candidate.json> --evidence-map <evidence-map.json> --output-root <new-handoff-root>\n",
    );
    if (!values.help) process.exitCode = 2;
    return;
  }
  const common = {
    candidateSourcePath: values["candidate-source"],
    releasePolicyPath: values["release-policy"],
    repositoryRoot: values["repository-root"],
    gitExecutable: values["git-executable"],
  };
  const result = candidateOnly
    ? await writeWindowsCandidateManifest({
        ...common,
        outputPath: values["candidate-output"],
      })
    : await produceWindowsAcceptanceHandoff({
        ...common,
        candidateManifestPath: values["candidate-manifest"],
        evidenceMapPath: values["evidence-map"],
        outputRoot: values["output-root"],
      });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Windows acceptance handoff production failed: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}
