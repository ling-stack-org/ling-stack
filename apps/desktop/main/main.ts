import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  screen,
  systemPreferences,
  webContents,
  type WebFrameMain,
} from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ComputerUsePreviewCoordinator } from "./computer-use/coordinator.js";
import { DaemonComputerUsePreviewDescriptorResolver } from "./computer-use/daemon-descriptor-resolver.js";
import { DaemonComputerUseProjectionClient } from "./computer-use/daemon-projection-client.js";
import {
  FAKE_COMPUTER_USE_DESCRIPTOR,
  InMemoryComputerUsePreviewDescriptorRegistry,
  type ResolvedComputerUsePreviewDescriptor,
} from "./computer-use/descriptor-registry.js";
import { ElectronComputerUsePreviewPlatformAdapter } from "./computer-use/electron-platform-adapter.js";
import { FakeComputerUsePreviewPlatformAdapter } from "./computer-use/fake-platform-adapter.js";
import {
  FAKE_COMPUTER_USE_PROJECTION,
  FakeComputerUseProjectionClient,
} from "./computer-use/fake-projection-client.js";
import { createComputerUsePreviewWindowFactory } from "./computer-use/window.js";
import { COMPUTER_USE_PREVIEW_SESSION_PARTITION } from "./computer-use/session-partition.js";
import { parseElectronWindowSourceId } from "./computer-use/source-mapping.js";
import { FileComputerUsePreviewTelemetry } from "./computer-use/telemetry.js";
import { DesktopDaemonLifecycle } from "./daemon-lifecycle.js";
import {
  ensureDesktopDaemonWithStartupRecovery,
  type DesktopDaemonStartupRecoveryPrompt,
} from "./daemon-startup-recovery.js";
import { loadOrCreateDesktopBridgeToken } from "./bridge-token.js";
import { registerDesktopIpc } from "./ipc.js";
import { DesktopPreferenceStore } from "./preferences.js";
import { resolveDesktopResourcePaths } from "./resource-paths.js";
import { createMainWindow } from "./window-factory.js";
import type { DesktopDisplayWorkArea, DesktopRect } from "../shared/desktop-capabilities.js";

const daemonBaseUrl = process.env.LING_STACK_DAEMON_URL ?? "http://127.0.0.1:17891";
const execFileAsync = promisify(execFile);
const smokeHeadless = process.argv.includes("--ling-desktop-smoke-headless");
const screenPermissionProbe = process.argv.includes("--ling-desktop-screen-permission-probe");
const fakeComputerUseMode = process.env.LING_DESKTOP_FAKE_COMPUTER_USE === "1" ||
  process.argv.includes("--ling-desktop-fake-computer-use");
const directRealWindowCaptureSmokeMode = process.argv.includes("--ling-desktop-real-capture-smoke");
const directRealDisplayCaptureSmokeMode = process.argv.includes("--ling-desktop-real-display-capture-smoke");
const directRealCaptureSmokeMode = directRealWindowCaptureSmokeMode || directRealDisplayCaptureSmokeMode;
const windowsProviderCaptureRestartSmokeMode = process.argv.includes(
  "--ling-desktop-windows-provider-capture-restart-smoke",
);
const windowsProviderCaptureRestartPhase = process.argv.includes(
  "--ling-desktop-windows-provider-capture-restart-phase",
);
const windowsProviderCaptureSmokeMode = process.argv.includes("--ling-desktop-windows-provider-capture-smoke") ||
  windowsProviderCaptureRestartSmokeMode ||
  windowsProviderCaptureRestartPhase;
const realCaptureSmokeMode = directRealCaptureSmokeMode || windowsProviderCaptureSmokeMode;
const windowsProviderSmokeCommandReader = windowsProviderCaptureSmokeMode
  ? createInterface({ input: process.stdin, crlfDelay: Infinity })
  : undefined;
const windowsProviderSmokeCommandIterator = windowsProviderSmokeCommandReader?.[Symbol.asyncIterator]();
let windowsProviderSmokeRestarting = false;
const fixedComputerUseConversationId = process.argv
  .find((argument) => argument.startsWith("--ling-desktop-computer-use-conversation="))
  ?.slice("--ling-desktop-computer-use-conversation=".length)
  .trim() || undefined;

app.setName("Ling Stack");

if (app.isPackaged && !isLoopbackDaemonUrl(daemonBaseUrl)) {
  throw new Error("packaged_desktop_requires_loopback_daemon");
}

let mainWindow: BrowserWindow | undefined;
const captureSmokeTargetWindows: BrowserWindow[] = [];
let realCaptureSmokeDescriptor: ResolvedComputerUsePreviewDescriptor | undefined;
let realCaptureSmokeDescriptorRegistry: InMemoryComputerUsePreviewDescriptorRegistry | undefined;
let realCaptureSmokeProjectionClient: FakeComputerUseProjectionClient | undefined;
let unregisterIpc: (() => void) | undefined;
let daemon: DesktopDaemonLifecycle | undefined;
let computerUse: ComputerUsePreviewCoordinator | undefined;
let cleanupStarted = false;
let cleanupComplete = false;
const startupLogPath = resolve(app.getPath("userData"), "desktop-startup.log");

logStartup("app.module_loaded", { packaged: app.isPackaged, smokeHeadless });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!mainWindow) {
    void openMainWindow();
  }
});

app.on("before-quit", (event) => {
  if (cleanupComplete) {
    return;
  }
  event.preventDefault();
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  void shutdown().finally(() => {
    cleanupComplete = true;
    app.quit();
  });
});

void app.whenReady()
  .then(async () => {
    logStartup("app.ready", { packaged: app.isPackaged, smokeHeadless });
    if (screenPermissionProbe) {
      const status = process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "unsupported";
      console.log(`Ling Stack Desktop screen permission: ${status}`);
      app.quit();
      return;
    }
    if (realCaptureSmokeMode) {
      realCaptureSmokeDescriptor = await prepareRealCaptureSmokeDescriptor();
    }
    const opened = await openMainWindow();
    if (!opened) {
      return;
    }
    if (smokeHeadless) {
      if (fakeComputerUseMode || realCaptureSmokeMode) {
        await runComputerUseSmoke();
        if (windowsProviderSmokeRestarting) {
          return;
        }
        console.log(
          directRealCaptureSmokeMode
            ? "Ling Stack Desktop direct Electron Computer Use capture lifecycle passed"
            : windowsProviderCaptureSmokeMode
              ? "Ling Stack Desktop Windows provider capture lifecycle passed"
            : "Ling Stack Desktop fake Computer Use lifecycle passed",
        );
      } else {
        console.log("Ling Stack Desktop smoke ready");
      }
      app.quit();
    }
  })
  .catch((error: unknown) => {
    logStartup("app.startup_failed", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    console.error("Ling Stack Desktop startup failed", error);
    app.exit(1);
  });

async function openMainWindow(): Promise<boolean> {
  if (mainWindow) {
    mainWindow.show();
    return true;
  }
  const resources = await resolveDesktopResourcePaths(app);
  logStartup("resources.resolved", {
    webIndexPath: resources.webIndexPath,
    daemonEntryPath: resources.daemonEntryPath,
    previewIndexPath: resources.previewIndexPath,
  });
  if (realCaptureSmokeMode && realCaptureSmokeDescriptor) {
    await verifyRealCaptureRequestProvenance(resources.previewIndexPath, realCaptureSmokeDescriptor);
  }
  const defaultWorkspaceCwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD ?? (
    app.isPackaged ? resolve(app.getPath("userData"), "workspace") : resolve(app.getAppPath(), "../..")
  );
  const bridgeToken = await loadOrCreateDesktopBridgeToken(resolve(app.getPath("userData"), "desktop-bridge-token"));
  daemon ??= new DesktopDaemonLifecycle({
    baseUrl: daemonBaseUrl,
    daemonEntryPath: resources.daemonEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: bridgeToken,
    onDiagnostic: logStartup,
  });
  const daemonStartup = await ensureDesktopDaemonWithStartupRecovery({
    daemon,
    allowInteractiveRecovery: !smokeHeadless,
    prompt: promptForIncompatibleDaemon,
  });
  if (daemonStartup === "quit") {
    logStartup("daemon.recovery_quit", { baseUrl: daemonBaseUrl });
    app.quit();
    return false;
  }
  logStartup("daemon.connected", { ownedByDesktop: daemon.status.ownedByDesktop });
  if (!computerUse) {
    const descriptorRegistry = new InMemoryComputerUsePreviewDescriptorRegistry();
    if (fakeComputerUseMode) {
      descriptorRegistry.register(FAKE_COMPUTER_USE_DESCRIPTOR);
    } else if (realCaptureSmokeDescriptor) {
      descriptorRegistry.register(realCaptureSmokeDescriptor);
      realCaptureSmokeDescriptorRegistry = descriptorRegistry;
    }
    const descriptorResolver = fakeComputerUseMode || realCaptureSmokeMode
      ? descriptorRegistry
      : new DaemonComputerUsePreviewDescriptorResolver(
          daemonBaseUrl,
          defaultWorkspaceCwd,
          bridgeToken,
          (descriptorId) => computerUse?.sessionIdForDescriptor(descriptorId),
        );
    const smokeProjection = (windowsProviderCaptureRestartSmokeMode || windowsProviderCaptureRestartPhase) && realCaptureSmokeDescriptor
      ? {
          ...FAKE_COMPUTER_USE_PROJECTION,
          preview: {
            ...FAKE_COMPUTER_USE_PROJECTION.preview!,
            revision: realCaptureSmokeDescriptor.revision,
          },
        }
      : FAKE_COMPUTER_USE_PROJECTION;
    const projectionClient = fakeComputerUseMode || realCaptureSmokeMode
      ? new FakeComputerUseProjectionClient(smokeProjection)
      : new DaemonComputerUseProjectionClient(defaultWorkspaceCwd, daemonBaseUrl, undefined, undefined, bridgeToken);
    if (realCaptureSmokeMode && projectionClient instanceof FakeComputerUseProjectionClient) {
      realCaptureSmokeProjectionClient = projectionClient;
    }
    computerUse = new ComputerUsePreviewCoordinator({
      projectionClient,
      platformAdapter: fakeComputerUseMode
        ? new FakeComputerUsePreviewPlatformAdapter()
        : new ElectronComputerUsePreviewPlatformAdapter(descriptorResolver, {
            expectedFrameUrl: pathToFileURL(resources.previewIndexPath).href,
            onDiagnostic: logStartup,
          }),
      preferenceStore: new DesktopPreferenceStore(resolve(app.getPath("userData"), "desktop-preferences.json")),
      telemetry: new FileComputerUsePreviewTelemetry(
        resolve(app.getPath("userData"), "computer-use-preview-telemetry.jsonl"),
      ),
      previewIndexPath: resources.previewIndexPath,
      createWindow: createComputerUsePreviewWindowFactory(),
      getDisplays: () => screen.getAllDisplays().map(toDesktopDisplay),
      getDisplayMatching: (bounds?: DesktopRect) => {
        const matchingBounds = bounds ?? mainWindow?.getBounds();
        return toDesktopDisplay(matchingBounds ? screen.getDisplayMatching(matchingBounds) : screen.getPrimaryDisplay());
      },
      onDisplaysChanged: (listener) => {
        screen.on("display-added", listener);
        screen.on("display-removed", listener);
        screen.on("display-metrics-changed", listener);
        return () => {
          screen.off("display-added", listener);
          screen.off("display-removed", listener);
          screen.off("display-metrics-changed", listener);
        };
      },
      openOwnerConversation: async () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    });
    await computerUse.start();
    logStartup("computer_use.started", { fakeMode: fakeComputerUseMode, realCaptureSmokeMode });
    computerUse.onSummaryChanged((summary) => {
      mainWindow?.webContents.send("ling-desktop:computer-use:summary-changed", summary);
    });
  }
  unregisterIpc ??= registerDesktopIpc({
    daemon,
    computerUse,
    getMainWindow: () => mainWindow,
    ...(fakeComputerUseMode || realCaptureSmokeMode || fixedComputerUseConversationId
      ? { fixedComputerUseConversationId: fixedComputerUseConversationId ?? FAKE_COMPUTER_USE_PROJECTION.conversationId }
      : {}),
  });
  mainWindow = await createMainWindow({
    daemonBaseUrl,
    webIndexPath: resources.webIndexPath,
    showWhenReady: !smokeHeadless,
  });
  logStartup("main_window.loaded");
  if (fakeComputerUseMode || realCaptureSmokeMode || fixedComputerUseConversationId) {
    computerUse.reportSelectedConversation(fixedComputerUseConversationId ?? FAKE_COMPUTER_USE_PROJECTION.conversationId);
  }
  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });
  return true;
}

async function promptForIncompatibleDaemon(
  input: DesktopDaemonStartupRecoveryPrompt,
): Promise<"retry" | "quit"> {
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  const result = await dialog.showMessageBox({
    type: "warning",
    title: chinese ? "需要更新 Ling 本地服务" : "Ling local service needs an update",
    message: chinese
      ? "另一个 Ling daemon 正在使用本地端口，但与当前 Desktop 不兼容。"
      : "Another Ling daemon is using the local port, but it is incompatible with this Desktop build.",
    detail: chinese
      ? `Ling 不会自动终止不属于 Desktop 的服务。请先保存其中正在运行的任务，退出或更新 ${input.baseUrl} 上的 daemon，然后点击“重试”。`
      : `Ling will not terminate a service it did not start. Save any active work, stop or update the daemon at ${input.baseUrl}, then choose Retry.`,
    buttons: chinese ? ["重试", "退出"] : ["Retry", "Quit"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  const decision = result.response === 0 ? "retry" : "quit";
  logStartup("daemon.recovery_decision", {
    baseUrl: input.baseUrl,
    reason: input.reason,
    decision,
  });
  return decision;
}

function toDesktopDisplay(display: Electron.Display): DesktopDisplayWorkArea {
  return {
    id: String(display.id),
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height,
    },
    primary: display.id === screen.getPrimaryDisplay().id,
  };
}

function logStartup(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  try {
    mkdirSync(dirname(startupLogPath), { recursive: true });
    appendFileSync(startupLogPath, `${JSON.stringify({ ts: new Date().toISOString(), event, ...details })}\n`, "utf8");
  } catch {
    // Startup logging must never become a second startup failure.
  }
}

function isLoopbackDaemonUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function readSafePositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffff_ffff
    ? value as number
    : undefined;
}

function readSafeNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function readCanonicalNativeWindowId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= 0xffff_ffff_ffff_ffffn ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runComputerUseSmoke(): Promise<void> {
  const coordinator = computerUse;
  if (!coordinator) {
    throw new Error("desktop_preview_smoke_coordinator_missing");
  }
  await waitForSmokeCondition(
    () => coordinator.getSummary()?.visible === true,
    "desktop_preview_smoke_first_frame_timeout",
  );
  const sessionId = coordinator.getSummary()?.sessionId;
  if (!sessionId) {
    throw new Error("desktop_preview_smoke_session_missing");
  }
  const initialPreviewWebContentsId = coordinator.getPreviewWebContentsId();
  if (initialPreviewWebContentsId === undefined) {
    throw new Error("desktop_preview_smoke_renderer_missing");
  }
  if (realCaptureSmokeMode) {
    await assertSmokeRendererMediaState(initialPreviewWebContentsId, "live");
  }
  const hidden = await coordinator.hide(sessionId);
  if (!hidden.accepted) {
    throw new Error(hidden.reason ?? "desktop_preview_smoke_hide_failed");
  }
  await waitForSmokeCondition(
    () => coordinator.getSummary()?.visible === false,
    "desktop_preview_smoke_hide_timeout",
  );
  if (coordinator.getPreviewWebContentsId() !== initialPreviewWebContentsId) {
    throw new Error("desktop_preview_smoke_release_ack_forced_renderer_teardown");
  }
  if (realCaptureSmokeMode) {
    await assertSmokeRendererMediaState(initialPreviewWebContentsId, "released");
  }
  const shown = await coordinator.show(sessionId);
  if (!shown.accepted) {
    throw new Error(shown.reason ?? "desktop_preview_smoke_show_failed");
  }
  await waitForSmokeCondition(
    () => coordinator.getSummary()?.visible === true,
    "desktop_preview_smoke_reopen_timeout",
  );
  if (coordinator.getPreviewWebContentsId() !== initialPreviewWebContentsId) {
    throw new Error("desktop_preview_smoke_show_did_not_reuse_acknowledged_renderer");
  }
  if (realCaptureSmokeMode) {
    await assertSmokeRendererMediaState(initialPreviewWebContentsId, "live");
  }
  if (directRealCaptureSmokeMode) {
    await exerciseSmokeHostWindowFocusLifecycle(coordinator, initialPreviewWebContentsId);
  }
  if (fakeComputerUseMode || directRealCaptureSmokeMode) {
    await exerciseSmokeRendererCrash(coordinator, sessionId, directRealCaptureSmokeMode);
  }
  if (directRealWindowCaptureSmokeMode) {
    await exerciseRealCaptureRevisionAndSourceEnd(coordinator);
  } else if (windowsProviderCaptureRestartPhase) {
    await exerciseWindowsProviderRestartRecovery(coordinator);
    return;
  } else if (windowsProviderCaptureSmokeMode) {
    await exerciseWindowsProviderRevisionAndTargetClose(coordinator);
    return;
  }
  const stopped = await coordinator.stop(sessionId);
  if (!stopped.accepted) {
    throw new Error(stopped.reason ?? "desktop_preview_smoke_stop_failed");
  }
  await waitForSmokeCondition(
    () => coordinator.getSummary() === undefined,
    "desktop_preview_smoke_terminal_close_timeout",
  );
}

async function exerciseSmokeHostWindowFocusLifecycle(
  coordinator: ComputerUsePreviewCoordinator,
  previewWebContentsId: number,
): Promise<void> {
  const owner = mainWindow;
  if (!owner || owner.isDestroyed()) {
    throw new Error("desktop_real_capture_smoke_main_window_missing");
  }
  owner.show();
  owner.focus();
  owner.blur();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  if (coordinator.getSummary()?.visible !== true || coordinator.getPreviewWebContentsId() !== previewWebContentsId) {
    throw new Error("desktop_real_capture_smoke_app_blur_hid_preview");
  }
  await assertSmokeRendererMediaState(previewWebContentsId, "live");
  owner.minimize();
  await waitForSmokeCondition(() => owner.isMinimized(), "desktop_real_capture_smoke_main_minimize_timeout");
  if (coordinator.getSummary()?.visible !== true || coordinator.getPreviewWebContentsId() !== previewWebContentsId) {
    throw new Error("desktop_real_capture_smoke_main_minimize_hid_preview");
  }
  await assertSmokeRendererMediaState(previewWebContentsId, "live");
  owner.restore();
  owner.hide();
}

async function exerciseSmokeRendererCrash(
  coordinator: ComputerUsePreviewCoordinator,
  sessionId: string,
  expectLiveMedia: boolean,
): Promise<void> {
  const previousWebContentsId = coordinator.getPreviewWebContentsId();
  const previousRenderer = previousWebContentsId === undefined
    ? undefined
    : webContents.fromId(previousWebContentsId);
  if (!previousRenderer || previousRenderer.isDestroyed() || typeof previousRenderer.forcefullyCrashRenderer !== "function") {
    throw new Error("desktop_preview_smoke_renderer_crash_unavailable");
  }
  previousRenderer.forcefullyCrashRenderer();
  await waitForSmokeCondition(() => {
    const nextWebContentsId = coordinator.getPreviewWebContentsId();
    const snapshot = coordinator.getRendererSnapshot();
    return nextWebContentsId !== undefined &&
      nextWebContentsId !== previousWebContentsId &&
      coordinator.getSummary()?.sessionId === sessionId &&
      coordinator.getSummary()?.visible === true &&
      snapshot?.sessionId === sessionId &&
      snapshot.frameReady &&
      snapshot.sourceStatus === "live";
  }, "desktop_preview_smoke_renderer_crash_recovery_timeout");
  if (expectLiveMedia) {
    const nextWebContentsId = coordinator.getPreviewWebContentsId();
    if (nextWebContentsId === undefined) {
      throw new Error("desktop_preview_smoke_renderer_crash_recovery_missing");
    }
    await assertSmokeRendererMediaState(nextWebContentsId, "live");
  }
}

async function assertSmokeRendererMediaState(
  webContentsId: number,
  expected: "live" | "released",
): Promise<void> {
  const renderer = webContents.fromId(webContentsId);
  if (!renderer || renderer.isDestroyed()) {
    throw new Error("desktop_real_capture_smoke_renderer_unavailable");
  }
  const state: unknown = await renderer.executeJavaScript(`(() => {
    const video = document.querySelector('.preview-video');
    const stream = video && video.srcObject instanceof MediaStream ? video.srcObject : undefined;
    const tracks = stream ? stream.getTracks() : [];
    return {
      videoPresent: Boolean(video),
      trackCount: tracks.length,
      liveTrackCount: tracks.filter((track) => track.readyState === 'live').length,
      endedTrackCount: tracks.filter((track) => track.readyState === 'ended').length,
    };
  })()`);
  if (!isRecord(state)) {
    throw new Error("desktop_real_capture_smoke_media_state_invalid");
  }
  const trackCount = readSafeNonNegativeInteger(state.trackCount);
  const liveTrackCount = readSafeNonNegativeInteger(state.liveTrackCount);
  if (trackCount === undefined || liveTrackCount === undefined) {
    throw new Error("desktop_real_capture_smoke_media_state_invalid");
  }
  if (expected === "live" ? trackCount < 1 || liveTrackCount < 1 : liveTrackCount !== 0) {
    throw new Error(`desktop_real_capture_smoke_media_${expected}_mismatch`);
  }
}

async function prepareRealCaptureSmokeDescriptor(): Promise<ResolvedComputerUsePreviewDescriptor> {
  if (windowsProviderCaptureSmokeMode) {
    return createWindowsProviderSmokeDescriptor();
  }
  return createRealCaptureSmokeDescriptor(FAKE_COMPUTER_USE_PROJECTION.preview?.revision ?? 1);
}

function createWindowsProviderSmokeDescriptor(): ResolvedComputerUsePreviewDescriptor {
  if (process.platform !== "win32") {
    throw new Error("desktop_windows_provider_smoke_platform_unsupported");
  }
  const preview = FAKE_COMPUTER_USE_PROJECTION.preview;
  if (!preview) {
    throw new Error("desktop_windows_provider_smoke_preview_missing");
  }
  const raw = process.env.LING_DESKTOP_WINDOWS_PROVIDER_DESCRIPTOR?.trim();
  if (!raw) {
    throw new Error("desktop_windows_provider_smoke_descriptor_missing");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("desktop_windows_provider_smoke_descriptor_invalid");
  }
  const requestedRevision = readSafePositiveInteger(value && isRecord(value) ? value.revision : undefined);
  return createWindowsProviderSmokeDescriptorForRevision(value, requestedRevision ?? preview.revision ?? 1);
}

function createWindowsProviderSmokeDescriptorForRevision(
  value: unknown,
  revision: number,
): ResolvedComputerUsePreviewDescriptor {
  const preview = FAKE_COMPUTER_USE_PROJECTION.preview;
  if (!preview) {
    throw new Error("desktop_windows_provider_smoke_preview_missing");
  }
  if (!isRecord(value)) {
    throw new Error("desktop_windows_provider_smoke_descriptor_invalid");
  }
  const processId = readSafePositiveInteger(value.processId);
  const nativeWindowId = readCanonicalNativeWindowId(value.nativeWindowId);
  if (processId === undefined || nativeWindowId === undefined) {
    throw new Error("desktop_windows_provider_smoke_descriptor_identity_invalid");
  }
  return {
    descriptorId: preview.descriptorId,
    revision,
    platform: "windows",
    sourceKind: "window",
    target: { processId, nativeWindowId },
    authorization: {
      grantId: `desktop_windows_provider_smoke_grant_${revision}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    },
  };
}

async function verifyRealCaptureRequestProvenance(
  previewIndexPath: string,
  descriptor: ResolvedComputerUsePreviewDescriptor,
): Promise<void> {
  const descriptorRegistry = new InMemoryComputerUsePreviewDescriptorRegistry();
  descriptorRegistry.register(descriptor);
  const expectedFrameUrl = pathToFileURL(previewIndexPath).href;
  const adapter = new ElectronComputerUsePreviewPlatformAdapter(descriptorRegistry, {
    expectedFrameUrl,
    onDiagnostic: logStartup,
  });
  const createProbeWindow = (partition = COMPUTER_USE_PREVIEW_SESSION_PARTITION): BrowserWindow => new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      partition,
    },
  });
  const authorized = createProbeWindow();
  const foreign = createProbeWindow();
  const wrongUrl = createProbeWindow();
  const wrongPartition = createProbeWindow("ling-computer-use-provenance-wrong-partition");
  const prepareAuthorized = async (
    candidate: ResolvedComputerUsePreviewDescriptor = descriptor,
  ): Promise<void> => {
    await adapter.prepare({
      sessionId: "desktop_real_capture_provenance_smoke",
      descriptorId: candidate.descriptorId,
      revision: candidate.revision,
      requesterWebContentsId: authorized.webContents.id,
      maxFrameRate: 30,
      maxSize: { width: 960, height: 600 },
    });
  };
  const verifyDeniedThenAuthorized = async (
    label: string,
    requestDeniedProbe: () => Promise<"granted" | "denied">,
  ): Promise<void> => {
    await prepareAuthorized();
    await expectProbeDisplayMediaResult(requestDeniedProbe(), "denied", `${label}_granted`);
    await expectProbeDisplayMediaResult(
      requestProbeDisplayMedia(authorized),
      "granted",
      `${label}_consumed_grant`,
    );
    await expectProbeDisplayMediaResult(
      requestProbeDisplayMedia(authorized),
      "denied",
      `${label}_replay_granted`,
    );
  };
  try {
    await Promise.all([
      authorized.loadFile(previewIndexPath),
      foreign.loadFile(previewIndexPath),
      wrongUrl.loadURL(`${expectedFrameUrl}?unexpected=1`),
      wrongPartition.loadFile(previewIndexPath),
    ]);
    await expectProbePrepareFailure(
      () => adapter.prepare({
        sessionId: "desktop_real_capture_provenance_wrong_url",
        descriptorId: descriptor.descriptorId,
        revision: descriptor.revision,
        requesterWebContentsId: wrongUrl.webContents.id,
        maxFrameRate: 30,
        maxSize: { width: 960, height: 600 },
      }),
      "desktop_real_capture_smoke_wrong_url_prepare_granted",
    );
    await expectProbePrepareFailure(
      () => adapter.prepare({
        sessionId: "desktop_real_capture_provenance_wrong_partition",
        descriptorId: descriptor.descriptorId,
        revision: descriptor.revision,
        requesterWebContentsId: wrongPartition.webContents.id,
        maxFrameRate: 30,
        maxSize: { width: 960, height: 600 },
      }),
      "desktop_real_capture_smoke_wrong_partition_prepare_granted",
    );

    await verifyDeniedThenAuthorized(
      "desktop_real_capture_smoke_foreign_renderer",
      () => requestProbeDisplayMedia(foreign),
    );
    await verifyDeniedThenAuthorized(
      "desktop_real_capture_smoke_audio_request",
      () => requestProbeDisplayMedia(authorized, true),
    );

    const subframe = await createProbeSubframe(authorized);
    if (subframe) {
      await verifyDeniedThenAuthorized(
        "desktop_real_capture_smoke_subframe",
        () => requestProbeDisplayMediaFrame(subframe),
      );
    } else {
      logStartup("computer_use.capture_provenance_subframe_blocked_by_csp");
    }

    await prepareAuthorized();
    await authorized.loadFile(previewIndexPath);
    await expectProbeDisplayMediaResult(
      requestProbeDisplayMedia(authorized),
      "denied",
      "desktop_real_capture_smoke_navigation_reused_grant",
    );

    await prepareAuthorized();
    await adapter.release();
    await expectProbeDisplayMediaResult(
      requestProbeDisplayMedia(authorized),
      "denied",
      "desktop_real_capture_smoke_release_reused_grant",
    );

    const expiringDescriptor: ResolvedComputerUsePreviewDescriptor = {
      ...descriptor,
      descriptorId: `${descriptor.descriptorId}_expiring`,
      authorization: {
        grantId: `${descriptor.authorization.grantId}_expiring`,
        expiresAt: new Date(Date.now() + 500).toISOString(),
      },
    };
    descriptorRegistry.register(expiringDescriptor);
    await prepareAuthorized(expiringDescriptor);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 650));
    await expectProbeDisplayMediaResult(
      requestProbeDisplayMedia(authorized),
      "denied",
      "desktop_real_capture_smoke_expired_grant_reused",
    );

    await prepareAuthorized();
    await expectProbeDisplayMediaResult(
      requestProbeDisplayMedia(authorized),
      "granted",
      "desktop_real_capture_smoke_final_authorized_denied",
    );
    await expectProbeDisplayMediaResult(
      requestProbeDisplayMedia(authorized),
      "denied",
      "desktop_real_capture_smoke_final_grant_replayed",
    );
    logStartup("computer_use.capture_provenance_smoke_passed");
  } finally {
    await adapter.dispose().catch(() => undefined);
    if (!authorized.isDestroyed()) {
      authorized.destroy();
    }
    if (!foreign.isDestroyed()) {
      foreign.destroy();
    }
    if (!wrongUrl.isDestroyed()) {
      wrongUrl.destroy();
    }
    if (!wrongPartition.isDestroyed()) {
      wrongPartition.destroy();
    }
  }
}

async function requestProbeDisplayMedia(
  window: BrowserWindow,
  requestAudio = false,
): Promise<"granted" | "denied"> {
  return requestProbeDisplayMediaTarget(window.webContents, requestAudio);
}

async function requestProbeDisplayMediaFrame(frame: WebFrameMain): Promise<"granted" | "denied"> {
  return requestProbeDisplayMediaTarget(frame, false);
}

async function requestProbeDisplayMediaTarget(
  target: Pick<WebFrameMain, "executeJavaScript">,
  requestAudio: boolean,
): Promise<"granted" | "denied"> {
  return target.executeJavaScript(`(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: ${requestAudio ? "true" : "false"},
      });
      stream.getTracks().forEach((track) => track.stop());
      return "granted";
    } catch {
      return "denied";
    }
  })()`) as Promise<"granted" | "denied">;
}

async function createProbeSubframe(window: BrowserWindow): Promise<WebFrameMain | undefined> {
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.src = "about:blank";
    iframe.addEventListener("load", () => resolve(true), { once: true });
    iframe.addEventListener("error", () => resolve(false), { once: true });
    document.body.append(iframe);
    setTimeout(() => resolve(false), 250);
  })`);
  return window.webContents.mainFrame.frames.find((frame) => !frame.isDestroyed() && !frame.detached);
}

async function expectProbeDisplayMediaResult(
  resultPromise: Promise<"granted" | "denied">,
  expected: "granted" | "denied",
  errorCode: string,
): Promise<void> {
  if (await resultPromise !== expected) {
    throw new Error(errorCode);
  }
}

async function expectProbePrepareFailure(
  prepare: () => Promise<unknown>,
  errorCode: string,
): Promise<void> {
  let rejected = false;
  try {
    await prepare();
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(errorCode);
  }
}

async function createRealCaptureSmokeDescriptor(revision: number): Promise<ResolvedComputerUsePreviewDescriptor> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("desktop_real_capture_smoke_platform_unsupported");
  }
  const preview = FAKE_COMPUTER_USE_PROJECTION.preview;
  if (!preview) {
    throw new Error("desktop_real_capture_smoke_preview_missing");
  }
  if (directRealDisplayCaptureSmokeMode) {
    const primaryDisplayId = String(screen.getPrimaryDisplay().id);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    const matches = sources.filter((source) => source.display_id === primaryDisplayId);
    if (matches.length !== 1) {
      throw new Error(`desktop_real_display_capture_smoke_source_ambiguous:${matches.length}`);
    }
    return {
      descriptorId: preview.descriptorId,
      revision,
      platform: process.platform === "win32" ? "windows" : "macos",
      sourceKind: "display",
      target: { electronSourceId: matches[0].id },
      authorization: {
        grantId: `desktop_real_display_capture_smoke_grant_${revision}`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      },
    };
  }
  const targetTitle = `Ling Computer Use Capture Smoke ${process.pid} r${revision}`;
  const target = new BrowserWindow({
    width: 640,
    height: 400,
    show: true,
    title: targetTitle,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  captureSmokeTargetWindows.push(target);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${targetTitle}</title>` +
    `<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;color:#eef6ff;` +
    `font:600 32px system-ui;background:linear-gradient(135deg,#12233c,#274f88)}div{padding:28px 36px;` +
    `border:1px solid #ffffff55;border-radius:18px;background:#08111fcc}</style></head>` +
    `<body><div>Ling real capture smoke</div></body></html>`;
  await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  const matches = sources.filter((source) => source.name === targetTitle);
  if (matches.length !== 1) {
    throw new Error(`desktop_real_capture_smoke_source_ambiguous:${matches.length}`);
  }
  const electronSourceId = matches[0].id;
  const nativeWindowId = parseElectronWindowSourceId(electronSourceId);
  if (process.platform === "win32" && !nativeWindowId) {
    throw new Error("desktop_real_capture_smoke_windows_source_id_invalid");
  }
  const cuaNativeIdentity = process.platform === "darwin" &&
      process.env.LING_DESKTOP_CUA_NATIVE_HANDOFF_SMOKE === "1"
    ? await resolveCuaNativeWindowIdentity(process.pid, electronSourceId)
    : undefined;
  return {
    descriptorId: preview.descriptorId,
    revision,
    platform: process.platform === "win32" ? "windows" : "macos",
    sourceKind: "window",
    target: cuaNativeIdentity ?? {
      electronSourceId,
      ...(process.platform === "win32"
        ? { processId: process.pid, nativeWindowId: nativeWindowId as string }
        : {}),
    },
    authorization: {
      grantId: `desktop_real_capture_smoke_grant_${revision}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    },
  };
}

async function resolveCuaNativeWindowIdentity(
  targetPid: number,
  electronSourceId: string,
): Promise<{ readonly processId: number; readonly nativeWindowId: string }> {
  const expectedWindowId = parseElectronWindowSourceId(electronSourceId);
  if (!expectedWindowId) {
    throw new Error("desktop_real_capture_smoke_cua_electron_source_id_invalid");
  }
  const command = process.env.LING_CUA_DRIVER_COMMAND?.trim() || "cua-driver";
  const { stdout } = await execFileAsync(
    command,
    ["call", "list_windows", "{}", "--compact"],
    { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed: unknown = JSON.parse(stdout);
  const windows = isRecord(parsed) && Array.isArray(parsed.windows) ? parsed.windows : undefined;
  if (!windows) {
    throw new Error("desktop_real_capture_smoke_cua_windows_invalid");
  }
  const matches = windows.filter((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }
    return readCuaNativeWindowId(candidate.window_id) === expectedWindowId;
  });
  if (matches.length !== 1) {
    const smokeCandidates = windows.flatMap((candidate) => {
      if (!isRecord(candidate) ||
          typeof candidate.title !== "string" ||
          !candidate.title.startsWith("Ling Computer Use Capture Smoke")) {
        return [];
      }
      return [{
        pid: readSafePositiveInteger(candidate.pid),
        windowId: readCuaNativeWindowId(candidate.window_id),
      }];
    });
    throw new Error(
      `desktop_real_capture_smoke_cua_window_ambiguous:${matches.length}:` +
      `${expectedWindowId}:${JSON.stringify(smokeCandidates)}`,
    );
  }
  const providerPid = readSafePositiveInteger((matches[0] as Record<string, unknown>).pid);
  if (providerPid === undefined) {
    throw new Error("desktop_real_capture_smoke_cua_window_pid_invalid");
  }
  logStartup("computer_use.cua_native_window_handoff_verified", {
    provider: "cua-driver",
    matchCount: matches.length,
    ownerMatchesMainProcess: providerPid === targetPid,
  });
  return { processId: providerPid, nativeWindowId: expectedWindowId };
}

function readCuaNativeWindowId(value: unknown): string | undefined {
  const numeric = readSafePositiveInteger(value);
  return numeric !== undefined ? String(numeric) : readCanonicalNativeWindowId(value);
}

async function exerciseRealCaptureRevisionAndSourceEnd(
  coordinator: ComputerUsePreviewCoordinator,
): Promise<void> {
  const registry = realCaptureSmokeDescriptorRegistry;
  const projectionClient = realCaptureSmokeProjectionClient;
  const previousTarget = captureSmokeTargetWindows.at(-1);
  if (!registry || !projectionClient || !previousTarget) {
    throw new Error("desktop_real_capture_smoke_revision_fixture_missing");
  }
  const replacementRevision = (FAKE_COMPUTER_USE_PROJECTION.preview?.revision ?? 1) + 1;
  const replacement = await createRealCaptureSmokeDescriptor(replacementRevision);
  registry.register(replacement);
  projectionClient.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: {
      ...FAKE_COMPUTER_USE_PROJECTION.preview!,
      revision: replacementRevision,
    },
    updatedAt: new Date().toISOString(),
  });
  await waitForSmokeCondition(
    () => {
      const snapshot = coordinator.getRendererSnapshot();
      return snapshot?.sourceRevision === replacementRevision && snapshot.frameReady && snapshot.sourceStatus === "live";
    },
    "desktop_real_capture_smoke_revision_timeout",
  );

  previousTarget.destroy();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
  const afterOldTargetClose = coordinator.getRendererSnapshot();
  if (afterOldTargetClose?.sourceRevision !== replacementRevision || afterOldTargetClose.sourceStatus !== "live") {
    throw new Error("desktop_real_capture_smoke_stale_source_end_regression");
  }

  const activeTarget = captureSmokeTargetWindows.at(-1);
  activeTarget?.destroy();
  await waitForSmokeCondition(
    () => coordinator.getRendererSnapshot()?.sourceStatus === "stalled",
    "desktop_real_capture_smoke_source_end_timeout",
  );
  if (coordinator.getSummary()?.status !== "running") {
    throw new Error("desktop_real_capture_smoke_source_end_stopped_runtime");
  }
}

async function exerciseWindowsProviderRevisionAndTargetClose(
  coordinator: ComputerUsePreviewCoordinator,
): Promise<void> {
  const registry = realCaptureSmokeDescriptorRegistry;
  const projectionClient = realCaptureSmokeProjectionClient;
  if (!registry || !projectionClient) {
    throw new Error("desktop_windows_provider_smoke_revision_fixture_missing");
  }
  const initialRevision = FAKE_COMPUTER_USE_PROJECTION.preview?.revision ?? 1;
  assertWindowsProviderSmokeSourceLive(coordinator, initialRevision, "descriptor_a_not_live");
  console.log("Ling Stack Desktop Windows provider descriptor A live");

  const replaceCommand = await readWindowsProviderSmokeCommand("replace_descriptor", 30_000);
  const replacementRevision = initialRevision + 1;
  const replacement = createWindowsProviderSmokeDescriptorForRevision(
    replaceCommand.descriptor,
    replacementRevision,
  );
  registry.register(replacement);
  projectionClient.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: {
      ...FAKE_COMPUTER_USE_PROJECTION.preview!,
      revision: replacementRevision,
    },
    updatedAt: new Date().toISOString(),
  });
  await waitForSmokeCondition(
    () => {
      const snapshot = coordinator.getRendererSnapshot();
      return snapshot?.sourceRevision === replacementRevision && snapshot.frameReady && snapshot.sourceStatus === "live";
    },
    "desktop_windows_provider_smoke_revision_timeout",
    15_000,
  );
  console.log("Ling Stack Desktop Windows provider descriptor B live");

  await readWindowsProviderSmokeCommand("old_target_closed", 30_000);
  assertWindowsProviderSmokeSourceLive(coordinator, replacementRevision, "stale_source_end_regression");
  console.log("Ling Stack Desktop Windows provider old target close isolated");

  if (windowsProviderCaptureRestartSmokeMode) {
    await readWindowsProviderSmokeCommand("restart_desktop", 30_000);
    windowsProviderSmokeRestarting = true;
    console.log("Ling Stack Desktop Windows provider restart requested");
    app.quit();
    return;
  }

  // The external runner owns target B. It closes the real window only after
  // this marker, so the observed stalled state is tied to a specific ACKed
  // target transition instead of a timing delay.
  console.log("Ling Stack Desktop Windows provider current target close requested");
  await waitForSmokeCondition(
    () => coordinator.getRendererSnapshot()?.sourceStatus === "stalled",
    "desktop_windows_provider_smoke_source_end_timeout",
    15_000,
  );
  if (coordinator.getSummary()?.status !== "running") {
    throw new Error("desktop_windows_provider_smoke_source_end_stopped_runtime");
  }
  console.log("Ling Stack Desktop Windows provider stalled runtime still running");
}

async function exerciseWindowsProviderRestartRecovery(
  coordinator: ComputerUsePreviewCoordinator,
): Promise<void> {
  const expectedRevision = realCaptureSmokeDescriptor?.revision;
  if (!expectedRevision) {
    throw new Error("desktop_windows_provider_smoke_restart_revision_missing");
  }
  assertWindowsProviderSmokeSourceLive(coordinator, expectedRevision, "restart_descriptor_not_live");
  console.log("Ling Stack Desktop Windows provider descriptor replay live");
  console.log("Ling Stack Desktop Windows provider current target close requested");
  await waitForSmokeCondition(
    () => coordinator.getRendererSnapshot()?.sourceStatus === "stalled",
    "desktop_windows_provider_smoke_restart_source_end_timeout",
    15_000,
  );
  if (coordinator.getSummary()?.status !== "running") {
    throw new Error("desktop_windows_provider_smoke_restart_stopped_runtime");
  }
  console.log("Ling Stack Desktop Windows provider stalled runtime still running");
}

function assertWindowsProviderSmokeSourceLive(
  coordinator: ComputerUsePreviewCoordinator,
  expectedRevision: number,
  reason: string,
): void {
  const snapshot = coordinator.getRendererSnapshot();
  if (
    snapshot?.sourceRevision !== expectedRevision
    || !snapshot.frameReady
    || snapshot.sourceStatus !== "live"
  ) {
    throw new Error(`desktop_windows_provider_smoke_${reason}`);
  }
}

type WindowsProviderSmokeCommand =
  | { readonly type: "replace_descriptor"; readonly descriptor: unknown }
  | { readonly type: "old_target_closed" }
  | { readonly type: "restart_desktop" };

async function readWindowsProviderSmokeCommand<T extends WindowsProviderSmokeCommand["type"]>(
  expectedType: T,
  timeoutMs: number,
): Promise<Extract<WindowsProviderSmokeCommand, { readonly type: T }>> {
  const iterator = windowsProviderSmokeCommandIterator;
  if (!iterator) {
    throw new Error("desktop_windows_provider_smoke_command_channel_missing");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`desktop_windows_provider_smoke_command_timeout:${expectedType}`)),
          timeoutMs,
        );
      }),
    ]);
    if (next.done) {
      throw new Error(`desktop_windows_provider_smoke_command_channel_closed:${expectedType}`);
    }
    let command: unknown;
    try {
      command = JSON.parse(next.value);
    } catch {
      throw new Error("desktop_windows_provider_smoke_command_invalid");
    }
    if (!isRecord(command) || command.type !== expectedType) {
      throw new Error(`desktop_windows_provider_smoke_command_unexpected:${String(isRecord(command) ? command.type : "invalid")}`);
    }
    if (expectedType === "replace_descriptor" && !("descriptor" in command)) {
      throw new Error("desktop_windows_provider_smoke_command_descriptor_missing");
    }
    return command as Extract<WindowsProviderSmokeCommand, { readonly type: T }>;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitForSmokeCondition(
  predicate: () => boolean,
  timeoutError: string,
  timeoutMs?: number,
): Promise<void> {
  const deadline = Date.now() + (
    timeoutMs ?? (process.arch === "x64" && process.platform === "darwin" ? 15_000 : 5_000)
  );
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(timeoutError);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function shutdown(): Promise<void> {
  let firstCleanupError: unknown;
  let cleanupFailed = false;
  const attemptCleanup = async (cleanup: () => void | Promise<void>): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      if (!cleanupFailed) {
        cleanupFailed = true;
        firstCleanupError = error;
      }
    }
  };

  let mainSession: Electron.Session | undefined;
  await attemptCleanup(() => {
    mainSession = mainWindow?.webContents.session;
  });

  const activeComputerUse = computerUse;
  computerUse = undefined;
  await attemptCleanup(() => activeComputerUse?.dispose());

  await attemptCleanup(() => windowsProviderSmokeCommandReader?.close());

  const activeUnregisterIpc = unregisterIpc;
  unregisterIpc = undefined;
  await attemptCleanup(() => activeUnregisterIpc?.());

  const activeMainWindow = mainWindow;
  mainWindow = undefined;
  await attemptCleanup(() => {
    if (activeMainWindow && !activeMainWindow.isDestroyed()) {
      activeMainWindow.destroy();
    }
  });

  const smokeTargets = captureSmokeTargetWindows.splice(0);
  for (const target of smokeTargets) {
    await attemptCleanup(() => {
      if (!target.isDestroyed()) {
        target.destroy();
      }
    });
  }
  captureSmokeTargetWindows.length = 0;
  realCaptureSmokeDescriptorRegistry = undefined;
  realCaptureSmokeProjectionClient = undefined;

  await attemptCleanup(() => windowsProviderSmokeCommandReader?.close());
  await attemptCleanup(() => mainSession?.closeAllConnections());

  const activeDaemon = daemon;
  daemon = undefined;
  await attemptCleanup(() => activeDaemon?.stopOwnedDaemon());

  if (cleanupFailed) {
    throw firstCleanupError;
  }
}
