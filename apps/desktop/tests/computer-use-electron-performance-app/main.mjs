/**
 * Electron-side worker for computer-use-performance-harness.mjs.
 * It must be launched by Electron, not Node, because the measured boundary is
 * the real BrowserWindow/preload/renderer/IPC lifecycle.
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ComputerUsePreviewCoordinator } from "../../dist/main/computer-use/coordinator.js";
import { InMemoryComputerUsePreviewDescriptorRegistry } from "../../dist/main/computer-use/descriptor-registry.js";
import { ElectronComputerUsePreviewPlatformAdapter } from "../../dist/main/computer-use/electron-platform-adapter.js";
import { parseElectronWindowSourceId } from "../../dist/main/computer-use/source-mapping.js";
import { registerDesktopIpc } from "../../dist/main/ipc.js";
import { createComputerUsePreviewWindowFactory } from "../../dist/main/computer-use/window.js";
import { DESKTOP_IPC_CHANNELS } from "../../dist/shared/ipc-channels.js";

const RESULT_PREFIX = "LING_COMPUTER_USE_ELECTRON_PERF_RESULT=";
const desktopRoot = resolve(import.meta.dirname, "../..");
const previewIndexPath = resolve(desktopRoot, "dist/renderer/computer-use-preview/index.html");
const realCaptureMode = process.env.LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE === "1";
const measuredCycles = positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_PERF_CYCLES, realCaptureMode ? 10 : 5);
const lifecycleTimeoutMs = positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_PERF_STEP_TIMEOUT_MS, 8_000);
const settleTimeoutMs = positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_PERF_SETTLE_TIMEOUT_MS, 5_000);
const realCaptureHoldMs = positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE_HOLD_MS, 1_000);
const realCaptureIdleSampleMs = positiveInteger(
  process.env.LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE_IDLE_SAMPLE_MS,
  5_000,
);
const realCaptureIdleWarmupMs = positiveInteger(
  process.env.LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE_IDLE_WARMUP_MS,
  5_000,
);
const realCaptureSteadyWarmupMs = positiveInteger(
  process.env.LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE_STEADY_WARMUP_MS,
  5_000,
);
const realCaptureSteadySampleMs = positiveInteger(
  process.env.LING_COMPUTER_USE_ELECTRON_REAL_CAPTURE_STEADY_SAMPLE_MS,
  30_000,
);
const thresholds = {
  firstFrameP95Ms: positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_FIRST_FRAME_P95_MS, 2_500),
  pageSwitchP95Ms: positiveInteger(process.env.LING_COMPUTER_USE_PAGE_SWITCH_P95_MS, 500),
  heapGrowthBytes: positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_HEAP_GROWTH_BYTES, 32 * 1024 * 1024),
  rssGrowthBytes: positiveInteger(process.env.LING_COMPUTER_USE_ELECTRON_RSS_GROWTH_BYTES, 96 * 1024 * 1024),
  appWorkingSetGrowthBytes: positiveInteger(
    process.env.LING_COMPUTER_USE_ELECTRON_WORKING_SET_GROWTH_BYTES,
    128 * 1024 * 1024,
  ),
};

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.setName(realCaptureMode
  ? "Ling Computer Use Real Capture Performance Harness"
  : "Ling Computer Use Electron Performance Harness");
app.on("window-all-closed", () => undefined);
const harnessKeepAlive = setInterval(() => undefined, 1_000);

let exitCode = 1;
let report;

void app.whenReady().then(async () => {
  try {
    report = realCaptureMode ? await runRealCaptureHarness() : await runHarness();
    exitCode = report.verdict.pass ? 0 : 1;
  } catch (error) {
    report = failureReport(error);
  }
  await finish();
}).catch(async (error) => {
  report = failureReport(error);
  await finish();
});

async function finish() {
  clearInterval(harnessKeepAlive);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
  await writeResult(report);
  app.exit(exitCode);
}

function failureReport(error) {
  return {
    kind: realCaptureMode
      ? "ling-computer-use-preview-real-capture-performance"
      : "ling-computer-use-preview-electron-performance",
    status: "failed",
    scope: realCaptureMode
      ? "current-host real Electron MediaStream capture under the development runtime"
      : "real Electron BrowserWindow/preload/renderer/IPC lifecycle with the fake source adapter",
    measuredAt: new Date().toISOString(),
    environment: environmentSummary(),
    ...(realCaptureMode ? { limitations: realCaptureLimitations(false) } : {}),
    thresholds,
    error: serializeError(error),
    verdict: { pass: false, checks: { harnessCompleted: { pass: false } } },
  };
}

async function runRealCaptureHarness() {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("electron_real_capture_perf_platform_unsupported");
  }

  const allWindowRecords = [];
  const cycleWindowRecords = [];
  const cycleReports = [];
  const diagnostics = [];
  const timers = new TrackedTimers();
  const preferences = new MemoryPreferenceStore();
  const descriptorRegistry = new InMemoryComputerUsePreviewDescriptorRegistry();
  const baseWindowFactory = createComputerUsePreviewWindowFactory();
  const ipcBaseline = countIpcListeners();
  let targetWindow;
  let coordinator;
  let projectionClient;
  let adapter;
  let unregisterIpc;
  let previewWindow;
  let warmup;
  let permissionState;
  let baseline;
  let measuredFinal;
  let cleanupFinal;
  let rendererPhaseSamples;
  let steadyState;
  let wallMs = 0;
  let cpu = { user: 0, system: 0 };

  try {
    const target = await createRealCaptureTargetDescriptor();
    targetWindow = target.window;
    descriptorRegistry.register(target.descriptor);
    const projection = createRealCaptureProjection(target.descriptor);
    projectionClient = new InstrumentedProjectionClient(projection);
    adapter = new InstrumentedRealAdapter(new ElectronComputerUsePreviewPlatformAdapter(
      descriptorRegistry,
      {
        expectedFrameUrl: pathToFileURL(previewIndexPath).href,
        onDiagnostic: (event, details) => {
          diagnostics.push({ event, details });
        },
      },
    ));
    permissionState = await adapter.getPermissionState({
      descriptorId: target.descriptor.descriptorId,
      revision: target.descriptor.revision,
    });
    if (permissionState !== "granted") {
      throw new Error(`electron_real_capture_perf_permission_${permissionState}`);
    }

    coordinator = new ComputerUsePreviewCoordinator({
      workspaceId: "/fake/workspace",
      projectionClient,
      platformAdapter: adapter,
      preferenceStore: preferences,
      previewIndexPath,
      createWindow: (bounds) => {
        const window = baseWindowFactory(bounds);
        const record = createWindowRecord(window, 0);
        cycleWindowRecords.push(record);
        allWindowRecords.push(record);
        return record.coordinatorWindow;
      },
      getDisplays: () => screen.getAllDisplays().map(toDesktopDisplay),
      getDisplayMatching: (bounds) => toDesktopDisplay(
        bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay(),
      ),
      setTimer: (callback, milliseconds) => timers.set(callback, milliseconds),
      clearTimer: (timer) => timers.clear(timer),
    });
    unregisterIpc = registerDesktopIpc({
      daemon: fakeDaemon,
      computerUse: coordinator,
      getMainWindow: () => undefined,
    });

    await coordinator.start();
    const warmupStartedAt = performance.now();
    coordinator.reportSelectedConversation(projection.conversationId);
    await waitForLiveFrame(coordinator, projection.sessionId, projection.preview.revision, "real warmup first frame");
    const warmupFirstFrameLatencyMs = performance.now() - warmupStartedAt;
    previewWindow = currentWindow(cycleWindowRecords, "real warmup preview");
    const previewWebContentsId = previewWindow.webContents.id;
    await delay(realCaptureHoldMs);
    const warmupLiveMedia = await readRendererMediaState(previewWindow);
    assertRendererMediaState(warmupLiveMedia, "live", "real warmup live media");
    const warmupHideStartedAt = performance.now();
    await hideRealCapture(coordinator, projection.sessionId, previewWindow, previewWebContentsId, "real warmup Hide");
    const warmupHiddenMedia = await readRendererMediaState(previewWindow);
    assertRendererMediaState(warmupHiddenMedia, "released", "real warmup hidden media");
    warmup = {
      firstFrameLatencyMs: round(warmupFirstFrameLatencyMs),
      hideReleaseLatencyMs: round(performance.now() - warmupHideStartedAt),
      liveMedia: warmupLiveMedia,
      hiddenMedia: warmupHiddenMedia,
    };
    await installRendererMediaPerformanceProbe(previewWindow);

    globalThis.gc?.();
    await delay(100);
    baseline = await captureResourceSnapshot();
    const cpuStart = process.cpuUsage();
    const wallStartedAt = performance.now();

    for (let cycle = 0; cycle < measuredCycles; cycle += 1) {
      const showStartedAt = performance.now();
      const shown = await coordinator.show(projection.sessionId);
      if (!shown.accepted) {
        throw new Error(shown.reason ?? `electron_real_capture_perf_show_rejected:${cycle}`);
      }
      await waitForLiveFrame(
        coordinator,
        projection.sessionId,
        projection.preview.revision,
        `real Show first frame ${cycle + 1}`,
      );
      const firstFrameLatencyMs = performance.now() - showStartedAt;
      assertStablePreviewWindow(previewWindow, previewWebContentsId, `real Show ${cycle + 1}`);
      await delay(realCaptureHoldMs);
      const liveMedia = await readRendererMediaState(previewWindow);
      assertRendererMediaState(liveMedia, "live", `real live media ${cycle + 1}`);

      const hideStartedAt = performance.now();
      await hideRealCapture(
        coordinator,
        projection.sessionId,
        previewWindow,
        previewWebContentsId,
        `real Hide ${cycle + 1}`,
      );
      const hideReleaseLatencyMs = performance.now() - hideStartedAt;
      const hiddenMedia = await readRendererMediaState(previewWindow);
      assertRendererMediaState(hiddenMedia, "released", `real hidden media ${cycle + 1}`);
      cycleReports.push({
        cycle: cycle + 1,
        firstFrameLatencyMs: round(firstFrameLatencyMs),
        hideReleaseLatencyMs: round(hideReleaseLatencyMs),
        liveMedia,
        hiddenMedia,
        previewWebContentsId,
      });
    }

    wallMs = performance.now() - wallStartedAt;
    cpu = process.cpuUsage(cpuStart);
    rendererPhaseSamples = await readRendererMediaPerformanceProbe(previewWindow);
    globalThis.gc?.();
    await delay(100);
    measuredFinal = await captureResourceSnapshot();

    await delay(realCaptureIdleWarmupMs);
    await captureResourceSnapshot();
    await delay(realCaptureIdleSampleMs);
    const idleSample = await captureResourceSnapshot();
    const steadyShowStartedAt = performance.now();
    const steadyShown = await coordinator.show(projection.sessionId);
    if (!steadyShown.accepted) {
      throw new Error(steadyShown.reason ?? "electron_real_capture_perf_steady_show_rejected");
    }
    await waitForLiveFrame(
      coordinator,
      projection.sessionId,
      projection.preview.revision,
      "real steady first frame",
    );
    const steadyFirstFrameLatencyMs = performance.now() - steadyShowStartedAt;
    await delay(realCaptureSteadyWarmupMs);
    const activeBaseline = await captureResourceSnapshot();
    await delay(realCaptureSteadySampleMs);
    const activeFinal = await captureResourceSnapshot();
    const steadyLiveMedia = await readRendererMediaState(previewWindow);
    assertRendererMediaState(steadyLiveMedia, "live", "real steady live media");
    const steadyHideStartedAt = performance.now();
    await hideRealCapture(
      coordinator,
      projection.sessionId,
      previewWindow,
      previewWebContentsId,
      "real steady Hide",
    );
    const steadyHiddenMedia = await readRendererMediaState(previewWindow);
    assertRendererMediaState(steadyHiddenMedia, "released", "real steady hidden media");
    steadyState = buildSteadyStateReport({
      idleSample,
      activeBaseline,
      activeFinal,
      firstFrameLatencyMs: steadyFirstFrameLatencyMs,
      hideReleaseLatencyMs: performance.now() - steadyHideStartedAt,
      liveMedia: steadyLiveMedia,
      hiddenMedia: steadyHiddenMedia,
    });
  } finally {
    await coordinator?.dispose().catch(() => undefined);
    unregisterIpc?.();
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.destroy();
    }
    for (const record of cycleWindowRecords) {
      if (!record.window.isDestroyed()) {
        record.window.destroy();
      }
    }
    await waitFor(
      () => BrowserWindow.getAllWindows().length === 0 && rendererProcessCount(app.getAppMetrics()) === 0,
      "real capture final BrowserWindow and renderer cleanup",
      settleTimeoutMs,
    );
    globalThis.gc?.();
    await delay(100);
    cleanupFinal = await captureResourceSnapshot();
  }

  if (!baseline || !measuredFinal || !cleanupFinal || !warmup || !adapter || !projectionClient || !steadyState) {
    throw new Error("electron_real_capture_perf_report_incomplete");
  }

  const firstFrameSamples = cycleReports.map((cycle) => cycle.firstFrameLatencyMs);
  const firstFrameP95Ms = percentile(firstFrameSamples, 0.95);
  const hiddenLiveTracks = [warmup.hiddenMedia, ...cycleReports.map((cycle) => cycle.hiddenMedia)]
    .map((media) => media.liveTrackCount ?? Number.POSITIVE_INFINITY);
  const liveTrackSamples = cycleReports.map((cycle) => cycle.liveMedia.liveTrackCount ?? 0);
  const heapGrowthBytes = measuredFinal.node.heapUsed - baseline.node.heapUsed;
  const rssGrowthBytes = measuredFinal.node.rss - baseline.node.rss;
  const appWorkingSetGrowthBytes = measuredFinal.appWorkingSetBytes - baseline.appWorkingSetBytes;
  const captureSourceEnumerationCount = diagnostics.filter(
    ({ event }) => event === "computer_use.capture_source_resolved",
  ).length;
  const rendererDocumentLoadCount = sum(allWindowRecords.map((record) => record.loadFileCount));
  const processResidue = Math.max(0, cleanupFinal.processCount - baseline.processCount);
  const trackedLiveWindows = allWindowRecords.filter((record) => !record.window.isDestroyed()).length +
    (targetWindow && !targetWindow.isDestroyed() ? 1 : 0);
  const windowListeners = sum(allWindowRecords.map((record) => activeWindowBoundarySubscriptions(record)));
  const rawWindowListenerDeltas = summarizeRawWindowListenerDeltas(allWindowRecords);
  const rawWindowListenerResidue = countRawWindowListenerResidue(rawWindowListenerDeltas);
  const ipcListeners = countIpcListenerResidue(ipcBaseline);
  const cpuMs = round((cpu.user + cpu.system) / 1_000);
  const oneCoreCpuPercent = wallMs > 0 ? round((cpuMs / wallMs) * 100) : 0;
  const checks = {
    permissionGranted: { observed: permissionState, expected: "granted", pass: permissionState === "granted" },
    captureCyclesCompleted: {
      observed: cycleReports.length,
      expected: measuredCycles,
      pass: cycleReports.length === measuredCycles && measuredCycles >= 10,
    },
    realLiveTracksObserved: {
      observed: liveTrackSamples,
      threshold: "at least one live track per cycle",
      pass: liveTrackSamples.length === measuredCycles && liveTrackSamples.every((count) => count >= 1),
    },
    hideReleasedAllTracks: {
      observed: hiddenLiveTracks,
      threshold: 0,
      pass: hiddenLiveTracks.length === measuredCycles + 1 && hiddenLiveTracks.every((count) => count === 0),
    },
    firstFrameP95Ms: {
      observed: firstFrameP95Ms,
      threshold: thresholds.firstFrameP95Ms,
      pass: firstFrameP95Ms <= thresholds.firstFrameP95Ms,
    },
    heapGrowthBytes: {
      observed: heapGrowthBytes,
      threshold: thresholds.heapGrowthBytes,
      pass: heapGrowthBytes <= thresholds.heapGrowthBytes,
    },
    rssGrowthBytes: {
      observed: rssGrowthBytes,
      threshold: thresholds.rssGrowthBytes,
      pass: rssGrowthBytes <= thresholds.rssGrowthBytes,
    },
    appWorkingSetGrowthBytes: {
      observed: appWorkingSetGrowthBytes,
      threshold: thresholds.appWorkingSetGrowthBytes,
      pass: appWorkingSetGrowthBytes <= thresholds.appWorkingSetGrowthBytes,
    },
    browserWindowResidue: {
      observed: cleanupFinal.windowCount,
      threshold: 0,
      pass: cleanupFinal.windowCount === 0,
    },
    trackedLiveWindows: { observed: trackedLiveWindows, threshold: 0, pass: trackedLiveWindows === 0 },
    processResidue: { observed: processResidue, threshold: 0, pass: processResidue === 0 },
    rendererProcessResidue: {
      observed: cleanupFinal.rendererProcessCount,
      threshold: 0,
      pass: cleanupFinal.rendererProcessCount === 0,
    },
    rendererTrackResidue: {
      observed: Math.max(...hiddenLiveTracks),
      threshold: 0,
      pass: hiddenLiveTracks.every((count) => count === 0) && cleanupFinal.rendererProcessCount === 0,
    },
    windowListenerResidue: { observed: windowListeners, threshold: 0, pass: windowListeners === 0 },
    rawWindowListenerResidue: {
      observed: rawWindowListenerResidue,
      threshold: 0,
      pass: rawWindowListenerResidue === 0,
    },
    ipcListenerResidue: { observed: ipcListeners, threshold: 0, pass: ipcListeners === 0 },
    coordinatorTimerResidue: {
      observed: timers.pending.size,
      threshold: 0,
      pass: timers.pending.size === 0,
    },
    projectionSubscriptionResidue: {
      observed: projectionClient.listeners.size,
      threshold: 0,
      pass: projectionClient.listeners.size === 0,
    },
    adapterSourceResidue: {
      observed: adapter.activeSources,
      threshold: 0,
      pass: adapter.activeSources === 0,
    },
    adapterDisposed: { observed: adapter.disposeCount, expected: 1, pass: adapter.disposeCount === 1 },
    singleSourceEnumerationPerActivation: {
      observed: captureSourceEnumerationCount,
      expected: adapter.prepareCount,
      pass: captureSourceEnumerationCount === adapter.prepareCount,
    },
    rendererDocumentReusedAcrossShowHide: {
      observed: rendererDocumentLoadCount,
      expected: 1,
      pass: rendererDocumentLoadCount === 1 && allWindowRecords.length === 1,
    },
    postAcquisitionConstraintReconfigurationAvoided: {
      observed: rendererPhaseSamples?.applyConstraints?.samples?.length ?? Number.POSITIVE_INFINITY,
      expected: 0,
      pass: rendererPhaseSamples?.applyConstraints?.samples?.length === 0,
    },
    steadyCaptureObserved: {
      observed: steadyState.liveMedia.liveTrackCount,
      threshold: "at least one live track after the steady sample",
      pass: steadyState.liveMedia.liveTrackCount >= 1,
    },
    steadyHideReleasedAllTracks: {
      observed: steadyState.hiddenMedia.liveTrackCount,
      threshold: 0,
      pass: steadyState.hiddenMedia.liveTrackCount === 0,
    },
  };
  const releaseBudgetChecks = {
    localCaptureLatencyProxyMs: {
      observed: firstFrameP95Ms,
      threshold: 250,
      pass: firstFrameP95Ms < 250,
    },
    activePreviewIncrementalCpuPercent: {
      observed: steadyState.cpu.incrementalOneCorePercent,
      threshold: 8,
      pass: steadyState.cpu.incrementalOneCorePercent < 8,
    },
    activePreviewWorkingSetOverheadBytes: {
      observed: steadyState.memory.activeWorkingSetOverheadBytes,
      threshold: 20 * 1024 * 1024,
      pass: steadyState.memory.activeWorkingSetOverheadBytes < 20 * 1024 * 1024,
    },
  };
  const churnComparisonChecks = {
    showHideChurnMainProcessCpuPercent: {
      observed: oneCoreCpuPercent,
      threshold: 8,
      pass: oneCoreCpuPercent < 8,
    },
    captureChurnAppWorkingSetGrowthBytes: {
      observed: appWorkingSetGrowthBytes,
      threshold: 20 * 1024 * 1024,
      pass: appWorkingSetGrowthBytes < 20 * 1024 * 1024,
      cycles: measuredCycles,
    },
  };

  return {
    kind: "ling-computer-use-preview-real-capture-performance",
    status: Object.values(checks).every((check) => check.pass) ? "passed" : "failed",
    scope: "current-host real Electron MediaStream capture under the development runtime",
    measuredAt: new Date().toISOString(),
    environment: { ...environmentSummary(), permissionState },
    limitations: realCaptureLimitations(true),
    thresholds,
    cycles: measuredCycles,
    liveHoldMs: realCaptureHoldMs,
    steadyState,
    warmup,
    cycleReports,
    performance: {
      wallMs: round(wallMs),
      cpuScope: "Electron main process process.cpuUsage over the measured capture cycles",
      cpuMs,
      oneCoreCpuPercent,
      firstFrameSamples: firstFrameSamples.length,
      firstFrameMedianMs: percentile(firstFrameSamples, 0.5),
      firstFrameP95Ms,
      hideReleaseMedianMs: percentile(cycleReports.map((cycle) => cycle.hideReleaseLatencyMs), 0.5),
      hideReleaseP95Ms: percentile(cycleReports.map((cycle) => cycle.hideReleaseLatencyMs), 0.95),
      rendererPhases: rendererPhaseSamples,
    },
    releaseBudgetComparison: {
      pass: Object.values(releaseBudgetChecks).every((check) => check.pass),
      evidenceClass: "informational_current_host_development_runtime",
      comparability: {
        latency: "Show command to first decoded frame is a conservative proxy for local visual latency.",
        cpu: `Measures whole-app CPU over ${realCaptureSteadySampleMs} ms of continuous capture and subtracts a ${realCaptureIdleSampleMs} ms hidden-idle baseline on the same process set.`,
        memory: "Measures whole-app active working-set overhead against the hidden loaded-renderer baseline after steady warmup.",
      },
      checks: releaseBudgetChecks,
    },
    churnComparison: {
      pass: Object.values(churnComparisonChecks).every((check) => check.pass),
      evidenceClass: "diagnostic_show_hide_churn",
      checks: churnComparisonChecks,
    },
    memory: {
      baselineHidden: baseline,
      finalHidden: measuredFinal,
      heapGrowthBytes,
      rssGrowthBytes,
      appWorkingSetGrowthBytes,
    },
    lifecycle: {
      adapterPrepareCount: adapter.prepareCount,
      adapterReleaseCount: adapter.releaseCount,
      adapterDisposeCount: adapter.disposeCount,
      maxActiveAdapterSources: adapter.maxActiveSources,
      realLiveTrackSamples: liveTrackSamples,
      hiddenLiveTrackSamples: hiddenLiveTracks,
      previewWindowsCreated: allWindowRecords.length,
      rendererDocumentLoadCount,
      captureSourceEnumerationCount,
    },
    diagnostics,
    residue: {
      processes: processResidue,
      browserWindows: cleanupFinal.windowCount,
      trackedLiveWindows,
      rendererProcesses: cleanupFinal.rendererProcessCount,
      rendererLiveTracks: Math.max(...hiddenLiveTracks),
      windowListeners,
      rawWindowListenerDeltas,
      ipcListeners,
      coordinatorTimers: timers.pending.size,
      projectionSubscriptions: projectionClient.listeners.size,
      adapterSources: adapter.activeSources,
      cleanupSnapshot: cleanupFinal,
    },
    verdict: {
      pass: Object.values(checks).every((check) => check.pass),
      checks,
    },
  };
}

async function runHarness() {
  const allWindowRecords = [];
  const lifecycleErrors = [];

  // Warm Electron, V8, the isolated session, preload, and renderer bundles before
  // taking the memory baseline. This prevents one-time Chromium startup cost from
  // being mislabeled as per-cycle leakage.
  await runLifecycleCycle({ cycle: -1, warmup: true, allWindowRecords });
  await settleAfterCleanup();
  globalThis.gc?.();
  await delay(100);

  const baseline = await captureResourceSnapshot();
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const cycleReports = [];

  for (let cycle = 0; cycle < measuredCycles; cycle += 1) {
    try {
      cycleReports.push(await runLifecycleCycle({ cycle, warmup: false, allWindowRecords }));
    } catch (error) {
      lifecycleErrors.push({ cycle, error: serializeError(error) });
      break;
    }
  }

  await settleAfterCleanup();
  globalThis.gc?.();
  await delay(100);
  const final = await captureResourceSnapshot();
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const firstFrameSamples = cycleReports.flatMap((cycle) => Object.values(cycle.firstFrameLatencyMs));
  const pageSwitchSamples = cycleReports.map((cycle) => cycle.firstFrameLatencyMs.pageSwitch);
  const adapterPrepareCount = sum(cycleReports.map((cycle) => cycle.adapter.prepareCount));
  const adapterReleaseCount = sum(cycleReports.map((cycle) => cycle.adapter.releaseCount));
  const adapterDisposeCount = sum(cycleReports.map((cycle) => cycle.adapter.disposeCount));
  const activeAdapterSources = sum(cycleReports.map((cycle) => cycle.adapter.activeSources));
  const maxActiveAdapterSources = Math.max(0, ...cycleReports.map((cycle) => cycle.adapter.maxActiveSources));
  const pendingTimers = sum(cycleReports.map((cycle) => cycle.residue.pendingCoordinatorTimers));
  const projectionSubscriptions = sum(cycleReports.map((cycle) => cycle.residue.projectionSubscriptions));
  const ipcListeners = sum(cycleReports.map((cycle) => cycle.residue.ipcListeners));
  const rawWindowListenerDeltas = summarizeRawWindowListenerDeltas(allWindowRecords);
  const windowListeners = sum(allWindowRecords.map((record) => activeWindowBoundarySubscriptions(record)));
  const trackedLiveWindows = allWindowRecords.filter((record) => !record.window.isDestroyed()).length;
  const browserWindowResidue = Math.max(0, BrowserWindow.getAllWindows().length - baseline.windowCount);
  const processResidue = Math.max(0, final.processCount - baseline.processCount);
  const rendererProcessResidue = final.rendererProcessCount;
  const heapGrowthBytes = final.node.heapUsed - baseline.node.heapUsed;
  const rssGrowthBytes = final.node.rss - baseline.node.rss;
  const appWorkingSetGrowthBytes = final.appWorkingSetBytes - baseline.appWorkingSetBytes;
  const firstFrameP95Ms = percentile(firstFrameSamples, 0.95);
  const pageSwitchP95Ms = percentile(pageSwitchSamples, 0.95);

  const checks = {
    allCyclesCompleted: {
      observed: cycleReports.length,
      expected: measuredCycles,
      pass: cycleReports.length === measuredCycles && lifecycleErrors.length === 0,
    },
    firstFrameP95Ms: {
      observed: firstFrameP95Ms,
      threshold: thresholds.firstFrameP95Ms,
      pass: firstFrameP95Ms <= thresholds.firstFrameP95Ms,
    },
    pageSwitchP95Ms: {
      observed: pageSwitchP95Ms,
      threshold: thresholds.pageSwitchP95Ms,
      pass: pageSwitchP95Ms <= thresholds.pageSwitchP95Ms,
    },
    maxActiveAdapterSources: {
      observed: maxActiveAdapterSources,
      threshold: 1,
      pass: maxActiveAdapterSources <= 1,
    },
    heapGrowthBytes: {
      observed: heapGrowthBytes,
      threshold: thresholds.heapGrowthBytes,
      pass: heapGrowthBytes <= thresholds.heapGrowthBytes,
    },
    rssGrowthBytes: {
      observed: rssGrowthBytes,
      threshold: thresholds.rssGrowthBytes,
      pass: rssGrowthBytes <= thresholds.rssGrowthBytes,
    },
    appWorkingSetGrowthBytes: {
      observed: appWorkingSetGrowthBytes,
      threshold: thresholds.appWorkingSetGrowthBytes,
      pass: appWorkingSetGrowthBytes <= thresholds.appWorkingSetGrowthBytes,
    },
    browserWindowResidue: { observed: browserWindowResidue, threshold: 0, pass: browserWindowResidue === 0 },
    trackedLiveWindows: { observed: trackedLiveWindows, threshold: 0, pass: trackedLiveWindows === 0 },
    processResidue: { observed: processResidue, threshold: 0, pass: processResidue === 0 },
    rendererProcessResidue: { observed: rendererProcessResidue, threshold: 0, pass: rendererProcessResidue === 0 },
    windowListenerResidue: { observed: windowListeners, threshold: 0, pass: windowListeners === 0 },
    ipcListenerResidue: { observed: ipcListeners, threshold: 0, pass: ipcListeners === 0 },
    coordinatorTimerResidue: { observed: pendingTimers, threshold: 0, pass: pendingTimers === 0 },
    projectionSubscriptionResidue: {
      observed: projectionSubscriptions,
      threshold: 0,
      pass: projectionSubscriptions === 0,
    },
    adapterSourceResidue: { observed: activeAdapterSources, threshold: 0, pass: activeAdapterSources === 0 },
    adapterDisposeCount: {
      observed: adapterDisposeCount,
      expected: measuredCycles,
      pass: adapterDisposeCount === measuredCycles,
    },
  };

  return {
    kind: "ling-computer-use-preview-electron-performance",
    status: Object.values(checks).every((check) => check.pass) ? "passed" : "failed",
    scope: "real Electron BrowserWindow/preload/renderer/IPC lifecycle with the fake source adapter",
    measuredAt: new Date().toISOString(),
    environment: environmentSummary(),
    limitations: {
      realCaptureTracksObserved: false,
      reason: "The harness uses the fake source adapter so it can run without macOS TCC or a Windows provider.",
      evidenceBoundary: "Adapter source ownership is measured; real MediaStream track residue requires the signed real-capture matrix.",
      rendererTimerEvidence: "Renderer-global timers are not enumerated; zero renderer-process residue proves their owning process exited.",
      rawEmitterDiagnostics: "Destroyed Electron objects may retain inert EventEmitter entries while the harness holds diagnostic references; only active coordinator boundary subscriptions are a failure gate.",
    },
    thresholds,
    cycles: measuredCycles,
    cycleReports,
    lifecycleErrors,
    performance: {
      wallMs: round(wallMs),
      cpuMs: round((cpu.user + cpu.system) / 1_000),
      oneCoreCpuPercent: wallMs > 0 ? round((((cpu.user + cpu.system) / 1_000) / wallMs) * 100) : 0,
      firstFrameSamples: firstFrameSamples.length,
      firstFrameMedianMs: percentile(firstFrameSamples, 0.5),
      firstFrameP95Ms,
      pageSwitchSamples: pageSwitchSamples.length,
      pageSwitchMedianMs: percentile(pageSwitchSamples, 0.5),
      pageSwitchP95Ms,
    },
    memory: {
      baseline,
      final,
      heapGrowthBytes,
      rssGrowthBytes,
      appWorkingSetGrowthBytes,
    },
    lifecycle: {
      adapterPrepareCount,
      adapterReleaseCount,
      adapterDisposeCount,
      activeAdapterSources,
      maxActiveAdapterSources,
      measuredWindowsCreated: sum(cycleReports.map((cycle) => cycle.windowsCreated)),
      warmupWindowsCreated: allWindowRecords.length - sum(cycleReports.map((cycle) => cycle.windowsCreated)),
      rendererCrashesRequested: cycleReports.length,
    },
    residue: {
      processes: processResidue,
      browserWindows: browserWindowResidue,
      trackedLiveWindows,
      rendererProcesses: rendererProcessResidue,
      windowListeners,
      rawWindowListenerDeltas,
      ipcListeners,
      coordinatorTimers: pendingTimers,
      projectionSubscriptions,
      adapterSources: activeAdapterSources,
    },
    verdict: {
      pass: Object.values(checks).every((check) => check.pass),
      checks,
    },
  };
}

async function runLifecycleCycle({ cycle, warmup, allWindowRecords }) {
  const projection = createProjection(cycle);
  const projectionClient = new InstrumentedProjectionClient(projection);
  const adapter = new InstrumentedFakeAdapter();
  const timers = new TrackedTimers();
  const preferences = new MemoryPreferenceStore();
  const cycleWindowRecords = [];
  const baseWindowFactory = createComputerUsePreviewWindowFactory();
  const ipcBaseline = countIpcListeners();
  let coordinator;
  let unregisterIpc;
  let cycleReport;

  try {
    coordinator = new ComputerUsePreviewCoordinator({
      workspaceId: "/fake/workspace",
      projectionClient,
      platformAdapter: adapter,
      preferenceStore: preferences,
      previewIndexPath,
      createWindow: (bounds) => {
        const window = baseWindowFactory(bounds);
        const record = createWindowRecord(window, cycle);
        cycleWindowRecords.push(record);
        allWindowRecords.push(record);
        return record.coordinatorWindow;
      },
      getDisplays: () => screen.getAllDisplays().map(toDesktopDisplay),
      getDisplayMatching: (bounds) => toDesktopDisplay(
        bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay(),
      ),
      setTimer: (callback, milliseconds) => timers.set(callback, milliseconds),
      clearTimer: (timer) => timers.clear(timer),
    });
    unregisterIpc = registerDesktopIpc({
      daemon: fakeDaemon,
      computerUse: coordinator,
      getMainWindow: () => undefined,
    });

    await coordinator.start();
    const initialStartedAt = performance.now();
    coordinator.reportSelectedConversation(projection.conversationId);
    await waitForLiveFrame(coordinator, projection.sessionId, projection.preview.revision, "initial first frame");
    const initialFirstFrameMs = performance.now() - initialStartedAt;
    const initialWindow = currentWindow(cycleWindowRecords, "initial window");
    const initialRendererMedia = await readRendererMediaState(initialWindow);

    const hidden = await coordinator.hide(projection.sessionId);
    if (!hidden.accepted) {
      throw new Error(hidden.reason ?? "electron_perf_hide_rejected");
    }
    await waitFor(() => coordinator.getSummary()?.visible === false, "Hide visibility");

    const reshowStartedAt = performance.now();
    const shown = await coordinator.show(projection.sessionId);
    if (!shown.accepted) {
      throw new Error(shown.reason ?? "electron_perf_show_rejected");
    }
    await waitForLiveFrame(coordinator, projection.sessionId, projection.preview.revision, "Show first frame");
    const reshowFirstFrameMs = performance.now() - reshowStartedAt;

    const windowBeforeClose = currentWindow(cycleWindowRecords, "window before Close");
    windowBeforeClose.close();
    await waitFor(() => windowBeforeClose.isDestroyed(), "native Close destruction");
    await waitFor(() => coordinator.getSummary()?.visible === false, "native Close visibility");

    const closeReopenStartedAt = performance.now();
    const reopened = await coordinator.show(projection.sessionId);
    if (!reopened.accepted) {
      throw new Error(reopened.reason ?? "electron_perf_close_reopen_rejected");
    }
    await waitForLiveFrame(coordinator, projection.sessionId, projection.preview.revision, "Close reopen first frame");
    const closeReopenFirstFrameMs = performance.now() - closeReopenStartedAt;

    const replacement = {
      ...projection,
      preview: { ...projection.preview, revision: projection.preview.revision + 1 },
      updatedAt: new Date().toISOString(),
    };
    const revisionStartedAt = performance.now();
    projectionClient.emit(replacement);
    await waitForLiveFrame(
      coordinator,
      replacement.sessionId,
      replacement.preview.revision,
      "revision first frame",
    );
    const revisionFirstFrameMs = performance.now() - revisionStartedAt;

    const pageProjection = {
      ...replacement,
      sessionId: `${replacement.sessionId}_page_b`,
      runId: `${replacement.runId}_page_b`,
      workUnitId: `${replacement.workUnitId}_page_b`,
      target: { ...replacement.target, displayName: "Electron performance page B" },
      preview: {
        ...replacement.preview,
        descriptorId: `${replacement.preview.descriptorId}_page_b`,
      },
      updatedAt: new Date(Date.now() + 1).toISOString(),
    };
    projectionClient.emit(pageProjection);
    await waitFor(
      () => coordinator.getDeckState()?.availablePageIds.includes(pageProjection.sessionId),
      "page B deck eligibility",
    );
    const windowBeforePageSwitch = currentWindow(cycleWindowRecords, "window before page switch");
    const pageSwitchStartedAt = performance.now();
    const pageSwitch = await coordinator.activatePage(pageProjection.sessionId);
    if (!pageSwitch.accepted) {
      throw new Error(pageSwitch.reason ?? "electron_perf_page_switch_rejected");
    }
    await waitForLiveFrame(
      coordinator,
      pageProjection.sessionId,
      pageProjection.preview.revision,
      "page switch first frame",
    );
    const pageSwitchFirstFrameMs = performance.now() - pageSwitchStartedAt;
    const windowAfterPageSwitch = currentWindow(cycleWindowRecords, "window after page switch");
    if (windowAfterPageSwitch.webContents.id !== windowBeforePageSwitch.webContents.id) {
      throw new Error("electron_perf_page_switch_recreated_window");
    }

    const windowBeforeCrash = currentWindow(cycleWindowRecords, "window before renderer crash");
    const createdBeforeCrash = cycleWindowRecords.length;
    const crashStartedAt = performance.now();
    if (typeof windowBeforeCrash.webContents.forcefullyCrashRenderer !== "function") {
      throw new Error("electron_perf_forcefully_crash_renderer_unavailable");
    }
    windowBeforeCrash.webContents.forcefullyCrashRenderer();
    await waitFor(() => windowBeforeCrash.isDestroyed(), "crashed window destruction");
    await waitFor(() => cycleWindowRecords.length > createdBeforeCrash, "renderer crash recreation");
    await waitForLiveFrame(
      coordinator,
      pageProjection.sessionId,
      pageProjection.preview.revision,
      "renderer crash recovery first frame",
    );
    const crashRecoveryFirstFrameMs = performance.now() - crashStartedAt;
    const recoveredWindow = currentWindow(cycleWindowRecords, "recovered window");
    const recoveredRendererMedia = await readRendererMediaState(recoveredWindow);

    cycleReport = {
      cycle,
      warmup,
      firstFrameLatencyMs: {
        initial: round(initialFirstFrameMs),
        reshow: round(reshowFirstFrameMs),
        closeReopen: round(closeReopenFirstFrameMs),
        revision: round(revisionFirstFrameMs),
        pageSwitch: round(pageSwitchFirstFrameMs),
        crashRecovery: round(crashRecoveryFirstFrameMs),
      },
      adapter: {
        prepareCount: adapter.prepareCount,
        releaseCount: adapter.releaseCount,
        disposeCount: adapter.disposeCount,
        activeSources: adapter.activeSources,
        maxActiveSources: adapter.maxActiveSources,
      },
      rendererMedia: {
        initial: initialRendererMedia,
        recovered: recoveredRendererMedia,
      },
      windowsCreated: cycleWindowRecords.length,
    };
  } finally {
    await coordinator?.dispose().catch(() => undefined);
    unregisterIpc?.();
    for (const record of cycleWindowRecords) {
      if (!record.window.isDestroyed()) {
        record.window.destroy();
      }
    }
    await waitFor(
      () => cycleWindowRecords.every((record) => record.window.isDestroyed()),
      "cycle BrowserWindow cleanup",
      settleTimeoutMs,
    ).catch(() => undefined);
    if (cycleReport) {
      cycleReport.adapter = {
        prepareCount: adapter.prepareCount,
        releaseCount: adapter.releaseCount,
        disposeCount: adapter.disposeCount,
        activeSources: adapter.activeSources,
        maxActiveSources: adapter.maxActiveSources,
      };
      cycleReport.residue = {
        pendingCoordinatorTimers: timers.pending.size,
        projectionSubscriptions: projectionClient.listeners.size,
        ipcListeners: countIpcListenerResidue(ipcBaseline),
      };
    }
  }
  return cycleReport;
}

async function settleAfterCleanup() {
  await waitFor(
    () => BrowserWindow.getAllWindows().length === 0 && rendererProcessCount(app.getAppMetrics()) === 0,
    "Electron renderer process cleanup",
    settleTimeoutMs,
  );
  await delay(100);
}

async function captureResourceSnapshot() {
  const metrics = app.getAppMetrics();
  const processMemory = typeof process.getProcessMemoryInfo === "function"
    ? await process.getProcessMemoryInfo()
    : undefined;
  return {
    node: {
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
      heapTotal: process.memoryUsage().heapTotal,
      external: process.memoryUsage().external,
    },
    electronProcessMemory: processMemory,
    appWorkingSetBytes: sum(metrics.map((metric) => Number(metric.memory?.workingSetSize ?? 0))) * 1024,
    processCount: metrics.length,
    rendererProcessCount: rendererProcessCount(metrics),
    processTypes: countBy(metrics.map((metric) => metric.type)),
    processMetrics: metrics
      .map((metric) => ({
        pid: metric.pid,
        creationTime: metric.creationTime,
        type: metric.type,
        name: metric.name,
        cpuPercent: round(Number(metric.cpu?.percentCPUUsage ?? 0)),
        cumulativeCpuSeconds: round(Number(metric.cpu?.cumulativeCPUUsage ?? 0)),
        workingSetBytes: Number(metric.memory?.workingSetSize ?? 0) * 1024,
      }))
      .sort((left, right) => left.pid - right.pid || left.creationTime - right.creationTime),
    windowCount: BrowserWindow.getAllWindows().length,
  };
}

function buildSteadyStateReport({
  idleSample,
  activeBaseline,
  activeFinal,
  firstFrameLatencyMs,
  hideReleaseLatencyMs,
  liveMedia,
  hiddenMedia,
}) {
  const idleCpuPercent = sum(idleSample.processMetrics.map((metric) => metric.cpuPercent));
  const activeCpuPercent = sum(activeFinal.processMetrics.map((metric) => metric.cpuPercent));
  const idleCpuByProcess = new Map(
    idleSample.processMetrics.map((metric) => [processMetricKey(metric), metric.cpuPercent]),
  );
  const cpuProcessDeltas = activeFinal.processMetrics.map((metric) => ({
    pid: metric.pid,
    creationTime: metric.creationTime,
    type: metric.type,
    name: metric.name,
    idlePercent: idleCpuByProcess.get(processMetricKey(metric)) ?? 0,
    activePercent: metric.cpuPercent,
    positiveDeltaPercent: round(Math.max(
      0,
      metric.cpuPercent - (idleCpuByProcess.get(processMetricKey(metric)) ?? 0),
    )),
  }));
  return {
    idleSampleMs: realCaptureIdleSampleMs,
    idleWarmupMs: realCaptureIdleWarmupMs,
    warmupMs: realCaptureSteadyWarmupMs,
    activeSampleMs: realCaptureSteadySampleMs,
    firstFrameLatencyMs: round(firstFrameLatencyMs),
    hideReleaseLatencyMs: round(hideReleaseLatencyMs),
    liveMedia,
    hiddenMedia,
    cpu: {
      idleOneCorePercent: round(idleCpuPercent),
      activeOneCorePercent: round(activeCpuPercent),
      incrementalOneCorePercent: round(sum(cpuProcessDeltas.map((metric) => metric.positiveDeltaPercent))),
      processDeltas: cpuProcessDeltas,
      idleProcesses: idleSample.processMetrics,
      activeProcesses: activeFinal.processMetrics,
    },
    memory: {
      hiddenWorkingSetBytes: idleSample.appWorkingSetBytes,
      activeBaselineWorkingSetBytes: activeBaseline.appWorkingSetBytes,
      activeFinalWorkingSetBytes: activeFinal.appWorkingSetBytes,
      activeWorkingSetOverheadBytes: activeFinal.appWorkingSetBytes - idleSample.appWorkingSetBytes,
      activeSampleGrowthBytes: activeFinal.appWorkingSetBytes - activeBaseline.appWorkingSetBytes,
      hiddenProcesses: idleSample.processMetrics,
      activeBaselineProcesses: activeBaseline.processMetrics,
      activeFinalProcesses: activeFinal.processMetrics,
    },
  };
}

function processMetricKey(metric) {
  return `${metric.pid}:${metric.creationTime}`;
}

function createWindowRecord(window, cycle) {
  const webContents = window.webContents;
  const active = {
    closed: new Set(),
    move: new Set(),
    resize: new Set(),
    rendererGone: 0,
  };
  const record = {
    cycle,
    window,
    webContents,
    loadFileCount: 0,
    active,
    baseline: {
      closed: window.listenerCount("closed"),
      move: window.listenerCount("move"),
      resize: window.listenerCount("resize"),
      rendererGone: webContents.listenerCount("render-process-gone"),
      didStartNavigation: webContents.listenerCount("did-start-navigation"),
      webContentsDestroyed: webContents.listenerCount("destroyed"),
    },
  };
  const coordinatorWindow = {
    webContents,
    loadFile: (path) => {
      record.loadFileCount += 1;
      return window.loadFile(path);
    },
    showInactive: () => window.showInactive(),
    hide: () => window.hide(),
    destroy: () => window.destroy(),
    isDestroyed: () => window.isDestroyed(),
    isVisible: () => window.isVisible(),
    setAspectRatio: (aspectRatio) => window.setAspectRatio(aspectRatio),
    setBounds: (bounds, animate) => window.setBounds(bounds, animate),
    getBounds: () => window.getBounds(),
    on: (event, listener) => {
      active[event].add(listener);
      window.on(event, listener);
      return coordinatorWindow;
    },
    off: (event, listener) => {
      active[event].delete(listener);
      try {
        window.off(event, listener);
      } catch {
        // The boundary subscription is already dropped even if Electron has
        // destroyed the native window before EventEmitter cleanup runs.
      }
      return coordinatorWindow;
    },
    onRendererProcessGone: (listener) => {
      active.rendererGone += 1;
      const unsubscribe = window.onRendererProcessGone(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        active.rendererGone = Math.max(0, active.rendererGone - 1);
        try {
          unsubscribe();
        } catch {
          // The callback ownership is already cleared at this boundary.
        }
      };
    },
  };
  record.coordinatorWindow = coordinatorWindow;
  return record;
}

function summarizeRawWindowListenerDeltas(records) {
  const summary = {
    windowsInspected: records.length,
    windowsWithDeltas: 0,
    closed: 0,
    move: 0,
    resize: 0,
    rendererGone: 0,
    didStartNavigation: 0,
    webContentsDestroyed: 0,
  };
  for (const record of records) {
    const current = {
      closed: safeListenerCount(record.window, "closed"),
      move: safeListenerCount(record.window, "move"),
      resize: safeListenerCount(record.window, "resize"),
      rendererGone: safeListenerCount(record.webContents, "render-process-gone"),
      didStartNavigation: safeListenerCount(record.webContents, "did-start-navigation"),
      webContentsDestroyed: safeListenerCount(record.webContents, "destroyed"),
    };
    const delta = {
      closed: Math.max(0, current.closed - record.baseline.closed),
      move: Math.max(0, current.move - record.baseline.move),
      resize: Math.max(0, current.resize - record.baseline.resize),
      rendererGone: Math.max(0, current.rendererGone - record.baseline.rendererGone),
      didStartNavigation: Math.max(0, current.didStartNavigation - record.baseline.didStartNavigation),
      webContentsDestroyed: Math.max(0, current.webContentsDestroyed - record.baseline.webContentsDestroyed),
    };
    const total = delta.closed + delta.move + delta.resize + delta.rendererGone +
      delta.didStartNavigation + delta.webContentsDestroyed;
    if (total > 0) {
      summary.windowsWithDeltas += 1;
    }
    summary.closed += delta.closed;
    summary.move += delta.move;
    summary.resize += delta.resize;
    summary.rendererGone += delta.rendererGone;
    summary.didStartNavigation += delta.didStartNavigation;
    summary.webContentsDestroyed += delta.webContentsDestroyed;
  }
  return summary;
}

function countRawWindowListenerResidue(summary) {
  return summary.closed + summary.move + summary.resize + summary.rendererGone +
    summary.didStartNavigation + summary.webContentsDestroyed;
}

function activeWindowBoundarySubscriptions(record) {
  return record.active.closed.size + record.active.move.size + record.active.resize.size + record.active.rendererGone;
}

function countIpcListeners() {
  return Object.fromEntries(
    Object.values(DESKTOP_IPC_CHANNELS).map((channel) => [channel, ipcMain.listenerCount(channel)]),
  );
}

function countIpcListenerResidue(baseline) {
  const current = countIpcListeners();
  return sum(Object.keys(current).map((channel) => Math.max(0, current[channel] - (baseline[channel] ?? 0))));
}

async function readRendererMediaState(window) {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return { accessible: false, reason: "renderer_destroyed" };
  }
  try {
    return await window.webContents.executeJavaScript(`(() => {
      const video = document.querySelector("video.preview-video");
      const stream = video && video.srcObject instanceof MediaStream ? video.srcObject : undefined;
      const tracks = stream ? stream.getTracks() : [];
      return {
        accessible: true,
        videoPresent: Boolean(video),
        trackCount: tracks.length,
        liveTrackCount: tracks.filter((track) => track.readyState === "live").length,
        endedTrackCount: tracks.filter((track) => track.readyState === "ended").length,
      };
    })()`);
  } catch (error) {
    return { accessible: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function installRendererMediaPerformanceProbe(window) {
  await window.webContents.executeJavaScript(`(() => {
    const state = { getDisplayMediaMs: [], currentDataMs: [], applyConstraintsMs: [], playMs: [] };
    globalThis.__lingComputerUseMediaPerformance = state;
    const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (...args) => {
      const startedAt = performance.now();
      try {
        const stream = await originalGetDisplayMedia(...args);
        const observeCurrentData = () => {
          const video = document.querySelector("video.preview-video");
          if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            state.currentDataMs.push(performance.now() - startedAt);
            return;
          }
          if (performance.now() - startedAt < 2000) {
            setTimeout(observeCurrentData, 5);
          }
        };
        setTimeout(observeCurrentData, 0);
        return stream;
      } finally {
        state.getDisplayMediaMs.push(performance.now() - startedAt);
      }
    };
    const originalApplyConstraints = MediaStreamTrack.prototype.applyConstraints;
    MediaStreamTrack.prototype.applyConstraints = async function (...args) {
      const startedAt = performance.now();
      try {
        return await originalApplyConstraints.apply(this, args);
      } finally {
        state.applyConstraintsMs.push(performance.now() - startedAt);
      }
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = async function (...args) {
      const startedAt = performance.now();
      try {
        return await originalPlay.apply(this, args);
      } finally {
        state.playMs.push(performance.now() - startedAt);
      }
    };
  })()`);
}

async function readRendererMediaPerformanceProbe(window) {
  return window.webContents.executeJavaScript(`(() => {
    const state = globalThis.__lingComputerUseMediaPerformance;
    if (!state) {
      return undefined;
    }
    const summarize = (values) => ({
      samples: values.map((value) => Math.round(value * 100) / 100),
      medianMs: values.length ? values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * 0.5)] : 0,
      p95Ms: values.length ? values.slice().sort((a, b) => a - b)[Math.ceil((values.length - 1) * 0.95)] : 0,
    });
    return {
      getDisplayMedia: summarize(state.getDisplayMediaMs),
      currentData: summarize(state.currentDataMs),
      applyConstraints: summarize(state.applyConstraintsMs),
      play: summarize(state.playMs),
    };
  })()`);
}

function assertRendererMediaState(state, expected, label) {
  if (!state?.accessible || !state.videoPresent) {
    throw new Error(`electron_real_capture_perf_media_unavailable:${label}:${state?.reason ?? "unknown"}`);
  }
  const trackCount = Number(state.trackCount);
  const liveTrackCount = Number(state.liveTrackCount);
  if (!Number.isInteger(trackCount) || trackCount < 0 || !Number.isInteger(liveTrackCount) || liveTrackCount < 0) {
    throw new Error(`electron_real_capture_perf_media_invalid:${label}`);
  }
  if (expected === "live" ? trackCount < 1 || liveTrackCount < 1 : liveTrackCount !== 0) {
    throw new Error(`electron_real_capture_perf_media_${expected}_mismatch:${label}`);
  }
}

async function hideRealCapture(coordinator, sessionId, window, webContentsId, label) {
  const hidden = await coordinator.hide(sessionId);
  if (!hidden.accepted) {
    throw new Error(hidden.reason ?? `electron_real_capture_perf_hide_rejected:${label}`);
  }
  await waitFor(() => coordinator.getSummary()?.visible === false, `${label} visibility`);
  assertStablePreviewWindow(window, webContentsId, label);
}

function assertStablePreviewWindow(window, webContentsId, label) {
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    window.webContents.id !== webContentsId
  ) {
    throw new Error(`electron_real_capture_perf_preview_recreated:${label}`);
  }
}

async function createRealCaptureTargetDescriptor() {
  const targetTitle = `Ling Computer Use Performance Target ${process.pid}`;
  const window = new BrowserWindow({
    width: 640,
    height: 400,
    show: true,
    title: targetTitle,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${targetTitle}</title>` +
    `<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;color:#eef6ff;` +
    `font:600 30px system-ui;background:linear-gradient(135deg,#12233c,#274f88)}` +
    `div{padding:28px 36px;border:1px solid #ffffff55;border-radius:18px;background:#08111fcc}` +
    `span{display:block;margin-top:10px;font:500 16px ui-monospace;color:#b7d7ff}</style></head>` +
    `<body><div>Ling real MediaStream performance<span id="tick">frame 0</span></div>` +
    `<script>let tick=0;setInterval(()=>{document.querySelector('#tick').textContent='frame '+(++tick)},50)</script>` +
    `</body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await delay(150);
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  const matches = sources.filter((source) => source.name === targetTitle);
  if (matches.length !== 1) {
    throw new Error(`electron_real_capture_perf_source_ambiguous:${matches.length}`);
  }
  const electronSourceId = matches[0].id;
  const nativeWindowId = parseElectronWindowSourceId(electronSourceId);
  if (!nativeWindowId) {
    throw new Error("electron_real_capture_perf_native_source_id_invalid");
  }
  const descriptorId = `preview_real_capture_perf_descriptor_${process.pid}`;
    return {
      window,
      descriptor: {
        descriptorId,
        revision: 1,
        platform: process.platform === "win32" ? "windows" : "macos",
        sourceKind: "window",
        target: {
          electronSourceId,
          processId: process.pid,
          nativeWindowId,
        },
        authorization: {
          grantId: `preview_real_capture_perf_grant_${process.pid}`,
          expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
        },
      },
    };
  } catch (error) {
    if (!window.isDestroyed()) {
      window.destroy();
    }
    throw error;
  }
}

function createRealCaptureProjection(descriptor) {
  return {
    sessionId: `preview_real_capture_perf_${process.pid}`,
    conversationId: `preview_real_capture_perf_conversation_${process.pid}`,
    runId: `preview_real_capture_perf_run_${process.pid}`,
    workUnitId: `preview_real_capture_perf_work_${process.pid}`,
    status: "running",
    target: {
      kind: "browser",
      displayName: "Real MediaStream performance target",
      applicationId: "com.lingstack.performance-harness",
    },
    preview: {
      descriptorId: descriptor.descriptorId,
      revision: descriptor.revision,
      aspectRatio: 1.6,
      cursorAvailable: true,
    },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function waitForLiveFrame(coordinator, sessionId, revision, label) {
  await waitFor(() => {
    const snapshot = coordinator.getRendererSnapshot();
    return coordinator.getSummary()?.visible === true &&
      snapshot?.sessionId === sessionId &&
      snapshot.sourceRevision === revision &&
      snapshot.frameReady === true &&
      snapshot.sourceStatus === "live";
  }, label);
}

async function waitFor(predicate, label, timeoutMs = lifecycleTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`electron_perf_timeout:${label}`);
    }
    await delay(10);
  }
}

function currentWindow(records, label) {
  const window = records.findLast((record) => !record.window.isDestroyed())?.window;
  if (!window) {
    throw new Error(`electron_perf_window_missing:${label}`);
  }
  return window;
}

function createProjection(cycle) {
  const suffix = cycle < 0 ? "warmup" : String(cycle + 1);
  return {
    sessionId: `preview_electron_perf_${suffix}`,
    conversationId: `preview_electron_perf_conversation_${suffix}`,
    runId: `preview_electron_perf_run_${suffix}`,
    workUnitId: `preview_electron_perf_work_${suffix}`,
    status: "running",
    target: {
      kind: "browser",
      displayName: "Electron performance target",
      applicationId: "com.lingstack.performance-harness",
    },
    preview: {
      descriptorId: `preview_electron_perf_descriptor_${suffix}`,
      revision: 1,
      aspectRatio: 1.6,
      cursorAvailable: true,
    },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

class InstrumentedProjectionClient {
  listeners = new Set();
  sequence = 0;

  constructor(projection) {
    this.projection = projection;
  }

  async list() {
    return [this.projection];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    let closed = false;
    return {
      close: () => {
        if (!closed) {
          closed = true;
          this.listeners.delete(listener);
        }
      },
    };
  }

  emit(projection) {
    this.projection = projection;
    this.sequence += 1;
    for (const listener of this.listeners) {
      listener({
        seq: this.sequence,
        kind: "upsert",
        sessionId: projection.sessionId,
        projection,
        occurredAt: projection.updatedAt,
      });
    }
  }

  async stop(sessionId) {
    const terminalAt = new Date().toISOString();
    const terminal = { ...this.projection, status: "cancelled", updatedAt: terminalAt, terminalAt };
    this.emit(terminal);
    return {
      sessionId,
      accepted: true,
      acknowledged: true,
      auditId: `electron_perf_stop_${sessionId}`,
      projection: terminal,
      acknowledgedAt: terminalAt,
    };
  }
}

class InstrumentedFakeAdapter {
  platform = "fake";
  prepareCount = 0;
  releaseCount = 0;
  disposeCount = 0;
  activeSources = 0;
  maxActiveSources = 0;

  async getPermissionState() {
    return "granted";
  }

  async prepare() {
    this.prepareCount += 1;
    if (this.activeSources !== 0) {
      throw new Error("electron_perf_dual_adapter_source_detected");
    }
    this.activeSources = 1;
    this.maxActiveSources = Math.max(this.maxActiveSources, this.activeSources);
    return { sourceKind: "fake", aspectRatio: 1.6 };
  }

  async release() {
    this.releaseCount += 1;
    this.activeSources = 0;
  }

  async dispose() {
    this.disposeCount += 1;
    this.activeSources = 0;
  }

  async openPermissionSettings() {}
}

class InstrumentedRealAdapter {
  prepareCount = 0;
  releaseCount = 0;
  disposeCount = 0;
  activeSources = 0;
  maxActiveSources = 0;

  constructor(delegate) {
    this.delegate = delegate;
    this.platform = delegate.platform;
  }

  async getPermissionState(input) {
    return this.delegate.getPermissionState(input);
  }

  async prepare(input) {
    const prepared = await this.delegate.prepare(input);
    this.prepareCount += 1;
    this.activeSources = 1;
    this.maxActiveSources = Math.max(this.maxActiveSources, this.activeSources);
    return prepared;
  }

  async release() {
    this.releaseCount += 1;
    try {
      await this.delegate.release();
    } finally {
      this.activeSources = 0;
    }
  }

  async dispose() {
    this.disposeCount += 1;
    try {
      await this.delegate.dispose();
    } finally {
      this.activeSources = 0;
    }
  }

  async openPermissionSettings() {
    await this.delegate.openPermissionSettings();
  }
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

class TrackedTimers {
  pending = new Set();

  set(callback, milliseconds) {
    let timer;
    timer = setTimeout(() => {
      this.pending.delete(timer);
      callback();
    }, milliseconds);
    this.pending.add(timer);
    return timer;
  }

  clear(timer) {
    clearTimeout(timer);
    this.pending.delete(timer);
  }
}

const fakeDaemon = {
  status: { state: "connected", baseUrl: "http://127.0.0.1:0", ownedByDesktop: false },
  async restart() {
    return this.status;
  },
  onStatusChanged() {
    return () => undefined;
  },
};

function toDesktopDisplay(display) {
  return {
    id: String(display.id),
    primary: display.id === screen.getPrimaryDisplay().id,
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height,
    },
  };
}

function rendererProcessCount(metrics) {
  return metrics.filter((metric) => {
    const type = String(metric.type).toLowerCase();
    return type === "tab" || type.includes("renderer");
  }).length;
}

function safeListenerCount(emitter, event) {
  try {
    return typeof emitter?.listenerCount === "function" ? emitter.listenerCount(event) : 0;
  } catch {
    return 0;
  }
}

function environmentSummary() {
  return {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    gcExposed: typeof globalThis.gc === "function",
  };
}

function realCaptureLimitations(realCaptureTracksObserved) {
  return {
    currentHostOnly: true,
    realCaptureTracksObserved,
    signedReleaseEvidence: false,
    artifactClass: "unpackaged Ling code running under the local development Electron runtime",
    reason: "This measures the current host and its current Screen Recording permission only. It does not prove Developer ID signing, notarization, Gatekeeper, a fresh TCC prompt/revocation matrix, packaged-app behavior, or Windows provider performance.",
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "Error", message: String(error) };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function writeResult(value) {
  await new Promise((resolveWrite) => {
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(value)}\n`, resolveWrite);
  });
}
