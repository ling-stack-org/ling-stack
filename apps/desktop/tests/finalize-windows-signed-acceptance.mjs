import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { CUA_DRIVER_ARTIFACT_LAYOUT } from "../shared/cua-driver-artifact-layout.mjs";
import {
  WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS,
  WINDOWS_RELEASE_HARNESS_FILES,
  canonicalJson,
  validateWindowsAcceptanceReportShape,
  verifyWindowsAcceptanceEvidenceFiles,
  windowsAcceptanceEvidenceSha256,
} from "./windows-acceptance-report.mjs";
import {
  WINDOWS_HANDOFF_ARTIFACT_ROLES,
  WINDOWS_SIGNED_ACCEPTANCE_MATRIX_KIND,
  WINDOWS_SIGNED_ACCEPTANCE_MATRIX_SCHEMA_VERSION,
  validateWindowsCellHandoffDocument,
  validateWindowsHandoffIndexDocument,
  validateWindowsSignedAcceptanceMatrixDocument,
} from "./windows-handoff-contracts.mjs";
import {
  validateWindowsCandidateManifestDocument,
  validateWindowsReleasePolicyDocument,
} from "./windows-release-evidence-contracts.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MANUAL_EVIDENCE_ROLES = Object.freeze([
  "windowsVersion",
  "display",
  "narrator",
  "nvda",
  "smartScreen",
  "installLifecycle",
]);

export async function finalizeWindowsSignedAcceptance(input, options = {}) {
  const indexPath = resolveRequiredPath(
    input?.handoffIndexPath,
    "windows_finalizer_handoff_index_required",
  );
  const indexDirectory = await realpath(dirname(indexPath));
  const handoffRoot = indexDirectory;
  const indexFile = await readJsonWithDigest(indexPath, "handoff_index");
  requireDigest(
    options.expectedHandoffIndexSha256,
    indexFile.sha256,
    "windows_finalizer_handoff_index_digest_mismatch",
  );
  const index = validateWindowsHandoffIndexDocument(indexFile.document);
  requireDigest(
    options.expectedCandidateManifestSha256,
    index.candidateManifest.sha256,
    "windows_finalizer_candidate_manifest_digest_mismatch",
  );
  requireDigest(
    options.expectedReleasePolicySha256,
    index.releasePolicy.sha256,
    "windows_finalizer_release_policy_digest_mismatch",
  );
  if (
    options.expectedCandidateCommit &&
    options.expectedCandidateCommit !== index.candidateCommit
  ) {
    throw new TypeError("windows_finalizer_candidate_commit_mismatch");
  }

  const candidateReference = await resolveAndVerifyReference({
    root: handoffRoot,
    ownerDirectory: indexDirectory,
    reference: index.candidateManifest,
    label: "candidate_manifest",
  });
  const policyReference = await resolveAndVerifyReference({
    root: handoffRoot,
    ownerDirectory: indexDirectory,
    reference: index.releasePolicy,
    label: "release_policy",
  });
  const policy = validateWindowsReleasePolicyDocument(
    await parseJsonBytes(policyReference.bytes, "release_policy"),
  );
  const candidate = validateWindowsCandidateManifestDocument(
    await parseJsonBytes(candidateReference.bytes, "candidate_manifest"),
    {
      policy,
      expectedCommit: index.candidateCommit,
      expectedReleasePolicySha256: index.releasePolicy.sha256,
    },
  );
  assertIndexDocumentTuple(index, candidate, policy);

  const resolvedArtifacts = {};
  for (const role of WINDOWS_HANDOFF_ARTIFACT_ROLES) {
    resolvedArtifacts[role] = await resolveAndVerifyReference({
      root: handoffRoot,
      ownerDirectory: indexDirectory,
      reference: index.artifacts[role],
      label: `artifact_${role}`,
    });
  }
  await verifyCandidateArtifactTuple(candidate, index, resolvedArtifacts, handoffRoot);

  const cellManifestDirectory = await resolveDirectoryInsideRoot(
    handoffRoot,
    indexDirectory,
    index.cellManifestDirectory,
    "cell_manifest_directory",
  );
  const reportDirectory = await resolveDirectoryInsideRoot(
    handoffRoot,
    indexDirectory,
    index.reportDirectory,
    "report_directory",
  );
  const suppliedManifestPaths = Array.isArray(input?.cellManifestPaths)
    ? input.cellManifestPaths.map((path) => resolve(path))
    : [];
  if (suppliedManifestPaths.length !== index.requiredAcceptanceCells.length) {
    throw new TypeError("windows_finalizer_cell_manifest_count_invalid");
  }
  await assertExactDirectoryFileSet(
    cellManifestDirectory,
    suppliedManifestPaths,
    "windows_finalizer_cell_manifest_file_set_invalid",
  );

  const expectedCellById = new Map(
    index.requiredAcceptanceCells.map((cell) => [cell.id, cell]),
  );
  const seenCellIds = new Set();
  const seenRunIds = new Set();
  const seenManifestDigests = new Set();
  const expectedReportPaths = [];
  const cellResults = [];
  const manualReviewerIds = new Set();
  const manualEvidencePaths = new Set();
  const manualEvidenceDigests = new Set();
  const attachmentPaths = new Set();
  const attachmentDigests = new Set();

  for (const suppliedManifestPath of suppliedManifestPaths) {
    const manifestRealPath = await assertPathInsideRoot(
      handoffRoot,
      suppliedManifestPath,
      "cell_manifest",
    );
    if (dirname(manifestRealPath) !== cellManifestDirectory) {
      throw new TypeError("windows_finalizer_cell_manifest_directory_mismatch");
    }
    const manifestFile = await readJsonWithDigest(
      manifestRealPath,
      "cell_manifest",
    );
    const manifest = validateWindowsCellHandoffDocument(manifestFile.document);
    if (
      seenCellIds.has(manifest.cell.id) ||
      seenRunIds.has(manifest.runId) ||
      seenManifestDigests.has(manifestFile.sha256)
    ) {
      throw new TypeError("windows_finalizer_duplicate_cell_manifest");
    }
    seenCellIds.add(manifest.cell.id);
    seenRunIds.add(manifest.runId);
    seenManifestDigests.add(manifestFile.sha256);
    const expectedCell = expectedCellById.get(manifest.cell.id);
    if (!expectedCell || !isDeepStrictEqual(manifest.cell, expectedCell)) {
      throw new TypeError("windows_finalizer_cross_cell_manifest");
    }
    await verifyCellManifestBindings({
      manifest,
      manifestDirectory: dirname(manifestRealPath),
      handoffRoot,
      index,
      indexPath,
      indexSha256: indexFile.sha256,
      indexDirectory,
    });

    const reportPath = await resolvePathInsideRoot(
      handoffRoot,
      dirname(manifestRealPath),
      manifest.outputReport.path,
      "cell_report",
    );
    if (dirname(reportPath) !== reportDirectory) {
      throw new TypeError("windows_finalizer_cell_report_directory_mismatch");
    }
    expectedReportPaths.push(reportPath);
    const reportFile = await readJsonWithDigest(reportPath, "cell_report");
    const report = validateWindowsAcceptanceReportShape(reportFile.document);
    if (
      report.mode !== "Full" ||
      report.summary.fullAcceptanceStatus !== "PASS" ||
      report.summary.releaseStatus !== "MANUAL_REVIEW_REQUIRED" ||
      report.summary.releaseReady !== false ||
      !isDeepStrictEqual(
        report.summary.releaseBlockers,
        WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS,
      ) ||
      !isDeepStrictEqual(report.cell, manifest.cell) ||
      report.handoff.runId !== manifest.runId ||
      report.handoff.handoffIndexSha256 !== indexFile.sha256 ||
      report.handoff.cellManifestSha256 !== manifestFile.sha256
    ) {
      throw new TypeError("windows_finalizer_cell_report_binding_invalid");
    }
    assertReportCandidateTuple(report, index, manifest);
    const repositoryRoot = await resolveDirectoryInsideRoot(
      handoffRoot,
      dirname(manifestRealPath),
      manifest.inputs.repositoryRoot,
      "repository_root",
    );
    const verifiedContext = await verifyWindowsAcceptanceEvidenceFiles(report, {
      gitExecutable: options.gitExecutable,
      expectedCandidateCommit: index.candidateCommit,
      expectedRepositoryRoot: repositoryRoot,
      expectedReleasePolicySha256: index.releasePolicy.sha256,
    });
    for (const reviewerId of verifiedContext.manualEvidence.reviewerIds) {
      manualReviewerIds.add(reviewerId);
    }
    await collectManualEvidenceIdentity({
      report,
      handoffRoot,
      manifestDirectory: dirname(manifestRealPath),
      manifestManualEvidence: manifest.inputs.manualEvidence,
      requireSmartScreen: index.distributionChannel === "production",
      evidencePaths: manualEvidencePaths,
      evidenceDigests: manualEvidenceDigests,
      attachmentPaths,
      attachmentDigests,
    });
    cellResults.push({
      cellId: manifest.cell.id,
      runId: manifest.runId,
      cellManifestSha256: manifestFile.sha256,
      reportPath: portableRelative(handoffRoot, reportPath),
      reportSha256: reportFile.sha256,
      reportEvidenceSha256: windowsAcceptanceEvidenceSha256(report),
      fullAcceptanceStatus: "PASS",
    });
  }

  if (
    seenCellIds.size !== expectedCellById.size ||
    [...expectedCellById.keys()].some((id) => !seenCellIds.has(id))
  ) {
    throw new TypeError("windows_finalizer_required_cell_missing");
  }
  await assertExactDirectoryFileSet(
    reportDirectory,
    expectedReportPaths,
    "windows_finalizer_report_file_set_invalid",
  );
  cellResults.sort((left, right) => left.cellId.localeCompare(right.cellId));
  const matrix = {
    schemaVersion: WINDOWS_SIGNED_ACCEPTANCE_MATRIX_SCHEMA_VERSION,
    kind: WINDOWS_SIGNED_ACCEPTANCE_MATRIX_KIND,
    finalizedAt: normalizeNow(options.now),
    handoffIndexSha256: indexFile.sha256,
    candidateManifestSha256: index.candidateManifest.sha256,
    releasePolicySha256: index.releasePolicy.sha256,
    candidateCommit: index.candidateCommit,
    signingTier: index.signingTier,
    distributionChannel: index.distributionChannel,
    productionEligible: index.productionEligible,
    testAuthorityKind: index.testAuthorityKind,
    artifacts: Object.fromEntries(
      WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
        role,
        index.artifacts[role].sha256,
      ]),
    ),
    harness: structuredClone(index.harness),
    cells: cellResults,
    manualReviewerIds: [...manualReviewerIds].sort(),
    evidenceSha256: null,
    verdict: {
      status: "MANUAL_REVIEW_REQUIRED",
      fullAcceptanceStatus: "PASS",
      promotionStatus: "ATTESTATION_REQUIRED",
      releaseReady: false,
      releaseBlockers: [...WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS],
    },
  };
  matrix.evidenceSha256 = windowsAcceptanceMatrixEvidenceSha256(matrix);
  validateWindowsSignedAcceptanceMatrixDocument(matrix);
  return { matrix, context: { releasePolicy: policy, candidateManifest: candidate } };
}

export function windowsAcceptanceMatrixEvidenceSha256(matrix) {
  const material = { ...structuredClone(matrix), evidenceSha256: null };
  return createHash("sha256").update(canonicalJson(material), "utf8").digest("hex");
}

async function verifyCellManifestBindings({
  manifest,
  manifestDirectory,
  handoffRoot,
  index,
  indexPath,
  indexSha256,
  indexDirectory,
}) {
  const expected = manifest.expected;
  const artifactDigests = Object.fromEntries(
    WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
      role,
      index.artifacts[role].sha256,
    ]),
  );
  if (
    expected.candidateCommit !== index.candidateCommit ||
    expected.candidateManifestSha256 !== index.candidateManifest.sha256 ||
    expected.releasePolicySha256 !== index.releasePolicy.sha256 ||
    expected.handoffIndexSha256 !== indexSha256 ||
    expected.signingTier !== index.signingTier ||
    expected.distributionChannel !== index.distributionChannel ||
    expected.productionEligible !== index.productionEligible ||
    expected.testAuthorityKind !== index.testAuthorityKind ||
    expected.harnessCommit !== index.harness.commit ||
    !isDeepStrictEqual(expected.artifacts, artifactDigests)
  ) {
    throw new TypeError("windows_finalizer_cell_expected_tuple_mismatch");
  }
  const indexReferencePath = await resolvePathInsideRoot(
    handoffRoot,
    manifestDirectory,
    manifest.handoffIndex.path,
    "cell_handoff_index",
  );
  if (
    indexReferencePath !== (await realpath(indexPath)) ||
    manifest.handoffIndex.sha256 !== indexSha256
  ) {
    throw new TypeError("windows_finalizer_cell_index_binding_mismatch");
  }
  for (const role of [
    "candidateManifest",
    "releasePolicy",
    ...WINDOWS_HANDOFF_ARTIFACT_ROLES,
  ]) {
    const indexReference =
      role === "candidateManifest" || role === "releasePolicy"
        ? index[role]
        : index.artifacts[role];
    const expectedPath = await resolvePathInsideRoot(
      handoffRoot,
      indexDirectory,
      indexReference.path,
      `index_${role}`,
    );
    const actualPath = await resolvePathInsideRoot(
      handoffRoot,
      manifestDirectory,
      manifest.inputs[role].path,
      `cell_${role}`,
    );
    if (
      expectedPath !== actualPath ||
      manifest.inputs[role].sha256 !== indexReference.sha256
    ) {
      throw new TypeError(`windows_finalizer_cell_input_mismatch:${role}`);
    }
  }
}

function assertIndexDocumentTuple(index, candidate, policy) {
  if (
    index.signingTier !== candidate.signingTier ||
    index.distributionChannel !== candidate.distributionChannel ||
    index.productionEligible !== candidate.productionEligible ||
    index.testAuthorityKind !== candidate.testAuthorityKind ||
    index.signingTier !== policy.requiredSigningTier ||
    index.distributionChannel !== policy.requiredDistributionChannel ||
    index.productionEligible !== policy.requiredProductionEligible ||
    index.testAuthorityKind !== policy.requiredTestAuthorityKind ||
    !isDeepStrictEqual(
      index.requiredAcceptanceCells,
      policy.requiredAcceptanceCells,
    ) ||
    index.harness.commit !== index.candidateCommit ||
    !isDeepStrictEqual(
      index.harness.files.map((file) => file.name),
      WINDOWS_RELEASE_HARNESS_FILES,
    )
  ) {
    throw new TypeError("windows_finalizer_index_document_tuple_mismatch");
  }
}

async function verifyCandidateArtifactTuple(
  candidate,
  index,
  artifacts,
  handoffRoot,
) {
  const governed = candidate.tierGovernedArtifacts;
  const expectedDigests = {
    lingApp: governed.lingApp.sha256,
    lingInstaller: governed.lingInstaller.sha256,
    lingUninstaller: governed.lingUninstaller.sha256,
    provider: governed.provider.sha256,
    providerSeal: candidate.packagedProvider.providerSealSha256,
    providerCatalog: governed.providerCatalog.sha256,
  };
  for (const role of WINDOWS_HANDOFF_ARTIFACT_ROLES) {
    if (
      index.artifacts[role].sha256 !== expectedDigests[role] ||
      artifacts[role].sha256 !== expectedDigests[role]
    ) {
      throw new TypeError(`windows_finalizer_candidate_artifact_mismatch:${role}`);
    }
  }
  const appRoot = dirname(artifacts.lingApp.path);
  for (const [position, nativeArtifact] of candidate.vendorNativeInventory.entries()) {
    await resolveAndVerifyReference({
      root: handoffRoot,
      ownerDirectory: appRoot,
      reference: {
        path: nativeArtifact.relativePath,
        sha256: nativeArtifact.sha256,
      },
      label: `vendor_native_${position}`,
    });
  }
  const uiAccessPath = resolve(
    dirname(artifacts.provider.path),
    "cua-driver-uia.exe",
  );
  try {
    await access(uiAccessPath);
    throw new TypeError("windows_finalizer_standard_payload_contains_uiaccess");
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "windows_finalizer_standard_payload_contains_uiaccess"
    ) {
      throw error;
    }
  }
  const payloadEntries = await readdir(dirname(artifacts.provider.path), {
    withFileTypes: true,
  });
  const extraExecutables = payloadEntries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".exe") &&
      entry.name.toLowerCase() !==
        CUA_DRIVER_ARTIFACT_LAYOUT["win32-x64"].packagedExecutableName,
  );
  if (extraExecutables.length > 0) {
    throw new TypeError("windows_finalizer_standard_payload_executable_extra");
  }
}

function assertReportCandidateTuple(report, index, manifest) {
  const installerReport = report.probes.installerPayload.report;
  const reportHarness = {
    commit: report.bindings.harness.commit,
    files: report.bindings.harness.files.map(({ name, sha256 }) => ({
      name,
      sha256,
    })),
  };
  if (
    report.bindings.commit !== index.candidateCommit ||
    report.bindings.candidateManifest.sha256 !==
      index.candidateManifest.sha256 ||
    report.bindings.releasePolicy.sha256 !== index.releasePolicy.sha256 ||
    report.bindings.lingApp.sha256 !== index.artifacts.lingApp.sha256 ||
    report.bindings.lingInstaller.sha256 !==
      index.artifacts.lingInstaller.sha256 ||
    report.bindings.provider.sha256 !== index.artifacts.provider.sha256 ||
    report.bindings.providerSeal.sha256 !==
      index.artifacts.providerSeal.sha256 ||
    report.bindings.providerCatalog.sha256 !==
      index.artifacts.providerCatalog.sha256 ||
    installerReport?.uninstaller?.sha256 !==
      index.artifacts.lingUninstaller.sha256 ||
    !isDeepStrictEqual(reportHarness, index.harness) ||
    !isDeepStrictEqual(report.cell, manifest.cell)
  ) {
    throw new TypeError("windows_finalizer_report_candidate_tuple_mismatch");
  }
}

async function collectManualEvidenceIdentity({
  report,
  handoffRoot,
  manifestDirectory,
  manifestManualEvidence,
  requireSmartScreen,
  evidencePaths,
  evidenceDigests,
  attachmentPaths,
  attachmentDigests,
}) {
  for (const role of MANUAL_EVIDENCE_ROLES) {
    const manifestReference = manifestManualEvidence[role];
    const reportProbe = report.acceptance[role];
    const reportReference = reportProbe.evidence;
    if (!requireSmartScreen && role === "smartScreen") {
      if (
        manifestReference !== null ||
        reportProbe.attempted !== false ||
        reportProbe.passed !== null ||
        reportProbe.operator !== null ||
        reportReference.path !== null ||
        reportReference.sha256 !== null
      ) {
        throw new TypeError(
          "windows_finalizer_manual_evidence_binding_mismatch:smartScreen",
        );
      }
      continue;
    }
    if (manifestReference === null) {
      throw new TypeError(
        `windows_finalizer_manual_evidence_binding_mismatch:${role}`,
      );
    }
    const manifestEvidencePath = await resolvePathInsideRoot(
      handoffRoot,
      manifestDirectory,
      manifestReference.path,
      `cell_manual_evidence_${role}`,
    );
    const evidencePath = await assertPathInsideRoot(
      handoffRoot,
      reportReference.path,
      `manual_evidence_${role}`,
    );
    if (
      evidencePath !== manifestEvidencePath ||
      reportReference.sha256 !== manifestReference.sha256
    ) {
      throw new TypeError(
        `windows_finalizer_manual_evidence_binding_mismatch:${role}`,
      );
    }
    assertUniqueEvidence(
      evidencePath,
      reportReference.sha256,
      evidencePaths,
      evidenceDigests,
      `windows_finalizer_manual_evidence_reused:${role}`,
    );
    const document = await parseJsonBytes(
      await readFile(evidencePath),
      `manual_evidence_${role}`,
    );
    for (const attachment of document.attachments) {
      const attachmentPath = await resolvePathInsideRoot(
        handoffRoot,
        dirname(evidencePath),
        attachment.path,
        `manual_attachment_${role}`,
      );
      assertUniqueEvidence(
        attachmentPath,
        attachment.sha256,
        attachmentPaths,
        attachmentDigests,
        `windows_finalizer_manual_attachment_reused:${role}`,
      );
    }
  }
}

function assertUniqueEvidence(path, sha256, paths, digests, code) {
  if (paths.has(path) || digests.has(sha256)) {
    throw new TypeError(code);
  }
  paths.add(path);
  digests.add(sha256);
}

async function resolveAndVerifyReference({
  root,
  ownerDirectory,
  reference,
  label,
}) {
  const path = await resolvePathInsideRoot(
    root,
    ownerDirectory,
    reference.path,
    label,
  );
  const bytes = await readFile(path);
  const sha256 = sha256Bytes(bytes);
  if (sha256 !== reference.sha256) {
    throw new TypeError(`windows_finalizer_file_hash_mismatch:${label}`);
  }
  return { path, bytes, sha256 };
}

async function resolveDirectoryInsideRoot(root, ownerDirectory, path, label) {
  const resolved = await resolvePathInsideRoot(root, ownerDirectory, path, label);
  const entries = await readdir(resolved);
  void entries;
  return resolved;
}

async function resolvePathInsideRoot(root, ownerDirectory, path, label) {
  if (
    typeof path !== "string" ||
    path.trim().length === 0 ||
    path.includes("\0") ||
    isAbsolute(path)
  ) {
    throw new TypeError(`windows_finalizer_path_invalid:${label}`);
  }
  return assertPathInsideRoot(root, resolve(ownerDirectory, path), label);
}

async function assertPathInsideRoot(root, path, label) {
  const rootReal = await realpath(root);
  let pathReal;
  try {
    pathReal = await realpath(path);
  } catch {
    throw new TypeError(`windows_finalizer_path_unresolvable:${label}`);
  }
  const fromRoot = relative(rootReal, pathReal);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new TypeError(`windows_finalizer_path_escape:${label}`);
  }
  return pathReal;
}

async function assertExactDirectoryFileSet(directory, expectedPaths, code) {
  const expected = new Set(
    await Promise.all(expectedPaths.map((path) => realpath(path))),
  );
  if (expected.size !== expectedPaths.length) {
    throw new TypeError(code);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = new Set(
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
          throw new TypeError(code);
        }
        return realpath(resolve(directory, entry.name));
      }),
    ),
  );
  if (
    actual.size !== expected.size ||
    [...actual].some((path) => !expected.has(path))
  ) {
    throw new TypeError(code);
  }
}

async function readJsonWithDigest(path, label) {
  const bytes = await readFile(path);
  return {
    document: await parseJsonBytes(bytes, label),
    bytes,
    sha256: sha256Bytes(bytes),
  };
}

async function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw new TypeError(`windows_finalizer_json_invalid:${label}`);
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(expected, actual, code) {
  if (!SHA256_PATTERN.test(expected ?? "") || expected !== actual) {
    throw new TypeError(code);
  }
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function resolveRequiredPath(path, code) {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new TypeError(code);
  }
  return resolve(path);
}

function normalizeNow(value) {
  const now = value ? new Date(value) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("windows_finalizer_time_invalid");
  }
  return now.toISOString();
}

async function main() {
  const { values } = parseArgs({
    options: {
      "handoff-index": { type: "string" },
      "cell-manifest": { type: "string", multiple: true },
      "expected-handoff-index-sha256": { type: "string" },
      "expected-candidate-manifest-sha256": { type: "string" },
      "expected-release-policy-sha256": { type: "string" },
      "expected-candidate-commit": { type: "string" },
      "git-executable": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const required = [
    "handoff-index",
    "expected-handoff-index-sha256",
    "expected-candidate-manifest-sha256",
    "expected-release-policy-sha256",
    "expected-candidate-commit",
    "git-executable",
    "output",
  ];
  if (
    values.help ||
    required.some((name) => !values[name]) ||
    !Array.isArray(values["cell-manifest"]) ||
    values["cell-manifest"].length === 0
  ) {
    process.stdout.write(
      "Usage: node finalize-windows-signed-acceptance.mjs --handoff-index <index.json> --cell-manifest <cell.json> [--cell-manifest <cell.json> ...] --expected-handoff-index-sha256 <sha256> --expected-candidate-manifest-sha256 <sha256> --expected-release-policy-sha256 <sha256> --expected-candidate-commit <commit> --git-executable <trusted-git.exe> --output <matrix.json>\n",
    );
    if (!values.help) process.exitCode = 2;
    return;
  }
  const { matrix } = await finalizeWindowsSignedAcceptance(
    {
      handoffIndexPath: values["handoff-index"],
      cellManifestPaths: values["cell-manifest"],
    },
    {
      expectedHandoffIndexSha256:
        values["expected-handoff-index-sha256"].toLowerCase(),
      expectedCandidateManifestSha256:
        values["expected-candidate-manifest-sha256"].toLowerCase(),
      expectedReleasePolicySha256:
        values["expected-release-policy-sha256"].toLowerCase(),
      expectedCandidateCommit: values["expected-candidate-commit"].toLowerCase(),
      gitExecutable: values["git-executable"],
    },
  );
  const outputPath = resolve(values.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(matrix, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Windows signed acceptance finalization failed: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}
