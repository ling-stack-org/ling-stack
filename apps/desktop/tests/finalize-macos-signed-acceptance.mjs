import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  canonicalJson,
  LING_DESKTOP_BUNDLE_ID,
  MACOS_RELEASE_ARCHITECTURES,
  MACOS_TCC_CASE_IDS,
  assertReleaseHarnessProvenance,
  captureMacosReleaseHarnessProvenance,
  macosSystemTool,
  nonEmptyString,
  reportRelativePath,
  sha256Buffer,
  sha256File,
  validDateTime,
  verifyEvidenceReference,
} from "./macos-acceptance-common.mjs";
import {
  candidateReportFingerprint,
  reverifyMacosSignedCandidateReport,
} from "./verify-macos-signed-candidate.mjs";

const EXPECTED_PERMISSION_BY_CASE = Object.freeze({
  denied: new Set(["denied", "restricted"]),
  prompt: new Set(["not-determined"]),
  granted: new Set(["granted"]),
  revoked: new Set(["denied", "restricted"]),
});
const SMOKE_MARKER =
  "Desktop direct Electron Computer Use capture first-frame/hide/show/stop smoke passed";
const PACKAGED_REAL_MARKER =
  "Ling Stack Desktop direct Electron Computer Use capture lifecycle passed";
const PACKAGED_FAKE_MARKER = "Ling Stack Desktop fake Computer Use lifecycle passed";
const execFileAsync = promisify(execFile);

export async function finalizeMacosSignedAcceptance(input, options = {}) {
  const manifestPath = resolve(
    options.manifestPath ?? input?.manifestPath ?? "macos-evidence-manifest.json",
  );
  const outputPath = resolve(
    options.outputPath ?? input?.outputPath ?? "macos-signed-acceptance.json",
  );
  const candidateEvidence = await verifyEvidenceReference(
    input?.candidate,
    manifestPath,
    "candidate",
    { parseJson: true },
  );
  const candidate = candidateEvidence.json;
  if (options.harnessProvenance) {
    assertReleaseHarnessProvenance(
      candidate?.harness,
      options.harnessProvenance,
      [
        "apps/desktop/tests/macos-acceptance-common.mjs",
        "apps/desktop/tests/verify-macos-signed-candidate.mjs",
      ],
      "candidate",
    );
  }
  const candidateFingerprint = candidateReportFingerprint(candidate);
  const candidateVerifier =
    options.candidateVerifier ?? reverifyMacosSignedCandidateReport;
  const liveCandidate = await candidateVerifier(candidate, candidateEvidence.path);
  if (
    JSON.stringify(candidateReportFingerprint(liveCandidate)) !==
    JSON.stringify(candidateFingerprint)
  ) {
    throw new Error("macos_acceptance_candidate_live_mismatch");
  }
  const candidateExecutables = candidateExecutableIndex(candidate);

  const notarization = await verifyNotarization(
    input?.notarization,
    manifestPath,
    outputPath,
    candidate,
    options,
  );

  const tccCases = {};
  const tccReports = {};
  for (const caseId of MACOS_TCC_CASE_IDS) {
    tccCases[caseId] = {};
    tccReports[caseId] = {};
    for (const architecture of MACOS_RELEASE_ARCHITECTURES) {
      const label = `tccCases.${caseId}.${architecture}`;
      const evidence = await verifyEvidenceReference(
        input?.tccCases?.[caseId]?.[architecture],
        manifestPath,
        label,
        { parseJson: true },
      );
      const validation = await assertTccCaseReport({
        report: evidence.json,
        reportPath: evidence.path,
        caseId,
        architecture,
        candidateSha256: candidateEvidence.sha256,
        candidatePath: candidateEvidence.path,
        teamId: candidate.expected.teamId,
        candidateExecutables,
        harnessProvenance: options.harnessProvenance,
      });
      tccCases[caseId][architecture] = referenceForOutput(evidence, outputPath);
      tccReports[caseId][architecture] = {
        report: evidence.json,
        reportPath: evidence.path,
        validation,
      };
    }
  }

  const captureIndicator = {};
  for (const architecture of MACOS_RELEASE_ARCHITECTURES) {
    const window = await verifyEvidenceReference(
      input?.captureIndicator?.[architecture]?.window,
      manifestPath,
      `captureIndicator.${architecture}.window`,
    );
    const display = await verifyEvidenceReference(
      input?.captureIndicator?.[architecture]?.display,
      manifestPath,
      `captureIndicator.${architecture}.display`,
    );
    if (window.sha256 === display.sha256) {
      throw new Error(`macos_acceptance_capture_indicator_not_distinct:${architecture}`);
    }
    if (
      input?.captureIndicator?.[architecture]?.clearedAfterHide !== true ||
      input?.captureIndicator?.[architecture]?.clearedAfterExit !== true
    ) {
      throw new Error(`macos_acceptance_capture_indicator_invalid:${architecture}`);
    }
    const grantedEvidence = tccReports.granted[architecture].validation.evidenceByKind;
    if (
      window.path !== grantedEvidence.get("window_capture_indicator")?.path ||
      window.sha256 !== grantedEvidence.get("window_capture_indicator")?.sha256 ||
      display.path !== grantedEvidence.get("display_capture_indicator")?.path ||
      display.sha256 !== grantedEvidence.get("display_capture_indicator")?.sha256
    ) {
      throw new Error(`macos_acceptance_capture_indicator_not_bound:${architecture}`);
    }
    captureIndicator[architecture] = {
      window: referenceForOutput(window, outputPath),
      display: referenceForOutput(display, outputPath),
      clearedAfterHide: true,
      clearedAfterExit: true,
    };
  }

  const voiceOverEvidence = await verifyEvidenceReference(
    input?.voiceOver?.evidence,
    manifestPath,
    "voiceOver.evidence",
  );
  if (
    !nonEmptyString(input?.voiceOver?.operator) ||
    input?.voiceOver?.focusOrder !== true ||
    input?.voiceOver?.names !== true ||
    input?.voiceOver?.statusAnnouncements !== true ||
    input?.voiceOver?.recoveryActions !== true
  ) {
    throw new Error("macos_acceptance_voiceover_invalid");
  }

  const performance = {};
  for (const architecture of MACOS_RELEASE_ARCHITECTURES) {
    const evidence = await verifyEvidenceReference(
      input?.performance?.[architecture],
      manifestPath,
      `performance.${architecture}`,
      { parseJson: true },
    );
    await assertSignedPerformanceReport({
      report: evidence.json,
      reportPath: evidence.path,
      architecture,
      candidateSha256: candidateEvidence.sha256,
      teamId: candidate.expected.teamId,
      candidateExecutables,
      harnessProvenance: options.harnessProvenance,
    });
    performance[architecture] = referenceForOutput(evidence, outputPath);
  }

  if (!nonEmptyString(input?.review?.reviewedBy) || !validDateTime(input?.review?.reviewedAt)) {
    throw new Error("macos_acceptance_review_invalid");
  }
  const reviewMaterial = {
    candidate: referenceForOutput(candidateEvidence, outputPath),
    notarization,
    tccCases,
    captureIndicator,
    voiceOver: {
      operator: input.voiceOver.operator.trim(),
      focusOrder: true,
      names: true,
      statusAnnouncements: true,
      recoveryActions: true,
      evidence: referenceForOutput(voiceOverEvidence, outputPath),
    },
    performance,
  };
  const reviewMaterialSha256 = sha256Buffer(
    Buffer.from(canonicalJson(reviewMaterial), "utf8"),
  );
  const reviewVerification = { status: "not_verified" };
  if (input?.review?.attestation) {
    throw new Error("macos_acceptance_review_attestation_external_only");
  }

  return {
    schemaVersion: 2,
    kind: "ling-desktop-macos-signed-acceptance",
    ...(options.harnessProvenance
      ? { harness: options.harnessProvenance }
      : {}),
    candidate: referenceForOutput(candidateEvidence, outputPath),
    notarization,
    tccCases,
    captureIndicator,
    voiceOver: reviewMaterial.voiceOver,
    performance,
    review: {
      reviewedBy: input.review.reviewedBy.trim(),
      reviewedAt: new Date(input.review.reviewedAt).toISOString(),
      evidenceSha256: reviewMaterialSha256,
      verification: reviewVerification,
    },
    verdict: {
      status: "MANUAL_REVIEW_REQUIRED",
      pass: false,
      signedReleaseEvidence: false,
      manualReviewRequired: true,
    },
  };
}

async function verifyNotarization(
  value,
  manifestPath,
  outputPath,
  candidate,
  options,
) {
  if (value?.ticketStapled !== true || !Array.isArray(value?.submissions)) {
    throw new Error("macos_acceptance_notarization_invalid");
  }
  const requiredArtifactHashes = new Set(
    [...candidate.dmgs, ...candidate.zips].map((artifact) => artifact.sha256),
  );
  const covered = new Set();
  const submissionIds = new Set();
  const submissions = [];
  for (const [index, submission] of value.submissions.entries()) {
    if (
      !nonEmptyString(submission?.submissionId) ||
      !/^[0-9a-f]{64}$/u.test(submission?.artifactSha256 ?? "") ||
      !requiredArtifactHashes.has(submission.artifactSha256) ||
      submissionIds.has(submission.submissionId)
    ) {
      throw new Error(`macos_acceptance_notarization_submission_invalid:${index}`);
    }
    submissionIds.add(submission.submissionId);
    const log = await verifyEvidenceReference(
      submission.log,
      manifestPath,
      `notarization.submissions.${index}.log`,
      { parseJson: true },
    );
    const logId = log.json?.jobId ?? log.json?.id;
    if (
      logId !== submission.submissionId ||
      log.json?.status !== "Accepted" ||
      log.json?.sha256 !== submission.artifactSha256
    ) {
      throw new Error(`macos_acceptance_notarization_log_invalid:${index}`);
    }
    const live = options?.notaryVerifier
      ? await options.notaryVerifier({
          submissionId: submission.submissionId,
          artifactSha256: submission.artifactSha256,
          profile: options.notaryProfile,
        })
      : await verifyNotarySubmissionLive({
          submissionId: submission.submissionId,
          profile: options?.notaryProfile,
        });
    if (
      live?.accepted !== true ||
      live.submissionId !== submission.submissionId ||
      live.artifactSha256 !== submission.artifactSha256
    ) {
      throw new Error(`macos_acceptance_notarization_live_invalid:${index}`);
    }
    if (covered.has(submission.artifactSha256)) {
      throw new Error(`macos_acceptance_notarization_duplicate:${index}`);
    }
    covered.add(submission.artifactSha256);
    submissions.push({
      submissionId: submission.submissionId,
      artifactSha256: submission.artifactSha256,
      log: referenceForOutput(log, outputPath),
    });
  }
  if (
    covered.size !== requiredArtifactHashes.size ||
    [...requiredArtifactHashes].some((sha256) => !covered.has(sha256))
  ) {
    throw new Error("macos_acceptance_notarization_coverage_incomplete");
  }
  return { submissions, ticketStapled: true };
}

async function verifyNotarySubmissionLive({ submissionId, profile }) {
  if (!nonEmptyString(profile)) {
    throw new Error("macos_acceptance_notary_profile_required");
  }
  const args = [
    "notarytool",
    "info",
    submissionId,
    "--keychain-profile",
    profile,
    "--output-format",
    "json",
  ];
  const info = await execFileAsync(macosSystemTool("xcrun"), args, {
    maxBuffer: 2 * 1024 * 1024,
  });
  const log = await execFileAsync(macosSystemTool("xcrun"), [
    "notarytool",
    "log",
    submissionId,
    "--keychain-profile",
    profile,
    "--output-format",
    "json",
  ], { maxBuffer: 8 * 1024 * 1024 });
  const infoJson = JSON.parse(info.stdout);
  const logJson = JSON.parse(log.stdout);
  const infoId = infoJson.id ?? infoJson.jobId;
  const logId = logJson.id ?? logJson.jobId;
  const artifactSha256 = String(
    logJson.sha256 ??
      logJson.artifactSha256 ??
      infoJson.sha256 ??
      infoJson.artifactSha256 ??
      "",
  ).toLowerCase();
  if (
    infoId !== submissionId ||
    logId !== submissionId ||
    infoJson.status !== "Accepted" ||
    logJson.status !== "Accepted" ||
    !/^[0-9a-f]{64}$/u.test(artifactSha256)
  ) {
    throw new Error("macos_acceptance_notarization_live_not_accepted");
  }
  return { accepted: true, submissionId, artifactSha256 };
}

async function assertTccCaseReport({
  report,
  reportPath,
  caseId,
  architecture,
  candidateSha256,
  candidatePath,
  teamId,
  candidateExecutables,
  harnessProvenance,
}) {
  if (
    report?.schemaVersion !== 2 ||
    report?.kind !== "ling-desktop-macos-tcc-case" ||
    report?.caseId !== caseId ||
    report?.verdict?.status !== "PASS" ||
    report?.verdict?.pass !== true ||
    report?.verdict?.overallReleaseGateClosed !== false ||
    report?.tccMutationCommandUsed !== false ||
    report?.signedCandidateReport?.sha256 !== candidateSha256 ||
    report?.signedCandidateReport?.teamId !== teamId ||
    report?.host?.platform !== "darwin" ||
    report?.host?.architecture !== architecture ||
    report?.executable?.executionArchitecture !== architecture ||
    !Array.isArray(report?.executable?.architectures) ||
    !report.executable.architectures.includes(architecture) ||
    !/^[0-9a-f]{64}$/u.test(report?.executable?.sha256 ?? "")
  ) {
    throw new Error(`macos_acceptance_tcc_case_invalid:${caseId}:${architecture}`);
  }
  if (harnessProvenance) {
    assertReleaseHarnessProvenance(
      report.harness,
      harnessProvenance,
      [
        "apps/desktop/tests/macos-acceptance-common.mjs",
        "apps/desktop/tests/run-computer-use-smoke.mjs",
        "apps/desktop/tests/run-macos-tcc-acceptance.mjs",
        "apps/desktop/tests/verify-macos-signed-candidate.mjs",
      ],
      `tcc:${caseId}:${architecture}`,
    );
  }
  const candidateBinding = candidateExecutables.get(
    report.executable.sha256,
  );
  if (
    !candidateBinding?.architectures.has(architecture) ||
    !sameBundleFingerprint(candidateBinding.bundleFingerprints, report.executable.bundleFingerprint)
  ) {
    throw new Error(
      `macos_acceptance_tcc_executable_not_bound:${caseId}:${architecture}`,
    );
  }
  const boundCandidate = await verifyEvidenceReference(
    report.signedCandidateReport,
    reportPath,
    `tcc.${caseId}.${architecture}.candidate`,
  );
  if (boundCandidate.path !== candidatePath) {
    throw new Error(`macos_acceptance_tcc_candidate_path_mismatch:${caseId}:${architecture}`);
  }
  const executable = await verifyEvidenceReference(
    {
      path: report.executable.path,
      sha256: report.executable.sha256,
    },
    reportPath,
    `tcc.${caseId}.${architecture}.executable`,
  );
  if (executable.sha256 !== report.executable.sha256) {
    throw new Error(`macos_acceptance_tcc_executable_hash_invalid:${caseId}:${architecture}`);
  }
  assertPermissionSemantics(report, caseId, architecture);

  const evidenceByKind = new Map();
  for (const [index, item] of (report.evidence ?? []).entries()) {
    if (!nonEmptyString(item?.kind) || evidenceByKind.has(item.kind)) {
      throw new Error(`macos_acceptance_tcc_evidence_invalid:${caseId}:${architecture}:${index}`);
    }
    const evidence = await verifyEvidenceReference(
      item,
      reportPath,
      `tcc.${caseId}.${architecture}.evidence.${index}`,
    );
    evidenceByKind.set(item.kind, evidence);
  }

  if (caseId === "denied" || caseId === "prompt") {
    if (!evidenceByKind.has("manual")) {
      throw new Error(`macos_acceptance_tcc_manual_evidence_missing:${caseId}:${architecture}`);
    }
    assertSkippedSmoke(report.smokes?.window, caseId, architecture, "window");
    assertSkippedSmoke(report.smokes?.display, caseId, architecture, "display");
  } else if (caseId === "granted") {
    if (
      !evidenceByKind.has("window_capture_indicator") ||
      !evidenceByKind.has("display_capture_indicator") ||
      evidenceByKind.get("window_capture_indicator")?.sha256 ===
        evidenceByKind.get("display_capture_indicator")?.sha256
    ) {
      throw new Error(`macos_acceptance_tcc_granted_evidence_invalid:${architecture}`);
    }
    await verifySmokeRecord(
      report.smokes?.window,
      reportPath,
      `tcc.granted.${architecture}.window`,
      "window",
      report.executable.sha256,
    );
    await verifySmokeRecord(
      report.smokes?.display,
      reportPath,
      `tcc.granted.${architecture}.display`,
      "display",
      report.executable.sha256,
    );
    await verifyRestartRecord(
      report.restart,
      reportPath,
      architecture,
      report.executable.sha256,
    );
  } else {
    if (!evidenceByKind.has("revocation_transition")) {
      throw new Error(`macos_acceptance_tcc_revocation_evidence_missing:${architecture}`);
    }
    const revocation = await verifyRevocationRecord(
      report.revocation,
      reportPath,
      architecture,
      report.executable.sha256,
      teamId,
      candidateSha256,
      candidateExecutables,
      harnessProvenance,
    );
    const transition = evidenceByKind.get("revocation_transition");
    if (
      transition?.path !== revocation.report.path ||
      transition?.sha256 !== revocation.report.sha256
    ) {
      throw new Error(`macos_acceptance_tcc_revocation_not_bound:${architecture}`);
    }
  }
  return { evidenceByKind };
}

function assertPermissionSemantics(report, caseId, architecture) {
  const expected = EXPECTED_PERMISSION_BY_CASE[caseId];
  if (!expected.has(report.expectedPermission)) {
    throw new Error(`macos_acceptance_tcc_expected_permission_invalid:${caseId}:${architecture}`);
  }
  const pass =
    caseId === "revoked"
      ? report.permissionBefore === "granted" &&
        expected.has(report.permissionAfter)
      : report.permissionBefore === report.expectedPermission &&
        report.permissionAfter === report.expectedPermission;
  if (!pass) {
    throw new Error(`macos_acceptance_tcc_permission_invalid:${caseId}:${architecture}`);
  }
}

function assertSkippedSmoke(value, caseId, architecture, kind) {
  if (value?.status !== "SKIP") {
    throw new Error(
      `macos_acceptance_tcc_smoke_must_skip:${caseId}:${architecture}:${kind}`,
    );
  }
}

async function verifySmokeRecord(
  value,
  reportPath,
  label,
  kind,
  executableSha256,
) {
  if (
    value?.status !== "PASS" ||
    value?.exitCode !== 0 ||
    value?.signal != null ||
    value?.executableSha256 !== executableSha256 ||
    !Array.isArray(value?.args) ||
    !validDateTime(value?.startedAt) ||
    !validDateTime(value?.finishedAt)
  ) {
    throw new Error(`macos_acceptance_smoke_invalid:${label}`);
  }
  const requiredFlag = kind === "display" ? "--display" : "--real";
  if (!value.args.includes(requiredFlag)) {
    throw new Error(`macos_acceptance_smoke_mode_invalid:${label}`);
  }
  const output = await verifyEvidenceReference(
    value.output,
    reportPath,
    `${label}.output`,
  );
  if (!output.bytes.toString("utf8").includes(SMOKE_MARKER)) {
    throw new Error(`macos_acceptance_smoke_marker_missing:${label}`);
  }
}

async function verifyRestartRecord(
  value,
  reportPath,
  architecture,
  executableSha256,
) {
  if (
    value?.status !== "PASS" ||
    value?.projectionRecovered !== true ||
    value?.sameDaemonProjection !== true ||
    value?.sameExecutableSha256 !== executableSha256
  ) {
    throw new Error(`macos_acceptance_restart_invalid:${architecture}`);
  }
  await verifySmokeRecord(
    value.firstLaunch,
    reportPath,
    `restart.${architecture}.firstLaunch`,
    "window",
    executableSha256,
  );
  await verifySmokeRecord(
    value.secondLaunch,
    reportPath,
    `restart.${architecture}.secondLaunch`,
    "window",
    executableSha256,
  );
  if (
    Date.parse(value.secondLaunch.startedAt) <
    Date.parse(value.firstLaunch.finishedAt)
  ) {
    throw new Error(`macos_acceptance_restart_sequence_invalid:${architecture}`);
  }
  if (
    value.firstLaunch?.projection?.projectionSource !== "daemon" ||
    value.secondLaunch?.projection?.projectionSource !== "daemon" ||
    JSON.stringify(value.firstLaunch.projection) !==
      JSON.stringify(value.secondLaunch.projection)
  ) {
    throw new Error(`macos_acceptance_restart_projection_invalid:${architecture}`);
  }
}

async function verifyRevocationRecord(
  value,
  tccReportPath,
  architecture,
  executableSha256,
  teamId,
  candidateSha256,
  candidateExecutables,
  harnessProvenance,
) {
  const evidence = await verifyEvidenceReference(
    value?.report,
    tccReportPath,
    `revocation.${architecture}.report`,
    { parseJson: true },
  );
  const report = evidence.json;
  if (
    report?.schemaVersion !== 2 ||
    report?.kind !== "ling-desktop-macos-tcc-revocation" ||
    report?.candidate?.reportSha256 !== candidateSha256 ||
    report?.candidate?.executableSha256 !== executableSha256 ||
    !sameBundleFingerprint(
      candidateExecutables.get(executableSha256)?.bundleFingerprints,
      report?.candidate?.bundleFingerprint,
    ) ||
    report?.candidate?.teamId !== teamId ||
    report?.candidate?.executionArchitecture !== architecture ||
    report?.host?.platform !== "darwin" ||
    report?.host?.architecture !== architecture ||
    report?.permissionBefore !== "granted" ||
    !EXPECTED_PERMISSION_BY_CASE.revoked.has(report?.permissionAfter) ||
    report?.observation?.activeCaptureBeforeRevocation !== true ||
    report?.observation?.sourceEndedOrPermissionFailureObserved !== true ||
    report?.observation?.runtimeContinuedWithoutStop !== true ||
    report?.observation?.stopRequestCount !== 0 ||
    report?.observation?.captureIndicatorCleared !== true ||
    report?.verdict?.status !== "PASS" ||
    report?.verdict?.pass !== true
  ) {
    throw new Error(`macos_acceptance_revocation_invalid:${architecture}`);
  }
  if (harnessProvenance) {
    assertReleaseHarnessProvenance(
      report.harness,
      harnessProvenance,
      [
        "apps/desktop/tests/macos-acceptance-common.mjs",
        "apps/desktop/tests/run-macos-tcc-revocation.mjs",
        "apps/desktop/tests/verify-macos-signed-candidate.mjs",
      ],
      `revocation:${architecture}`,
    );
  }
  const machineLog = await verifyEvidenceReference(
    report?.evidence?.machineLog,
    evidence.path,
    `revocation.${architecture}.machineLog`,
  );
  const indicator = await verifyEvidenceReference(
    report?.evidence?.captureIndicator,
    evidence.path,
    `revocation.${architecture}.captureIndicator`,
  );
  if (
    !machineLog.bytes.toString("utf8").includes(
      "LING_MACOS_TCC_REVOCATION_RESULT=",
    ) ||
    indicator.bytes.length === 0
  ) {
    throw new Error(`macos_acceptance_revocation_evidence_invalid:${architecture}`);
  }
  return { report: evidence };
}

async function assertSignedPerformanceReport({
  report,
  reportPath,
  architecture,
  candidateSha256,
  teamId,
  candidateExecutables,
  harnessProvenance,
}) {
  if (
    report?.schemaVersion !== 1 ||
    report?.kind !== "ling-desktop-macos-signed-performance" ||
    report?.limitations?.signedReleaseEvidence !== true ||
    report?.candidate?.reportSha256 !== candidateSha256 ||
    report?.candidate?.teamId !== teamId ||
    report?.host?.platform !== "darwin" ||
    report?.host?.architecture !== architecture ||
    report?.executable?.executionArchitecture !== architecture ||
    !/^[0-9a-f]{64}$/u.test(report?.executable?.sha256 ?? "") ||
    report?.verdict?.status !== "PASS" ||
    report?.verdict?.pass !== true ||
    report?.releaseBudgetComparison?.pass !== true ||
    report?.producer?.machineGenerated !== true ||
    report?.producer?.command !== process.execPath ||
    !/^[0-9a-f]{64}$/u.test(report?.producer?.scriptSha256 ?? "") ||
    !Array.isArray(report?.producer?.args) ||
    !Array.isArray(report?.cycles) ||
    report.cycles.length < 3
  ) {
    throw new Error(`macos_acceptance_performance_invalid:${architecture}`);
  }
  if (harnessProvenance) {
    assertReleaseHarnessProvenance(
      report.harness,
      harnessProvenance,
      [
        "apps/desktop/tests/macos-acceptance-common.mjs",
        "apps/desktop/tests/run-macos-signed-performance.mjs",
        "apps/desktop/tests/verify-macos-signed-candidate.mjs",
      ],
      `performance:${architecture}`,
    );
  }
  const trustedProducerPath = fileURLToPath(
    new URL("./run-macos-signed-performance.mjs", import.meta.url),
  );
  const trustedProducerSha256 = await sha256File(trustedProducerPath);
  if (report.producer.scriptSha256 !== trustedProducerSha256) {
    throw new Error(`macos_acceptance_performance_producer_untrusted:${architecture}`);
  }
  const candidateBinding = candidateExecutables.get(report.executable.sha256);
  if (
    !candidateBinding?.architectures.has(architecture) ||
    !sameBundleFingerprint(candidateBinding.bundleFingerprints, report.executable.bundleFingerprint)
  ) {
    throw new Error(`macos_acceptance_performance_not_bound:${architecture}`);
  }
  await verifyEvidenceReference(
    { path: report.executable.path, sha256: report.executable.sha256 },
    reportPath,
    `performance.${architecture}.executable`,
  );
  await verifyEvidenceReference(
    { path: report.producer.script, sha256: report.producer.scriptSha256 },
    reportPath,
    `performance.${architecture}.producer`,
  );
  for (const [index, cycle] of report.cycles.entries()) {
    for (const lane of ["baseline", "capture"]) {
      const value = cycle?.[lane];
      if (
        value?.exitCode !== 0 ||
        value?.signal != null ||
        !Number.isFinite(value?.firstFrameLatencyMs) ||
        value.firstFrameLatencyMs < 0 ||
        !Array.isArray(value?.rssSamplesBytes) ||
        value.rssSamplesBytes.length === 0 ||
        !Array.isArray(value?.cpuSamples) ||
        value.cpuSamples.length === 0 ||
        value.rssSamplesBytes.length !== value.cpuSamples.length ||
        value.rssSamplesBytes.some((sample) => !Number.isFinite(sample) || sample < 0) ||
        value.cpuSamples.some((sample) => !Number.isFinite(sample) || sample < 0) ||
        !Number.isInteger(value.sampling?.requestedHoldMs) ||
        value.sampling.requestedHoldMs <= 0 ||
        !Number.isInteger(value.sampling?.observedHoldMs) ||
        value.sampling.observedHoldMs < 0 ||
        !Number.isInteger(value.sampling?.minimumSamples) ||
        value.sampling.minimumSamples < 2 ||
        value.sampling?.intervalMs !== 100 ||
        value.sampling.sampleCount !== value.rssSamplesBytes.length ||
        value.sampling.observedHoldMs < Math.max(100, value.sampling.requestedHoldMs * 0.75) ||
        value.sampling.sampleCount < value.sampling.minimumSamples
      ) {
        throw new Error(
          `macos_acceptance_performance_cycle_invalid:${architecture}:${index}:${lane}`,
        );
      }
      const output = await verifyEvidenceReference(
        value.output,
        reportPath,
        `performance.${architecture}.cycles.${index}.${lane}.output`,
      );
      const marker = lane === "capture" ? PACKAGED_REAL_MARKER : PACKAGED_FAKE_MARKER;
      if (!output.bytes.toString("utf8").includes(marker)) {
        throw new Error(
          `macos_acceptance_performance_marker_missing:${architecture}:${index}:${lane}`,
        );
      }
    }
  }
  const firstFrameP95Ms = percentile(
    report.cycles.map((cycle) => cycle.capture.firstFrameLatencyMs),
    0.95,
  );
  const incrementalCpuPercent = round(
    median(report.cycles.map((cycle) => median(cycle.capture.cpuSamples))) -
      median(report.cycles.map((cycle) => median(cycle.baseline.cpuSamples))),
  );
  const workingSetOverheadBytes = Math.max(
    0,
    Math.round(
      median(report.cycles.map((cycle) => median(cycle.capture.rssSamplesBytes))) -
        median(report.cycles.map((cycle) => median(cycle.baseline.rssSamplesBytes))),
    ),
  );
  const expectedChecks = {
    localCaptureLatencyProxyMs: {
      observed: firstFrameP95Ms,
      threshold: 250,
      pass: firstFrameP95Ms < 250,
    },
    activePreviewIncrementalCpuPercent: {
      observed: incrementalCpuPercent,
      threshold: 8,
      pass: incrementalCpuPercent < 8,
    },
    activePreviewWorkingSetOverheadBytes: {
      observed: workingSetOverheadBytes,
      threshold: 20 * 1024 * 1024,
      pass: workingSetOverheadBytes < 20 * 1024 * 1024,
    },
  };
  if (
    JSON.stringify(report.releaseBudgetComparison.checks) !==
      JSON.stringify(expectedChecks) ||
    !Object.values(expectedChecks).every((check) => check.pass)
  ) {
    throw new Error(`macos_acceptance_performance_budget_forged:${architecture}`);
  }
}

function candidateExecutableIndex(candidate) {
  const index = new Map();
  for (const app of candidate.apps) {
    const sha256 = app.mainExecutable.sha256;
    const binding = index.get(sha256) ?? {
      architectures: new Set(),
      bundleFingerprints: new Set(),
    };
    for (const architecture of app.mainExecutable.architectures) {
      binding.architectures.add(architecture);
    }
    if (app.bundleFingerprint) {
      binding.bundleFingerprints.add(JSON.stringify(app.bundleFingerprint));
    }
    index.set(sha256, binding);
  }
  return index;
}

function sameBundleFingerprint(known, actual) {
  return actual && known?.has(JSON.stringify(actual));
}

function referenceForOutput(evidence, outputPath) {
  return {
    path: reportRelativePath(dirname(resolve(outputPath)), evidence.path),
    sha256: evidence.sha256,
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index];
}

function median(values) {
  return percentile(values, 0.5);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function main() {
  let outputPath;
  try {
    const { values } = parseArgs({
      options: {
        input: { type: "string" },
        output: { type: "string" },
        "notary-profile": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    outputPath = values.output ? resolve(values.output) : undefined;
    if (values.help || !values.input || !values.output) {
      process.stdout.write(
        "Usage: node finalize-macos-signed-acceptance.mjs --input <evidence-manifest.json> --output <final-report.json> [--notary-profile <profile>]\n" +
        "A local CLI invocation cannot self-assert trusted manual review; final PASS requires an external signature verifier.\n",
      );
      if (!values.help) {
        process.exitCode = 2;
      }
      return;
    }
    if (process.platform !== "darwin") {
      throw new Error("macos_acceptance_finalizer_requires_darwin");
    }
    const inputPath = resolve(values.input);
    const harnessProvenance = await captureMacosReleaseHarnessProvenance([
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL("./macos-acceptance-common.mjs", import.meta.url)),
      fileURLToPath(new URL("./verify-macos-signed-candidate.mjs", import.meta.url)),
      fileURLToPath(new URL("./run-macos-tcc-acceptance.mjs", import.meta.url)),
      fileURLToPath(new URL("./run-macos-tcc-revocation.mjs", import.meta.url)),
      fileURLToPath(new URL("./run-macos-signed-performance.mjs", import.meta.url)),
      fileURLToPath(new URL("./run-computer-use-smoke.mjs", import.meta.url)),
    ]);
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    const report = await finalizeMacosSignedAcceptance(input, {
      manifestPath: inputPath,
      outputPath,
      notaryProfile: values["notary-profile"],
      harnessProvenance,
    });
    await writeJsonAtomic(outputPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.verdict.pass) {
      process.exitCode = 2;
    }
  } catch (error) {
    if (outputPath) {
      const report = {
        schemaVersion: 2,
        kind: "ling-desktop-macos-signed-acceptance",
        failure: true,
        generatedAt: new Date().toISOString(),
        verdict: {
          status: "FAIL",
          pass: false,
          signedReleaseEvidence: false,
          manualReviewRequired: false,
        },
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      await writeJsonAtomic(outputPath, report);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `macOS signed acceptance finalization failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
