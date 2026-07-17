import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LING_DESKTOP_BUNDLE_ID,
  MACOS_RELEASE_ARCHITECTURES,
  MACOS_TCC_CASE_IDS,
  captureMacosReleaseHarnessProvenance,
  macosSystemTool,
  normalizeMacosArchitecture,
  reportRelativePath,
  sha256Buffer,
  sha256File,
  validDateTime,
  verifyEvidenceReference,
} from "./macos-acceptance-common.mjs";
import { reverifyMacosSignedCandidateReport } from "./verify-macos-signed-candidate.mjs";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const allowedCases = new Set(MACOS_TCC_CASE_IDS);
const allowedPermissions = new Set([
  "not-determined",
  "denied",
  "restricted",
  "granted",
  "unknown",
]);
const PROJECTION_ID_MARKER = "LING_DESKTOP_PROJECTION_ID=";
const DAEMON_PROJECTION_PERSISTENCE_MARKER =
  "Ling Stack Desktop daemon projection persistence checkpoint passed";

export function createMacosRestartProjection() {
  const timestamp = new Date().toISOString();
  return {
    sessionId: "macos_acceptance_restart_session",
    conversationId: "macos_acceptance_restart_conversation",
    runId: "macos_acceptance_restart_run",
    workUnitId: "macos_acceptance_restart_work_unit",
    status: "running",
    target: {
      kind: "window",
      displayName: "Ling macOS acceptance capture",
      applicationId: LING_DESKTOP_BUNDLE_ID,
    },
    preview: {
      descriptorId: "macos_acceptance_restart_descriptor",
      revision: 1,
      aspectRatio: 1.6,
      cursorAvailable: false,
    },
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

export function parseScreenPermissionProbe(output) {
  const match =
    /(?:^|\n)Ling Stack Desktop screen permission: ([a-z-]+)(?:\n|$)/u.exec(
      output,
    );
  if (!match || !allowedPermissions.has(match[1])) {
    throw new Error("macos_tcc_permission_probe_invalid");
  }
  return match[1];
}

export function validateMacosTccCaseOptions(input) {
  if (!allowedCases.has(input.caseId)) {
    throw new Error("macos_tcc_case_invalid");
  }
  if (!allowedPermissions.has(input.expectedPermission)) {
    throw new Error("macos_tcc_expected_permission_invalid");
  }
  const expectedByCase = {
    denied: new Set(["denied", "restricted"]),
    prompt: new Set(["not-determined"]),
    granted: new Set(["granted"]),
    revoked: new Set(["denied", "restricted"]),
  };
  if (!expectedByCase[input.caseId].has(input.expectedPermission)) {
    throw new Error("macos_tcc_case_permission_mismatch");
  }
  if (input.caseId === "granted") {
    if (!input.windowIndicatorEvidence || !input.displayIndicatorEvidence) {
      throw new Error("macos_tcc_granted_indicator_evidence_required");
    }
  }
  if (
    (input.caseId === "denied" || input.caseId === "prompt") &&
    (!input.manualEvidence || input.manualEvidence.length === 0)
  ) {
    throw new Error("macos_tcc_manual_evidence_required");
  }
  if (input.caseId === "revoked" && !input.revocationReport) {
    throw new Error("macos_tcc_revocation_report_required");
  }
  return input;
}

export function buildMacosTccCaseReport(input) {
  const evidenceKinds = new Set(
    (input.evidence ?? []).map((item) => item?.kind),
  );
  const permissionMatches =
    input.caseId === "revoked"
      ? input.permissionBefore === "granted" &&
        ["denied", "restricted"].includes(input.permissionAfter)
      : input.permissionBefore === input.expectedPermission &&
        input.permissionAfter === input.expectedPermission;
  const smokePass =
    input.caseId === "granted"
      ? input.windowSmoke?.status === "PASS" &&
        input.displaySmoke?.status === "PASS" &&
        input.restart?.status === "PASS" &&
        input.restart?.projectionRecovered === true &&
        input.restart?.sameDaemonProjection === true
      : input.caseId === "revoked"
        ? input.revocation?.pass === true &&
          input.permissionAfter === input.revocation.permissionAfter
        : true;
  const evidencePass =
    input.caseId === "denied" || input.caseId === "prompt"
      ? evidenceKinds.has("manual")
      : input.caseId === "granted"
        ? evidenceKinds.has("window_capture_indicator") &&
          evidenceKinds.has("display_capture_indicator")
        : input.caseId === "revoked"
          ? evidenceKinds.has("revocation_transition")
          : true;
  const status =
    permissionMatches && smokePass && evidencePass ? "PASS" : "FAIL";
  return {
    schemaVersion: 2,
    kind: "ling-desktop-macos-tcc-case",
    generatedAt: input.generatedAt,
    caseId: input.caseId,
    operator: input.operator,
    expectedPermission: input.expectedPermission,
    permissionBefore: input.permissionBefore,
    permissionAfter: input.permissionAfter,
    host: input.host,
    executable: input.executable,
    signedCandidateReport: input.signedCandidateReport,
    ...(input.harness ? { harness: input.harness } : {}),
    smokes: {
      window: input.windowSmoke ?? {
        status: "SKIP",
        reason: "Capture is not invoked for a non-granted case.",
      },
      display: input.displaySmoke ?? {
        status: "SKIP",
        reason: "Capture is not invoked for a non-granted case.",
      },
    },
    restart: input.restart,
    evidence: input.evidence,
    revocation: input.revocation,
    notes: input.notes || undefined,
    tccMutationCommandUsed: false,
    verdict: {
      status,
      pass: status === "PASS",
      overallReleaseGateClosed: false,
      reason:
        status === "PASS"
          ? "This one signed-host TCC case is recorded. All four TCC states, capture-indicator, VoiceOver, performance, and release review remain separate gates."
          : "The observed permission state, required evidence, granted capture smoke, or revoked transition did not match the requested case.",
    },
  };
}

export function buildMacosTccFailureReport(input) {
  return {
    schemaVersion: 2,
    kind: "ling-desktop-macos-tcc-case",
    failure: true,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    caseId: input.caseId ?? "unknown",
    operator: input.operator ?? "unknown",
    expectedPermission: input.expectedPermission ?? "unknown",
    permissionBefore: input.permissionBefore,
    permissionAfter: input.permissionAfter,
    host: input.host,
    executable: input.executable,
    signedCandidateReport: input.signedCandidateReport,
    ...(input.harness ? { harness: input.harness } : {}),
    smokes: {
      window: input.windowSmoke ?? {
        status: "SKIP",
        reason: "Case did not reach window smoke completion.",
      },
      display: input.displaySmoke ?? {
        status: "SKIP",
        reason: "Case did not reach display smoke completion.",
      },
    },
    restart: input.restart,
    evidence: input.evidence ?? [],
    revocation: input.revocation,
    tccMutationCommandUsed: false,
    error: serializeError(input.error),
    verdict: {
      status: "FAIL",
      pass: false,
      overallReleaseGateClosed: false,
      reason:
        "The signed-host TCC case failed before complete acceptance evidence was recorded.",
    },
  };
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macos_tcc_acceptance_requires_darwin");
  }
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      case: { type: "string" },
      "expected-permission": { type: "string" },
      "signed-candidate-report": { type: "string" },
      operator: { type: "string" },
      output: { type: "string" },
      evidence: { type: "string", multiple: true, default: [] },
      "window-indicator-evidence": { type: "string" },
      "display-indicator-evidence": { type: "string" },
      "revocation-report": { type: "string" },
      notes: { type: "string" },
      "timeout-ms": { type: "string", default: "90000" },
    },
    strict: true,
  });
  if (!values.output?.trim()) {
    throw new Error("macos_tcc_missing_output");
  }
  const outputPath = resolve(values.output);
  const context = {
    generatedAt: new Date().toISOString(),
    caseId: values.case?.trim(),
    operator: values.operator?.trim(),
    expectedPermission: values["expected-permission"]?.trim(),
  };
  try {
    context.harness = await captureMacosReleaseHarnessProvenance([
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL("./macos-acceptance-common.mjs", import.meta.url)),
      fileURLToPath(new URL("./run-computer-use-smoke.mjs", import.meta.url)),
      fileURLToPath(new URL("./verify-macos-signed-candidate.mjs", import.meta.url)),
    ]);
    for (const required of [
      "executable",
      "case",
      "expected-permission",
      "signed-candidate-report",
      "operator",
    ]) {
      if (!values[required]?.trim()) {
        throw new Error(`macos_tcc_missing_${required.replaceAll("-", "_")}`);
      }
    }
    const options = validateMacosTccCaseOptions({
      caseId: values.case.trim(),
      expectedPermission: values["expected-permission"].trim(),
      manualEvidence: values.evidence,
      windowIndicatorEvidence: values["window-indicator-evidence"],
      displayIndicatorEvidence: values["display-indicator-evidence"],
      revocationReport: values["revocation-report"],
    });
    context.caseId = options.caseId;
    context.expectedPermission = options.expectedPermission;
    const timeoutMs = readPositiveInteger(values["timeout-ms"], 90_000);
    const executionArchitecture = normalizeMacosArchitecture(arch());
    if (!executionArchitecture) {
      throw new Error("macos_tcc_host_architecture_unsupported");
    }
    context.host = {
      platform: process.platform,
      architecture: executionArchitecture,
      macosVersion: (
        await runProcess(macosSystemTool("swVers"), ["-productVersion"], 10_000)
      ).stdout.trim(),
    };
    const executablePath = await realpath(resolve(values.executable));
    const executableStat = await stat(executablePath);
    if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) {
      throw new Error("macos_tcc_executable_invalid");
    }
    context.executable = {
      path: reportRelativePath(dirname(outputPath), executablePath),
      sha256: await sha256File(executablePath),
      executionArchitecture,
    };
    const signedCandidatePath = await realpath(
      resolve(values["signed-candidate-report"]),
    );
    const signedCandidate = JSON.parse(
      await readFile(signedCandidatePath, "utf8"),
    );
    if (signedCandidate?.expected?.bundleId !== LING_DESKTOP_BUNDLE_ID) {
      throw new Error("macos_tcc_signed_candidate_bundle_id_invalid");
    }
    const liveSignedCandidate = await reverifyMacosSignedCandidateReport(
      signedCandidate,
      signedCandidatePath,
    );
    const executableSha256 = context.executable.sha256;
    const boundApp = assertSignedCandidateBinding(
      liveSignedCandidate,
      signedCandidatePath,
      executablePath,
      executableSha256,
    );
    if (!boundApp.mainExecutable.architectures.includes(executionArchitecture)) {
      throw new Error("macos_tcc_executable_host_architecture_mismatch");
    }
    context.executable.architectures = boundApp.mainExecutable.architectures;
    context.executable.bundleFingerprint = boundApp.bundleFingerprint;
    context.signedCandidateReport = {
      path: reportRelativePath(dirname(outputPath), signedCandidatePath),
      sha256: await sha256File(signedCandidatePath),
      teamId: liveSignedCandidate.expected.teamId,
      liveVerificationGeneratedAt: liveSignedCandidate.generatedAt,
    };

    const evidenceInputs = [
      ...values.evidence.map((path) => ({ kind: "manual", path })),
      ...(values["window-indicator-evidence"]
        ? [
            {
              kind: "window_capture_indicator",
              path: values["window-indicator-evidence"],
            },
          ]
        : []),
      ...(values["display-indicator-evidence"]
        ? [
            {
              kind: "display_capture_indicator",
              path: values["display-indicator-evidence"],
            },
          ]
        : []),
      ...(values["revocation-report"]
        ? [{ kind: "revocation_transition", path: values["revocation-report"] }]
        : []),
    ];
    const evidence = await Promise.all(
      evidenceInputs.map(async (input) => {
        const path = await realpath(resolve(input.path));
        return {
          kind: input.kind,
          path: reportRelativePath(dirname(outputPath), path),
          sha256: await sha256File(path),
        };
      }),
    );
    context.evidence = evidence;
    const revocation =
      options.caseId === "revoked"
        ? await readRevocationReport(
            values["revocation-report"],
            executableSha256,
            liveSignedCandidate.expected.teamId,
            executionArchitecture,
            outputPath,
            context.signedCandidateReport.sha256,
          )
        : undefined;
    context.revocation = revocation;

    const probeDirectory = await mkdtemp(
      resolve(tmpdir(), "ling-macos-tcc-probe-"),
    );
    let permissionBefore;
    let permissionAfter;
    let windowSmoke;
    let displaySmoke;
    let restart;
    try {
      permissionBefore =
        options.caseId === "revoked"
          ? revocation.permissionBefore
          : await probePermission(executablePath, probeDirectory, timeoutMs);
      if (
        permissionBefore === options.expectedPermission &&
        options.caseId === "granted"
      ) {
        const logDirectory = join(dirname(outputPath), "logs");
        windowSmoke = await runCaptureSmoke(
          executablePath,
          "window",
          timeoutMs,
          logDirectory,
          "window",
          executableSha256,
          outputPath,
        );
        displaySmoke = await runCaptureSmoke(
          executablePath,
          "display",
          timeoutMs,
          logDirectory,
          "display",
          executableSha256,
          outputPath,
        );
        const restartProjection = createMacosRestartProjection();
        const restartWorkspaceDirectory = await mkdtemp(
          resolve(tmpdir(), "ling-macos-tcc-restart-workspace-"),
        );
        const restartUserDataDirectory = await mkdtemp(
          resolve(tmpdir(), "ling-macos-tcc-restart-user-data-"),
        );
        const restartBridgeToken = randomBytes(32).toString("base64url");
        await writeFile(
          join(restartUserDataDirectory, "desktop-bridge-token"),
          `${restartBridgeToken}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        let restartDaemon;
        try {
          restartDaemon = await startMacosRestartDaemon({
            defaultWorkspaceCwd: restartWorkspaceDirectory,
            bridgeToken: restartBridgeToken,
            projection: restartProjection,
          });
          const restartFirstLaunch = await runCaptureSmoke(
            executablePath,
            "window",
            timeoutMs,
            logDirectory,
            "restart-first-launch",
            executableSha256,
            outputPath,
            {
              daemonUrl: restartDaemon.url,
              defaultWorkspaceCwd: restartWorkspaceDirectory,
              userDataDirectory: restartUserDataDirectory,
              projection: restartProjection,
              daemonProjection: true,
              preserveDaemonProjection: true,
              requirePersistenceCheckpoint: true,
            },
          );
          const restartSecondLaunch = await runCaptureSmoke(
            executablePath,
            "window",
            timeoutMs,
            logDirectory,
            "restart-second-launch",
            executableSha256,
            outputPath,
            {
              daemonUrl: restartDaemon.url,
              defaultWorkspaceCwd: restartWorkspaceDirectory,
              userDataDirectory: restartUserDataDirectory,
              projection: restartProjection,
              daemonProjection: true,
              requirePersistenceCheckpoint: false,
            },
          );
          restart = {
            status:
              restartFirstLaunch.status === "PASS" &&
              restartSecondLaunch.status === "PASS" &&
              sameDaemonProjection(restartFirstLaunch.projection, restartSecondLaunch.projection)
                ? "PASS"
                : "FAIL",
            projectionRecovered:
              restartFirstLaunch.status === "PASS" &&
              restartSecondLaunch.status === "PASS" &&
              sameDaemonProjection(restartFirstLaunch.projection, restartSecondLaunch.projection),
            sameDaemonProjection:
              sameDaemonProjection(restartFirstLaunch.projection, restartSecondLaunch.projection),
            sameExecutableSha256: executableSha256,
            firstLaunch: restartFirstLaunch,
            secondLaunch: restartSecondLaunch,
          };
        } finally {
          if (restartDaemon) {
            await restartDaemon.daemon.stop().catch(() => undefined);
          }
          await rm(restartUserDataDirectory, { recursive: true, force: true });
          await rm(restartWorkspaceDirectory, { recursive: true, force: true });
        }
      }
      permissionAfter = await probePermission(
        executablePath,
        probeDirectory,
        timeoutMs,
      );
    } finally {
      await rm(probeDirectory, { recursive: true, force: true });
    }
    context.permissionBefore = permissionBefore;
    context.permissionAfter = permissionAfter;
    context.windowSmoke = windowSmoke;
    context.displaySmoke = displaySmoke;
    context.restart = restart;

    const report = buildMacosTccCaseReport({
      generatedAt: context.generatedAt,
      caseId: options.caseId,
      operator: values.operator.trim(),
      expectedPermission: options.expectedPermission,
      permissionBefore,
      permissionAfter,
      host: context.host,
      executable: context.executable,
      signedCandidateReport: context.signedCandidateReport,
      harness: context.harness,
      windowSmoke,
      displaySmoke,
      restart,
      evidence,
      revocation,
      notes: values.notes?.trim(),
    });
    await writeJsonAtomic(outputPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.verdict.pass) {
      process.exitCode = 1;
    }
  } catch (error) {
    const report = buildMacosTccFailureReport({ ...context, error });
    await writeJsonAtomic(outputPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

function assertSignedCandidateBinding(
  report,
  reportPath,
  executablePath,
  executableSha256,
) {
  if (
    report?.schemaVersion !== 1 ||
    report?.kind !== "ling-desktop-macos-signed-candidate" ||
    report?.verdict?.pass !== true ||
    report?.verdict?.signedCandidateEvidence !== true ||
    typeof report?.expected?.teamId !== "string" ||
    !Array.isArray(report?.apps)
  ) {
    throw new Error("macos_tcc_signed_candidate_report_invalid");
  }
  const match = report.apps.find(
    (app) => {
      if (
        typeof app?.path !== "string" ||
        typeof app?.mainExecutable?.path !== "string"
      ) {
        return false;
      }
      const candidateExecutablePath = resolve(
        dirname(reportPath),
        app.path,
        app.mainExecutable.path,
      );
      return (
        candidateExecutablePath === executablePath &&
        app.mainExecutable.sha256 === executableSha256
      );
    },
  );
  if (
    !match ||
    match.pass !== true ||
    match.mainSignature?.teamIdentifier !== report.expected.teamId ||
    match.mainSignature?.hardenedRuntime !== true ||
    !/^[0-9a-f]{64}$/u.test(match.bundleFingerprint?.treeSha256 ?? "") ||
    !/^[0-9a-f]{40}$/u.test(match.bundleFingerprint?.cdhash ?? "") ||
    match.gatekeeper?.accepted !== true ||
    match.gatekeeper?.source !== "Notarized Developer ID" ||
    match.stapler?.validated !== true ||
    report.matrix?.pass !== true
  ) {
    throw new Error("macos_tcc_executable_not_bound_to_signed_candidate");
  }
  return match;
}

async function readRevocationReport(
  pathValue,
  executableSha256,
  teamId,
  executionArchitecture,
  outputPath,
  candidateReportSha256,
) {
  const path = await realpath(resolve(pathValue));
  const report = JSON.parse(await readFile(path, "utf8"));
  if (
    report?.schemaVersion !== 2 ||
    report?.kind !== "ling-desktop-macos-tcc-revocation" ||
    report?.candidate?.reportSha256 !== candidateReportSha256 ||
    report?.candidate?.executableSha256 !== executableSha256 ||
    report?.candidate?.teamId !== teamId ||
    report?.candidate?.executionArchitecture !== executionArchitecture ||
    report?.host?.platform !== "darwin" ||
    report?.host?.architecture !== executionArchitecture ||
    report?.permissionBefore !== "granted" ||
    !["denied", "restricted"].includes(report?.permissionAfter) ||
    report?.observation?.activeCaptureBeforeRevocation !== true ||
    report?.observation?.sourceEndedOrPermissionFailureObserved !== true ||
    report?.observation?.runtimeContinuedWithoutStop !== true ||
    report?.observation?.stopRequestCount !== 0 ||
    report?.observation?.captureIndicatorCleared !== true ||
    report?.verdict?.pass !== true
  ) {
    throw new Error("macos_tcc_revocation_report_invalid");
  }
  const machineLog = await verifyEvidenceReference(
    report?.evidence?.machineLog,
    path,
    "revocation.machineLog",
  );
  const captureIndicator = await verifyEvidenceReference(
    report?.evidence?.captureIndicator,
    path,
    "revocation.captureIndicator",
  );
  if (
    !machineLog.bytes
      .toString("utf8")
      .includes("LING_MACOS_TCC_REVOCATION_RESULT=") ||
    captureIndicator.bytes.length === 0
  ) {
    throw new Error("macos_tcc_revocation_evidence_invalid");
  }
  return {
    pass: true,
    report: {
      path: reportRelativePath(dirname(outputPath), path),
      sha256: await sha256File(path),
    },
    permissionBefore: report.permissionBefore,
    permissionAfter: report.permissionAfter,
    activeCaptureBeforeRevocation: true,
    sourceEndedOrPermissionFailureObserved: true,
    runtimeContinuedWithoutStop: true,
    stopRequestCount: 0,
    captureIndicatorCleared: true,
  };
}

async function probePermission(executablePath, userDataDirectory, timeoutMs) {
  const result = await runProcess(
    executablePath,
    [
      "--ling-desktop-screen-permission-probe",
      `--user-data-dir=${userDataDirectory}`,
    ],
    timeoutMs,
    dirname(executablePath),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `macos_tcc_permission_probe_failed:${result.exitCode ?? result.signal ?? "unknown"}`,
    );
  }
  return parseScreenPermissionProbe(`${result.stdout}\n${result.stderr}`);
}

export async function startMacosRestartDaemon({
  defaultWorkspaceCwd,
  bridgeToken,
  projection,
}) {
  // This is the production daemon server and production projection registry,
  // kept alive by the acceptance runner while Desktop is launched twice. The
  // fixture only seeds one active projection because starting a real provider
  // run would make this transport/restart gate depend on an unrelated model.
  const { startDaemon } = await import("../../../packages/daemon/dist/index.js");
  const port = await availablePort();
  const daemon = await startDaemon(
    {
      host: "127.0.0.1",
      port,
      defaultWorkspaceCwd,
      channels: {
        autoRoute: false,
        intentSelector: false,
        terminalReports: false,
      },
    },
    {
      desktopBridgeToken: bridgeToken,
      computerUseRouteToken: bridgeToken,
      computerUseStop: async () => ({
        accepted: true,
        acknowledged: true,
        terminalStatus: "cancelled",
        reason: "macos_acceptance_restart_stop_ack",
      }),
    },
  );
  daemon.computerUsePreviews.upsert(defaultWorkspaceCwd, projection);
  return {
    daemon,
    url: `http://127.0.0.1:${port}`,
  };
}

async function runCaptureSmoke(
  executablePath,
  kind,
  timeoutMs,
  logDirectory,
  logLabel,
  executableSha256,
  outputPath,
  options = {},
) {
  const args = [resolve(desktopRoot, "tests", "run-computer-use-smoke.mjs")];
  if (kind === "display") {
    args.push("--display");
  } else {
    args.push("--real");
  }
  const result = await runProcess(
    process.execPath,
    args,
    timeoutMs,
    desktopRoot,
    {
      ...process.env,
      LING_DESKTOP_SMOKE_EXECUTABLE: executablePath,
      LING_DESKTOP_SMOKE_TIMEOUT_MS: String(timeoutMs),
      ...(options.daemonUrl
        ? { LING_STACK_DAEMON_URL: options.daemonUrl }
        : {}),
      ...(options.defaultWorkspaceCwd
        ? { LING_STACK_DEFAULT_WORKSPACE_CWD: options.defaultWorkspaceCwd }
        : {}),
      ...(options.userDataDirectory
        ? { LING_DESKTOP_SMOKE_USER_DATA_DIR: options.userDataDirectory }
        : {}),
      ...(options.daemonProjection
        ? {
            LING_DESKTOP_DAEMON_PROJECTION_SMOKE: "1",
            LING_DESKTOP_SMOKE_PROJECTION_JSON: JSON.stringify(options.projection),
          }
        : {}),
      ...(options.preserveDaemonProjection
        ? { LING_DESKTOP_SMOKE_PRESERVE_DAEMON_PROJECTION: "1" }
        : {}),
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const projection = parseProjectionIdentity(output);
  if (options.daemonProjection && projection?.projectionSource !== "daemon") {
    throw new Error(`macos_tcc_restart_projection_not_daemon:${logLabel}`);
  }
  if (options.requirePersistenceCheckpoint && !output.includes(DAEMON_PROJECTION_PERSISTENCE_MARKER)) {
    throw new Error(`macos_tcc_restart_projection_checkpoint_missing:${logLabel}`);
  }
  await mkdir(logDirectory, { recursive: true });
  const logPath = join(logDirectory, `macos-tcc-${logLabel}-${Date.now()}.log`);
  await writeFile(logPath, output, "utf8");
  return {
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    executableSha256,
    command: process.execPath,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    projection,
    output: {
      path: reportRelativePath(dirname(outputPath), logPath),
      sha256: await sha256File(logPath),
    },
  };
}

export function parseProjectionIdentity(output) {
  const encoded = String(output)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(PROJECTION_ID_MARKER))
    .at(-1)
    ?.slice(PROJECTION_ID_MARKER.length);
  if (!encoded) {
    return undefined;
  }
  try {
    const value = JSON.parse(encoded);
    return typeof value?.sessionId === "string" &&
      typeof value?.conversationId === "string" &&
      Number.isSafeInteger(value?.sourceRevision) &&
      (value?.projectionSource === "daemon" || value?.projectionSource === "fake")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function sameDaemonProjection(first, second) {
  return first?.projectionSource === "daemon" &&
    second?.projectionSource === "daemon" &&
    first.sessionId === second.sessionId &&
    first.conversationId === second.conversationId &&
    first.sourceRevision === second.sourceRevision;
}

async function runProcess(
  command,
  args,
  timeoutMs,
  cwd = process.cwd(),
  env = process.env,
) {
  return new Promise((resolveResult, reject) => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveResult({
        exitCode,
        signal,
        stdout,
        stderr,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    });
  });
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (!port) {
          reject(new Error("macos_acceptance_daemon_port_unavailable"));
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

function boundedAppend(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= 100_000 ? next : next.slice(-100_000);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
