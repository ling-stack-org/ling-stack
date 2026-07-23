import { isDeepStrictEqual } from "node:util";

import { validateWindowsAcceptanceCell } from "./windows-release-evidence-contracts.mjs";

export const WINDOWS_HANDOFF_INDEX_SCHEMA_VERSION = 1;
export const WINDOWS_HANDOFF_INDEX_KIND = "ling.windows.handoff-index";
export const WINDOWS_CELL_HANDOFF_SCHEMA_VERSION = 1;
export const WINDOWS_CELL_HANDOFF_KIND = "ling.windows.cell-handoff";
export const WINDOWS_SIGNED_ACCEPTANCE_MATRIX_SCHEMA_VERSION = 1;
export const WINDOWS_SIGNED_ACCEPTANCE_MATRIX_KIND =
  "ling.windows.signed-acceptance-matrix";

export const WINDOWS_HANDOFF_ARTIFACT_ROLES = Object.freeze([
  "lingApp",
  "lingInstaller",
  "lingUninstaller",
  "provider",
  "providerSeal",
  "providerCatalog",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOOL_VERSION_REQUIREMENT_PATTERN = /^>=(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SIGNING_TUPLES = Object.freeze({
  test_signed_internal: Object.freeze({
    distributionChannel: "internal",
    productionEligible: false,
    testAuthorityRequired: true,
  }),
  production_signed: Object.freeze({
    distributionChannel: "production",
    productionEligible: true,
    testAuthorityRequired: false,
  }),
});

export function validateWindowsHandoffIndexDocument(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "createdAt",
      "candidateCommit",
      "signingTier",
      "distributionChannel",
      "productionEligible",
      "testAuthorityKind",
      "candidateManifest",
      "releasePolicy",
      "artifacts",
      "harness",
      "cellManifestDirectory",
      "reportDirectory",
      "requiredAcceptanceCells",
    ],
    "windows_handoff_index_shape_invalid",
  );
  if (
    value.schemaVersion !== WINDOWS_HANDOFF_INDEX_SCHEMA_VERSION ||
    value.kind !== WINDOWS_HANDOFF_INDEX_KIND ||
    !isIsoTimestamp(value.createdAt) ||
    !GIT_COMMIT_PATTERN.test(value.candidateCommit ?? "")
  ) {
    throw new TypeError("windows_handoff_index_identity_invalid");
  }
  validateSigningTuple(value, "windows_handoff_index_signing_tuple_invalid");
  validateFileReference(
    value.candidateManifest,
    "windows_handoff_index_candidate_manifest_invalid",
  );
  validateFileReference(
    value.releasePolicy,
    "windows_handoff_index_release_policy_invalid",
  );
  assertExactKeys(
    value.artifacts,
    WINDOWS_HANDOFF_ARTIFACT_ROLES,
    "windows_handoff_index_artifacts_shape_invalid",
  );
  for (const role of WINDOWS_HANDOFF_ARTIFACT_ROLES) {
    validateFileReference(
      value.artifacts[role],
      `windows_handoff_index_artifact_invalid:${role}`,
    );
  }
  validateHarnessClosure(
    value.harness,
    value.candidateCommit,
    "windows_handoff_index_harness_invalid",
  );
  if (
    !safeRelativePath(value.cellManifestDirectory) ||
    !safeRelativePath(value.reportDirectory) ||
    value.cellManifestDirectory === value.reportDirectory
  ) {
    throw new TypeError("windows_handoff_index_directories_invalid");
  }
  validateAcceptanceCells(value.requiredAcceptanceCells);
  return value;
}

export function validateWindowsCellHandoffDocument(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "runId",
      "handoffIndex",
      "cell",
      "expected",
      "inputs",
      "outputReport",
      "requiredToolVersions",
    ],
    "windows_cell_handoff_shape_invalid",
  );
  if (
    value.schemaVersion !== WINDOWS_CELL_HANDOFF_SCHEMA_VERSION ||
    value.kind !== WINDOWS_CELL_HANDOFF_KIND ||
    !RUN_ID_PATTERN.test(value.runId ?? "")
  ) {
    throw new TypeError("windows_cell_handoff_identity_invalid");
  }
  validateFileReference(
    value.handoffIndex,
    "windows_cell_handoff_index_reference_invalid",
    { allowParent: true },
  );
  validateWindowsAcceptanceCell(value.cell);
  validateExpectedTuple(value.expected);
  assertExactKeys(
    value.inputs,
    [
      "repositoryRoot",
      "candidateManifest",
      "releasePolicy",
      "lingApp",
      "lingInstaller",
      "lingUninstaller",
      "provider",
      "providerSeal",
      "providerCatalog",
      "manualEvidence",
    ],
    "windows_cell_handoff_inputs_shape_invalid",
  );
  if (!safeManifestRelativePath(value.inputs.repositoryRoot)) {
    throw new TypeError("windows_cell_handoff_repository_root_invalid");
  }
  for (const role of [
    "candidateManifest",
    "releasePolicy",
    ...WINDOWS_HANDOFF_ARTIFACT_ROLES,
  ]) {
    validateFileReference(
      value.inputs[role],
      `windows_cell_handoff_input_invalid:${role}`,
      { allowParent: true },
    );
  }
  assertExactKeys(
    value.inputs.manualEvidence,
    [
      "windowsVersion",
      "display",
      "narrator",
      "nvda",
      "smartScreen",
      "installLifecycle",
    ],
    "windows_cell_handoff_manual_evidence_shape_invalid",
  );
  for (const [kind, reference] of Object.entries(value.inputs.manualEvidence)) {
    if (kind === "smartScreen" && reference === null) {
      if (value.expected.distributionChannel !== "internal") {
        throw new TypeError(
          "windows_cell_handoff_production_smartscreen_missing",
        );
      }
      continue;
    }
    validateFileReference(
      reference,
      `windows_cell_handoff_manual_evidence_invalid:${kind}`,
      { allowParent: true },
    );
  }
  validateFileReference(
    value.outputReport,
    "windows_cell_handoff_output_invalid",
    { requireDigest: false, allowParent: true },
  );
  assertExactKeys(
    value.requiredToolVersions,
    ["node", "powershell", "git"],
    "windows_cell_handoff_tool_versions_shape_invalid",
  );
  if (
    !Object.values(value.requiredToolVersions).every((version) =>
      typeof version === "string"
      && TOOL_VERSION_REQUIREMENT_PATTERN.test(version))
  ) {
    throw new TypeError("windows_cell_handoff_tool_versions_invalid");
  }
  return value;
}

export function validateWindowsSignedAcceptanceMatrixDocument(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "finalizedAt",
      "handoffIndexSha256",
      "candidateManifestSha256",
      "releasePolicySha256",
      "candidateCommit",
      "signingTier",
      "distributionChannel",
      "productionEligible",
      "testAuthorityKind",
      "artifacts",
      "harness",
      "cells",
      "manualReviewerIds",
      "evidenceSha256",
      "verdict",
    ],
    "windows_acceptance_matrix_shape_invalid",
  );
  if (
    value.schemaVersion !== WINDOWS_SIGNED_ACCEPTANCE_MATRIX_SCHEMA_VERSION ||
    value.kind !== WINDOWS_SIGNED_ACCEPTANCE_MATRIX_KIND ||
    !isIsoTimestamp(value.finalizedAt) ||
    !isSha256(value.handoffIndexSha256) ||
    !isSha256(value.candidateManifestSha256) ||
    !isSha256(value.releasePolicySha256) ||
    !GIT_COMMIT_PATTERN.test(value.candidateCommit ?? "") ||
    !isSha256(value.evidenceSha256)
  ) {
    throw new TypeError("windows_acceptance_matrix_identity_invalid");
  }
  validateSigningTuple(value, "windows_acceptance_matrix_signing_tuple_invalid");
  assertExactKeys(
    value.artifacts,
    WINDOWS_HANDOFF_ARTIFACT_ROLES,
    "windows_acceptance_matrix_artifacts_shape_invalid",
  );
  if (!Object.values(value.artifacts).every(isSha256)) {
    throw new TypeError("windows_acceptance_matrix_artifacts_invalid");
  }
  validateHarnessClosure(
    value.harness,
    value.candidateCommit,
    "windows_acceptance_matrix_harness_invalid",
  );
  if (!Array.isArray(value.cells) || value.cells.length === 0) {
    throw new TypeError("windows_acceptance_matrix_cells_invalid");
  }
  if (
    !Array.isArray(value.manualReviewerIds) ||
    value.manualReviewerIds.length === 0 ||
    !isSortedUnique(value.manualReviewerIds) ||
    !value.manualReviewerIds.every(
      (id) => typeof id === "string" && id.trim().length > 0,
    )
  ) {
    throw new TypeError("windows_acceptance_matrix_reviewers_invalid");
  }
  const cellIds = [];
  const runIds = [];
  const manifestDigests = [];
  const reportDigests = [];
  const reportPaths = [];
  for (const entry of value.cells) {
    assertExactKeys(
      entry,
      [
        "cellId",
        "runId",
        "cellManifestSha256",
        "reportPath",
        "reportSha256",
        "reportEvidenceSha256",
        "fullAcceptanceStatus",
      ],
      "windows_acceptance_matrix_cell_shape_invalid",
    );
    if (
      typeof entry.cellId !== "string" ||
      entry.cellId.length === 0 ||
      !RUN_ID_PATTERN.test(entry.runId ?? "") ||
      !isSha256(entry.cellManifestSha256) ||
      !safeRelativePath(entry.reportPath) ||
      !isSha256(entry.reportSha256) ||
      !isSha256(entry.reportEvidenceSha256) ||
      entry.fullAcceptanceStatus !== "PASS"
    ) {
      throw new TypeError("windows_acceptance_matrix_cell_invalid");
    }
    cellIds.push(entry.cellId);
    runIds.push(entry.runId);
    manifestDigests.push(entry.cellManifestSha256);
    reportDigests.push(entry.reportSha256);
    reportPaths.push(entry.reportPath);
  }
  if (
    !isSortedUnique(cellIds) ||
    !allUnique(runIds) ||
    !allUnique(manifestDigests) ||
    !allUnique(reportDigests) ||
    !allUnique(reportPaths)
  ) {
    throw new TypeError("windows_acceptance_matrix_cell_set_invalid");
  }
  assertExactKeys(
    value.verdict,
    [
      "status",
      "fullAcceptanceStatus",
      "promotionStatus",
      "releaseReady",
      "releaseBlockers",
    ],
    "windows_acceptance_matrix_verdict_shape_invalid",
  );
  if (
    value.verdict.status !== "MANUAL_REVIEW_REQUIRED" ||
    value.verdict.fullAcceptanceStatus !== "PASS" ||
    value.verdict.promotionStatus !== "ATTESTATION_REQUIRED" ||
    value.verdict.releaseReady !== false ||
    !isDeepStrictEqual(value.verdict.releaseBlockers, [
      "external_reviewer_attestation_unverified",
      "candidate_build_provenance_unverified",
    ])
  ) {
    throw new TypeError("windows_acceptance_matrix_verdict_invalid");
  }
  return value;
}

function validateExpectedTuple(value) {
  assertExactKeys(
    value,
    [
      "candidateCommit",
      "candidateManifestSha256",
      "releasePolicySha256",
      "handoffIndexSha256",
      "signingTier",
      "distributionChannel",
      "productionEligible",
      "testAuthorityKind",
      "artifacts",
      "harnessCommit",
    ],
    "windows_cell_handoff_expected_shape_invalid",
  );
  if (
    !GIT_COMMIT_PATTERN.test(value.candidateCommit ?? "") ||
    !isSha256(value.candidateManifestSha256) ||
    !isSha256(value.releasePolicySha256) ||
    !isSha256(value.handoffIndexSha256) ||
    !GIT_COMMIT_PATTERN.test(value.harnessCommit ?? "")
  ) {
    throw new TypeError("windows_cell_handoff_expected_identity_invalid");
  }
  validateSigningTuple(value, "windows_cell_handoff_expected_signing_tuple_invalid");
  assertExactKeys(
    value.artifacts,
    WINDOWS_HANDOFF_ARTIFACT_ROLES,
    "windows_cell_handoff_expected_artifacts_shape_invalid",
  );
  if (!Object.values(value.artifacts).every(isSha256)) {
    throw new TypeError("windows_cell_handoff_expected_artifacts_invalid");
  }
}

function validateHarnessClosure(value, expectedCommit, code) {
  assertExactKeys(value, ["commit", "files"], code);
  if (
    value.commit !== expectedCommit ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    throw new TypeError(code);
  }
  const names = [];
  for (const file of value.files) {
    assertExactKeys(file, ["name", "sha256"], code);
    if (!safeRelativePath(file.name) || !isSha256(file.sha256)) {
      throw new TypeError(code);
    }
    names.push(file.name);
  }
  if (!isSortedUnique(names)) {
    throw new TypeError(code);
  }
}

function validateAcceptanceCells(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("windows_handoff_index_cells_invalid");
  }
  const ids = [];
  for (const cell of value) {
    validateWindowsAcceptanceCell(cell);
    ids.push(cell.id);
  }
  if (!isSortedUnique(ids)) {
    throw new TypeError("windows_handoff_index_cells_invalid");
  }
}

function validateFileReference(
  value,
  code,
  { requireDigest = true, allowParent = false } = {},
) {
  const expectedKeys = requireDigest ? ["path", "sha256"] : ["path"];
  assertExactKeys(value, expectedKeys, code);
  if (
    !(allowParent
      ? safeManifestRelativePath(value.path)
      : safeRelativePath(value.path)) ||
    (requireDigest && !isSha256(value.sha256))
  ) {
    throw new TypeError(code);
  }
}

function validateSigningTuple(value, code) {
  const tuple = SIGNING_TUPLES[value?.signingTier];
  if (
    !tuple ||
    value.distributionChannel !== tuple.distributionChannel ||
    value.productionEligible !== tuple.productionEligible ||
    (tuple.testAuthorityRequired
      ? !["ephemeral-ci", "managed-internal"].includes(value.testAuthorityKind)
      : value.testAuthorityKind !== null)
  ) {
    throw new TypeError(code);
  }
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

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    !/^(?:[A-Za-z]:|[/\\])/u.test(value) &&
    !value.split(/[\\/]/u).includes("..")
  );
}

function safeManifestRelativePath(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    !/^(?:[A-Za-z]:|[/\\])/u.test(value)
  );
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isSortedUnique(value) {
  return (
    allUnique(value) && isDeepStrictEqual(value, [...value].sort())
  );
}

function allUnique(value) {
  return new Set(value).size === value.length;
}
