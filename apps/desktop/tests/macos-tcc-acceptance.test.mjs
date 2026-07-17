import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildMacosTccCaseReport,
  buildMacosTccFailureReport,
  createMacosRestartProjection,
  parseScreenPermissionProbe,
  parseProjectionIdentity,
  sameDaemonProjection,
  startMacosRestartDaemon,
  validateMacosTccCaseOptions,
} from "./run-macos-tcc-acceptance.mjs";
import { parseRevocationMachineResult } from "./run-macos-tcc-revocation.mjs";

const desktopTestsRoot = dirname(fileURLToPath(import.meta.url));

test("macOS TCC acceptance stays read-only and fail-closed", () => {
  assert.equal(
    parseScreenPermissionProbe(
      "noise\nLing Stack Desktop screen permission: granted\n",
    ),
    "granted",
  );
  assert.throws(
    () => parseScreenPermissionProbe("permission: granted"),
    /permission_probe_invalid/u,
  );
  assert.throws(
    () =>
      validateMacosTccCaseOptions({
        caseId: "prompt",
        expectedPermission: "granted",
        manualEvidence: ["prompt.mov"],
      }),
    /case_permission_mismatch/u,
  );
  assert.throws(
    () =>
      validateMacosTccCaseOptions({
        caseId: "granted",
        expectedPermission: "granted",
      }),
    /indicator_evidence_required/u,
  );
  assert.throws(
    () =>
      validateMacosTccCaseOptions({
        caseId: "revoked",
        expectedPermission: "denied",
      }),
    /revocation_report_required/u,
  );
  assert.deepEqual(
    validateMacosTccCaseOptions({
      caseId: "granted",
      expectedPermission: "granted",
      windowIndicatorEvidence: "window.mov",
      displayIndicatorEvidence: "display.mov",
    }),
    {
      caseId: "granted",
      expectedPermission: "granted",
      windowIndicatorEvidence: "window.mov",
      displayIndicatorEvidence: "display.mov",
    },
  );

  const report = buildMacosTccCaseReport({
    generatedAt: "2026-07-17T00:00:00.000Z",
    caseId: "granted",
    operator: "release-owner",
    expectedPermission: "granted",
    permissionBefore: "granted",
    permissionAfter: "granted",
    host: { platform: "darwin", architecture: "arm64", macosVersion: "15.5" },
    executable: {
      path: "/Applications/Ling Stack.app/Contents/MacOS/Ling Stack",
      sha256: "a".repeat(64),
      architectures: ["arm64"],
      executionArchitecture: "arm64",
    },
    signedCandidateReport: {
      path: "/tmp/signed.json",
      sha256: "b".repeat(64),
      teamId: "ABCDEFGHIJ",
    },
    windowSmoke: { status: "PASS" },
    displaySmoke: { status: "PASS" },
    restart: {
      status: "PASS",
      projectionRecovered: true,
      sameDaemonProjection: true,
    },
    evidence: [
      {
        kind: "window_capture_indicator",
        path: "/tmp/window.mov",
        sha256: "c".repeat(64),
      },
      {
        kind: "display_capture_indicator",
        path: "/tmp/display.mov",
        sha256: "d".repeat(64),
      },
    ],
  });
  assert.equal(report.verdict.status, "PASS");
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.verdict.overallReleaseGateClosed, false);
  assert.equal(report.tccMutationCommandUsed, false);

  const failed = buildMacosTccCaseReport({
    ...report,
    caseId: "revoked",
    expectedPermission: "denied",
    permissionBefore: "denied",
    permissionAfter: "denied",
    revocation: { pass: true, permissionAfter: "denied" },
    evidence: [
      {
        kind: "revocation_transition",
        path: "/tmp/revoked.json",
        sha256: "e".repeat(64),
      },
    ],
  });
  assert.equal(failed.verdict.status, "FAIL");

  const revoked = buildMacosTccCaseReport({
    ...failed,
    permissionBefore: "granted",
  });
  assert.equal(revoked.verdict.status, "PASS");

  const failureReport = buildMacosTccFailureReport({
    generatedAt: "2026-07-17T00:00:00.000Z",
    caseId: "granted",
    operator: "release-owner",
    expectedPermission: "granted",
    error: new Error("probe failed"),
  });
  assert.equal(failureReport.verdict.status, "FAIL");
  assert.equal(failureReport.failure, true);
  assert.equal(failureReport.tccMutationCommandUsed, false);
  assert.equal(failureReport.error.message, "probe failed");

  assert.deepEqual(
    parseRevocationMachineResult(
      `noise\nLING_MACOS_TCC_REVOCATION_RESULT=${JSON.stringify({
        activeCaptureBeforeRevocation: true,
        sourceEndedOrPermissionFailureObserved: true,
        runtimeContinuedWithoutStop: true,
        stopRequestCount: 0,
      })}\n`,
    ),
    {
      activeCaptureBeforeRevocation: true,
      sourceEndedOrPermissionFailureObserved: true,
      runtimeContinuedWithoutStop: true,
      stopRequestCount: 0,
    },
  );
});

test(
  "macOS restart fixture serves one daemon projection identity across reconnects",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ling-macos-restart-fixture-test-"));
    const projection = createMacosRestartProjection();
    const bridgeToken = "macos-restart-fixture-test-token-0123456789";
    const fixture = await startMacosRestartDaemon({
      defaultWorkspaceCwd: root,
      bridgeToken,
      projection,
    });
    try {
      const response = await fetch(
        `${fixture.url}/computer-use/snapshot?cwd=${encodeURIComponent(root)}`,
        { headers: { "X-Ling-Computer-Use-Token": bridgeToken } },
      );
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.deepEqual(snapshot.projections, [projection]);
      const first = parseProjectionIdentity(
        `LING_DESKTOP_PROJECTION_ID=${JSON.stringify({
          sessionId: projection.sessionId,
          conversationId: projection.conversationId,
          sourceRevision: projection.preview.revision,
          projectionSource: "daemon",
        })}`,
      );
      const second = parseProjectionIdentity(
        `LING_DESKTOP_PROJECTION_ID=${JSON.stringify({
          sessionId: projection.sessionId,
          conversationId: projection.conversationId,
          sourceRevision: projection.preview.revision,
          projectionSource: "daemon",
        })}`,
      );
      assert.equal(sameDaemonProjection(first, second), true);
    } finally {
      await fixture.daemon.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Desktop smoke cannot promote a fake projection to daemon evidence through an env label",
  {
    skip: process.platform !== "darwin",
  },
  () => {
    const result = spawnSync(
      process.execPath,
      [resolve(desktopTestsRoot, "run-computer-use-smoke.mjs")],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          LING_DESKTOP_SMOKE_PROJECTION_SOURCE: "daemon",
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const projection = parseProjectionIdentity(`${result.stdout}\n${result.stderr}`);
    assert.equal(projection?.projectionSource, "fake");
  },
);

test(
  "macOS TCC CLI writes an atomic FAIL report when setup fails",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ling-macos-tcc-failure-test-"));
    const output = join(root, "failure.json");
    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(desktopTestsRoot, "run-macos-tcc-acceptance.mjs"),
          "--executable",
          join(root, "missing-executable"),
          "--case",
          "granted",
          "--expected-permission",
          "granted",
          "--signed-candidate-report",
          join(root, "missing-candidate.json"),
          "--operator",
          "release-owner",
          "--window-indicator-evidence",
          join(root, "window.mov"),
          "--display-indicator-evidence",
          join(root, "display.mov"),
          "--output",
          output,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      const report = JSON.parse(await readFile(output, "utf8"));
      assert.equal(report.verdict.status, "FAIL");
      assert.equal(report.failure, true);
      assert.equal(report.error.name, "Error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
