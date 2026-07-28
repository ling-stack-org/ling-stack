import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { finalizeMacosSignedAcceptance } from "./finalize-macos-signed-acceptance.mjs";
import { sha256File } from "./macos-acceptance-common.mjs";

const TEAM_ID = "ABCDE12345";
const BUNDLE_ID = "com.lingstack.desktop";
const SMOKE_MARKER =
  "Desktop direct Electron Computer Use capture first-frame/hide/show/stop smoke passed";

test("finalizer validates complete machine evidence but leaves final review external", async () => {
  const fixture = await createFixture();
  try {
    const report = await finalizeMacosSignedAcceptance(fixture.input, fixture.options);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.verdict.status, "MANUAL_REVIEW_REQUIRED");
    assert.equal(report.verdict.pass, false);
    assert.equal(report.verdict.signedReleaseEvidence, false);
    assert.equal(report.review.verification.status, "not_verified");
    assert.ok(report.tccCases.granted.arm64);
    assert.equal(report.performance.arm64.sha256, fixture.input.performance.arm64.sha256);
  } finally {
    await fixture.cleanup();
  }
});

test("local finalization cannot accept or self-verify a review attestation", async () => {
  const fixture = await createFixture();
  try {
    const unsigned = await finalizeMacosSignedAcceptance(fixture.input, {
      ...fixture.options,
      reviewVerifier: async () => ({
        trusted: true,
        verifier: "untrusted-caller",
        keyId: "self-declared-key",
      }),
    });
    assert.equal(unsigned.verdict.status, "MANUAL_REVIEW_REQUIRED");
    assert.equal(unsigned.review.verification.status, "not_verified");
    assert.equal(unsigned.review.attestation, undefined);

    const reviewAttestationPath = join(
      fixture.root,
      "evidence",
      "review-attestation.json",
    );
    await writeJson(reviewAttestationPath, {
      schemaVersion: 1,
      kind: "ling-desktop-macos-review-attestation",
      reviewedBy: fixture.input.review.reviewedBy,
      reviewedAt: fixture.input.review.reviewedAt,
      scope: "macos-signed-acceptance",
      candidateSha256: fixture.input.candidate.sha256,
      evidenceSha256: unsigned.review.evidenceSha256,
    });
    fixture.input.review.attestation = await reference(
      fixture.paths.manifest,
      reviewAttestationPath,
    );
    await assert.rejects(
      finalizeMacosSignedAcceptance(fixture.input, fixture.options),
      /macos_acceptance_review_attestation_external_only/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer requires live notarytool re-verification instead of trusting archived JSON", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      finalizeMacosSignedAcceptance(fixture.input, {
        ...fixture.options,
        notaryVerifier: undefined,
        notaryProfile: undefined,
      }),
      /notary_profile_required/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects reused notary jobs and a live job not bound to the artifact hash", async () => {
  const fixture = await createFixture();
  try {
    fixture.input.notarization.submissions[1].submissionId =
      fixture.input.notarization.submissions[0].submissionId;
    await assert.rejects(
      finalizeMacosSignedAcceptance(fixture.input, fixture.options),
      /notarization_submission_invalid:1/u,
    );

    const fresh = await createFixture();
    try {
      await assert.rejects(
        finalizeMacosSignedAcceptance(fresh.input, {
          ...fresh.options,
          notaryVerifier: async ({ submissionId }) => ({
            accepted: true,
            submissionId,
            artifactSha256: "0".repeat(64),
          }),
        }),
        /notarization_live_invalid:0/u,
      );
    } finally {
      await fresh.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects forged performance sample metadata", async () => {
  const fixture = await createFixture();
  try {
    const performancePath = fixture.paths.performance.arm64;
    const performance = JSON.parse(await readFile(performancePath, "utf8"));
    performance.cycles[0].capture.sampling.observedHoldMs = 1;
    await writeJson(performancePath, performance);
    fixture.input.performance.arm64 = await reference(
      fixture.paths.manifest,
      performancePath,
    );
    await assert.rejects(
      finalizeMacosSignedAcceptance(fixture.input, fixture.options),
      /performance_cycle_invalid:arm64:0:capture/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer atomically overwrites an old PASS with FAIL on CLI failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-macos-finalizer-fail-"));
  const inputPath = join(root, "input.json");
  const outputPath = join(root, "final.json");
  try {
    await writeJson(inputPath, {});
    await writeJson(outputPath, {
      schemaVersion: 2,
      kind: "ling-desktop-macos-signed-acceptance",
      verdict: { status: "PASS", pass: true, signedReleaseEvidence: true },
    });
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./finalize-macos-signed-acceptance.mjs", import.meta.url)), "--input", inputPath, "--output", outputPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.verdict.status, "FAIL");
    assert.equal(report.failure, true);
    assert.equal(report.verdict.pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalizer rejects forged permission semantics", async () => {
  const fixture = await createFixture();
  try {
    const deniedArmPath = fixture.paths.tcc.denied.arm64;
    const deniedArm = JSON.parse(await readFile(deniedArmPath, "utf8"));
    deniedArm.permissionBefore = "granted";
    deniedArm.permissionAfter = "granted";
    await writeJson(deniedArmPath, deniedArm);
    fixture.input.tccCases.denied.arm64 = await reference(
      fixture.paths.manifest,
      deniedArmPath,
    );
    await assert.rejects(
      finalizeMacosSignedAcceptance(fixture.input, fixture.options),
      /tcc_permission_invalid:denied:arm64/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects unsigned or over-budget performance and arbitrary notary text", async () => {
  const fixture = await createFixture();
  try {
    const performancePath = fixture.paths.performance.arm64;
    const performance = JSON.parse(await readFile(performancePath, "utf8"));
    performance.limitations.signedReleaseEvidence = false;
    await writeJson(performancePath, performance);
    fixture.input.performance.arm64 = await reference(
      fixture.paths.manifest,
      performancePath,
    );
    await assert.rejects(
      finalizeMacosSignedAcceptance(fixture.input, fixture.options),
      /performance_invalid:arm64/u,
    );

    const budgetFailure = await createFixture();
    try {
      const budgetFailurePath = budgetFailure.paths.performance.arm64;
      const report = JSON.parse(await readFile(budgetFailurePath, "utf8"));
      report.releaseBudgetComparison.pass = false;
      report.verdict = { status: "FAIL", pass: false };
      await writeJson(budgetFailurePath, report);
      budgetFailure.input.performance.arm64 = await reference(
        budgetFailure.paths.manifest,
        budgetFailurePath,
      );
      await assert.rejects(
        finalizeMacosSignedAcceptance(
          budgetFailure.input,
          budgetFailure.options,
        ),
        /performance_invalid:arm64/u,
      );
    } finally {
      await budgetFailure.cleanup();
    }

    const fresh = await createFixture();
    try {
      const logPath = fresh.paths.notaryLogs[0];
      await writeFile(logPath, "notary accepted", "utf8");
      fresh.input.notarization.submissions[0].log = await reference(
        fresh.paths.manifest,
        logPath,
      );
      await assert.rejects(
        finalizeMacosSignedAcceptance(fresh.input, fresh.options),
        /evidence_json_invalid:notarization/u,
      );
    } finally {
      await fresh.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects a candidate report whose live artifact fingerprint differs", async () => {
  const fixture = await createFixture();
  try {
    const live = structuredClone(fixture.candidate);
    live.apps[0].mainExecutable.sha256 = "9".repeat(64);
    live.dmgs[0].embeddedApp.mainExecutable.sha256 = "9".repeat(64);
    live.zips[0].embeddedApp.mainExecutable.sha256 = "9".repeat(64);
    fixture.options.candidateVerifier = async () => live;
    await assert.rejects(
      finalizeMacosSignedAcceptance(fixture.input, fixture.options),
      /candidate_live_mismatch/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "ling-macos-finalizer-v2-"));
  const trustedProducerPath = fileURLToPath(
    new URL("./run-macos-signed-performance.mjs", import.meta.url),
  );
  const producerPath = join(root, "producer.mjs");
  await writeFile(producerPath, await readFile(trustedProducerPath));
  const manifestPath = join(root, "manifest.json");
  const outputPath = join(root, "final.json");
  const candidatePath = join(root, "candidate.json");
  const executablePaths = {};
  const appRecords = [];
  for (const architecture of ["arm64"]) {
    const appPath = join(root, "artifacts", `${architecture}.app`);
    const executablePath = join(appPath, "Contents", "MacOS", "Ling Stack");
    await mkdir(dirname(executablePath), { recursive: true });
    await writeFile(executablePath, `signed-${architecture}-executable`, "utf8");
    executablePaths[architecture] = executablePath;
    appRecords.push(
      appRecord(
        candidatePath,
        appPath,
        await sha256File(executablePath),
        architecture,
      ),
    );
  }
  const packageRecords = { dmgs: [], zips: [] };
  const notaryLogs = [];
  for (const kind of ["dmgs", "zips"]) {
    for (const architecture of ["arm64"]) {
      const extension = kind === "dmgs" ? "dmg" : "zip";
      const artifactPath = join(root, "artifacts", `${architecture}.${extension}`);
      await writeFile(artifactPath, `${kind}-${architecture}`, "utf8");
      const sha256 = await sha256File(artifactPath);
      const embedded = appRecord(
        candidatePath,
        join(root, `embedded-${architecture}.app`),
        await sha256File(executablePaths[architecture]),
        architecture,
      );
      embedded.path = "Ling Stack.app";
      packageRecords[kind].push({
        type: kind === "dmgs" ? "dmg" : "zip",
        path: relativePath(candidatePath, artifactPath),
        pass: true,
        sha256,
        embeddedApp: embedded,
        ...(kind === "dmgs"
          ? {
              gatekeeper: { accepted: true, source: "Notarized Developer ID" },
              stapler: { validated: true },
            }
          : {}),
      });
    }
  }
  const candidate = {
    schemaVersion: 1,
    kind: "ling-desktop-macos-signed-candidate",
    expected: { teamId: TEAM_ID, bundleId: BUNDLE_ID },
    apps: appRecords,
    dmgs: packageRecords.dmgs,
    zips: packageRecords.zips,
    matrix: {
      pass: true,
      requiredArchitectures: ["arm64"],
      coverage: {
        apps: ["arm64"],
        dmgs: ["arm64"],
        zips: ["arm64"],
      },
    },
    verdict: { status: "PASS", pass: true, signedCandidateEvidence: true },
  };
  await writeJson(candidatePath, candidate);
  const candidateReference = await reference(manifestPath, candidatePath);

  const submissions = [];
  for (const [index, artifact] of [...candidate.dmgs, ...candidate.zips].entries()) {
    const submissionId = `submission-${index + 1}`;
    const path = join(root, "notary", `${submissionId}.json`);
    await writeJson(path, {
      jobId: submissionId,
      status: "Accepted",
      sha256: artifact.sha256,
    });
    notaryLogs.push(path);
    submissions.push({
      submissionId,
      artifactSha256: artifact.sha256,
      log: await reference(manifestPath, path),
    });
  }

  const tccCases = Object.fromEntries(
    ["denied", "prompt", "granted", "revoked"].map((caseId) => [caseId, {}]),
  );
  const tccPaths = Object.fromEntries(
    ["denied", "prompt", "granted", "revoked"].map((caseId) => [caseId, {}]),
  );
  const indicators = {};
  for (const architecture of ["arm64"]) {
    const windowIndicator = join(root, "evidence", `${architecture}-window.mov`);
    const displayIndicator = join(root, "evidence", `${architecture}-display.mov`);
    await mkdir(dirname(windowIndicator), { recursive: true });
    await writeFile(windowIndicator, `${architecture}-window-indicator`, "utf8");
    await writeFile(displayIndicator, `${architecture}-display-indicator`, "utf8");
    indicators[architecture] = { windowIndicator, displayIndicator };
    for (const caseId of ["denied", "prompt", "granted", "revoked"]) {
      const reportPath = join(root, "tcc", `${caseId}-${architecture}.json`);
      await mkdir(dirname(reportPath), { recursive: true });
      const evidence = [];
      if (caseId === "denied" || caseId === "prompt") {
        const manualPath = join(root, "evidence", `${caseId}-${architecture}.mov`);
        await writeFile(manualPath, `${caseId}-${architecture}`, "utf8");
        evidence.push({ kind: "manual", ...(await reference(reportPath, manualPath)) });
      }
      if (caseId === "granted") {
        evidence.push({
          kind: "window_capture_indicator",
          ...(await reference(reportPath, windowIndicator)),
        });
        evidence.push({
          kind: "display_capture_indicator",
          ...(await reference(reportPath, displayIndicator)),
        });
      }
      let revocation;
      if (caseId === "revoked") {
        const revocationPath = await writeRevocationFixture({
          root,
          architecture,
          executableSha256: await sha256File(executablePaths[architecture]),
          candidateSha256: candidateReference.sha256,
        });
        const revocationReference = await reference(reportPath, revocationPath);
        evidence.push({ kind: "revocation_transition", ...revocationReference });
        revocation = { report: revocationReference };
      }
      const smoke =
        caseId === "granted"
          ? await writeGrantedSmokeFixture({
              root,
              reportPath,
              architecture,
              executableSha256: await sha256File(executablePaths[architecture]),
            })
          : {
              window: { status: "SKIP", reason: "not granted" },
              display: { status: "SKIP", reason: "not granted" },
            };
      const expectedPermission =
        caseId === "prompt" ? "not-determined" : caseId === "granted" ? "granted" : "denied";
      const executableSha256 = await sha256File(executablePaths[architecture]);
      const candidateApp = appRecords.find(
        (app) => app.mainExecutable.sha256 === executableSha256,
      );
      const report = {
        schemaVersion: 2,
        kind: "ling-desktop-macos-tcc-case",
        generatedAt: "2026-07-17T00:00:00.000Z",
        caseId,
        operator: "release-owner",
        expectedPermission,
        permissionBefore: caseId === "revoked" ? "granted" : expectedPermission,
        permissionAfter: expectedPermission,
        host: { platform: "darwin", architecture, macosVersion: "15.5" },
        executable: {
          path: relativePath(reportPath, executablePaths[architecture]),
          sha256: executableSha256,
          architectures: [architecture],
          executionArchitecture: architecture,
          bundleFingerprint: candidateApp.bundleFingerprint,
        },
        signedCandidateReport: {
          path: relativePath(reportPath, candidatePath),
          sha256: candidateReference.sha256,
          teamId: TEAM_ID,
        },
        smokes: { window: smoke.window, display: smoke.display },
        restart: smoke.restart,
        evidence,
        revocation,
        tccMutationCommandUsed: false,
        verdict: { status: "PASS", pass: true, overallReleaseGateClosed: false },
      };
      await writeJson(reportPath, report);
      tccPaths[caseId][architecture] = reportPath;
      tccCases[caseId][architecture] = await reference(manifestPath, reportPath);
    }
  }

  const performance = {};
  const performancePaths = {};
  for (const architecture of ["arm64"]) {
    const reportPath = join(root, "performance", `${architecture}.json`);
    await mkdir(dirname(reportPath), { recursive: true });
    const cycles = [];
    for (let index = 0; index < 3; index += 1) {
      const cycle = {};
      for (const lane of ["baseline", "capture"]) {
        const logPath = join(root, "performance", `${architecture}-${lane}-${index}.log`);
        await writeFile(
          logPath,
          lane === "capture"
            ? "Ling Stack Desktop direct Electron Computer Use capture lifecycle passed"
            : "Ling Stack Desktop fake Computer Use lifecycle passed",
          "utf8",
        );
        cycle[lane] = {
          exitCode: 0,
          signal: null,
          firstFrameLatencyMs: 100,
          rssSamplesBytes: [1000, 1000, 1000],
          cpuSamples: [1, 1, 1],
          sampling: {
            intervalMs: 100,
            requestedHoldMs: 500,
            observedHoldMs: 500,
            sampleCount: 3,
            minimumSamples: 2,
          },
          output: await reference(reportPath, logPath),
        };
      }
      cycles.push(cycle);
    }
    await writeJson(reportPath, {
      schemaVersion: 1,
      kind: "ling-desktop-macos-signed-performance",
      limitations: { signedReleaseEvidence: true },
      candidate: {
        reportSha256: candidateReference.sha256,
        teamId: TEAM_ID,
        bundleFingerprint: appRecords.find(
          (app) => app.mainExecutable.architectures.includes(architecture),
        ).bundleFingerprint,
      },
      executable: {
        path: relativePath(reportPath, executablePaths[architecture]),
        sha256: await sha256File(executablePaths[architecture]),
        executionArchitecture: architecture,
        bundleFingerprint: appRecords.find(
          (app) => app.mainExecutable.architectures.includes(architecture),
        ).bundleFingerprint,
      },
      host: { platform: "darwin", architecture },
      producer: {
        machineGenerated: true,
        command: process.execPath,
        script: relativePath(reportPath, producerPath),
        scriptSha256: await sha256File(producerPath),
        args: ["--cycles", "3", "--hold-ms", "500"],
      },
      cycles,
      releaseBudgetComparison: {
        pass: true,
        checks: {
          localCaptureLatencyProxyMs: { observed: 100, threshold: 250, pass: true },
          activePreviewIncrementalCpuPercent: { observed: 0, threshold: 8, pass: true },
          activePreviewWorkingSetOverheadBytes: {
            observed: 0,
            threshold: 20 * 1024 * 1024,
            pass: true,
          },
        },
      },
      verdict: { status: "PASS", pass: true },
    });
    performancePaths[architecture] = reportPath;
    performance[architecture] = await reference(manifestPath, reportPath);
  }

  const voiceOverPath = join(root, "evidence", "voiceover.mov");
  await writeFile(voiceOverPath, "voiceover", "utf8");
  const captureIndicator = {
    arm64: {
      window: await reference(manifestPath, indicators.arm64.windowIndicator),
      display: await reference(manifestPath, indicators.arm64.displayIndicator),
      clearedAfterHide: true,
      clearedAfterExit: true,
    },
  };
  const voiceOver = {
    operator: "release-owner",
    focusOrder: true,
    names: true,
    statusAnnouncements: true,
    recoveryActions: true,
    evidence: await reference(manifestPath, voiceOverPath),
  };
  const notarization = { submissions, ticketStapled: true };
  const input = {
    candidate: candidateReference,
    notarization,
    tccCases,
    captureIndicator,
    voiceOver,
    performance,
    review: {
      reviewedBy: "release-reviewer",
      reviewedAt: "2026-07-17T12:00:00Z",
    },
  };
  await writeJson(manifestPath, input);
  return {
    root,
    candidate,
    input,
    options: {
      manifestPath,
      outputPath,
      candidateVerifier: async () => candidate,
      notaryVerifier: async ({ submissionId, artifactSha256 }) => ({
        accepted: true,
        submissionId,
        artifactSha256,
      }),
    },
    paths: {
      manifest: manifestPath,
      tcc: tccPaths,
      performance: performancePaths,
      notaryLogs,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function appRecord(candidatePath, appPath, executableSha256, architecture) {
  return {
    type: "app",
    path: relativePath(candidatePath, appPath),
    pass: true,
    bundleIdentifier: BUNDLE_ID,
    mainExecutable: {
      path: "Contents/MacOS/Ling Stack",
      sha256: executableSha256,
      architectures: [architecture],
    },
    mainSignature: {
      teamIdentifier: TEAM_ID,
      hardenedRuntime: true,
      entitlementsSha256: "e".repeat(64),
    },
    bundleFingerprint: {
      treeSha256: "a".repeat(64),
      cdhash: "b".repeat(40),
      cdhashFull: "c".repeat(64),
    },
    gatekeeper: { accepted: true, source: "Notarized Developer ID" },
    stapler: { validated: true },
  };
}

async function writeGrantedSmokeFixture({ root, reportPath, architecture, executableSha256 }) {
  const smoke = async (label, mode, startOffset) => {
    const logPath = join(root, "logs", `${architecture}-${label}.log`);
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, SMOKE_MARKER, "utf8");
    return {
      status: "PASS",
      executableSha256,
      command: process.execPath,
      args: ["run-computer-use-smoke.mjs", mode === "display" ? "--display" : "--real"],
      exitCode: 0,
      signal: null,
      startedAt: new Date(Date.parse("2026-07-17T00:00:00Z") + startOffset).toISOString(),
      finishedAt: new Date(Date.parse("2026-07-17T00:00:01Z") + startOffset).toISOString(),
      projection: {
        sessionId: "session-shared-restart",
        conversationId: "conversation-shared-restart",
        sourceRevision: 1,
        projectionSource: "daemon",
      },
      output: await reference(reportPath, logPath),
    };
  };
  const window = await smoke("window", "window", 0);
  const display = await smoke("display", "display", 0);
  const secondLaunch = await smoke("restart-second", "window", 2_000);
  return {
    window,
    display,
    restart: {
      status: "PASS",
      projectionRecovered: true,
      sameDaemonProjection: true,
      sameExecutableSha256: executableSha256,
      firstLaunch: window,
      secondLaunch,
    },
  };
}

async function writeRevocationFixture({ root, architecture, executableSha256, candidateSha256 }) {
  const reportPath = join(root, "revocation", `${architecture}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  const machineLog = join(root, "revocation", `${architecture}.log`);
  const indicator = join(root, "revocation", `${architecture}.mov`);
  await writeFile(machineLog, "LING_MACOS_TCC_REVOCATION_RESULT={}", "utf8");
  await writeFile(indicator, "indicator cleared", "utf8");
  await writeJson(reportPath, {
    schemaVersion: 2,
    kind: "ling-desktop-macos-tcc-revocation",
    candidate: {
      reportSha256: candidateSha256,
      executableSha256,
      bundleFingerprint: {
        treeSha256: "a".repeat(64),
        cdhash: "b".repeat(40),
        cdhashFull: "c".repeat(64),
      },
      teamId: TEAM_ID,
      executionArchitecture: architecture,
    },
    host: { platform: "darwin", architecture, macosVersion: "15.5" },
    permissionBefore: "granted",
    permissionAfter: "denied",
    observation: {
      activeCaptureBeforeRevocation: true,
      sourceEndedOrPermissionFailureObserved: true,
      runtimeContinuedWithoutStop: true,
      stopRequestCount: 0,
      captureIndicatorCleared: true,
    },
    evidence: {
      machineLog: await reference(reportPath, machineLog),
      captureIndicator: await reference(reportPath, indicator),
    },
    verdict: { status: "PASS", pass: true },
  });
  return reportPath;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function reference(reportPath, targetPath) {
  return { path: relativePath(reportPath, targetPath), sha256: await sha256File(targetPath) };
}

function relativePath(reportPath, targetPath) {
  return relative(dirname(reportPath), targetPath).split(sep).join("/") || ".";
}
