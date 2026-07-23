import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const DRAFT_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";
const EXPECTED_SCHEMA_FILES = Object.freeze([
  "macos-acceptance-failure.schema.json",
  "macos-signed-acceptance.schema.json",
  "macos-signed-performance.schema.json",
  "macos-tcc-case.schema.json",
  "macos-tcc-revocation.schema.json",
  "windows-candidate-build-attestation.schema.json",
  "windows-candidate-manifest.schema.json",
  "windows-cell-acceptance-report.schema.json",
  "windows-cell-handoff.schema.json",
  "windows-full-manual-evidence.schema.json",
  "windows-handoff-index.schema.json",
  "windows-internal-verification.schema.json",
  "windows-release-policy.schema.json",
  "windows-release-verification.schema.json",
  "windows-review-attestation.schema.json",
  "windows-signed-acceptance-matrix.schema.json",
]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const schemaDirectory = resolve(repositoryRoot, "docs/release/evidence");
const schemaFiles = (await readdir(schemaDirectory))
  .filter((name) => name.endsWith(".schema.json"))
  .sort();

if (
  schemaFiles.length !== EXPECTED_SCHEMA_FILES.length ||
  schemaFiles.some((name, index) => name !== EXPECTED_SCHEMA_FILES[index])
) {
  throw new Error(
    `release_evidence_schema_file_set_invalid:expected=${EXPECTED_SCHEMA_FILES.join(",")}:actual=${schemaFiles.join(",")}`,
  );
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormats(ajv);
const validators = new Map();

for (const name of schemaFiles) {
  const path = resolve(schemaDirectory, name);
  const schema = JSON.parse(await readFile(path, "utf8"));
  if (schema?.$schema !== DRAFT_2020_12_URI) {
    throw new Error(`release_evidence_schema_draft_invalid:${name}`);
  }
  try {
    validators.set(name, ajv.compile(schema));
  } catch (error) {
    throw new Error(
      `release_evidence_schema_compile_failed:${name}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

validateMacosSignedAcceptanceContract(
  validators.get("macos-signed-acceptance.schema.json"),
);
validateMacosSignedPerformanceContract(
  validators.get("macos-signed-performance.schema.json"),
);

process.stdout.write(
  `Validated ${schemaFiles.length} Draft 2020-12 release evidence schemas and fail-closed macOS verdict fixtures.\n`,
);

function validateMacosSignedAcceptanceContract(validate) {
  assertValidatorPresent(validate, "macos-signed-acceptance");

  const manualReview = macosSignedAcceptanceFixture({
    reviewStatus: "not_verified",
    verdictStatus: "MANUAL_REVIEW_REQUIRED",
  });
  assertSchemaAccepts(validate, manualReview, "macos_manual_review");

  const pass = macosSignedAcceptanceFixture({
    reviewStatus: "trusted_external_signature",
    verdictStatus: "PASS",
  });
  assertSchemaAccepts(validate, pass, "macos_trusted_pass");

  const passWithoutAttestation = structuredClone(pass);
  delete passWithoutAttestation.review.attestation;
  assertSchemaRejects(
    validate,
    passWithoutAttestation,
    "macos_pass_without_attestation",
  );

  const selfAssertedPass = structuredClone(manualReview);
  selfAssertedPass.verdict = {
    status: "PASS",
    pass: true,
    signedReleaseEvidence: true,
    manualReviewRequired: false,
  };
  assertSchemaRejects(validate, selfAssertedPass, "macos_pass_not_verified");

  const trustedManualReview = structuredClone(pass);
  trustedManualReview.verdict = {
    status: "MANUAL_REVIEW_REQUIRED",
    pass: false,
    signedReleaseEvidence: false,
    manualReviewRequired: true,
  };
  assertSchemaRejects(
    validate,
    trustedManualReview,
    "macos_manual_review_with_trusted_attestation",
  );
}

function validateMacosSignedPerformanceContract(validate) {
  assertValidatorPresent(validate, "macos-signed-performance");

  const pass = macosSignedPerformanceFixture(true);
  assertSchemaAccepts(validate, pass, "macos_performance_pass");

  const budgetFailure = macosSignedPerformanceFixture(false);
  assertSchemaAccepts(validate, budgetFailure, "macos_performance_budget_fail");

  const inconsistent = structuredClone(budgetFailure);
  inconsistent.verdict = { status: "PASS", pass: true };
  assertSchemaRejects(
    validate,
    inconsistent,
    "macos_performance_inconsistent_verdict",
  );
}

function macosSignedAcceptanceFixture({ reviewStatus, verdictStatus }) {
  const reference = (name) => ({
    path: `evidence/${name}.json`,
    sha256: "a".repeat(64),
  });
  const architectureEvidence = (name) => ({
    arm64: reference(`${name}-arm64`),
  });
  const captureIndicator = (architecture) => ({
    window: reference(`${architecture}-window-indicator`),
    display: reference(`${architecture}-display-indicator`),
    clearedAfterHide: true,
    clearedAfterExit: true,
  });
  const trusted = reviewStatus === "trusted_external_signature";
  return {
    schemaVersion: 2,
    kind: "ling-desktop-macos-signed-acceptance",
    candidate: reference("candidate"),
    notarization: {
      submissions: Array.from({ length: 2 }, (_, index) => ({
        submissionId: `submission-${index + 1}`,
        artifactSha256: "b".repeat(64),
        log: reference(`notary-${index + 1}`),
      })),
      ticketStapled: true,
    },
    tccCases: {
      denied: architectureEvidence("denied"),
      prompt: architectureEvidence("prompt"),
      granted: architectureEvidence("granted"),
      revoked: architectureEvidence("revoked"),
    },
    captureIndicator: {
      arm64: captureIndicator("arm64"),
    },
    voiceOver: {
      operator: "release-owner",
      focusOrder: true,
      names: true,
      statusAnnouncements: true,
      recoveryActions: true,
      evidence: reference("voiceover"),
    },
    performance: architectureEvidence("performance"),
    review: {
      reviewedBy: "release-reviewer",
      reviewedAt: "2026-07-17T00:00:00.000Z",
      evidenceSha256: "c".repeat(64),
      verification: trusted
        ? {
            status: "trusted_external_signature",
            verifier: "ling-release-review-verifier",
            keyId: "macos-review-key-1",
          }
        : { status: "not_verified" },
      ...(trusted ? { attestation: reference("review-attestation") } : {}),
    },
    verdict:
      verdictStatus === "PASS"
        ? {
            status: "PASS",
            pass: true,
            signedReleaseEvidence: true,
            manualReviewRequired: false,
          }
        : {
            status: "MANUAL_REVIEW_REQUIRED",
            pass: false,
            signedReleaseEvidence: false,
            manualReviewRequired: true,
          },
  };
}

function macosSignedPerformanceFixture(pass) {
  const bundleFingerprint = {
    treeSha256: "d".repeat(64),
    cdhash: "e".repeat(40),
    cdhashFull: "f".repeat(64),
  };
  const lane = {
    firstFrameLatencyMs: 20,
    rssSamplesBytes: [1_000_000, 1_100_000],
    cpuSamples: [1, 2],
    sampling: {
      intervalMs: 100,
      requestedHoldMs: 1_000,
      observedHoldMs: 1_000,
      sampleCount: 2,
      minimumSamples: 2,
    },
  };
  return {
    schemaVersion: 1,
    kind: "ling-desktop-macos-signed-performance",
    candidate: {
      reportSha256: "a".repeat(64),
      teamId: "ABCDE12345",
      bundleFingerprint,
    },
    executable: {
      path: "release/Ling Stack.app/Contents/MacOS/Ling Stack",
      sha256: "b".repeat(64),
      architectures: ["arm64"],
      executionArchitecture: "arm64",
      bundleFingerprint,
    },
    host: {
      platform: "darwin",
      architecture: "arm64",
      macosVersion: "15.5",
    },
    producer: {
      machineGenerated: true,
      command: "/usr/bin/node",
      script: "apps/desktop/tests/run-macos-signed-performance.mjs",
      scriptSha256: "c".repeat(64),
      args: ["--cycles", "3", "--hold-ms", "3000"],
    },
    limitations: { signedReleaseEvidence: true },
    cycles: Array.from({ length: 3 }, () => ({
      baseline: structuredClone(lane),
      capture: structuredClone(lane),
    })),
    releaseBudgetComparison: { pass },
    verdict: { status: pass ? "PASS" : "FAIL", pass },
  };
}

function assertValidatorPresent(validate, label) {
  if (typeof validate !== "function") {
    throw new Error(`release_evidence_schema_validator_missing:${label}`);
  }
}

function assertSchemaAccepts(validate, value, label) {
  if (!validate(value)) {
    throw new Error(
      `release_evidence_schema_fixture_rejected:${label}:${ajv.errorsText(validate.errors)}`,
    );
  }
}

function assertSchemaRejects(validate, value, label) {
  if (validate(value)) {
    throw new Error(`release_evidence_schema_fixture_accepted:${label}`);
  }
}
