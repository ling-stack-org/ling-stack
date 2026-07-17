import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LING_DESKTOP_BUNDLE_ID,
  captureMacosReleaseHarnessProvenance,
  macosSystemTool,
  normalizeMacosArchitecture,
  reportRelativePath,
  sha256File,
} from "./macos-acceptance-common.mjs";
import { reverifyMacosSignedCandidateReport } from "./verify-macos-signed-candidate.mjs";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const READY_MARKER = "LING_MACOS_TCC_REVOCATION_READY=";
const RESULT_MARKER = "LING_MACOS_TCC_REVOCATION_RESULT=";

export function parseRevocationMachineResult(output) {
  const encoded = String(output)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(RESULT_MARKER))
    .at(-1)
    ?.slice(RESULT_MARKER.length);
  if (!encoded) {
    throw new Error("macos_tcc_revocation_result_missing");
  }
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("macos_tcc_revocation_result_invalid");
  }
  if (
    value?.activeCaptureBeforeRevocation !== true ||
    value?.sourceEndedOrPermissionFailureObserved !== true ||
    value?.runtimeContinuedWithoutStop !== true ||
    value?.stopRequestCount !== 0
  ) {
    throw new Error("macos_tcc_revocation_machine_observation_failed");
  }
  return value;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macos_tcc_revocation_requires_darwin");
  }
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      "signed-candidate-report": { type: "string" },
      operator: { type: "string" },
      "capture-indicator-evidence": { type: "string" },
      output: { type: "string" },
      "timeout-ms": { type: "string", default: "600000" },
    },
    strict: true,
  });
  for (const required of [
    "executable",
    "signed-candidate-report",
    "operator",
    "capture-indicator-evidence",
    "output",
  ]) {
    if (!values[required]?.trim()) {
      throw new Error(`macos_tcc_revocation_missing_${required.replaceAll("-", "_")}`);
    }
  }
  const outputPath = resolve(values.output);
  const context = {
    schemaVersion: 2,
    kind: "ling-desktop-macos-tcc-revocation",
    generatedAt: new Date().toISOString(),
    operator: values.operator.trim(),
  };
  try {
    context.harness = await captureMacosReleaseHarnessProvenance([
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL("./macos-acceptance-common.mjs", import.meta.url)),
      fileURLToPath(new URL("./verify-macos-signed-candidate.mjs", import.meta.url)),
    ]);
    const executionArchitecture = normalizeMacosArchitecture(arch());
    if (!executionArchitecture) {
      throw new Error("macos_tcc_revocation_architecture_unsupported");
    }
    const executablePath = await realpath(resolve(values.executable));
    const metadata = await stat(executablePath);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error("macos_tcc_revocation_executable_invalid");
    }
    const executableSha256 = await sha256File(executablePath);
    const candidatePath = await realpath(resolve(values["signed-candidate-report"]));
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    if (candidate?.expected?.bundleId !== LING_DESKTOP_BUNDLE_ID) {
      throw new Error("macos_tcc_revocation_candidate_bundle_invalid");
    }
    const liveCandidate = await reverifyMacosSignedCandidateReport(candidate, candidatePath);
    const boundApp = findBoundApp(
      liveCandidate,
      candidatePath,
      executablePath,
      executableSha256,
    );
    if (!boundApp.mainExecutable.architectures.includes(executionArchitecture)) {
      throw new Error("macos_tcc_revocation_candidate_architecture_mismatch");
    }
    if (
      !/^[0-9a-f]{64}$/u.test(boundApp.bundleFingerprint?.treeSha256 ?? "") ||
      !/^[0-9a-f]{40}$/u.test(boundApp.bundleFingerprint?.cdhash ?? "")
    ) {
      throw new Error("macos_tcc_revocation_candidate_fingerprint_missing");
    }
    const probeRoot = await mkdtemp(join(tmpdir(), "ling-macos-revocation-probe-"));
    let permissionBefore;
    try {
      permissionBefore = await probePermission(
        executablePath,
        probeRoot,
        positiveInteger(values["timeout-ms"], 600_000),
      );
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
    if (permissionBefore !== "granted") {
      throw new Error("macos_tcc_revocation_permission_before_not_granted");
    }

    const logDirectory = join(dirname(outputPath), "logs");
    await mkdir(logDirectory, { recursive: true });
    const machineLogPath = join(
      logDirectory,
      `macos-tcc-revocation-${executionArchitecture}-${Date.now()}.log`,
    );
    const timeoutMs = positiveInteger(values["timeout-ms"], 600_000);
    const processResult = await runInteractiveRevocation(
      executablePath,
      timeoutMs,
    );
    await writeFile(machineLogPath, processResult.output, "utf8");
    if (processResult.exitCode !== 0) {
      throw new Error(
        `macos_tcc_revocation_desktop_exit:${processResult.exitCode ?? processResult.signal ?? "unknown"}`,
      );
    }
    const observation = parseRevocationMachineResult(processResult.output);
    const afterProbeRoot = await mkdtemp(join(tmpdir(), "ling-macos-revocation-after-"));
    let permissionAfter;
    try {
      permissionAfter = await probePermission(executablePath, afterProbeRoot, timeoutMs);
    } finally {
      await rm(afterProbeRoot, { recursive: true, force: true });
    }
    if (!new Set(["denied", "restricted"]).has(permissionAfter)) {
      throw new Error("macos_tcc_revocation_permission_after_not_denied");
    }
    const indicatorPath = await realpath(resolve(values["capture-indicator-evidence"]));
    const indicatorStat = await stat(indicatorPath);
    if (!indicatorStat.isFile() || indicatorStat.size === 0) {
      throw new Error("macos_tcc_revocation_indicator_evidence_invalid");
    }
    const report = {
      ...context,
      candidate: {
        reportSha256: await sha256File(candidatePath),
        executableSha256,
        bundleFingerprint: boundApp.bundleFingerprint,
        teamId: liveCandidate.expected.teamId,
        executionArchitecture,
      },
      host: {
        platform: "darwin",
        architecture: executionArchitecture,
        macosVersion: (await runProcess(macosSystemTool("swVers"), ["-productVersion"], 10_000)).stdout.trim(),
      },
      permissionBefore,
      permissionAfter,
      observation: {
        ...observation,
        captureIndicatorCleared: true,
      },
      evidence: {
        machineLog: {
          path: reportRelativePath(dirname(outputPath), machineLogPath),
          sha256: await sha256File(machineLogPath),
        },
        captureIndicator: {
          path: reportRelativePath(dirname(outputPath), indicatorPath),
          sha256: await sha256File(indicatorPath),
        },
      },
      verdict: { status: "PASS", pass: true },
    };
    await writeJsonAtomic(outputPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const report = {
      ...context,
      failure: true,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
      verdict: { status: "FAIL", pass: false },
    };
    await writeJsonAtomic(outputPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

async function runInteractiveRevocation(executablePath, timeoutMs) {
  const userDataDirectory = await mkdtemp(join(tmpdir(), "ling-macos-revocation-app-"));
  const daemonPort = await availablePort();
  let child;
  let completion;
  let reader;
  let timeout;
  const abortController = new AbortController();
  try {
    child = spawn(
      executablePath,
      [
        "--ling-desktop-smoke-headless",
        "--ling-desktop-macos-tcc-revocation-smoke",
        `--user-data-dir=${userDataDirectory}`,
      ],
      {
        cwd: desktopRoot,
        env: {
          ...process.env,
          LING_STACK_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
          LING_STACK_DEFAULT_WORKSPACE_CWD: dirname(dirname(desktopRoot)),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolveReady, rejectReady) => {
      readyResolve = resolveReady;
      readyReject = rejectReady;
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
      if (stdout.includes(READY_MARKER)) {
        readyResolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once("error", readyReject);
    completion = new Promise((resolveCompletion) => {
      child.once("close", (exitCode, signal) => {
        resolveCompletion({ exitCode, signal });
      });
    });
    timeout = setTimeout(() => {
      abortController.abort(new Error("macos_tcc_revocation_timeout"));
      readyReject(new Error("macos_tcc_revocation_ready_timeout"));
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    const readyResult = await Promise.race([
      ready.then(() => ({ kind: "ready" })),
      completion.then((result) => ({ kind: "closed", result })),
    ]);
    if (readyResult.kind === "closed") {
      throw new Error(
        `macos_tcc_revocation_desktop_closed_before_ready:${readyResult.result.exitCode ?? readyResult.result.signal ?? "unknown"}`,
      );
    }
    process.stderr.write(
      "Active signed display capture is live. Revoke Screen Recording for Ling Stack in System Settings, wait for the system capture indicator to clear, then press Enter.\n",
    );
    reader = createInterface({ input: process.stdin, output: process.stderr });
    await reader.question("", { signal: abortController.signal });
    await writeChildInput(child, `${JSON.stringify({ type: "permission_revoked" })}\n`);
    const result = await completion;
    if (abortController.signal.aborted) {
      throw abortController.signal.reason;
    }
    return { ...result, output: `${stdout}\n${stderr}` };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    reader?.close();
    if (!abortController.signal.aborted) {
      abortController.abort(new Error("macos_tcc_revocation_finished"));
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = completion
        ? await Promise.race([
            completion.then(() => true),
            new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2_000)),
          ])
        : false;
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await completion?.catch(() => undefined);
      }
    }
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

function writeChildInput(child, value) {
  return new Promise((resolveWrite, reject) => {
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      reject(new Error("macos_tcc_revocation_stdin_unavailable"));
      return;
    }
    const onError = (error) => {
      child.stdin.off("error", onError);
      reject(error);
    };
    child.stdin.once("error", onError);
    child.stdin.end(value, () => {
      child.stdin.off("error", onError);
      resolveWrite();
    });
  });
}

function findBoundApp(candidate, candidatePath, executablePath, executableSha256) {
  const match = candidate.apps.find((app) =>
    resolve(dirname(candidatePath), app.path, app.mainExecutable.path) === executablePath &&
    app.mainExecutable.sha256 === executableSha256 &&
    app.pass === true,
  );
  if (!match) {
    throw new Error("macos_tcc_revocation_executable_not_bound");
  }
  return match;
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
  const match = /(?:^|\n)Ling Stack Desktop screen permission: ([a-z-]+)(?:\n|$)/u.exec(
    `${result.stdout}\n${result.stderr}`,
  );
  if (result.exitCode !== 0 || !match) {
    throw new Error("macos_tcc_revocation_permission_probe_failed");
  }
  return match[1];
}

function runProcess(command, args, timeoutMs, cwd = process.cwd()) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
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
      resolveResult({ exitCode, signal, stdout, stderr });
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
          reject(new Error("macos_tcc_revocation_port_unavailable"));
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedAppend(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= 200_000 ? next : next.slice(-200_000);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
