import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  WINDOWS_HANDOFF_ARTIFACT_ROLES,
  validateWindowsCellHandoffDocument,
  validateWindowsHandoffIndexDocument,
  validateWindowsSignedAcceptanceMatrixDocument,
} from "./windows-handoff-contracts.mjs";
import { windowsAcceptanceCellFixture } from "./windows-release-evidence-fixtures.mjs";

const COMMIT = "a".repeat(40);
const SHA = (value) => value.repeat(64);

test("handoff index freezes the exact internal candidate, artifacts, harness, and cells", () => {
  const index = handoffIndexFixture();
  assert.equal(validateWindowsHandoffIndexDocument(index), index);

  const crossed = structuredClone(index);
  crossed.distributionChannel = "production";
  assert.throws(
    () => validateWindowsHandoffIndexDocument(crossed),
    /signing_tuple_invalid/u,
  );
});

test("handoff JSON Schemas accept runtime fixtures and reject self-promotion", async () => {
  const fixtures = [
    ["windows-handoff-index.schema.json", handoffIndexFixture()],
    ["windows-cell-handoff.schema.json", cellHandoffFixture()],
    ["windows-signed-acceptance-matrix.schema.json", matrixFixture()],
  ];
  for (const [name, fixture] of fixtures) {
    const validate = await schemaValidator(name);
    assert.equal(validate(fixture), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }

  const validateMatrix = await schemaValidator(
    "windows-signed-acceptance-matrix.schema.json",
  );
  const selfPromoted = matrixFixture();
  selfPromoted.verdict.releaseReady = true;
  assert.equal(validateMatrix(selfPromoted), false);
});

test("handoff paths are relative and cannot traverse outside the handoff root", () => {
  const index = handoffIndexFixture();
  index.artifacts.provider.path = "../outside/cua-driver.exe";
  assert.throws(
    () => validateWindowsHandoffIndexDocument(index),
    /artifact_invalid:provider/u,
  );

  const cell = cellHandoffFixture();
  cell.inputs.repositoryRoot = "C:\\source";
  assert.throws(
    () => validateWindowsCellHandoffDocument(cell),
    /repository_root_invalid/u,
  );
});

test("internal cell handoff may omit production-only SmartScreen evidence", () => {
  const cell = cellHandoffFixture();
  assert.equal(validateWindowsCellHandoffDocument(cell), cell);
});

test("production cell handoff requires SmartScreen evidence", () => {
  const cell = cellHandoffFixture({ production: true });
  cell.inputs.manualEvidence.smartScreen = null;
  assert.throws(
    () => validateWindowsCellHandoffDocument(cell),
    /production_smartscreen_missing/u,
  );
});

test("cell handoff cannot alter an index-bound artifact digest or signing tuple shape", () => {
  const cell = cellHandoffFixture();
  delete cell.expected.artifacts.providerCatalog;
  assert.throws(
    () => validateWindowsCellHandoffDocument(cell),
    /expected_artifacts_shape_invalid/u,
  );
});

test("cell handoff pins parseable minimum Node, PowerShell, and Git versions", () => {
  const cell = cellHandoffFixture();
  cell.requiredToolVersions.node = "latest";
  assert.throws(
    () => validateWindowsCellHandoffDocument(cell),
    /tool_versions_invalid/u,
  );
});

test("matrix is canonical, immutable, and non-self-promoting", () => {
  const matrix = matrixFixture();
  assert.equal(validateWindowsSignedAcceptanceMatrixDocument(matrix), matrix);

  const duplicate = structuredClone(matrix);
  duplicate.cells.push({ ...duplicate.cells[0], cellId: "z-extra" });
  assert.throws(
    () => validateWindowsSignedAcceptanceMatrixDocument(duplicate),
    /cell_set_invalid/u,
  );

  const selfPromoted = structuredClone(matrix);
  selfPromoted.verdict.releaseReady = true;
  assert.throws(
    () => validateWindowsSignedAcceptanceMatrixDocument(selfPromoted),
    /verdict_invalid/u,
  );
});

test("handoff documents reject harness, signing-tuple, and reviewer-set drift", () => {
  const index = handoffIndexFixture();
  index.harness.commit = "b".repeat(40);
  assert.throws(
    () => validateWindowsHandoffIndexDocument(index),
    /harness_invalid/u,
  );

  const cell = cellHandoffFixture();
  cell.expected.productionEligible = true;
  assert.throws(
    () => validateWindowsCellHandoffDocument(cell),
    /expected_signing_tuple_invalid/u,
  );

  const matrix = matrixFixture();
  matrix.manualReviewerIds.push("manual-reviewer");
  assert.throws(
    () => validateWindowsSignedAcceptanceMatrixDocument(matrix),
    /reviewers_invalid/u,
  );
});

function handoffIndexFixture({ production = false } = {}) {
  return {
    schemaVersion: 1,
    kind: "ling.windows.handoff-index",
    createdAt: "2026-07-21T00:00:00.000Z",
    candidateCommit: COMMIT,
    signingTier: production ? "production_signed" : "test_signed_internal",
    distributionChannel: production ? "production" : "internal",
    productionEligible: production,
    testAuthorityKind: production ? null : "ephemeral-ci",
    candidateManifest: fileReference("candidate/candidate-manifest.json", "1"),
    releasePolicy: fileReference("candidate/windows-release-policy.json", "2"),
    artifacts: Object.fromEntries(
      WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role, index) => [
        role,
        fileReference(`candidate/${role}.bin`, String(index + 3)),
      ]),
    ),
    harness: {
      commit: COMMIT,
      files: [
        { name: "apps/desktop/tests/run-windows-acceptance.ps1", sha256: SHA("9") },
        { name: "apps/desktop/tests/windows-acceptance-report.mjs", sha256: SHA("a") },
      ],
    },
    cellManifestDirectory: "cells",
    reportDirectory: "reports",
    requiredAcceptanceCells: [windowsAcceptanceCellFixture()],
  };
}

function cellHandoffFixture({ production = false } = {}) {
  const index = handoffIndexFixture({ production });
  const inputArtifacts = Object.fromEntries(
    WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
      role,
      structuredClone(index.artifacts[role]),
    ]),
  );
  return {
    schemaVersion: 1,
    kind: "ling.windows.cell-handoff",
    runId: "4a43ddcb-df07-4bf0-8749-88c0b7bf76f3",
    handoffIndex: fileReference("../handoff-index.json", "b"),
    cell: windowsAcceptanceCellFixture(),
    expected: {
      candidateCommit: COMMIT,
      candidateManifestSha256: index.candidateManifest.sha256,
      releasePolicySha256: index.releasePolicy.sha256,
      handoffIndexSha256: SHA("b"),
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
      harnessCommit: COMMIT,
    },
    inputs: {
      repositoryRoot: "../repository",
      candidateManifest: structuredClone(index.candidateManifest),
      releasePolicy: structuredClone(index.releasePolicy),
      ...inputArtifacts,
      manualEvidence: {
        windowsVersion: fileReference("../evidence/windows-version.json", "c"),
        display: fileReference("../evidence/display.json", "d"),
        narrator: fileReference("../evidence/narrator.json", "e"),
        nvda: fileReference("../evidence/nvda.json", "f"),
        smartScreen: production
          ? fileReference("../evidence/smartscreen.json", "0")
          : null,
        installLifecycle: fileReference("../evidence/install-lifecycle.json", "1"),
      },
    },
    outputReport: { path: "../reports/win11-24h2-dual-100-150.json" },
    requiredToolVersions: {
      node: ">=22.0.0",
      powershell: ">=7.4.0",
      git: ">=2.45.0",
    },
  };
}

function matrixFixture() {
  const index = handoffIndexFixture();
  return {
    schemaVersion: 1,
    kind: "ling.windows.signed-acceptance-matrix",
    finalizedAt: "2026-07-21T02:00:00.000Z",
    handoffIndexSha256: SHA("b"),
    candidateManifestSha256: index.candidateManifest.sha256,
    releasePolicySha256: index.releasePolicy.sha256,
    candidateCommit: COMMIT,
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
    manualReviewerIds: ["manual-reviewer"],
    cells: [
      {
        cellId: "win11-24h2-dual-100-150",
        runId: "4a43ddcb-df07-4bf0-8749-88c0b7bf76f3",
        cellManifestSha256: SHA("c"),
        reportPath: "reports/win11-24h2-dual-100-150.json",
        reportSha256: SHA("d"),
        reportEvidenceSha256: SHA("e"),
        fullAcceptanceStatus: "PASS",
      },
    ],
    evidenceSha256: SHA("f"),
    verdict: {
      status: "MANUAL_REVIEW_REQUIRED",
      fullAcceptanceStatus: "PASS",
      promotionStatus: "ATTESTATION_REQUIRED",
      releaseReady: false,
      releaseBlockers: [
        "external_reviewer_attestation_unverified",
        "candidate_build_provenance_unverified",
      ],
    },
  };
}

function fileReference(path, digestCharacter) {
  return { path, sha256: SHA(digestCharacter) };
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
