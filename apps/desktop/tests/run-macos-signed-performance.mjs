import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

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
const scriptPath = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);
const HOLD_READY = "LING_DESKTOP_SIGNED_PERFORMANCE_HOLD_READY";
const HOLD_COMPLETE = "LING_DESKTOP_SIGNED_PERFORMANCE_HOLD_COMPLETE";
const REAL_MARKER = "Ling Stack Desktop direct Electron Computer Use capture lifecycle passed";
const FAKE_MARKER = "Ling Stack Desktop fake Computer Use lifecycle passed";
const SAMPLE_INTERVAL_MS = 100;

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macos_signed_performance_requires_darwin");
  }
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      "signed-candidate-report": { type: "string" },
      output: { type: "string" },
      cycles: { type: "string", default: "3" },
      "hold-ms": { type: "string", default: "3000" },
      "timeout-ms": { type: "string", default: "90000" },
    },
    strict: true,
  });
  for (const required of ["executable", "signed-candidate-report", "output"]) {
    if (!values[required]?.trim()) {
      throw new Error(`macos_signed_performance_missing_${required.replaceAll("-", "_")}`);
    }
  }
  const outputPath = resolve(values.output);
  try {
    const harness = await captureMacosReleaseHarnessProvenance([
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL("./macos-acceptance-common.mjs", import.meta.url)),
      fileURLToPath(new URL("./verify-macos-signed-candidate.mjs", import.meta.url)),
    ]);
    const executionArchitecture = normalizeMacosArchitecture(arch());
    if (!executionArchitecture) {
      throw new Error("macos_signed_performance_architecture_unsupported");
    }
    const executablePath = await realpath(resolve(values.executable));
    const executableStat = await stat(executablePath);
    if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) {
      throw new Error("macos_signed_performance_executable_invalid");
    }
    const executableSha256 = await sha256File(executablePath);
    const candidatePath = await realpath(resolve(values["signed-candidate-report"]));
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    if (candidate?.expected?.bundleId !== LING_DESKTOP_BUNDLE_ID) {
      throw new Error("macos_signed_performance_candidate_bundle_invalid");
    }
    const liveCandidate = await reverifyMacosSignedCandidateReport(candidate, candidatePath);
    const boundApp = findBoundApp(liveCandidate, candidatePath, executablePath, executableSha256);
    if (!boundApp.mainExecutable.architectures.includes(executionArchitecture)) {
      throw new Error("macos_signed_performance_architecture_mismatch");
    }
    if (
      !/^[0-9a-f]{64}$/u.test(boundApp.bundleFingerprint?.treeSha256 ?? "") ||
      !/^[0-9a-f]{40}$/u.test(boundApp.bundleFingerprint?.cdhash ?? "")
    ) {
      throw new Error("macos_signed_performance_bundle_fingerprint_missing");
    }
    const cycles = positiveInteger(values.cycles, 3);
    const holdMs = positiveInteger(values["hold-ms"], 3_000);
    const timeoutMs = positiveInteger(values["timeout-ms"], 90_000);
    const logDirectory = join(dirname(outputPath), "logs");
    await mkdir(logDirectory, { recursive: true });
    const reports = [];
    for (let index = 0; index < cycles; index += 1) {
      const baseline = await runLifecycle({
        executablePath,
        realCapture: false,
        holdMs,
        timeoutMs,
        logDirectory,
        outputPath,
        label: `baseline-${index + 1}`,
      });
      const capture = await runLifecycle({
        executablePath,
        realCapture: true,
        holdMs,
        timeoutMs,
        logDirectory,
        outputPath,
        label: `capture-${index + 1}`,
      });
      reports.push({ baseline, capture });
    }
    const firstFrameSamples = reports.map((item) => item.capture.firstFrameLatencyMs);
    const baselineCpu = reports.map((item) => median(item.baseline.cpuSamples));
    const captureCpu = reports.map((item) => median(item.capture.cpuSamples));
    const baselineRss = reports.map((item) => median(item.baseline.rssSamplesBytes));
    const captureRss = reports.map((item) => median(item.capture.rssSamplesBytes));
    const firstFrameP95Ms = percentile(firstFrameSamples, 0.95);
    const incrementalCpuPercent = round(
      median(captureCpu) - median(baselineCpu),
    );
    const workingSetOverheadBytes = Math.max(
      0,
      Math.round(median(captureRss) - median(baselineRss)),
    );
    const checks = {
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
    const pass = Object.values(checks).every((check) => check.pass);
    const report = {
      schemaVersion: 1,
      kind: "ling-desktop-macos-signed-performance",
      generatedAt: new Date().toISOString(),
      harness,
      candidate: {
        reportSha256: await sha256File(candidatePath),
        teamId: liveCandidate.expected.teamId,
        bundleFingerprint: boundApp.bundleFingerprint,
      },
      executable: {
        path: reportRelativePath(dirname(outputPath), executablePath),
        sha256: executableSha256,
        architectures: boundApp.mainExecutable.architectures,
        executionArchitecture,
        bundleFingerprint: boundApp.bundleFingerprint,
      },
      host: {
        platform: "darwin",
        architecture: executionArchitecture,
        macosVersion: (await execFileAsync(macosSystemTool("swVers"), ["-productVersion"])).stdout.trim(),
      },
      producer: {
        machineGenerated: true,
        command: process.execPath,
        script: reportRelativePath(dirname(outputPath), scriptPath),
        scriptSha256: await sha256File(scriptPath),
        args: ["--cycles", String(cycles), "--hold-ms", String(holdMs)],
      },
      limitations: {
        signedReleaseEvidence: true,
        scope:
          "Developer ID/notarized packaged Ling executable; fake baseline and real display-media capture sampled on the same signed host.",
      },
      cycles: reports,
      releaseBudgetComparison: { pass, checks },
      verdict: { status: pass ? "PASS" : "FAIL", pass },
    };
    await writeJsonAtomic(outputPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!pass) {
      process.exitCode = 1;
    }
  } catch (error) {
    const report = {
      schemaVersion: 1,
      kind: "ling-desktop-macos-signed-performance",
      failure: true,
      generatedAt: new Date().toISOString(),
      limitations: { signedReleaseEvidence: false },
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

async function runLifecycle({
  executablePath,
  realCapture,
  holdMs,
  timeoutMs,
  logDirectory,
  outputPath,
  label,
}) {
  const userDataDirectory = await mkdtemp(join(tmpdir(), `ling-signed-perf-${label}-`));
  const daemonPort = await availablePort();
  try {
    const args = [
      "--ling-desktop-smoke-headless",
      realCapture ? "--ling-desktop-real-capture-smoke" : "--ling-desktop-fake-computer-use",
      `--user-data-dir=${userDataDirectory}`,
    ];
    const startedAt = new Date().toISOString();
    const child = spawn(executablePath, args, {
      cwd: desktopRoot,
      env: {
        ...process.env,
        ...(realCapture ? {} : { LING_DESKTOP_FAKE_COMPUTER_USE: "1" }),
        LING_DESKTOP_SIGNED_PERFORMANCE_HOLD_MS: String(holdMs),
        LING_STACK_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
        LING_STACK_DEFAULT_WORKSPACE_CWD: dirname(dirname(desktopRoot)),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let holdActive = false;
    let holdReadyAt;
    let holdCompleteAt;
    let sampling = false;
    const rssSamplesBytes = [];
    const cpuSamples = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
      if (stdout.includes(HOLD_READY) && holdReadyAt === undefined) {
        holdReadyAt = Date.now();
        holdActive = true;
      }
      if (stdout.includes(HOLD_COMPLETE) && holdCompleteAt === undefined) {
        holdCompleteAt = Date.now();
        holdActive = false;
      }
    });
    child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
    const interval = setInterval(async () => {
      if (!holdActive || sampling) {
        return;
      }
      sampling = true;
      try {
        const sample = await sampleProcess(child.pid);
        if (sample) {
          rssSamplesBytes.push(sample.rssBytes);
          cpuSamples.push(sample.cpuPercent);
        }
      } finally {
        sampling = false;
      }
    }, SAMPLE_INTERVAL_MS);
    const result = await new Promise((resolveResult, reject) => {
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
        resolveResult({ exitCode, signal });
      });
    });
    clearInterval(interval);
    const output = `${stdout}\n${stderr}`;
    const expectedMarker = realCapture ? REAL_MARKER : FAKE_MARKER;
    const observedHoldMs = holdReadyAt !== undefined && holdCompleteAt !== undefined
      ? Math.max(0, holdCompleteAt - holdReadyAt)
      : 0;
    const minimumSamples = Math.max(
      2,
      Math.floor(Math.max(100, holdMs * 0.75) / SAMPLE_INTERVAL_MS * 0.5),
    );
    if (
      result.exitCode !== 0 ||
      !output.includes(expectedMarker) ||
      observedHoldMs < Math.max(100, holdMs * 0.75) ||
      rssSamplesBytes.length < minimumSamples ||
      rssSamplesBytes.length !== cpuSamples.length ||
      rssSamplesBytes.some((sample) => !Number.isFinite(sample) || sample < 0) ||
      cpuSamples.some((sample) => !Number.isFinite(sample) || sample < 0)
    ) {
      throw new Error(`macos_signed_performance_lifecycle_failed:${label}`);
    }
    const telemetryPath = join(userDataDirectory, "computer-use-preview-telemetry.jsonl");
    const events = (await readFile(telemetryPath, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const firstFrameLatencyMs = events.find((event) => event.event === "preview_opened")
      ?.firstFrameLatencyMs;
    if (!Number.isFinite(firstFrameLatencyMs) || firstFrameLatencyMs < 0) {
      throw new Error(`macos_signed_performance_first_frame_missing:${label}`);
    }
    const logPath = join(logDirectory, `${label}-${Date.now()}.log`);
    await writeFile(logPath, output, "utf8");
    return {
      mode: realCapture ? "real" : "fake",
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signal: result.signal,
      firstFrameLatencyMs,
      rssSamplesBytes,
      cpuSamples,
      sampling: {
        intervalMs: SAMPLE_INTERVAL_MS,
        requestedHoldMs: holdMs,
        observedHoldMs,
        sampleCount: rssSamplesBytes.length,
        minimumSamples,
      },
      output: {
        path: reportRelativePath(dirname(outputPath), logPath),
        sha256: await sha256File(logPath),
      },
    };
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

async function sampleProcess(pid) {
  try {
    const { stdout } = await execFileAsync(macosSystemTool("ps"), [
      "-axo",
      "pid=,ppid=,rss=,%cpu=",
    ]);
    const processes = stdout
      .split(/\r?\n/u)
      .flatMap((line) => {
        const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9.]+)\s*$/u.exec(line);
        return match
          ? [{
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              rssBytes: Number(match[3]) * 1024,
              cpuPercent: Number(match[4]),
            }]
          : [];
      });
    const included = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const process of processes) {
        if (!included.has(process.pid) && included.has(process.parentPid)) {
          included.add(process.pid);
          changed = true;
        }
      }
    }
    const selected = processes.filter((process) => included.has(process.pid));
    return selected.length > 0
      ? {
          rssBytes: selected.reduce((total, process) => total + process.rssBytes, 0),
          cpuPercent: selected.reduce((total, process) => total + process.cpuPercent, 0),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function findBoundApp(candidate, candidatePath, executablePath, executableSha256) {
  const match = candidate.apps.find((app) =>
    resolve(dirname(candidatePath), app.path, app.mainExecutable.path) === executablePath &&
    app.mainExecutable.sha256 === executableSha256 &&
    app.pass === true,
  );
  if (!match) {
    throw new Error("macos_signed_performance_executable_not_bound");
  }
  return match;
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("macos_signed_performance_port_unavailable"));
        else resolvePort(port);
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

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function median(values) {
  return percentile(values, 0.5);
}

function round(value) {
  return Math.round(value * 100) / 100;
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
