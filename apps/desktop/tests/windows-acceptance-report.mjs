import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  win32 as windowsPath,
} from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual, promisify } from "node:util";
import { WINDOWS_CUA_DRIVER_RELEASE } from "./verify-windows-cua-driver-provider.mjs";
import {
  WINDOWS_CANDIDATE_MANIFEST_KIND,
  WINDOWS_CANDIDATE_MANIFEST_VERSION,
  WINDOWS_RELEASE_POLICY_KIND,
  WINDOWS_RELEASE_POLICY_SCHEMA_VERSION,
  WINDOWS_RELEASE_POLICY_VERSION,
  WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
  WINDOWS_PROVIDER_LOCK_RELATIVE_PATH,
  WINDOWS_PROVIDER_RELATIVE_PATH,
  WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
  validateWindowsCandidateManifestDocument,
  validateWindowsReleasePolicyDocument,
} from "./windows-release-evidence-contracts.mjs";

export const WINDOWS_ACCEPTANCE_SCHEMA_VERSION = 1;
export const WINDOWS_ACCEPTANCE_REPORT_KIND = "ling.windows.acceptance";
export const WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS = Object.freeze([
  "external_reviewer_attestation_unverified",
  "candidate_build_provenance_unverified",
]);
export const WINDOWS_ACCEPTANCE_STATUSES = Object.freeze([
  "PASS",
  "FAIL",
  "BLOCKED",
  "SKIP",
]);
export const WINDOWS_ACCEPTANCE_GATE_IDS = Object.freeze([
  "candidate-binding",
  "host",
  "interactive-session",
  "display-topology",
  "dpi-profile",
  "accessibility-readiness",
  "signature",
  "installer-payload",
  "install-cleanliness",
  "provider-verification",
  "provider-smoke",
]);
export const WINDOWS_RELEASE_HARNESS_FILES = Object.freeze([
  "apps/desktop/tests/finalize-windows-signed-acceptance.mjs",
  "apps/desktop/tests/load-windows-cell-handoff.mjs",
  "apps/desktop/tests/produce-windows-acceptance-handoff.mjs",
  "apps/desktop/tests/run-windows-acceptance.ps1",
  "apps/desktop/tests/run-windows-provider-smoke.mjs",
  "apps/desktop/tests/verify-windows-cua-driver-provider.mjs",
  "apps/desktop/tests/verify-windows-internal-attestations.mjs",
  "apps/desktop/tests/verify-windows-release-attestations.mjs",
  "apps/desktop/tests/windows-acceptance-report.mjs",
  "apps/desktop/tests/windows-handoff-contracts.mjs",
  "apps/desktop/tests/windows-provider-smoke-support.mjs",
  "apps/desktop/tests/windows-release-evidence-contracts.mjs",
]);

const STATUS_SET = new Set(WINDOWS_ACCEPTANCE_STATUSES);
const MODE_SET = new Set(["Preflight", "Full"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const REQUIRED_PROVIDER_VERSION = "0.8.3";
const REQUIRED_SIGNATURE_STATUS = "Valid";
const OUTPUT_LIMIT = 65_536;
const WINDOWS_FULL_EVIDENCE_SCHEMA_VERSION = 3;
const WINDOWS_FULL_EVIDENCE_KIND_PREFIX = "ling.windows.full-evidence.";
const WINDOWS_FULL_EVIDENCE_LABELS = Object.freeze([
  "windowsVersion",
  "display",
  "narrator",
  "nvda",
  "smartScreen",
  "installLifecycle",
]);
const WINDOWS_FULL_EVIDENCE_KIND_BY_LABEL = Object.freeze({
  windowsVersion: `${WINDOWS_FULL_EVIDENCE_KIND_PREFIX}windows-version`,
  display: `${WINDOWS_FULL_EVIDENCE_KIND_PREFIX}display`,
  narrator: `${WINDOWS_FULL_EVIDENCE_KIND_PREFIX}narrator`,
  nvda: `${WINDOWS_FULL_EVIDENCE_KIND_PREFIX}nvda`,
  smartScreen: `${WINDOWS_FULL_EVIDENCE_KIND_PREFIX}smartscreen`,
  installLifecycle: `${WINDOWS_FULL_EVIDENCE_KIND_PREFIX}install-lifecycle`,
});
const execFileAsync = promisify(execFile);

/**
 * Build the canonical Windows acceptance report.
 *
 * Missing release evidence is deliberately represented as BLOCKED. The builder
 * never upgrades an absent provider, Session 0, missing display/DPI profile,
 * unsigned artifact, missing accessibility tool, or unexecuted Full smoke to PASS.
 */
export function buildWindowsAcceptanceReport(input = {}) {
  const mode = normalizeMode(input.mode);
  const generatedAt = normalizeGeneratedAt(input.generatedAt);
  const handoff = normalizeHandoff(input.handoff);
  const cell = normalizeAcceptanceCell(input.cell);
  const bindings = normalizeBindings(input.bindings);
  const host = normalizeHost(input.host);
  const installation = normalizeInstallation(input.installation);
  const probes = normalizeProbes(input.probes);
  const acceptance = normalizeAcceptance(input.acceptance);
  const requirements = Object.freeze({
    requiredPlatform: "win32",
    minimumDisplayCount:
      mode === "Full" && cell.displayTopology === "single" ? 1 : 2,
    minimumDpiProfiles:
      mode === "Full" && cell.displayScalePercents.length > 0
        ? cell.displayScalePercents.length
        : mode === "Full"
          ? 2
          : 1,
    requireNarrator: true,
    requireNvda: true,
    requiredSignatureStatus: REQUIRED_SIGNATURE_STATUS,
    requiredProviderVersion: REQUIRED_PROVIDER_VERSION,
    requireCandidateManifest: mode === "Full",
    requireApprovedReleasePolicy: mode === "Full",
    requireSupportedWindowsEvidence: mode === "Full",
    requireVisualEvidence: mode === "Full",
    requireAccessibilityAcceptance: mode === "Full",
    requireSmartScreenEvidence:
      mode === "Full" &&
      bindings.candidateManifest.distributionChannel === "production",
    requireInstallerPayload: mode === "Full",
    requireInstallLifecycle: mode === "Full",
    requireHandoffBinding: mode === "Full",
    requireAcceptanceCell: mode === "Full",
  });
  const evidence = {
    handoff,
    cell,
    bindings,
    host,
    installation,
    probes,
    acceptance,
  };
  const gates = deriveGates(mode, requirements, evidence);
  const status = aggregateGateStatus(gates);
  const fullAcceptanceStatus =
    mode === "Full" && gates.every((gate) => gate.status === "PASS")
      ? "PASS"
      : status === "FAIL"
        ? "FAIL"
        : "BLOCKED";
  const counts = Object.fromEntries(
    WINDOWS_ACCEPTANCE_STATUSES.map((candidate) => [
      candidate,
      gates.filter((gate) => gate.status === candidate).length,
    ]),
  );

  const report = {
    schemaVersion: WINDOWS_ACCEPTANCE_SCHEMA_VERSION,
    kind: WINDOWS_ACCEPTANCE_REPORT_KIND,
    mode,
    generatedAt,
    requirements,
    ...evidence,
    gates,
    summary: {
      status,
      fullAcceptanceStatus,
      releaseStatus:
        mode === "Full" && fullAcceptanceStatus === "PASS"
          ? "MANUAL_REVIEW_REQUIRED"
          : fullAcceptanceStatus,
      evidenceSha256: null,
      reviewerAttestation: "not_verified",
      candidateBuildProvenance: "not_verified",
      releaseBlockers:
        mode === "Full" && fullAcceptanceStatus === "PASS"
          ? [...WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS]
          : ["full_acceptance_not_passed"],
      releaseReady: false,
      counts,
    },
  };
  report.summary.evidenceSha256 = windowsAcceptanceEvidenceSha256(report);
  return report;
}

/**
 * Hash only the immutable acceptance evidence surface. Release promotion fields are
 * deliberately excluded so an external verifier can bind its detached signatures to the
 * exact report without creating a self-referential digest.
 */
export function windowsAcceptanceEvidenceSha256(report) {
  const material = {
    schemaVersion: report?.schemaVersion,
    kind: report?.kind,
    mode: report?.mode,
    generatedAt: report?.generatedAt,
    requirements: report?.requirements,
    handoff: report?.handoff,
    cell: report?.cell,
    bindings: report?.bindings,
    host: report?.host,
    installation: report?.installation,
    probes: report?.probes,
    acceptance: report?.acceptance,
    gates: report?.gates,
    gateSummary: {
      status: report?.summary?.status,
      fullAcceptanceStatus: report?.summary?.fullAcceptanceStatus,
      counts: report?.summary?.counts,
    },
  };
  return createHash("sha256")
    .update(canonicalJson(material), "utf8")
    .digest("hex");
}

export function canonicalJson(value) {
  return JSON.stringify(sortCanonicalJsonValue(value));
}

/**
 * Validate report shape and all derived status invariants without reading files.
 *
 * The report is rebuilt exclusively from its embedded evidence. This rejects hand-edited
 * PASS statuses, but it is intentionally not the public file-authenticating validator.
 */
export function validateWindowsAcceptanceReportShape(report) {
  if (!isRecord(report)) {
    throw new TypeError("windows_acceptance_report_invalid");
  }
  if (report.schemaVersion !== WINDOWS_ACCEPTANCE_SCHEMA_VERSION) {
    throw new TypeError("windows_acceptance_schema_version_invalid");
  }
  if (report.kind !== WINDOWS_ACCEPTANCE_REPORT_KIND) {
    throw new TypeError("windows_acceptance_kind_invalid");
  }
  if (!MODE_SET.has(report.mode)) {
    throw new TypeError("windows_acceptance_mode_invalid");
  }
  if (
    !Array.isArray(report.gates) ||
    report.gates.length !== WINDOWS_ACCEPTANCE_GATE_IDS.length
  ) {
    throw new TypeError("windows_acceptance_gates_invalid");
  }
  const gateIds = report.gates.map((gate) => gate?.id);
  if (
    new Set(gateIds).size !== WINDOWS_ACCEPTANCE_GATE_IDS.length ||
    !WINDOWS_ACCEPTANCE_GATE_IDS.every(
      (gateId, index) => gateIds[index] === gateId,
    ) ||
    report.gates.some((gate) => !isRecord(gate) || !STATUS_SET.has(gate.status))
  ) {
    throw new TypeError("windows_acceptance_gate_contract_invalid");
  }

  const rebuilt = buildWindowsAcceptanceReport({
    mode: report.mode,
    generatedAt: report.generatedAt,
    handoff: report.handoff,
    cell: report.cell,
    bindings: report.bindings,
    host: report.host,
    installation: report.installation,
    probes: report.probes,
    acceptance: report.acceptance,
  });
  if (!isDeepStrictEqual(report, rebuilt)) {
    throw new TypeError("windows_acceptance_report_inconsistent");
  }
  return report;
}

/**
 * Validate the canonical report and re-read every referenced artifact and evidence file.
 * This is the public release-evidence validator. Shape-only callers must opt into the
 * explicitly named validateWindowsAcceptanceReportShape helper.
 */
export async function validateWindowsAcceptanceReport(report, options = {}) {
  validateWindowsAcceptanceReportShape(report);
  await verifyWindowsAcceptanceEvidenceFiles(report, options);
  return report;
}

export async function verifyWindowsAcceptanceEvidenceFiles(input, options = {}) {
  const bindings = input?.bindings ?? {};
  const externalAnchors = requireWindowsFullExternalAnchors(input, options);
  await verifyWindowsReleaseHarnessFiles(
    bindings.harness,
    externalAnchors?.candidateCommit ?? bindings.commit,
    input?.mode === "Full",
    {
      ...options,
      expectedRepositoryRoot: externalAnchors?.repositoryRoot,
    },
  );
  for (const [label, artifact] of [
    ["lingApp", bindings.lingApp],
    ["lingInstaller", bindings.lingInstaller],
    ["provider", bindings.provider],
    ["providerSeal", bindings.providerSeal],
    ["providerCatalog", bindings.providerCatalog],
  ]) {
    if (artifact?.exists === true) {
      await verifyFileHash(artifact, `bindings.${label}`);
    }
  }
  const fullRequired = input?.mode === "Full";
  const releasePolicy = await verifyWindowsReleasePolicyReference(
    bindings.releasePolicy,
    fullRequired,
  );
  const candidateManifest = await verifyWindowsCandidateManifestReference(
    bindings.candidateManifest,
    bindings,
    releasePolicy,
    fullRequired,
  );
  if (fullRequired) {
    const manualEvidence = await verifyWindowsFullManualEvidenceFiles({
      acceptance: input?.acceptance,
      candidateManifestSha256: bindings.candidateManifest?.sha256,
      cell: input?.cell,
      host: input?.host,
      releasePolicy,
      generatedAt: input?.generatedAt,
      requireSmartScreen:
        candidateManifest.distributionChannel === "production",
    });
    return { externalAnchors, releasePolicy, candidateManifest, manualEvidence };
  }
  return {
    externalAnchors,
    releasePolicy,
    candidateManifest,
    manualEvidence: null,
  };
}

export async function verifyWindowsReleaseHarnessFiles(
  value,
  expectedCommit,
  required = true,
  options = {},
) {
  const harness = normalizeReleaseHarness(value);
  const errors = releaseHarnessBindingErrors(
    harness,
    nullableLowercase(expectedCommit),
  );
  if (errors.length > 0) {
    if (!required && releaseHarnessIsEmpty(harness)) {
      return undefined;
    }
    throw new TypeError(
      `windows_acceptance_release_harness_invalid:${errors.join(",")}`,
    );
  }

  const repositoryRoot = await realpath(harness.repositoryRoot);
  if (options.expectedRepositoryRoot) {
    let expectedRepositoryRoot;
    try {
      expectedRepositoryRoot = await realpath(options.expectedRepositoryRoot);
    } catch {
      throw new TypeError(
        "windows_acceptance_expected_repository_root_unresolvable",
      );
    }
    if (!sameCanonicalPath(repositoryRoot, expectedRepositoryRoot)) {
      throw new TypeError(
        "windows_acceptance_external_repository_root_mismatch",
      );
    }
  }
  if (!options.gitExecutable) {
    throw new TypeError(
      "windows_acceptance_release_harness_git_verifier_required",
    );
  }
  const gitExecutable = await realpath(options.gitExecutable);
  assertTrustedGitExecutable(gitExecutable);
  if ((await realpath(harness.gitExecutable)) !== gitExecutable) {
    throw new TypeError(
      "windows_acceptance_release_harness_git_metadata_mismatch",
    );
  }
  for (const file of harness.files) {
    const workingPath = await realpath(resolve(repositoryRoot, file.name));
    const relativePath = relative(repositoryRoot, workingPath);
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith(`..${windowsPath.sep}`) ||
      relativePath.startsWith("../") ||
      isAbsolute(relativePath) ||
      resolve(file.path) !== workingPath
    ) {
      throw new TypeError(
        `windows_acceptance_release_harness_path_invalid:${file.name}`,
      );
    }
    await verifyFileHash(
      { path: workingPath, sha256: file.sha256 },
      `bindings.harness.${file.name}`,
    );
    let committedObjectId;
    let workingObjectId;
    try {
      const committed = await execFileAsync(
        gitExecutable,
        ["-C", repositoryRoot, "rev-parse", `${harness.commit}:${file.name}`],
        { encoding: "utf8", maxBuffer: 64 * 1024 },
      );
      const working = await execFileAsync(
        gitExecutable,
        [
          "-C",
          repositoryRoot,
          "hash-object",
          `--path=${file.name}`,
          workingPath,
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 },
      );
      committedObjectId = committed.stdout.trim().toLowerCase();
      workingObjectId = working.stdout.trim().toLowerCase();
    } catch {
      throw new TypeError(
        `windows_acceptance_release_harness_commit_blob_missing:${file.name}`,
      );
    }
    if (
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(committedObjectId) ||
      committedObjectId !== workingObjectId
    ) {
      throw new TypeError(
        `windows_acceptance_release_harness_commit_blob_mismatch:${file.name}`,
      );
    }
  }
  return harness;
}

export async function verifyWindowsReleasePolicyReference(reference, required = true) {
  if (!hasFileReference(reference)) {
    if (required) {
      throw new TypeError("windows_acceptance_release_policy_missing");
    }
    return null;
  }
  const parsed = await readJsonReference(reference, "bindings.releasePolicy");
  try {
    validateWindowsReleasePolicyDocument(parsed);
  } catch {
    throw new TypeError("windows_acceptance_release_policy_invalid");
  }
  const projected = normalizeReleasePolicy({
    ...parsed,
    path: reference.path,
    sha256: reference.sha256,
    verified: true,
    error: null,
  });
  if (!isDeepStrictEqual(normalizeReleasePolicy(reference), projected)) {
    throw new TypeError("windows_acceptance_release_policy_binding_invalid");
  }
  return parsed;
}

export async function verifyWindowsCandidateManifestReference(
  reference,
  bindings,
  releasePolicy,
  required = true,
) {
  if (!hasFileReference(reference)) {
    if (required) {
      throw new TypeError("windows_acceptance_candidate_manifest_missing");
    }
    return null;
  }
  const parsed = await readJsonReference(reference, "bindings.candidateManifest");
  if (!releasePolicy) {
    throw new TypeError("windows_acceptance_candidate_manifest_tuple_invalid");
  }
  try {
    validateWindowsCandidateManifestDocument(parsed, {
      policy: releasePolicy,
      expectedCommit: bindings?.commit,
      expectedReleasePolicySha256: bindings?.releasePolicy?.sha256,
    });
  } catch {
    throw new TypeError("windows_acceptance_candidate_manifest_tuple_invalid");
  }
  const projected = normalizeCandidateManifest({
    ...parsed,
    path: reference.path,
    sha256: reference.sha256,
    verified: true,
    error: null,
  });
  if (!isDeepStrictEqual(normalizeCandidateManifest(reference), projected)) {
    throw new TypeError("windows_acceptance_candidate_manifest_binding_invalid");
  }
  const governed = parsed.tierGovernedArtifacts;
  const packaged = parsed.packagedProvider;
  if (
    governed.lingApp.sha256 !== bindings?.lingApp?.sha256 ||
    governed.lingInstaller.sha256 !== bindings?.lingInstaller?.sha256 ||
    governed.provider.sha256 !== bindings?.provider?.sha256 ||
    governed.providerCatalog?.sha256 !== bindings?.providerCatalog?.sha256 ||
    packaged.providerSealSha256 !== bindings?.providerSeal?.sha256 ||
    !pathEndsWithPortableRelativePath(
      bindings?.provider?.path,
      WINDOWS_PROVIDER_RELATIVE_PATH,
    ) ||
    !pathEndsWithPortableRelativePath(
      bindings?.providerSeal?.path,
      WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
    ) ||
    !pathEndsWithPortableRelativePath(
      bindings?.providerCatalog?.path,
      WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
    )
  ) {
    throw new TypeError("windows_acceptance_candidate_manifest_artifact_mismatch");
  }
  return parsed;
}

export async function verifyWindowsFullManualEvidenceFiles({
  acceptance,
  candidateManifestSha256,
  cell,
  host,
  releasePolicy,
  generatedAt,
  requireSmartScreen = true,
}) {
  if (!SHA256_PATTERN.test(candidateManifestSha256 ?? "")) {
    throw new TypeError("windows_acceptance_manual_candidate_binding_invalid");
  }
  const usedEvidencePaths = new Set();
  const usedEvidenceHashes = new Set();
  const usedAttachmentPaths = new Set();
  const usedAttachmentHashes = new Set();
  const reviewerIds = new Set();
  const requiredLabels = WINDOWS_FULL_EVIDENCE_LABELS.filter(
    (label) => requireSmartScreen || label !== "smartScreen",
  );
  for (const label of requiredLabels) {
    const probe = acceptance?.[label];
    const reference = probe?.evidence;
    if (!hasFileReference(reference)) {
      throw new TypeError(`windows_acceptance_manual_evidence_missing:${label}`);
    }
    const evidencePath = resolve(reference.path);
    if (
      usedEvidencePaths.has(evidencePath) ||
      usedEvidenceHashes.has(reference.sha256)
    ) {
      throw new TypeError(`windows_acceptance_manual_evidence_reused:${label}`);
    }
    usedEvidencePaths.add(evidencePath);
    usedEvidenceHashes.add(reference.sha256);
    const document = await readJsonReference(reference, `acceptance.${label}.evidence`);
    validateWindowsFullManualEvidenceDocument({
      document,
      label,
      probe,
      candidateManifestSha256,
      host,
      releasePolicy,
      cell,
      generatedAt,
    });
    reviewerIds.add(document.reviewer.id);
    const evidenceDirectory = dirname(evidencePath);
    const realEvidenceDirectory = await realpath(evidenceDirectory);
    for (const [index, attachment] of document.attachments.entries()) {
      const attachmentPath = await resolveManualAttachmentPath(
        evidenceDirectory,
        realEvidenceDirectory,
        attachment.path,
      );
      if (
        usedAttachmentPaths.has(attachmentPath) ||
        usedAttachmentHashes.has(attachment.sha256)
      ) {
        throw new TypeError(
          `windows_acceptance_manual_attachment_reused:${label}:${index}`,
        );
      }
      usedAttachmentPaths.add(attachmentPath);
      usedAttachmentHashes.add(attachment.sha256);
      await verifyFileHash(
        { path: attachmentPath, sha256: attachment.sha256 },
        `acceptance.${label}.attachments.${index}`,
      );
    }
  }
  return { reviewerIds: [...reviewerIds].sort() };
}

function validateWindowsFullManualEvidenceDocument({
  document,
  label,
  probe,
  candidateManifestSha256,
  host,
  releasePolicy,
  cell,
  generatedAt,
}) {
  const expectedKind = WINDOWS_FULL_EVIDENCE_KIND_BY_LABEL[label];
  const outcome = document?.case?.outcome;
  const passed = outcome === "PASS";
  const error = nullableString(document?.case?.error);
  const generatedAtMilliseconds = Date.parse(generatedAt);
  const completedAtMilliseconds = Date.parse(document?.case?.completedAt);
  const reviewedAtMilliseconds = Date.parse(document?.reviewer?.reviewedAt);
  const approvedAtMilliseconds = Date.parse(releasePolicy?.approvedAt);
  if (
    !hasExactKeys(document, [
      "schemaVersion",
      "kind",
      "candidateManifestSha256",
      "host",
      "operator",
      "reviewer",
      "case",
      "details",
      "attachments",
    ]) ||
    !hasExactKeys(document?.host, [
      "machineName",
      "platform",
      "architecture",
      "windowsBuild",
      "session",
    ]) ||
    !hasExactKeys(document?.host?.session, [
      "id",
      "name",
      "interactive",
      "locked",
    ]) ||
    !hasExactKeys(document?.operator, ["id"]) ||
    !hasExactKeys(document?.reviewer, ["id", "reviewedAt", "status"]) ||
    !hasExactKeys(document?.case, [
      "outcome",
      "summary",
      "completedAt",
      "error",
    ]) ||
    document?.schemaVersion !== WINDOWS_FULL_EVIDENCE_SCHEMA_VERSION ||
    document?.kind !== expectedKind ||
    document?.candidateManifestSha256 !== candidateManifestSha256 ||
    document?.host?.windowsBuild !== cell?.windowsBuild ||
    document?.host?.architecture !== cell?.architecture ||
    !matchesManualEvidenceHost(document?.host, host) ||
    !nullableString(document?.operator?.id) ||
    !nullableString(document?.reviewer?.id) ||
    document.reviewer.id === document.operator.id ||
    document.reviewer.status !== "review_claimed_unverified" ||
    !isIsoTimestamp(document.reviewer.reviewedAt) ||
    !releasePolicy?.manualEvidenceReviewers?.includes(document.reviewer.id) ||
    (outcome !== "PASS" && outcome !== "FAIL") ||
    !nullableString(document?.case?.summary) ||
    !isIsoTimestamp(document?.case?.completedAt) ||
    !isIsoTimestamp(generatedAt) ||
    !isIsoTimestamp(releasePolicy?.approvedAt) ||
    completedAtMilliseconds < approvedAtMilliseconds ||
    reviewedAtMilliseconds < completedAtMilliseconds ||
    completedAtMilliseconds > generatedAtMilliseconds + 300_000 ||
    reviewedAtMilliseconds > generatedAtMilliseconds + 300_000 ||
    (passed ? error !== null : error === null) ||
    !Array.isArray(document?.attachments) ||
    document.attachments.length === 0 ||
    document.attachments.some(
      (attachment) =>
        !hasExactKeys(attachment, ["path", "sha256"]) ||
        !nullableString(attachment?.path) ||
        !SHA256_PATTERN.test(attachment?.sha256 ?? ""),
    ) ||
    probe?.attempted !== true ||
    probe?.passed !== passed ||
    probe?.operator !== document.operator.id ||
    probe?.error !== error
  ) {
    throw new TypeError(`windows_acceptance_manual_evidence_invalid:${label}`);
  }
  validateManualEvidenceDetails(
    label,
    document.details,
    passed,
    probe,
    host,
    cell,
  );
}

function validateManualEvidenceDetails(
  label,
  details,
  passed,
  probe,
  host,
  cell,
) {
  if (!isRecord(details)) {
    throw new TypeError(`windows_acceptance_manual_details_invalid:${label}`);
  }
  const hostDisplays = Array.isArray(host?.displays) ? host.displays : [];
  let shapeValid = false;
  let passDetails = false;
  if (label === "windowsVersion") {
    shapeValid =
      hasExactKeys(details, ["supportedBuild"]) &&
      typeof details.supportedBuild === "boolean";
    passDetails = details.supportedBuild === true;
  } else if (label === "display") {
    shapeValid =
      hasExactKeys(details, [
        "displayTopology",
        "displayIds",
        "dpiProfiles",
        "crossDisplayCapturePassed",
        "visualReviewPassed",
      ]) &&
      details.displayTopology === cell?.displayTopology &&
      hasTypedArray(details.displayIds, (value) => Boolean(nullableString(value))) &&
      hasTypedArray(
        details.dpiProfiles,
        (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
      ) &&
      (typeof details.crossDisplayCapturePassed === "boolean" ||
        details.crossDisplayCapturePassed === null) &&
      typeof details.visualReviewPassed === "boolean";
    passDetails =
      details.displayIds.length ===
        (cell?.displayTopology === "single" ? 1 : 2) &&
      isDeepStrictEqual(
        [...new Set(details.dpiProfiles)].sort((left, right) => left - right),
        cell?.displayScalePercents,
      ) &&
      details.displayIds.every((displayId) =>
        hostDisplays.some((display) => display.id === displayId),
      ) &&
      details.dpiProfiles.every((dpiProfile) =>
        hostDisplays.some((display) => display.scalePercent === dpiProfile),
      ) &&
      (cell?.displayTopology === "single"
        ? details.crossDisplayCapturePassed === null
        : details.crossDisplayCapturePassed === true) &&
      details.visualReviewPassed === true;
  } else if (label === "narrator" || label === "nvda") {
    const outcomes = [
      details.focusPassed,
      details.namesPassed,
      details.orderPassed,
      details.announcementsPassed,
      details.failureRecoveryPassed,
    ];
    shapeValid =
      hasExactKeys(details, [
        "focusPassed",
        "namesPassed",
        "orderPassed",
        "announcementsPassed",
        "failureRecoveryPassed",
      ]) && outcomes.every((value) => typeof value === "boolean");
    passDetails = outcomes.every((value) => value === true);
  } else if (label === "smartScreen") {
    shapeValid =
      hasExactKeys(details, [
        "reputationEstablished",
        "warningDisplayed",
        "runAnywayUsed",
        "installerLaunchAllowed",
      ]) &&
      typeof details.reputationEstablished === "boolean" &&
      typeof details.warningDisplayed === "boolean" &&
      typeof details.runAnywayUsed === "boolean" &&
      typeof details.installerLaunchAllowed === "boolean";
    passDetails =
      details.reputationEstablished === true &&
      details.warningDisplayed === false &&
      details.runAnywayUsed === false &&
      details.installerLaunchAllowed === true;
  } else if (label === "installLifecycle") {
    const outcomes = [
      details.cleanBaselinePassed,
      details.installPassed,
      details.installedSmokePassed,
      details.updatePassed,
      details.uninstallPassed,
    ];
    shapeValid =
      hasExactKeys(details, [
        "cleanBaselinePassed",
        "installPassed",
        "installedSmokePassed",
        "updatePassed",
        "uninstallPassed",
        "finalResidueCount",
      ]) &&
      outcomes.every((value) => typeof value === "boolean") &&
      Number.isSafeInteger(details.finalResidueCount) &&
      details.finalResidueCount >= 0;
    passDetails =
      outcomes.every((value) => value === true) &&
      details.finalResidueCount === 0;
    if (
      probe?.cleanBaselinePassed !== details.cleanBaselinePassed ||
      probe?.installPassed !== details.installPassed ||
      probe?.installedSmokePassed !== details.installedSmokePassed ||
      probe?.updatePassed !== details.updatePassed ||
      probe?.uninstallPassed !== details.uninstallPassed
    ) {
      throw new TypeError("windows_acceptance_install_lifecycle_binding_invalid");
    }
  }
  if (!shapeValid) {
    throw new TypeError(`windows_acceptance_manual_details_invalid:${label}`);
  }
  if (passed && !passDetails) {
    throw new TypeError(`windows_acceptance_manual_pass_details_invalid:${label}`);
  }
}

function hasTypedArray(value, predicate) {
  return Array.isArray(value) && value.length > 0 && value.every(predicate);
}

function hasUniqueNonEmptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0) &&
    new Set(value).size === value.length
  );
}

function hasValidAttestorKeys(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const normalized = normalizeAttestorKeys(value);
  return (
    normalized.length === value.length &&
    value.every(
      (entry) =>
        hasExactKeys(entry, [
          "id",
          "keyId",
          "algorithm",
          "publicKeySpkiSha256",
        ]) &&
        typeof entry.id === "string" &&
        entry.id.trim() === entry.id &&
        typeof entry.keyId === "string" &&
        entry.keyId.trim() === entry.keyId &&
        entry.algorithm === "RSA-SHA256" &&
        SHA256_PATTERN.test(entry.publicKeySpkiSha256 ?? ""),
    ) &&
    normalized.every(
      (entry) =>
        entry.id &&
        entry.keyId &&
        entry.algorithm === "RSA-SHA256" &&
        SHA256_PATTERN.test(entry.publicKeySpkiSha256 ?? ""),
    ) &&
    new Set(normalized.map((entry) => entry.id)).size === normalized.length &&
    new Set(normalized.map((entry) => entry.keyId)).size === normalized.length
  );
}

function hasIndependentAttestorRoles(reviewerKeys, candidateBuildAttestors) {
  const reviewers = normalizeAttestorKeys(reviewerKeys);
  const buildAttestors = normalizeAttestorKeys(candidateBuildAttestors);
  return ["id", "keyId", "publicKeySpkiSha256"].every((field) => {
    const reviewerValues = new Set(reviewers.map((entry) => entry[field]));
    return buildAttestors.every((entry) => !reviewerValues.has(entry[field]));
  });
}

function matchesManualEvidenceHost(candidate, host) {
  return (
    isRecord(candidate) &&
    candidate.machineName === host?.machineName &&
    candidate.platform === host?.platform &&
    candidate.architecture === host?.architecture &&
    candidate.windowsBuild === host?.windowsBuild &&
    candidate.session?.id === host?.session?.id &&
    candidate.session?.name === host?.session?.name &&
    candidate.session?.interactive === host?.session?.interactive &&
    candidate.session?.locked === host?.session?.locked
  );
}

function matchesPinnedProviderRelease(candidate) {
  return (
    isRecord(candidate) &&
    candidate.repository === WINDOWS_CUA_DRIVER_RELEASE.repository &&
    candidate.component === WINDOWS_CUA_DRIVER_RELEASE.component &&
    candidate.version === WINDOWS_CUA_DRIVER_RELEASE.version &&
    candidate.tag === WINDOWS_CUA_DRIVER_RELEASE.tag &&
    candidate.assetName === WINDOWS_CUA_DRIVER_RELEASE.assetName &&
    candidate.assetBytes === WINDOWS_CUA_DRIVER_RELEASE.assetBytes &&
    candidate.archiveSha256 === WINDOWS_CUA_DRIVER_RELEASE.sha256 &&
    candidate.providerSha256 === WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver.exe"].sha256 &&
    candidate.providerHelperSha256 === WINDOWS_CUA_DRIVER_RELEASE.binaries["cua-driver-uia.exe"].sha256
  );
}

function hasAtLeastDistinctValues(value, minimum) {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    new Set(value.map((item) => JSON.stringify(item))).size >= minimum
  );
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return isDeepStrictEqual(actual, expected);
}

function hasFileReference(value) {
  return Boolean(value?.path) && SHA256_PATTERN.test(value?.sha256 ?? "");
}

function requireWindowsFullExternalAnchors(input, options) {
  if (input?.mode !== "Full") {
    return null;
  }

  const candidateCommit = nullableLowercase(options.expectedCandidateCommit);
  if (!candidateCommit) {
    throw new TypeError(
      "windows_acceptance_expected_candidate_commit_required",
    );
  }
  if (!GIT_COMMIT_PATTERN.test(candidateCommit)) {
    throw new TypeError("windows_acceptance_expected_candidate_commit_invalid");
  }

  const repositoryRoot = nullableString(options.expectedRepositoryRoot);
  if (!repositoryRoot) {
    throw new TypeError(
      "windows_acceptance_expected_repository_root_required",
    );
  }
  if (!isAbsolute(repositoryRoot) && !windowsPath.isAbsolute(repositoryRoot)) {
    throw new TypeError("windows_acceptance_expected_repository_root_invalid");
  }

  const releasePolicySha256 = nullableLowercase(
    options.expectedReleasePolicySha256,
  );
  if (!releasePolicySha256) {
    throw new TypeError(
      "windows_acceptance_expected_release_policy_sha256_required",
    );
  }
  if (!SHA256_PATTERN.test(releasePolicySha256)) {
    throw new TypeError(
      "windows_acceptance_expected_release_policy_sha256_invalid",
    );
  }

  const bindings = input?.bindings ?? {};
  if (
    nullableLowercase(bindings.commit) !== candidateCommit ||
    nullableLowercase(bindings.harness?.commit) !== candidateCommit
  ) {
    throw new TypeError(
      "windows_acceptance_external_candidate_commit_mismatch",
    );
  }
  if (
    normalizeSha256(bindings.releasePolicy?.sha256) !== releasePolicySha256
  ) {
    throw new TypeError(
      "windows_acceptance_external_release_policy_sha256_mismatch",
    );
  }

  return { candidateCommit, repositoryRoot, releasePolicySha256 };
}

function sameCanonicalPath(left, right) {
  if (process.platform === "win32") {
    return (
      windowsPath.normalize(left).toLowerCase() ===
      windowsPath.normalize(right).toLowerCase()
    );
  }
  return left === right;
}

function pathEndsWithPortableRelativePath(absolutePath, relativePathValue) {
  if (!absolutePath || !relativePathValue) {
    return false;
  }
  const candidate = String(absolutePath).replaceAll("/", "\\").toLowerCase();
  const suffix = String(relativePathValue)
    .replaceAll("/", "\\")
    .replace(/^\\+/u, "")
    .toLowerCase();
  return candidate === suffix || candidate.endsWith(`\\${suffix}`);
}

function releaseHarnessIsEmpty(harness) {
  return (
    harness.schemaVersion === null &&
    harness.commit === null &&
    harness.repositoryRoot === null &&
    harness.gitExecutable === null &&
    harness.files.length === 0
  );
}

function releaseHarnessBindingErrors(harness, expectedCommit) {
  const errors = [];
  if (harness.schemaVersion !== 1) {
    errors.push("schema_version");
  }
  if (
    !GIT_COMMIT_PATTERN.test(harness.commit ?? "") ||
    harness.commit !== expectedCommit
  ) {
    errors.push("commit");
  }
  if (
    !harness.repositoryRoot ||
    (!isAbsolute(harness.repositoryRoot) &&
      !windowsPath.isAbsolute(harness.repositoryRoot))
  ) {
    errors.push("repository_root");
  }
  if (
    !harness.gitExecutable ||
    (!isAbsolute(harness.gitExecutable) &&
      !windowsPath.isAbsolute(harness.gitExecutable))
  ) {
    errors.push("git_executable");
  }
  const names = harness.files.map((file) => file.name);
  if (
    names.length !== WINDOWS_RELEASE_HARNESS_FILES.length ||
    !isDeepStrictEqual(names, WINDOWS_RELEASE_HARNESS_FILES)
  ) {
    errors.push("files");
  }
  for (const file of harness.files) {
    const expectedPath = harness.repositoryRoot
      ? windowsPath.resolve(
          harness.repositoryRoot,
          file.name?.replaceAll("/", windowsPath.sep) ?? "",
        )
      : undefined;
    if (
      !file.name ||
      !file.path ||
      !SHA256_PATTERN.test(file.sha256 ?? "") ||
      (windowsPath.isAbsolute(harness.repositoryRoot ?? "") &&
        windowsPath.normalize(file.path).toLowerCase() !==
          windowsPath.normalize(expectedPath ?? "").toLowerCase())
    ) {
      errors.push(`file:${file.name ?? "unknown"}`);
    }
  }
  return errors;
}

function assertTrustedGitExecutable(path) {
  if (process.platform !== "win32") {
    if (!path.endsWith("/git") && !path.endsWith("/git.exe")) {
      throw new TypeError("windows_acceptance_release_harness_git_untrusted");
    }
    return;
  }
  const trustedRoots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.RUNNER_TOOL_CACHE,
  ].filter(Boolean);
  const trusted = trustedRoots.some((root) => {
    const relativePath = windowsPath.relative(root, path);
    return (
      relativePath.length > 0 &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${windowsPath.sep}`) &&
      !windowsPath.isAbsolute(relativePath)
    );
  });
  if (!trusted || windowsPath.basename(path).toLowerCase() !== "git.exe") {
    throw new TypeError("windows_acceptance_release_harness_git_untrusted");
  }
}

async function resolveManualAttachmentPath(
  evidenceDirectory,
  realEvidenceDirectory,
  attachmentPath,
) {
  if (
    typeof attachmentPath !== "string" ||
    attachmentPath.trim().length === 0 ||
    attachmentPath.includes("\0") ||
    isAbsolute(attachmentPath) ||
    windowsPath.isAbsolute(attachmentPath) ||
    attachmentPath.split(/[\\/]/u).includes("..")
  ) {
    throw new TypeError("windows_acceptance_manual_attachment_path_invalid");
  }
  const candidatePath = resolve(realEvidenceDirectory, attachmentPath);
  const relativePath = relative(realEvidenceDirectory, candidatePath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${windowsPath.sep}`) ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    throw new TypeError("windows_acceptance_manual_attachment_path_invalid");
  }
  const realCandidatePath = await realpath(candidatePath);
  const realRelativePath = relative(realEvidenceDirectory, realCandidatePath);
  if (
    realRelativePath.length === 0 ||
    realRelativePath === ".." ||
    realRelativePath.startsWith(`..${windowsPath.sep}`) ||
    realRelativePath.startsWith("../") ||
    isAbsolute(realRelativePath)
  ) {
    throw new TypeError("windows_acceptance_manual_attachment_path_invalid");
  }
  return realCandidatePath;
}

async function readJsonReference(reference, label) {
  const bytes = await verifyFileHash(reference, label);
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw new TypeError(`windows_acceptance_json_invalid:${label}`);
  }
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value)
  );
}

async function verifyFileHash(reference, label) {
  if (!reference?.path || !SHA256_PATTERN.test(reference?.sha256 ?? "")) {
    throw new TypeError(`windows_acceptance_file_reference_invalid:${label}`);
  }
  const bytes = await readFile(resolve(reference.path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== reference.sha256) {
    throw new TypeError(`windows_acceptance_file_hash_mismatch:${label}`);
  }
  return bytes;
}

function deriveGates(mode, requirements, evidence) {
  const { handoff, cell, bindings, host, installation, probes, acceptance } =
    evidence;
  const bindingMissing = [];
  if (
    requirements.requireHandoffBinding &&
    (!handoff.runId ||
      !SHA256_PATTERN.test(handoff.handoffIndexSha256 ?? "") ||
      !SHA256_PATTERN.test(handoff.cellManifestSha256 ?? ""))
  ) {
    bindingMissing.push("handoff");
  }
  if (
    requirements.requireAcceptanceCell &&
    (!cell.id ||
      !cell.windowsBuild ||
      cell.architecture !== "x64" ||
      !["single", "dual"].includes(cell.displayTopology) ||
      cell.displayScalePercents.length === 0)
  ) {
    bindingMissing.push("acceptance_cell");
  }
  if (!GIT_COMMIT_PATTERN.test(bindings.commit ?? "")) {
    bindingMissing.push("commit");
  }
  if (releaseHarnessBindingErrors(bindings.harness, bindings.commit).length > 0) {
    bindingMissing.push("release_harness");
  }
  for (const [label, artifact] of [
    ["ling_app_sha256", bindings.lingApp],
    ["ling_installer_sha256", bindings.lingInstaller],
    ["provider_sha256", bindings.provider],
  ]) {
    if (
      !artifact.path ||
      !artifact.exists ||
      !SHA256_PATTERN.test(artifact.sha256 ?? "")
    ) {
      bindingMissing.push(label);
    }
  }
  if (mode === "Full") {
    for (const [label, artifact] of [
      ["provider_seal_sha256", bindings.providerSeal],
      ["provider_catalog_sha256", bindings.providerCatalog],
    ]) {
      if (
        !artifact.path ||
        !artifact.exists ||
        !SHA256_PATTERN.test(artifact.sha256 ?? "")
      ) {
        bindingMissing.push(label);
      }
    }
  }
  if (bindings.provider.version !== requirements.requiredProviderVersion) {
    bindingMissing.push("provider_version");
  }
  if (
    requirements.requireCandidateManifest &&
    (bindings.candidateManifest.verified !== true ||
      bindings.candidateManifest.schemaVersion !==
        WINDOWS_CANDIDATE_MANIFEST_VERSION ||
      bindings.candidateManifest.kind !== WINDOWS_CANDIDATE_MANIFEST_KIND ||
      bindings.candidateManifest.commit !== bindings.commit ||
      bindings.candidateManifest.releasePolicySha256 !==
        bindings.releasePolicy.sha256 ||
      !bindings.candidateManifest.path ||
      !SHA256_PATTERN.test(bindings.candidateManifest.sha256 ?? ""))
  ) {
    bindingMissing.push("candidate_manifest");
  }
  if (
    requirements.requireApprovedReleasePolicy &&
    (bindings.releasePolicy.verified !== true ||
      bindings.releasePolicy.schemaVersion !==
        WINDOWS_RELEASE_POLICY_SCHEMA_VERSION ||
      bindings.releasePolicy.kind !== WINDOWS_RELEASE_POLICY_KIND ||
      bindings.releasePolicy.policyVersion !== WINDOWS_RELEASE_POLICY_VERSION ||
      !bindings.releasePolicy.path ||
      !SHA256_PATTERN.test(bindings.releasePolicy.sha256 ?? "") ||
      !bindings.releasePolicy.windowsAcceptanceOwner ||
      bindings.releasePolicy.supportedWindowsBuilds.length === 0 ||
      bindings.releasePolicy.requiredAcceptanceCells.length === 0 ||
      bindings.releasePolicy.manualEvidenceReviewers.length === 0 ||
      bindings.releasePolicy.reviewerKeys.length === 0 ||
      bindings.releasePolicy.candidateBuildAttestors.length === 0 ||
      bindings.releasePolicy.error !== null)
  ) {
    bindingMissing.push("release_policy");
  }
  if (
    mode === "Full" &&
    bindings.releasePolicy.verified === true &&
    (!isDeepStrictEqual(
      bindings.releasePolicy.requiredAcceptanceCells.find(
        (candidate) => candidate.id === cell.id,
      ),
      cell,
    ) ||
      bindings.releasePolicy.requiredSigningTier !==
        bindings.candidateManifest.signingTier ||
      bindings.releasePolicy.requiredDistributionChannel !==
        bindings.candidateManifest.distributionChannel ||
      bindings.releasePolicy.requiredProductionEligible !==
        bindings.candidateManifest.productionEligible ||
      bindings.releasePolicy.requiredTestAuthorityKind !==
        bindings.candidateManifest.testAuthorityKind)
  ) {
    bindingMissing.push("policy_candidate_cell_tuple");
  }
  if (
    mode === "Full" &&
    (bindings.candidateManifest.tierGovernedArtifacts.lingApp.sha256 !==
      bindings.lingApp.sha256 ||
      bindings.candidateManifest.tierGovernedArtifacts.lingInstaller.sha256 !==
        bindings.lingInstaller.sha256 ||
      bindings.candidateManifest.tierGovernedArtifacts.provider.sha256 !==
        bindings.provider.sha256 ||
      bindings.candidateManifest.tierGovernedArtifacts.providerCatalog?.sha256 !==
        bindings.providerCatalog.sha256 ||
      bindings.candidateManifest.packagedProvider.providerSealSha256 !==
        bindings.providerSeal.sha256)
  ) {
    bindingMissing.push("candidate_artifact_tuple");
  }

  const gates = [
    gate(
      "candidate-binding",
      bindingMissing.length === 0 ? "PASS" : "BLOCKED",
      bindingMissing.length === 0
        ? "candidate_tuple_bound"
        : `missing_or_incompatible:${bindingMissing.join(",")}`,
    ),
  ];

  const windowsVersionAcceptance = deriveAcceptanceProbe(
    acceptance.windowsVersion,
    requirements.requireSupportedWindowsEvidence,
  );
  const hostInventoryReady =
    host.platform === requirements.requiredPlatform &&
    host.architecture === "x64" &&
    Boolean(host.machineName) &&
    Boolean(host.windowsBuild) &&
    host.errors.length === 0;
  const hostPolicyUnavailable =
    requirements.requireApprovedReleasePolicy &&
    bindings.releasePolicy.verified !== true;
  const hostBuildApproved =
    !requirements.requireApprovedReleasePolicy ||
    (!hostPolicyUnavailable &&
      bindings.releasePolicy.supportedWindowsBuilds.includes(host.windowsBuild) &&
      host.windowsBuild === cell.windowsBuild &&
      host.architecture === cell.architecture);
  const hostReady =
    hostInventoryReady &&
    hostBuildApproved &&
    windowsVersionAcceptance.status === "PASS";
  const hostGate = !hostInventoryReady
    ? {
        status: "BLOCKED",
        reason: "windows_x64_host_unavailable_or_probe_incomplete",
      }
    : hostPolicyUnavailable
      ? { status: "BLOCKED", reason: "windows_build_policy_unavailable" }
      : windowsVersionAcceptance.status === "FAIL"
        ? { status: "FAIL", reason: windowsVersionAcceptance.reason }
        : !hostBuildApproved
          ? { status: "FAIL", reason: "windows_build_not_approved_by_release_policy" }
          : hostReady
            ? { status: "PASS", reason: "windows_x64_supported_build_accepted" }
            : { status: "BLOCKED", reason: windowsVersionAcceptance.reason };
  gates.push(
    gate("host", hostGate.status, hostGate.reason),
  );

  const sessionReady =
    host.session.id !== null &&
    host.session.id > 0 &&
    host.session.interactive === true &&
    host.session.locked === false;
  gates.push(
    gate(
      "interactive-session",
      sessionReady ? "PASS" : "BLOCKED",
      sessionReady
        ? "unlocked_interactive_session"
        : "session_0_locked_or_noninteractive",
    ),
  );

  const displayInventoryReady =
    host.displays.length === requirements.minimumDisplayCount;
  const displayAcceptance = deriveAcceptanceProbe(
    acceptance.display,
    requirements.requireVisualEvidence,
  );
  const displayReady =
    displayInventoryReady && displayAcceptance.status === "PASS";
  gates.push(
    gate(
      "display-topology",
      displayReady
        ? "PASS"
        : displayAcceptance.status === "FAIL"
          ? "FAIL"
          : "BLOCKED",
      displayReady
        ? `display_count:${host.displays.length};cross_display_visual_evidence`
        : !displayInventoryReady
          ? `requires_${requirements.minimumDisplayCount}_displays:found_${host.displays.length}`
          : displayAcceptance.reason,
    ),
  );

  const dpiProfiles = new Set(
    host.displays
      .map((display) => display.scalePercent)
      .filter((value) => Number.isFinite(value) && value > 0),
  );
  const observedScales = [...dpiProfiles].sort((left, right) => left - right);
  const dpiInventoryReady =
    (requirements.requireAcceptanceCell
      ? dpiProfiles.size === requirements.minimumDpiProfiles &&
        isDeepStrictEqual(observedScales, cell.displayScalePercents)
      : dpiProfiles.size >= requirements.minimumDpiProfiles);
  const dpiReady = dpiInventoryReady && displayAcceptance.status === "PASS";
  gates.push(
    gate(
      "dpi-profile",
      dpiReady
        ? "PASS"
        : displayAcceptance.status === "FAIL"
          ? "FAIL"
          : "BLOCKED",
      dpiReady
        ? `dpi_profiles:${observedScales.join(",")}`
        : !dpiInventoryReady
          ? `requires_${requirements.minimumDpiProfiles}_dpi_profiles:found_${dpiProfiles.size}`
          : displayAcceptance.reason,
    ),
  );

  const missingAccessibility = [];
  if (host.accessibility.narrator.available !== true) {
    missingAccessibility.push("narrator");
  }
  if (host.accessibility.nvda.available !== true) {
    missingAccessibility.push("nvda");
  }
  const narratorAcceptance = deriveAcceptanceProbe(
    acceptance.narrator,
    requirements.requireAccessibilityAcceptance,
  );
  const nvdaAcceptance = deriveAcceptanceProbe(
    acceptance.nvda,
    requirements.requireAccessibilityAcceptance,
  );
  const accessibilityFailed =
    narratorAcceptance.status === "FAIL" || nvdaAcceptance.status === "FAIL";
  const accessibilityReady =
    missingAccessibility.length === 0 &&
    narratorAcceptance.status === "PASS" &&
    nvdaAcceptance.status === "PASS";
  gates.push(
    gate(
      "accessibility-readiness",
      accessibilityReady ? "PASS" : accessibilityFailed ? "FAIL" : "BLOCKED",
      accessibilityReady
        ? "narrator_and_nvda_real_acceptance_passed"
        : missingAccessibility.length > 0
          ? `missing:${missingAccessibility.join(",")}`
          : `manual_acceptance:${narratorAcceptance.reason},${nvdaAcceptance.reason}`,
    ),
  );

  const signatureResult = deriveSignatureGate(
    mode,
    bindings,
    acceptance.smartScreen,
  );
  gates.push(gate("signature", signatureResult.status, signatureResult.reason));

  const installerPayload = deriveInstallerPayloadGate(
    probes.installerPayload,
    bindings,
    requirements.requireInstallerPayload,
  );
  gates.push(
    gate(
      "installer-payload",
      installerPayload.status,
      installerPayload.reason,
    ),
  );

  const residue = [
    ...installation.lingProcesses,
    ...installation.providerProcesses,
    ...installation.installRoots,
    ...installation.residualPaths,
    ...installation.registryEntries,
    ...installation.shortcuts,
  ];
  const installAcceptance = deriveInstallLifecycleGate(
    acceptance.installLifecycle,
    requirements.requireInstallLifecycle,
  );
  gates.push(
    gate(
      "install-cleanliness",
      installation.observed !== true
        ? "BLOCKED"
        : residue.length > 0
          ? "FAIL"
          : installAcceptance.status,
      installation.observed !== true
        ? "install_residue_not_observed"
        : residue.length > 0
          ? `residue_detected:${residue.length}`
          : installAcceptance.status === "PASS"
            ? "install_update_uninstall_and_no_residue"
            : installAcceptance.reason,
    ),
  );

  const providerVerification = deriveProviderVerificationGate(
    probes.providerVerification,
    bindings,
  );
  gates.push(
    gate(
      "provider-verification",
      providerVerification.status,
      providerVerification.reason,
    ),
  );

  gates.push(
    gate(
      "provider-smoke",
      mode === "Preflight"
        ? "SKIP"
        : deriveProbeGate(probes.providerSmoke, "provider_smoke").status,
      mode === "Preflight"
        ? "full_smoke_not_requested"
        : deriveProbeGate(probes.providerSmoke, "provider_smoke").reason,
    ),
  );

  return gates;
}

function deriveSignatureGate(mode, bindings, smartScreen) {
  const artifacts = [
    bindings.lingApp,
    bindings.lingInstaller,
    bindings.provider,
    ...(mode === "Full" ? [bindings.providerCatalog] : []),
  ];
  if (
    artifacts.some(
      (artifact) => !artifact.exists || artifact.signature.checked !== true,
    )
  ) {
    return { status: "BLOCKED", reason: "signature_evidence_missing" };
  }
  const statuses = artifacts.map((artifact) => artifact.signature.status);
  if (statuses.some((status) => status === "NotSigned" || status === null)) {
    return { status: "BLOCKED", reason: "unsigned_artifact_or_provider" };
  }
  if (!statuses.every((status) => status === REQUIRED_SIGNATURE_STATUS)) {
    return {
      status: "FAIL",
      reason: `authenticode_invalid:${statuses.map((status) => status ?? "unknown").join(",")}`,
    };
  }
  if (
    bindings.releasePolicy.verified !== true ||
    bindings.releasePolicy.kind !== WINDOWS_RELEASE_POLICY_KIND ||
    bindings.releasePolicy.policyVersion !== WINDOWS_RELEASE_POLICY_VERSION ||
    !bindings.releasePolicy.lingSignerSubject ||
    !bindings.releasePolicy.providerSignerSubject ||
    !bindings.releasePolicy.catalogSignerSubject ||
    !SHA256_PATTERN.test(bindings.releasePolicy.lingSignerCertificateSha256 ?? "") ||
    !SHA256_PATTERN.test(bindings.releasePolicy.providerSignerCertificateSha256 ?? "") ||
    !SHA256_PATTERN.test(bindings.releasePolicy.catalogSignerCertificateSha256 ?? "")
  ) {
    return { status: "BLOCKED", reason: "approved_release_policy_missing" };
  }
  if (
    bindings.lingApp.signature.signerSubject !==
      bindings.releasePolicy.lingSignerSubject ||
    bindings.lingInstaller.signature.signerSubject !==
      bindings.releasePolicy.lingSignerSubject ||
    bindings.lingApp.signature.certificateSha256 !==
      bindings.releasePolicy.lingSignerCertificateSha256 ||
    bindings.lingInstaller.signature.certificateSha256 !==
      bindings.releasePolicy.lingSignerCertificateSha256
  ) {
    return { status: "FAIL", reason: "ling_publisher_mismatch" };
  }
  if (
    bindings.provider.signature.signerSubject !==
      bindings.releasePolicy.providerSignerSubject ||
    bindings.provider.signature.certificateSha256 !==
      bindings.releasePolicy.providerSignerCertificateSha256
  ) {
    return { status: "FAIL", reason: "provider_publisher_mismatch" };
  }
  if (
    mode === "Full" &&
    (bindings.providerCatalog.signature.signerSubject !==
      bindings.releasePolicy.catalogSignerSubject ||
      bindings.providerCatalog.signature.certificateSha256 !==
        bindings.releasePolicy.catalogSignerCertificateSha256)
  ) {
    return { status: "FAIL", reason: "provider_catalog_publisher_mismatch" };
  }
  const smartScreenAcceptance = deriveAcceptanceProbe(
    smartScreen,
    mode === "Full" &&
      bindings.candidateManifest.distributionChannel === "production",
  );
  if (smartScreenAcceptance.status !== "PASS") {
    return smartScreenAcceptance;
  }
  return {
    status: "PASS",
    reason: "publisher_bound_authenticode_and_smartscreen_passed",
  };
}

function deriveAcceptanceProbe(probe, required) {
  if (!required) {
    return { status: "PASS", reason: "not_required_in_preflight" };
  }
  if (
    probe.attempted !== true ||
    !probe.operator ||
    !probe.evidence.path ||
    !SHA256_PATTERN.test(probe.evidence.sha256 ?? "")
  ) {
    return { status: "BLOCKED", reason: "acceptance_evidence_missing" };
  }
  if (probe.passed === true && probe.error !== null) {
    return { status: "FAIL", reason: "acceptance_passed_with_error" };
  }
  if (probe.passed !== true) {
    return { status: "FAIL", reason: probe.error ?? "acceptance_failed" };
  }
  return { status: "PASS", reason: "acceptance_passed" };
}

function deriveInstallLifecycleGate(lifecycle, required) {
  if (!required) {
    return { status: "PASS", reason: "no_process_or_install_residue" };
  }
  const evidence = deriveAcceptanceProbe(lifecycle, true);
  if (evidence.status !== "PASS") {
    return evidence;
  }
  const steps = [
    lifecycle.cleanBaselinePassed,
    lifecycle.installPassed,
    lifecycle.installedSmokePassed,
    lifecycle.updatePassed,
    lifecycle.uninstallPassed,
  ];
  return steps.every((value) => value === true)
    ? { status: "PASS", reason: "install_lifecycle_passed" }
    : { status: "FAIL", reason: "install_lifecycle_step_failed" };
}

function deriveInstallerPayloadGate(probe, bindings, required) {
  if (!required) {
    return { status: "SKIP", reason: "signed_installer_payload_not_required_in_preflight" };
  }
  const base = deriveProbeGate(probe, "installer_payload");
  if (base.status !== "PASS") {
    return base;
  }
  const report = probe.report;
  const installedApp = report?.installedApp;
  const uninstaller = report?.uninstaller;
  const policy = bindings.releasePolicy;
  const governed = bindings.candidateManifest.tierGovernedArtifacts;
  const expectedVendorNativeInventory =
    bindings.candidateManifest.vendorNativeInventory;
  if (
    report?.schemaVersion !== 1 ||
    report?.mode !== "signed_installer_payload_roundtrip" ||
    report?.cleanBaselinePassed !== true ||
    report?.cleanupPassed !== true ||
    installedApp?.exists !== true ||
    installedApp?.sha256 !== bindings.lingApp.sha256 ||
    installedApp?.signature?.checked !== true ||
    installedApp?.signature?.status !== REQUIRED_SIGNATURE_STATUS ||
    installedApp?.signature?.signerSubject !== policy.lingSignerSubject ||
    installedApp?.signature?.certificateSha256 !==
      policy.lingSignerCertificateSha256 ||
    uninstaller?.exists !== true ||
    uninstaller?.sha256 !== governed.lingUninstaller.sha256 ||
    uninstaller?.signature?.checked !== true ||
    uninstaller?.signature?.status !== REQUIRED_SIGNATURE_STATUS ||
    uninstaller?.signature?.signerSubject !== policy.lingSignerSubject ||
    uninstaller?.signature?.certificateSha256 !==
      policy.lingSignerCertificateSha256 ||
    !matchesInstalledVendorNativeInventory(
      report?.installedVendorNativeInventory,
      expectedVendorNativeInventory,
    )
  ) {
    return { status: "FAIL", reason: "installer_payload_binding_invalid" };
  }
  return {
    status: "PASS",
    reason:
      "installed_app_uninstaller_and_vendor_native_inventory_match_manifest",
  };
}

function matchesInstalledVendorNativeInventory(observed, expected) {
  if (
    !Array.isArray(observed) ||
    !Array.isArray(expected) ||
    observed.length !== expected.length
  ) {
    return false;
  }
  return expected.every((expectedEntry, index) => {
    const observedEntry = observed[index];
    return (
      observedEntry?.relativePath === expectedEntry.relativePath &&
      observedEntry?.exists === true &&
      observedEntry?.sha256 === expectedEntry.sha256 &&
      observedEntry?.signature?.checked === true &&
      observedEntry.signature.status === expectedEntry.authenticodeStatus &&
      observedEntry.signature.signerSubject === expectedEntry.signerSubject &&
      observedEntry.signature.certificateSha256 ===
        expectedEntry.certificateSha256
    );
  });
}

function deriveProbeGate(probe, label) {
  if (probe.attempted !== true) {
    return { status: "BLOCKED", reason: `${label}_not_run` };
  }
  if (
    probe.passed !== true ||
    probe.exitCode !== 0 ||
    probe.error !== null ||
    !probe.output
  ) {
    return { status: "FAIL", reason: `${label}_failed_or_inconsistent` };
  }
  return { status: "PASS", reason: `${label}_passed` };
}

function deriveProviderVerificationGate(probe, bindings) {
  const base = deriveProbeGate(probe, "provider_verifier");
  if (base.status !== "PASS") {
    return base;
  }
  const report = probe.report;
  const providerLock = report?.providerLock;
  const providerSeal = report?.providerSeal;
  const providerCatalog = report?.providerCatalog;
  const candidate = bindings.candidateManifest;
  const governedProvider = candidate.tierGovernedArtifacts.provider;
  const governedCatalog = candidate.tierGovernedArtifacts.providerCatalog;
  const authenticode = report?.authenticode;
  const providerSignature = findProviderVerifierSignature(
    authenticode?.files,
    WINDOWS_PROVIDER_RELATIVE_PATH,
  );
  const catalogSignature = findProviderVerifierSignature(
    authenticode?.files,
    WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
  );
  const expectedCatalogMembers = [
    {
      relativePath: "payload/cua-driver.exe",
      sha256: bindings.provider.sha256,
    },
    {
      relativePath: "payload/provider-seal.json",
      sha256: bindings.providerSeal.sha256,
    },
  ];
  if (
    report?.schemaVersion !== 2 ||
    report?.mode !== "installed_bundled_provider_read_only" ||
    report?.versionProbe?.checked !== true ||
    report?.versionProbe?.expectedVersion !== REQUIRED_PROVIDER_VERSION ||
    !matchesRequiredProviderVersionOutput(report?.versionProbe?.output) ||
    report?.provider?.name !== "cua-driver.exe" ||
    report?.provider?.sha256 !== bindings.provider.sha256 ||
    providerSeal?.sha256 !== bindings.providerSeal.sha256 ||
    providerCatalog?.sha256 !== bindings.providerCatalog.sha256 ||
    !pathEndsWithPortableRelativePath(
      report?.provider?.path,
      WINDOWS_PROVIDER_RELATIVE_PATH,
    ) ||
    !pathEndsWithPortableRelativePath(
      providerSeal?.path,
      WINDOWS_PROVIDER_SEAL_RELATIVE_PATH,
    ) ||
    !pathEndsWithPortableRelativePath(
      providerCatalog?.path,
      WINDOWS_PROVIDER_CATALOG_RELATIVE_PATH,
    ) ||
    report?.uiAccessHelper?.packaged !== false ||
    report?.uiAccessHelper?.exists !== false ||
    !isDeepStrictEqual(
      report?.packageLayout?.distributionRootEntryNames,
      ["provider-lock.json", "win32-x64"],
    ) ||
    !isDeepStrictEqual(
      report?.packageLayout?.platformRootEntryNames,
      ["payload", "provider-integrity.cat"],
    ) ||
    !isDeepStrictEqual(
      report?.packageLayout?.payloadFileNames,
      ["cua-driver.exe", "provider-seal.json"],
    ) ||
    !isDeepStrictEqual(report?.packageLayout?.unexpectedPaths, [])
  ) {
    return { status: "FAIL", reason: "provider_verifier_report_invalid" };
  }
  if (
    !pathEndsWithPortableRelativePath(
      providerLock?.path,
      WINDOWS_PROVIDER_LOCK_RELATIVE_PATH,
    ) ||
    !SHA256_PATTERN.test(providerLock?.sha256 ?? "") ||
    providerLock?.componentId !== "cua-driver-win32-x64" ||
    providerLock?.sourceTarget !== "x86_64-pc-windows-msvc" ||
    providerLock?.sourceBuild?.target !== providerLock.sourceTarget ||
    providerLock?.sourceBuild?.binariesSha256BeforeSigning?.main !==
      candidate.preSignPayloadSha256
  ) {
    return { status: "FAIL", reason: "provider_verifier_lock_binding_invalid" };
  }
  const observedTestAuthorityKind = Object.hasOwn(
    providerSeal ?? {},
    "testAuthorityKind",
  )
    ? providerSeal.testAuthorityKind
    : null;
  if (
    providerSeal.schemaVersion !== 2 ||
    providerSeal.componentId !== providerLock.componentId ||
    providerSeal.lockSha256 !== providerLock.sha256 ||
    providerSeal.signingTier !== candidate.signingTier ||
    providerSeal.distributionChannel !== candidate.distributionChannel ||
    providerSeal.productionEligible !== candidate.productionEligible ||
    observedTestAuthorityKind !== candidate.testAuthorityKind ||
    providerSeal.main?.relativePath !== "payload/cua-driver.exe" ||
    providerSeal.main?.architecture !== "x86_64" ||
    providerSeal.main?.sha256 !== bindings.provider.sha256 ||
    providerSeal.main?.authenticodeStatus !==
      governedProvider.authenticodeStatus ||
    providerSeal.main?.signerSubject !== governedProvider.signerSubject ||
    providerSeal.main?.certificateSha256 !== governedProvider.certificateSha256 ||
    providerSeal.main?.timestampPolicy !== governedProvider.timestampPolicy ||
    providerSeal.main?.timestampStatus !== governedProvider.timestampStatus
  ) {
    return { status: "FAIL", reason: "provider_verifier_seal_binding_invalid" };
  }
  if (
    authenticode?.checked !== true ||
    authenticode?.trustRequired !== true ||
    authenticode.files?.length !== 2 ||
    !matchesProviderVerifierSignature(providerSignature, {
      status: governedProvider.authenticodeStatus,
      signerSubject: governedProvider.signerSubject,
      certificateSha256: governedProvider.certificateSha256,
      timestampStatus: governedProvider.timestampStatus,
    }) ||
    !matchesProviderVerifierSignature(catalogSignature, {
      status: governedCatalog?.authenticodeStatus,
      signerSubject: governedCatalog?.signerSubject,
      certificateSha256: governedCatalog?.certificateSha256,
      timestampStatus: governedCatalog?.timestampStatus,
    })
  ) {
    return {
      status: "FAIL",
      reason: "provider_verifier_authenticode_binding_invalid",
    };
  }
  if (
    providerCatalog.membership?.checked !== true ||
    providerCatalog.membership?.validationStatus !== "Valid" ||
    !isDeepStrictEqual(
      providerCatalog.membership?.members,
      expectedCatalogMembers,
    )
  ) {
    return {
      status: "FAIL",
      reason: "provider_verifier_catalog_membership_invalid",
    };
  }
  return { status: "PASS", reason: "provider_verifier_passed" };
}

function matchesRequiredProviderVersionOutput(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  const escapedVersion = REQUIRED_PROVIDER_VERSION.replaceAll(".", "\\.");
  return new RegExp(
    `(^|[^0-9A-Za-z.+-])v?${escapedVersion}($|[^0-9A-Za-z.+-])`,
    "u",
  ).test(value);
}

function findProviderVerifierSignature(files, relativePath) {
  if (!Array.isArray(files)) {
    return undefined;
  }
  const matches = files.filter((entry) =>
    pathEndsWithPortableRelativePath(entry?.path, relativePath),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function matchesProviderVerifierSignature(observed, expected) {
  return (
    observed?.status === expected.status &&
    observed?.signerSubject === expected.signerSubject &&
    observed?.certificateSha256 === expected.certificateSha256 &&
    observed?.timestampStatus === expected.timestampStatus
  );
}

function aggregateGateStatus(gates) {
  if (gates.some((gateItem) => gateItem.status === "FAIL")) {
    return "FAIL";
  }
  if (gates.some((gateItem) => gateItem.status === "BLOCKED")) {
    return "BLOCKED";
  }
  if (gates.every((gateItem) => gateItem.status === "SKIP")) {
    return "SKIP";
  }
  return "PASS";
}

function normalizeHandoff(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    runId: nullableString(candidate.runId),
    handoffIndexSha256: normalizeSha256(candidate.handoffIndexSha256),
    cellManifestSha256: normalizeSha256(candidate.cellManifestSha256),
  };
}

function normalizeAcceptanceCell(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    id: nullableString(candidate.id),
    windowsBuild: nullableString(candidate.windowsBuild),
    architecture: nullableString(candidate.architecture),
    displayTopology: nullableString(candidate.displayTopology),
    displayScalePercents: Array.isArray(candidate.displayScalePercents)
      ? [...new Set(candidate.displayScalePercents.filter((scale) =>
          Number.isSafeInteger(scale) && scale > 0))].sort(
          (left, right) => left - right,
        )
      : [],
    requiredEvidenceKinds: normalizeStringArray(
      candidate.requiredEvidenceKinds,
    ),
  };
}

function normalizeAcceptanceCells(value) {
  return Array.isArray(value)
    ? value
        .filter(isRecord)
        .map(normalizeAcceptanceCell)
        .sort((left, right) => (left.id ?? "").localeCompare(right.id ?? ""))
    : [];
}

function normalizeBindings(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    commit: nullableLowercase(candidate.commit),
    harness: normalizeReleaseHarness(candidate.harness),
    lingApp: normalizeArtifact(candidate.lingApp),
    lingInstaller: normalizeArtifact(candidate.lingInstaller),
    provider: {
      ...normalizeArtifact(candidate.provider),
      version: nullableString(candidate.provider?.version),
    },
    providerSeal: normalizeFileArtifact(candidate.providerSeal),
    providerCatalog: normalizeArtifact(candidate.providerCatalog),
    releasePolicy: normalizeReleasePolicy(candidate.releasePolicy),
    candidateManifest: normalizeCandidateManifest(candidate.candidateManifest),
  };
}

function normalizeReleaseHarness(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    schemaVersion: safeInteger(candidate.schemaVersion),
    commit: nullableLowercase(candidate.commit),
    repositoryRoot: nullableString(candidate.repositoryRoot),
    gitExecutable: nullableString(candidate.gitExecutable),
    files: Array.isArray(candidate.files)
      ? candidate.files
          .filter(isRecord)
          .map((file) => ({
            name: nullableString(file.name),
            path: nullableString(file.path),
            sha256: normalizeSha256(file.sha256),
          }))
          .sort((left, right) =>
            (left.name ?? "").localeCompare(right.name ?? ""),
          )
      : [],
  };
}

function normalizeReleasePolicy(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    path: nullableString(candidate.path),
    sha256: normalizeSha256(candidate.sha256),
    verified: candidate.verified === true,
    schemaVersion: safePositiveInteger(candidate.schemaVersion),
    kind: nullableString(candidate.kind),
    policyVersion: safePositiveInteger(candidate.policyVersion),
    status: nullableString(candidate.status),
    approvedBy: nullableString(candidate.approvedBy),
    approvedAt: nullableString(candidate.approvedAt),
    windowsAcceptanceOwner: nullableString(candidate.windowsAcceptanceOwner),
    requiredSigningTier: nullableString(candidate.requiredSigningTier),
    requiredDistributionChannel: nullableString(
      candidate.requiredDistributionChannel,
    ),
    requiredProductionEligible: nullableBoolean(
      candidate.requiredProductionEligible,
    ),
    requiredTestAuthorityKind:
      candidate.requiredTestAuthorityKind === null
        ? null
        : nullableString(candidate.requiredTestAuthorityKind),
    lingSignerSubject: nullableString(candidate.lingSignerSubject),
    providerSignerSubject: nullableString(candidate.providerSignerSubject),
    catalogSignerSubject: nullableString(candidate.catalogSignerSubject),
    lingSignerCertificateSha256: normalizeSha256(
      candidate.lingSignerCertificateSha256,
    ),
    providerSignerCertificateSha256: normalizeSha256(
      candidate.providerSignerCertificateSha256,
    ),
    catalogSignerCertificateSha256: normalizeSha256(
      candidate.catalogSignerCertificateSha256,
    ),
    supportedWindowsBuilds: normalizeStringArray(
      candidate.supportedWindowsBuilds,
    ),
    requiredAcceptanceCells: normalizeAcceptanceCells(
      candidate.requiredAcceptanceCells,
    ),
    manualEvidenceReviewers: normalizeStringArray(
      candidate.manualEvidenceReviewers,
    ),
    reviewerKeys: normalizeAttestorKeys(candidate.reviewerKeys),
    candidateBuildAttestors: normalizeAttestorKeys(
      candidate.candidateBuildAttestors,
    ),
    error: nullableString(candidate.error),
  };
}

function normalizeAttestorKeys(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((entry) => ({
      id: nullableString(entry.id),
      keyId: nullableString(entry.keyId),
      algorithm: nullableString(entry.algorithm),
      publicKeySpkiSha256: normalizeSha256(entry.publicKeySpkiSha256),
    }))
    .sort((left, right) =>
      `${left.id ?? ""}\0${left.keyId ?? ""}`.localeCompare(
        `${right.id ?? ""}\0${right.keyId ?? ""}`,
      ),
    );
}

function normalizeCandidateManifest(value) {
  const candidate = isRecord(value) ? value : {};
  const packagedProvider = isRecord(candidate.packagedProvider)
    ? candidate.packagedProvider
    : {};
  return {
    path: nullableString(candidate.path),
    sha256: normalizeSha256(candidate.sha256),
    verified: candidate.verified === true,
    schemaVersion: safePositiveInteger(candidate.schemaVersion),
    kind: nullableString(candidate.kind),
    commit: nullableLowercase(candidate.commit),
    releasePolicySha256: normalizeSha256(candidate.releasePolicySha256),
    signingTier: nullableString(candidate.signingTier),
    distributionChannel: nullableString(candidate.distributionChannel),
    productionEligible: nullableBoolean(candidate.productionEligible),
    testAuthorityKind:
      candidate.testAuthorityKind === null
        ? null
        : nullableString(candidate.testAuthorityKind),
    preSignPayloadSha256: normalizeSha256(candidate.preSignPayloadSha256),
    packagedProvider: {
      providerRelativePath: normalizePortableRelativePath(
        packagedProvider.providerRelativePath,
      ),
      providerSealRelativePath: normalizePortableRelativePath(
        packagedProvider.providerSealRelativePath,
      ),
      providerSealSha256: normalizeSha256(
        packagedProvider.providerSealSha256,
      ),
      providerCatalogRelativePath:
        packagedProvider.providerCatalogRelativePath === null
          ? null
          : normalizePortableRelativePath(
              packagedProvider.providerCatalogRelativePath,
            ),
      providerCatalogSha256: normalizeSha256(
        packagedProvider.providerCatalogSha256,
      ),
      auditOnlyUiAccessSha256: normalizeSha256(
        packagedProvider.auditOnlyUiAccessSha256,
      ),
      providerAuthenticodeSignerSubject: nullableString(
        packagedProvider.providerAuthenticodeSignerSubject,
      ),
      providerAuthenticodeCertificateSha256: normalizeSha256(
        packagedProvider.providerAuthenticodeCertificateSha256,
      ),
    },
    tierGovernedArtifacts: normalizeGovernedArtifacts(
      candidate.tierGovernedArtifacts,
    ),
    vendorNativeInventory: normalizeVendorNativeInventory(
      candidate.vendorNativeInventory,
    ),
    error: nullableString(candidate.error),
  };
}

function normalizeGovernedArtifacts(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    lingApp: normalizeGovernedArtifact(candidate.lingApp),
    lingInstaller: normalizeGovernedArtifact(candidate.lingInstaller),
    lingUninstaller: normalizeGovernedArtifact(candidate.lingUninstaller),
    provider: normalizeGovernedArtifact(candidate.provider),
    providerCatalog:
      candidate.providerCatalog === null
        ? null
        : normalizeGovernedArtifact(candidate.providerCatalog),
  };
}

function normalizeGovernedArtifact(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    relativePath: normalizePortableRelativePath(candidate.relativePath),
    sha256: normalizeSha256(candidate.sha256),
    authenticodeStatus: nullableString(candidate.authenticodeStatus),
    signerSubject: nullableString(candidate.signerSubject),
    certificateSha256: normalizeSha256(candidate.certificateSha256),
    timestampPolicy: nullableString(candidate.timestampPolicy),
    timestampStatus: nullableString(candidate.timestampStatus),
  };
}

function normalizeVendorNativeInventory(value) {
  return Array.isArray(value)
    ? value.filter(isRecord).map((entry) => ({
        relativePath: normalizePortableRelativePath(entry.relativePath),
        sha256: normalizeSha256(entry.sha256),
        authenticodeStatus: nullableString(entry.authenticodeStatus),
        signerSubject: nullableString(entry.signerSubject),
        certificateSha256: normalizeSha256(entry.certificateSha256),
      }))
    : [];
}

function normalizeFileArtifact(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    path: nullableString(candidate.path),
    exists: candidate.exists === true,
    sha256: normalizeSha256(candidate.sha256),
  };
}

function normalizeArtifact(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    path: nullableString(candidate.path),
    exists: candidate.exists === true,
    sha256: normalizeSha256(candidate.sha256),
    signature: normalizeSignature(candidate.signature),
  };
}

function normalizeSignature(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    checked: candidate.checked === true,
    status: nullableString(candidate.status),
    signerSubject: nullableString(candidate.signerSubject),
    certificateSha256: normalizeSha256(candidate.certificateSha256),
    error: nullableString(candidate.error),
  };
}

function normalizeHost(value) {
  const candidate = isRecord(value) ? value : {};
  const session = isRecord(candidate.session) ? candidate.session : {};
  const accessibility = isRecord(candidate.accessibility)
    ? candidate.accessibility
    : {};
  return {
    platform: nullableString(candidate.platform),
    architecture: nullableString(candidate.architecture),
    machineName: nullableString(candidate.machineName),
    windowsBuild: nullableString(candidate.windowsBuild),
    session: {
      id: safeNonNegativeInteger(session.id),
      name: nullableString(session.name),
      interactive: nullableBoolean(session.interactive),
      locked: nullableBoolean(session.locked),
    },
    displays: Array.isArray(candidate.displays)
      ? candidate.displays.filter(isRecord).map((display) => ({
          id: nullableString(display.id),
          primary: display.primary === true,
          width: safePositiveNumber(display.width),
          height: safePositiveNumber(display.height),
          dpiX: safePositiveNumber(display.dpiX),
          dpiY: safePositiveNumber(display.dpiY),
          scalePercent: safePositiveNumber(display.scalePercent),
        }))
      : [],
    accessibility: {
      narrator: normalizeAccessibilityTool(accessibility.narrator),
      nvda: normalizeAccessibilityTool(accessibility.nvda),
    },
    errors: normalizeStringArray(candidate.errors),
  };
}

function normalizeAccessibilityTool(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    available: nullableBoolean(candidate.available),
    running: nullableBoolean(candidate.running),
    path: nullableString(candidate.path),
  };
}

function normalizeInstallation(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    observed: candidate.observed === true,
    lingProcesses: normalizeStringArray(candidate.lingProcesses),
    providerProcesses: normalizeStringArray(candidate.providerProcesses),
    installRoots: normalizeStringArray(candidate.installRoots),
    residualPaths: normalizeStringArray(candidate.residualPaths),
    registryEntries: normalizeStringArray(candidate.registryEntries),
    shortcuts: normalizeStringArray(candidate.shortcuts),
    errors: normalizeStringArray(candidate.errors),
  };
}

function normalizeProbes(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    providerVerification: normalizeProbe(candidate.providerVerification),
    providerSmoke: normalizeProbe(candidate.providerSmoke),
    installerPayload: normalizeProbe(candidate.installerPayload),
  };
}

function normalizeAcceptance(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    windowsVersion: normalizeAcceptanceProbe(candidate.windowsVersion),
    display: normalizeAcceptanceProbe(candidate.display),
    narrator: normalizeAcceptanceProbe(candidate.narrator),
    nvda: normalizeAcceptanceProbe(candidate.nvda),
    smartScreen: normalizeAcceptanceProbe(candidate.smartScreen),
    installLifecycle: normalizeInstallLifecycle(candidate.installLifecycle),
  };
}

function normalizeAcceptanceProbe(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    attempted: candidate.attempted === true,
    passed: nullableBoolean(candidate.passed),
    operator: nullableString(candidate.operator),
    evidence: normalizeEvidenceReference(candidate.evidence),
    error: nullableString(candidate.error),
  };
}

function normalizeInstallLifecycle(value) {
  const probe = normalizeAcceptanceProbe(value);
  const candidate = isRecord(value) ? value : {};
  return {
    ...probe,
    cleanBaselinePassed: nullableBoolean(candidate.cleanBaselinePassed),
    installPassed: nullableBoolean(candidate.installPassed),
    installedSmokePassed: nullableBoolean(candidate.installedSmokePassed),
    updatePassed: nullableBoolean(candidate.updatePassed),
    uninstallPassed: nullableBoolean(candidate.uninstallPassed),
  };
}

function normalizeEvidenceReference(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    path: nullableString(candidate.path),
    sha256: normalizeSha256(candidate.sha256),
  };
}

function normalizeProbe(value) {
  const candidate = isRecord(value) ? value : {};
  return {
    attempted: candidate.attempted === true,
    passed: nullableBoolean(candidate.passed),
    exitCode: safeInteger(candidate.exitCode),
    error: nullableString(candidate.error),
    output: boundedString(candidate.output),
    report: cloneJsonValue(candidate.report),
  };
}

function gate(id, status, reason) {
  return { id, status, reason };
}

function normalizeMode(value) {
  if (!MODE_SET.has(value)) {
    throw new TypeError("windows_acceptance_mode_invalid");
  }
  return value;
}

function normalizeGeneratedAt(value) {
  const candidate =
    typeof value === "string" ? value : new Date().toISOString();
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("windows_acceptance_generated_at_invalid");
  }
  return new Date(timestamp).toISOString();
}

function normalizeSha256(value) {
  const candidate = nullableLowercase(value);
  return candidate && SHA256_PATTERN.test(candidate) ? candidate : null;
}

function normalizePortableRelativePath(value) {
  const candidate = nullableString(value);
  return candidate?.replaceAll("\\", "/") ?? null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(nullableString).filter(Boolean))].sort();
}

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableLowercase(value) {
  const candidate = nullableString(value);
  return candidate?.toLowerCase() ?? null;
}

function boundedString(value) {
  const candidate = nullableString(value);
  return candidate && candidate.length > OUTPUT_LIMIT
    ? candidate.slice(-OUTPUT_LIMIT)
    : candidate;
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safePositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function cloneJsonValue(value) {
  if (value === undefined) {
    return null;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    );
  }
  return String(value);
}

function sortCanonicalJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortCanonicalJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortCanonicalJsonValue(value[key])]),
    );
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "git-executable": { type: "string" },
      "expected-candidate-commit": { type: "string" },
      "expected-repository-root": { type: "string" },
      "expected-release-policy-sha256": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help || !values.input) {
    process.stdout.write(
      "Usage: node windows-acceptance-report.mjs --input <raw-evidence.json> [--git-executable <trusted-git.exe>] [--expected-candidate-commit <commit> --expected-repository-root <absolute-path> --expected-release-policy-sha256 <sha256>] [--output <acceptance-report.json>]\n",
    );
    if (!values.help) {
      process.exitCode = 2;
    }
    return;
  }

  const inputText = (await readFile(resolve(values.input), "utf8")).replace(
    /^\uFEFF/u,
    "",
  );
  const input = JSON.parse(inputText);
  const report = buildWindowsAcceptanceReport(input);
  await validateWindowsAcceptanceReport(report, {
    gitExecutable: values["git-executable"],
    expectedCandidateCommit: values["expected-candidate-commit"],
    expectedRepositoryRoot: values["expected-repository-root"],
    expectedReleasePolicySha256:
      values["expected-release-policy-sha256"],
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) {
    const outputPath = resolve(values.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, {
      encoding: "utf8",
      flag: report.mode === "Full" ? "wx" : "w",
    });
  } else {
    process.stdout.write(serialized);
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Windows acceptance report failed: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}
