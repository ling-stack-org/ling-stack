/**
 * Repeatable Computer Use PiP performance and cleanup harness.
 *
 * Run through `pnpm --filter @ling-stack/desktop performance:computer-use` after
 * a Desktop build. The default Electron lane performs five real-process cycles.
 * `LING_COMPUTER_USE_ELECTRON_PERF_CYCLES` and the `..._P95_MS` / `..._GROWTH_BYTES`
 * environment variables override cycle counts and failure thresholds.
 *
 * The default Electron lane intentionally uses the fake source adapter so CI can verify
 * BrowserWindow/preload/renderer/IPC ownership without screen-capture permission. Pass
 * `--real` to add a current-host real MediaStream lane. That lane is intentionally local
 * evidence and never claims signed/notarized release coverage. Its default one-second live
 * hold keeps Show/Hide churn from being mislabeled as active-preview CPU.
 */
import electronPath from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ComputerUsePreviewCoordinator } from "../dist/main/computer-use/coordinator.js";
import { FakeComputerUsePreviewPlatformAdapter } from "../dist/main/computer-use/fake-platform-adapter.js";
import {
  FAKE_COMPUTER_USE_PROJECTION,
  FakeComputerUseProjectionClient,
} from "../dist/main/computer-use/fake-projection-client.js";
import { chooseComputerUsePreviewBounds } from "../dist/main/computer-use/layout.js";

const lifecycleCycles = positiveInteger(process.env.LING_COMPUTER_USE_PERF_CYCLES, 100);
const layoutIterations = positiveInteger(process.env.LING_COMPUTER_USE_LAYOUT_ITERATIONS, 25_000);
const electronLifecycleCycles = positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_PERF_CYCLES, 5);
const realCaptureRequested = process.argv.includes("--real") ||
  process.env.LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE === "1";
const realCaptureCycles = positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE_CYCLES, 10);
const electronTimeoutMs = positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_PERF_TIMEOUT_MS, 120_000);
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const electronHarnessApp = resolve(desktopRoot, "tests/computer-use-electron-performance-app");

function measureLayout(iterations) {
  const input = {
    workArea: { x: 0, y: 0, width: 1_440, height: 900 },
    size: { width: 420, height: 263 },
    obstacles: [
      { x: 0, y: 720, width: 1_440, height: 180, kind: "composer" },
      { x: 1_080, y: 0, width: 360, height: 900, kind: "dock" },
      { x: 720, y: 120, width: 520, height: 420, kind: "modal" },
    ],
  };
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    const bounds = chooseComputerUsePreviewBounds({
      ...input,
      preferredCorner: index % 2 === 0 ? "bottom-right" : "top-right",
    });
    checksum += bounds.x + bounds.y;
  }
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  return {
    iterations,
    wallMs: round(wallMs),
    cpuMs: round((cpu.user + cpu.system) / 1_000),
    averageMicroseconds: round((wallMs * 1_000) / iterations),
    checksum,
  };
}

async function measureLifecycle(cycles) {
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const coordinator = new ComputerUsePreviewCoordinator({
    projectionClient: new FakeComputerUseProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    platformAdapter: adapter,
    preferenceStore: new MemoryPreferenceStore(),
    previewIndexPath: "/fake/preview/index.html",
    createWindow: (bounds) => {
      const window = new PerformancePreviewWindow(bounds, windows.length + 1);
      windows.push(window);
      return window;
    },
    getDisplays: () => [{ id: "primary", primary: true, workArea: { x: 0, y: 0, width: 1_440, height: 900 } }],
    getDisplayMatching: () => ({ id: "primary", primary: true, workArea: { x: 0, y: 0, width: 1_440, height: 900 } }),
  });

  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  const openDurations = [];
  for (let index = 0; index < cycles; index += 1) {
    if (index > 0) {
      const openStart = performance.now();
      await coordinator.show(FAKE_COMPUTER_USE_PROJECTION.sessionId);
      await flush();
      openDurations.push(performance.now() - openStart);
    }
    const snapshot = coordinator.getRendererSnapshot();
    coordinator.reportFrameReady(
      FAKE_COMPUTER_USE_PROJECTION.sessionId,
      snapshot.sourceRevision,
      snapshot.sourceGeneration,
    );
    await coordinator.close(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  }
  await coordinator.dispose();

  globalThis.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const liveWindows = windows.filter((window) => !window.destroyed).length;
  const listeners = windows.reduce(
    (total, window) => total + window.closedListeners.length + window.moveListeners.length +
      window.resizeListeners.length + window.rendererGoneListeners.length,
    0,
  );
  return {
    cycles,
    wallMs: round(wallMs),
    cpuMs: round((cpu.user + cpu.system) / 1_000),
    oneCoreCpuPercent: wallMs > 0 ? round(((cpu.user + cpu.system) / 1_000 / wallMs) * 100) : 0,
    heapGrowthBytes: heapAfter - heapBefore,
    fakeOpenMedianMs: percentile(openDurations, 0.5),
    fakeOpenP95Ms: percentile(openDurations, 0.95),
    prepareCount: adapter.prepareCount,
    releaseCount: adapter.releaseCount,
    residue: {
      windows: liveWindows,
      listeners,
    },
  };
}

class MemoryPreferenceStore {
  value = {
    schemaVersion: 1,
    previewAutoShow: true,
    hiddenSessionSuppressions: {},
  };

  async load() {
    return structuredClone(this.value);
  }

  async save(value) {
    this.value = structuredClone(value);
  }
}

class PerformancePreviewWindow {
  destroyed = false;
  visible = false;
  closedListeners = [];
  moveListeners = [];
  resizeListeners = [];
  rendererGoneListeners = [];
  webContents;

  constructor(bounds, id) {
    this.bounds = bounds;
    this.webContents = { id, send: () => undefined };
  }

  async loadFile() {}
  showInactive() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.visible = false;
    for (const listener of [...this.closedListeners]) {
      listener();
    }
  }

  isDestroyed() {
    return this.destroyed;
  }

  isVisible() {
    return this.visible;
  }

  setAspectRatio() {}

  setBounds(bounds) {
    this.bounds = bounds;
  }

  getBounds() {
    return this.bounds;
  }

  on(event, listener) {
    this.listenersFor(event).push(listener);
    return this;
  }

  off(event, listener) {
    const listeners = this.listenersFor(event);
    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
    return this;
  }

  onRendererProcessGone(listener) {
    this.rendererGoneListeners.push(listener);
    return () => {
      const index = this.rendererGoneListeners.indexOf(listener);
      if (index >= 0) {
        this.rendererGoneListeners.splice(index, 1);
      }
    };
  }

  listenersFor(event) {
    return event === "closed"
      ? this.closedListeners
      : event === "move"
        ? this.moveListeners
        : this.resizeListeners;
  }
}

const layout = measureLayout(layoutIterations);
const lifecycle = await measureLifecycle(lifecycleCycles);
let electronLifecycle;
try {
  electronLifecycle = await measureElectronLifecycle({ realCapture: false, cycles: electronLifecycleCycles });
} catch (error) {
  electronLifecycle = {
    kind: "ling-computer-use-preview-electron-performance",
    status: "unavailable",
    scope: "real Electron BrowserWindow/preload/renderer/IPC lifecycle with the fake source adapter",
    measuredAt: new Date().toISOString(),
    cycles: electronLifecycleCycles,
    thresholds: electronThresholds(),
    error: serializeError(error),
    verdict: {
      pass: false,
      checks: { harnessCompleted: { pass: false } },
    },
  };
}
let realCaptureLifecycle;
if (realCaptureRequested) {
  try {
    realCaptureLifecycle = await measureElectronLifecycle({ realCapture: true, cycles: realCaptureCycles });
  } catch (error) {
    realCaptureLifecycle = {
      kind: "ling-computer-use-preview-real-capture-performance",
      status: "unavailable",
      scope: "current-host real Electron MediaStream capture under the development runtime",
      measuredAt: new Date().toISOString(),
      cycles: realCaptureCycles,
      thresholds: electronThresholds(),
      limitations: {
        currentHostOnly: true,
        signedReleaseEvidence: false,
        artifactClass: "unpackaged Ling code running under the local development Electron runtime",
      },
      error: serializeError(error),
      verdict: {
        pass: false,
        checks: { harnessCompleted: { pass: false } },
      },
    };
  }
}
const result = {
  kind: "ling-computer-use-preview-performance",
  scope: realCaptureRequested
    ? "in-process fake baseline, fake-source Electron lifecycle, and current-host real MediaStream lifecycle"
    : "in-process fake baseline plus a real Electron BrowserWindow/preload/renderer/IPC subprocess lifecycle",
  measuredAt: new Date().toISOString(),
  limitations: {
    realCaptureTracksObserved: realCaptureLifecycle?.verdict?.checks?.realLiveTracksObserved?.pass === true,
    signedReleaseEvidence: false,
    currentHostOnly: realCaptureRequested,
    reason: realCaptureRequested
      ? "The real lane exercises the current host under the development Electron runtime; signed/notarized packaged release evidence remains a separate platform gate."
      : "The repeatable subprocess lane uses the fake source adapter; signed real-capture media-track evidence remains a platform gate.",
  },
  layout,
  lifecycle,
  electronLifecycle,
  ...(realCaptureRequested ? { realCaptureLifecycle } : {}),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (
  lifecycle.residue.windows !== 0 ||
  lifecycle.residue.listeners !== 0 ||
  electronLifecycle.verdict?.pass !== true ||
  (realCaptureRequested && realCaptureLifecycle?.verdict?.pass !== true)
) {
  process.exitCode = 1;
}

async function measureElectronLifecycle({ realCapture, cycles }) {
  const userDataDirectory = await mkdtemp(join(
    tmpdir(),
    realCapture ? "ling-computer-use-real-capture-perf-" : "ling-computer-use-electron-perf-",
  ));
  try {
    const result = await runElectron({
      executable: electronPath,
      args: [
        `--user-data-dir=${userDataDirectory}`,
        "--js-flags=--expose-gc",
        electronHarnessApp,
      ],
      env: {
        ...process.env,
        LING_COMPUTER_USE_ELECTRON_PERF_CYCLES: String(cycles),
        LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE: realCapture ? "1" : "0",
      },
    });
    const marker = "LING_COMPUTER_USE_ELECTRON_PERF_RESULT=";
    const encoded = result.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(marker))
      .at(-1)
      ?.slice(marker.length);
    if (!encoded) {
      throw new Error(
        `Electron performance subprocess did not emit a result (exit ${result.exitCode ?? result.signal ?? "unknown"}).\n` +
        `${result.stdout}\n${result.stderr}`,
      );
    }
    const report = JSON.parse(encoded);
    const childExitCheck = {
      observed: result.exitCode,
      threshold: 0,
      pass: result.exitCode === 0,
    };
    report.subprocess = {
      exitCode: result.exitCode,
      signal: result.signal,
      disposedFrameSendWarnings: countOccurrences(
        result.stderr,
        "Render frame was disposed before WebFrameMain could be accessed",
      ),
      stderrTail: result.stderr.slice(-4_000),
    };
    report.verdict ??= { pass: false, checks: {} };
    report.verdict.checks ??= {};
    report.verdict.checks.childExitCode = childExitCheck;
    report.verdict.pass = report.verdict.pass === true && childExitCheck.pass;
    if (!report.verdict.pass) {
      report.status = report.status === "unavailable" ? report.status : "failed";
    }
    return report;
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

function runElectron({ executable, args, env }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: desktopRoot,
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
    }, electronTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveRun({ exitCode, signal, stdout, stderr });
    });
  });
}

function electronThresholds() {
  return {
    firstFrameP95Ms: positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_FIRST_FRAME_P95_MS, 2_500),
    heapGrowthBytes: positiveInteger(
      process.env.LING_COMPUTER_USE_ELECTRON_HEAP_GROWTH_BYTES,
      32 * 1024 * 1024,
    ),
    rssGrowthBytes: positiveInteger(
      process.env.LING_COMPUTER_USE_ELECTRON_RSS_GROWTH_BYTES,
      96 * 1024 * 1024,
    ),
    appWorkingSetGrowthBytes: positiveInteger(
      process.env.LING_COMPUTER_USE_ELECTRON_WORKING_SET_GROWTH_BYTES,
      128 * 1024 * 1024,
    ),
  };
}

function boundedAppend(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= 250_000 ? next : next.slice(-250_000);
}

function countOccurrences(value, needle) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "Error", message: String(error) };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
