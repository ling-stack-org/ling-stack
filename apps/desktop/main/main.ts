import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  nativeTheme,
  powerMonitor,
  screen,
  shell,
  systemPreferences,
  webContents,
  type WebFrameMain,
} from "electron";
import {
  parseComputerUsePreviewProjection,
  type CuaDriverFeatureFlags,
  type ComputerUsePreviewProjection,
} from "@ling-stack/contracts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ComputerUsePreviewCoordinator } from "./computer-use/coordinator.js";
import {
  desktopBundledCuaDriverGateEnabled,
} from "./cua-driver/feature-gates.js";
import { CuaDriverDesktopCoordinator as BundledCuaDriverDesktopCoordinator } from "./cua-driver/coordinator.js";
import { createPackagedCuaDriverDesktopPlatformOwner } from "./cua-driver/platform-owner-composition.js";
import {
  resolveDesktopCuaDriverPackagedStartupAuthority,
  type DesktopCuaDriverPackagedStartupAuthority,
} from "./cua-driver/packaged-startup.js";
import { resolveCuaDriverResourcePaths } from "./cua-driver/resource-path.js";
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
import { DesktopRuntime } from "./desktop-runtime.js";
import {
  ensureDesktopDaemonWithStartupRecovery,
} from "./daemon-startup-recovery.js";
import {
  showIncompatibleDaemonRecoveryDialog,
  showOwnedDaemonStartupFailureDialog,
} from "./daemon-recovery-dialogs.js";
import type { DesktopStartupFailurePrompt } from "./startup-failure-recovery.js";
import { loadOrCreateDesktopBridgeToken } from "./bridge-token.js";
import { registerDesktopIpc } from "./ipc.js";
import { registerDesktopThemePackageIpc } from "./theme-packages/theme-package-ipc.js";
import { DesktopMobileAccessClient } from "./mobile-access/client.js";
import { DesktopThemePackageRepository } from "./theme-packages/theme-package-repository.js";
import { DesktopNavigationIntentStore } from "./navigation-intent.js";
import { openDesktopOwnerWindow } from "./owner-window.js";
import { DesktopPreferenceStore } from "./preferences.js";
import { FileLockedTaskContinuationPreferenceStore } from "./locked-task-continuation/preference-store.js";
import { DesktopRendererThemeStore } from "./renderer-theme-store.js";
import { resolveDesktopResourcePaths } from "./resource-paths.js";
import { resolveDesktopResourcesWithStartupRecovery } from "./resource-startup-recovery.js";
import { sendToLiveDesktopWindow } from "./safe-window-send.js";
import { establishDesktopSingleInstanceAuthority } from "./single-instance.js";
import {
  createDesktopExitLifecycle,
  createDesktopStartupOpenCoordinator,
  runDesktopStartup,
  type DesktopStartupOpenAttempt,
} from "./startup-lifecycle.js";
import { createMainWindow } from "./window-factory.js";
import type { DesktopDisplayWorkArea, DesktopRect } from "../shared/desktop-capabilities.js";
import { builtInDesktopRendererThemeInput } from "../shared/renderer-theme.js";
import { createDesktopThemePackageFirstPaintState } from "../shared/theme-package-first-paint.js";

const daemonBaseUrl = process.env.LING_STACK_DAEMON_URL ?? "http://127.0.0.1:17891";
let cuaDriverFeatureFlags: CuaDriverFeatureFlags | undefined;
let cuaDriverPackagedStartupAuthority: DesktopCuaDriverPackagedStartupAuthority | undefined;
const execFileAsync = promisify(execFile);
const smokeHeadless = process.argv.includes("--ling-desktop-smoke-headless");
const performanceHoldMs = (() => {
  const value = Number(process.env.LING_DESKTOP_SIGNED_PERFORMANCE_HOLD_MS ?? "0");
  return Number.isInteger(value) && value > 0 ? Math.min(value, 30_000) : 0;
})();
const screenPermissionProbe = process.argv.includes("--ling-desktop-screen-permission-probe");
const fakeComputerUseMode = process.env.LING_DESKTOP_FAKE_COMPUTER_USE === "1" ||
    process.argv.includes("--ling-desktop-fake-computer-use");
const daemonProjectionSmokeMode = process.env.LING_DESKTOP_DAEMON_PROJECTION_SMOKE === "1";
const preserveDaemonProjectionAfterSmoke =
  process.env.LING_DESKTOP_SMOKE_PRESERVE_DAEMON_PROJECTION === "1";
if (daemonProjectionSmokeMode && fakeComputerUseMode) {
  throw new Error("desktop_daemon_projection_smoke_cannot_use_fake_mode");
}
if (preserveDaemonProjectionAfterSmoke && !daemonProjectionSmokeMode) {
  throw new Error("desktop_projection_preserve_requires_daemon_mode");
}
const macosTccRevocationSmokeMode = process.argv.includes(
  "--ling-desktop-macos-tcc-revocation-smoke",
);
const directRealWindowCaptureSmokeMode = process.argv.includes("--ling-desktop-real-capture-smoke");
const directRealDisplayCaptureSmokeMode = process.argv.includes("--ling-desktop-real-display-capture-smoke") ||
  macosTccRevocationSmokeMode;
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
const macosTccRevocationCommandReader = macosTccRevocationSmokeMode
  ? createInterface({ input: process.stdin, crlfDelay: Infinity })
  : undefined;
const macosTccRevocationCommandIterator = macosTccRevocationCommandReader?.[Symbol.asyncIterator]();
let windowsProviderSmokeRestarting = false;
const fixedComputerUseConversationId = process.argv
  .find((argument) => argument.startsWith("--ling-desktop-computer-use-conversation="))
  ?.slice("--ling-desktop-computer-use-conversation=".length)
  .trim() || undefined;
const smokeComputerUseProjection = resolveSmokeComputerUseProjection();

app.setName("Ling Stack");

if (app.isPackaged && !isLoopbackDaemonUrl(daemonBaseUrl)) {
  throw new Error("packaged_desktop_requires_loopback_daemon");
}

let mainWindow: BrowserWindow | undefined;
let loadingMainWindow: BrowserWindow | undefined;
const captureSmokeTargetWindows: BrowserWindow[] = [];
let realCaptureSmokeDescriptor: ResolvedComputerUsePreviewDescriptor | undefined;
let realCaptureSmokeDescriptorRegistry: InMemoryComputerUsePreviewDescriptorRegistry | undefined;
let realCaptureSmokeProjectionClient: FakeComputerUseProjectionClient | undefined;
let smokeProjectionSource: "daemon" | "fake" = "fake";
let desktopBridgeToken: string | undefined;
let unregisterIpc: (() => void) | undefined;
let unregisterThemePackageIpc: (() => void) | undefined;
let unregisterLockedControlPreview: (() => void) | undefined;
let desktopRuntime: DesktopRuntime | undefined;
let computerUse: ComputerUsePreviewCoordinator | undefined;
const desktopNavigationIntents = new DesktopNavigationIntentStore();
const desktopRendererThemeStore = new DesktopRendererThemeStore(
  builtInDesktopRendererThemeInput(nativeTheme.shouldUseDarkColors ? "dark" : "light"),
);
const desktopThemePackageRepository = new DesktopThemePackageRepository({
  themesRoot: resolve(app.getPath("userData"), "themes"),
});
const startupLogPath = resolve(app.getPath("userData"), "desktop-startup.log");
const desktopExitLifecycle = createDesktopExitLifecycle({
  shutdown,
  quit: () => app.quit(),
  exit: (exitCode) => app.exit(exitCode),
  onShutdownError: (error) => {
    logStartup("app.shutdown_failed", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    console.error("Ling Stack Desktop shutdown failed", error);
  },
});
const mainWindowOpenCoordinator = createDesktopStartupOpenCoordinator({
  requestExit: (exitCode) => {
    void desktopExitLifecycle.requestExit(exitCode);
  },
});

establishDesktopSingleInstanceAuthority({
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  registerSecondInstanceHandler: (listener) => app.on("second-instance", listener),
  quitSecondaryInstance: () => app.quit(),
  startPrimaryInstance: registerPrimaryDesktopLifecycle,
  getMainWindow: () => mainWindow,
  openMainWindow,
  onSecondInstance: (focusedExistingWindow) => {
    logStartup("app.second_instance", { focusedExistingWindow });
  },
});

function registerPrimaryDesktopLifecycle(): void {
  logStartup("app.module_loaded", { packaged: app.isPackaged, smokeHeadless });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      void desktopExitLifecycle.requestExit(0);
    }
  });

  app.on("activate", () => {
    if (!mainWindow && !desktopExitLifecycle.isExitRequested()) {
      void openMainWindow();
    }
  });

  app.on("before-quit", (event) => {
    if (desktopExitLifecycle.isCleanupComplete()) {
      return;
    }
    event.preventDefault();
    void desktopExitLifecycle.requestExit(0);
  });

  void runDesktopStartup({
    start: async () => {
      await app.whenReady();
      logStartup("app.ready", { packaged: app.isPackaged, smokeHeadless });
      if (screenPermissionProbe) {
        const status = process.platform === "darwin"
          ? systemPreferences.getMediaAccessStatus("screen")
          : "unsupported";
        console.log(`Ling Stack Desktop screen permission: ${status}`);
        await desktopExitLifecycle.requestExit(0);
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
        if (macosTccRevocationSmokeMode) {
          const result = await runMacosTccRevocationSmoke();
          console.log(`LING_MACOS_TCC_REVOCATION_RESULT=${JSON.stringify(result)}`);
        } else if (fakeComputerUseMode || realCaptureSmokeMode) {
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
        await desktopExitLifecycle.requestExit(0);
      }
    },
    requestExit: (exitCode) => desktopExitLifecycle.requestExit(exitCode),
    onStartupError: (error) => {
      logStartup("app.startup_failed", {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      console.error("Ling Stack Desktop startup failed", error);
    },
  });
}

async function openMainWindow(): Promise<boolean> {
  if (desktopExitLifecycle.isExitRequested()) {
    return false;
  }
  if (mainWindow) {
    mainWindow.show();
    return true;
  }
  return mainWindowOpenCoordinator.run(openMainWindowOnce);
}

async function openMainWindowOnce(attempt: DesktopStartupOpenAttempt): Promise<boolean> {
  if (!attempt.isCurrent() || desktopExitLifecycle.isExitRequested()) {
    return false;
  }
  if (mainWindow) {
    mainWindow.show();
    return true;
  }
  const resources = await resolveDesktopResourcesWithStartupRecovery({
    resolveResources: () => resolveDesktopResourcePaths(app),
    allowInteractiveRecovery: !smokeHeadless,
    prompt: promptDesktopStartupFailure,
    openDiagnostics: openDesktopStartupDiagnostics,
  });
  if (!resources) {
    logStartup("resources.recovery_quit");
    attempt.requestExit(0);
    return false;
  }
  if (!attempt.isCurrent()) {
    return false;
  }
  logStartup("resources.resolved", {
    resourcesRoot: resources.resourcesRoot,
    webIndexPath: resources.webIndexPath,
    daemonEntryPath: resources.daemonEntryPath,
    previewIndexPath: resources.previewIndexPath,
  });
  if (realCaptureSmokeMode && realCaptureSmokeDescriptor) {
    await verifyRealCaptureRequestProvenance(resources.previewIndexPath, realCaptureSmokeDescriptor);
    if (!attempt.isCurrent()) {
      return false;
    }
  }
  const defaultWorkspaceCwd = resolve(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD ?? (
    app.isPackaged ? resolve(app.getPath("userData"), "workspace") : resolve(app.getAppPath(), "../..")
  ));
  const bridgeToken = await loadOrCreateDesktopBridgeToken(resolve(app.getPath("userData"), "desktop-bridge-token"));
  desktopBridgeToken = bridgeToken;
  if (!attempt.isCurrent()) {
    return false;
  }
  if (!desktopRuntime) {
    if (!cuaDriverFeatureFlags) {
      cuaDriverPackagedStartupAuthority = await resolveDesktopCuaDriverPackagedStartupAuthority({
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: resources.resourcesRoot,
        platform: process.platform,
      });
      if (cuaDriverPackagedStartupAuthority.failure) {
        logStartup("cua_driver.packaged_capabilities_unavailable", {
          error: cuaDriverPackagedStartupAuthority.failure instanceof Error
            ? cuaDriverPackagedStartupAuthority.failure.message
            : String(cuaDriverPackagedStartupAuthority.failure),
          bundledAuthoritative: true,
        });
      }
      cuaDriverFeatureFlags = cuaDriverPackagedStartupAuthority.featureFlags;
    }
    const featureFlags = cuaDriverFeatureFlags;
    const gateEnabled = desktopBundledCuaDriverGateEnabled(
      featureFlags,
      process.platform,
    );
    let platformOwner: Awaited<ReturnType<typeof createPackagedCuaDriverDesktopPlatformOwner>> | undefined;
    if (
      gateEnabled
      && cuaDriverPackagedStartupAuthority?.runtimeEligible === true
      && cuaDriverPackagedStartupAuthority.policy
    ) {
      try {
        platformOwner = await createPackagedCuaDriverDesktopPlatformOwner({
          platform: process.platform,
          policy: cuaDriverPackagedStartupAuthority.policy,
          ...(process.platform === "win32"
            ? {
                win32PowerMonitor: powerMonitor,
                baseEnvironment: process.env,
              }
            : {}),
          onDarwinPermissionChanged: async () => {
            await desktopRuntime?.refreshCuaDriverPlatform("darwin_permission_changed");
          },
        });
      } catch (error) {
        // A bad or missing trust policy disables only the bundled provider.
        // The normal Ling window stays up while the provider remains fail-closed.
        logStartup("cua_driver.platform_owner_unavailable", {
          platform: process.platform,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!attempt.isCurrent()) {
      await platformOwner?.dispose();
      return false;
    }
    try {
      desktopRuntime = new DesktopRuntime({
        daemon: new DesktopDaemonLifecycle({
          baseUrl: daemonBaseUrl,
          daemonEntryPath: resources.daemonEntryPath,
          defaultWorkspaceCwd,
          desktopBridgeToken: bridgeToken,
          cuaDriverFeatureFlags: featureFlags,
          ...(smokeHeadless && app.runningUnderARM64Translation ? { startupTimeoutMs: 60_000 } : {}),
          onDiagnostic: logStartup,
        }),
        daemonBaseUrl,
        bridgeToken,
        workspaceCwd: defaultWorkspaceCwd,
        resourcesRoot: resources.resourcesRoot,
        userDataPath: app.getPath("userData"),
        lockedTaskContinuationPreferenceStore: new FileLockedTaskContinuationPreferenceStore(
          resolve(app.getPath("userData"), "locked-task-continuation-preference.json"),
        ),
        featureFlags,
        packaged: app.isPackaged,
        powerMonitor,
        ...(platformOwner ? { platformOwner } : {}),
        onDiagnostic: logStartup,
      });
    } catch (error) {
      await platformOwner?.dispose();
      throw error;
    }
  }
  const daemonStartup = await ensureDesktopDaemonWithStartupRecovery({
    daemon: desktopRuntime,
    allowInteractiveRecovery: !smokeHeadless,
    prompt: async (prompt) => {
      const decision = await showIncompatibleDaemonRecoveryDialog({
        locale: app.getLocale(),
        prompt,
        showMessageBox: (options) => dialog.showMessageBox(options),
      });
      logStartup("daemon.recovery_decision", {
        baseUrl: prompt.baseUrl,
        reason: prompt.reason,
        decision,
      });
      return decision;
    },
    promptStartupFailure: promptDesktopStartupFailure,
    openDiagnostics: openDesktopStartupDiagnostics,
  });
  if (!attempt.isCurrent()) {
    return false;
  }
  if (daemonStartup === "quit") {
    logStartup("daemon.recovery_quit", { baseUrl: daemonBaseUrl });
    attempt.requestExit(0);
    return false;
  }
  logStartup("daemon.connected", { ownedByDesktop: desktopRuntime.status.ownedByDesktop });
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
          ...smokeComputerUseProjection,
          preview: {
            ...smokeComputerUseProjection.preview!,
            revision: realCaptureSmokeDescriptor.revision,
          },
        }
      : smokeComputerUseProjection;
    const projectionClient = daemonProjectionSmokeMode || (!fakeComputerUseMode && !realCaptureSmokeMode)
      ? new DaemonComputerUseProjectionClient(defaultWorkspaceCwd, daemonBaseUrl, undefined, undefined, bridgeToken)
      : new FakeComputerUseProjectionClient(smokeProjection);
    smokeProjectionSource = projectionClient instanceof DaemonComputerUseProjectionClient
      ? "daemon"
      : "fake";
    if (realCaptureSmokeMode && projectionClient instanceof FakeComputerUseProjectionClient) {
      realCaptureSmokeProjectionClient = projectionClient;
    }
    computerUse = new ComputerUsePreviewCoordinator({
      workspaceId: defaultWorkspaceCwd,
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
      openOwnerConversation: async (conversationId) => {
        const intent = desktopNavigationIntents.requestOpenConversation(conversationId);
        if (!intent) {
          return { accepted: false, reason: "computer_use_owner_conversation_missing" };
        }
        const opened = await openDesktopOwnerWindow({
          openMainWindow,
          getMainWindow: () => mainWindow,
        });
        if (!opened) {
          desktopNavigationIntents.discard(intent.requestId);
          logStartup("computer_use.owner_navigation_failed", { conversationId });
          return { accepted: false, reason: "computer_use_owner_window_unavailable" };
        }
        return { accepted: true };
      },
    });
    await computerUse.start();
    if (!attempt.isCurrent()) {
      return false;
    }
    logStartup("computer_use.started", { fakeMode: fakeComputerUseMode, realCaptureSmokeMode });
    unregisterLockedControlPreview ??= desktopRuntime.onLockedComputerControlChanged(
      (snapshot) => computerUse?.reportLockedControlState(snapshot),
    );
    computerUse.onSummaryChanged((summary) => {
      sendToLiveDesktopWindow(
        mainWindow ?? loadingMainWindow,
        "ling-desktop:computer-use:summary-changed",
        summary,
      );
    });
  }
  const initializedThemePackages = await desktopThemePackageRepository.initialize();
  if (!initializedThemePackages.ok) throw new Error("desktop_theme_packages_initialize_failed");
  if (!unregisterThemePackageIpc) {
    unregisterThemePackageIpc = registerDesktopThemePackageIpc({
      repository: desktopThemePackageRepository,
      getMainWindow: () => mainWindow ?? loadingMainWindow,
    });
  }
  unregisterIpc ??= registerDesktopIpc({
    runtime: desktopRuntime,
    computerUse,
    getMainWindow: () => mainWindow ?? loadingMainWindow,
    navigationIntents: desktopNavigationIntents,
    themeStore: desktopRendererThemeStore,
    mobileAccess: new DesktopMobileAccessClient({
      daemonBaseUrl,
      desktopBridgeToken: bridgeToken,
    }),
    ...(fakeComputerUseMode || realCaptureSmokeMode || fixedComputerUseConversationId
      ? { fixedComputerUseConversationId: fixedComputerUseConversationId ?? smokeComputerUseProjection.conversationId }
      : {}),
  });
  let createdWindow: BrowserWindow | undefined;
  try {
    const loadedWindow = await createMainWindow({
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111315" : "#f6f7f8",
      daemonBaseUrl,
      themePackageFirstPaint: createDesktopThemePackageFirstPaintState(
        initializedThemePackages.value,
      ),
      ...(desktopRuntime.computerControlPlatform
        ? { computerControlPlatform: desktopRuntime.computerControlPlatform }
        : {}),
      webIndexPath: resources.webIndexPath,
      showWhenReady: !smokeHeadless,
      onWindowCreated: (window) => {
        createdWindow = window;
        if (!attempt.isCurrent()) {
          try {
            window.destroy();
          } catch {
            // Shutdown already owns the process exit; do not revive this window.
          }
          return;
        }
        loadingMainWindow = window;
        window.once("closed", () => {
          if (loadingMainWindow === window) {
            loadingMainWindow = undefined;
          }
          if (mainWindow === window) {
            mainWindow = undefined;
          }
        });
      },
    });
    if (!attempt.isCurrent()) {
      if (loadingMainWindow === loadedWindow) {
        loadingMainWindow = undefined;
      }
      if (!loadedWindow.isDestroyed()) {
        try {
          loadedWindow.destroy();
        } catch {
          // Shutdown will continue even if Electron already destroyed it.
        }
      }
      return false;
    }
    if (loadedWindow.isDestroyed()) {
      if (loadingMainWindow === loadedWindow) {
        loadingMainWindow = undefined;
      }
      return false;
    }
    mainWindow = loadedWindow;
    if (loadingMainWindow === loadedWindow) {
      loadingMainWindow = undefined;
    }
  } catch (error) {
    if (loadingMainWindow === createdWindow) {
      loadingMainWindow = undefined;
    }
    if (createdWindow && !createdWindow.isDestroyed()) {
      try {
        createdWindow.destroy();
      } catch {
        // Preserve the original window-load failure.
      }
    }
    throw error;
  }
  logStartup("main_window.loaded");
  if (fakeComputerUseMode || realCaptureSmokeMode || fixedComputerUseConversationId) {
    computerUse.reportSelectedConversation(fixedComputerUseConversationId ?? smokeComputerUseProjection.conversationId);
  }
  return true;
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

async function promptDesktopStartupFailure(prompt: DesktopStartupFailurePrompt) {
  const decision = await showOwnedDaemonStartupFailureDialog({
    locale: app.getLocale(),
    prompt,
    showMessageBox: (options) => dialog.showMessageBox(options),
  });
  logStartup("desktop.startup_failure_decision", {
    ...(prompt.baseUrl ? { baseUrl: prompt.baseUrl } : {}),
    reason: prompt.reason,
    decision,
  });
  return decision;
}

async function openDesktopStartupDiagnostics(): Promise<void> {
  const failure = await shell.openPath(dirname(startupLogPath));
  if (failure) {
    logStartup("desktop.open_diagnostics_failed", { failure });
  }
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

function resolveSmokeComputerUseProjection(): ComputerUsePreviewProjection {
  const encoded = process.env.LING_DESKTOP_SMOKE_PROJECTION_JSON?.trim();
  if (!encoded) {
    if (daemonProjectionSmokeMode) {
      throw new Error("desktop_daemon_projection_smoke_projection_missing");
    }
    return FAKE_COMPUTER_USE_PROJECTION;
  }
  if (!daemonProjectionSmokeMode) {
    throw new Error("desktop_smoke_projection_json_requires_daemon_mode");
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("desktop_daemon_projection_smoke_projection_invalid");
  }
  const projection = parseComputerUsePreviewProjection(value);
  if (!projection || !projection.preview || projection.status !== "running") {
    throw new Error("desktop_daemon_projection_smoke_projection_invalid");
  }
  return projection;
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
  console.log(`LING_DESKTOP_PROJECTION_ID=${JSON.stringify({
    sessionId,
    conversationId: coordinator.getSummary()?.conversationId,
    sourceRevision: coordinator.getRendererSnapshot()?.sourceRevision,
    projectionSource: smokeProjectionSource,
  })}`);
  if (realCaptureSmokeMode) {
    await assertSmokeRendererMediaState(initialPreviewWebContentsId, "live");
  }
  if (performanceHoldMs > 0) {
    console.log("LING_DESKTOP_SIGNED_PERFORMANCE_HOLD_READY");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, performanceHoldMs));
    console.log("LING_DESKTOP_SIGNED_PERFORMANCE_HOLD_COMPLETE");
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
  if (directRealWindowCaptureSmokeMode && !daemonProjectionSmokeMode) {
    await exerciseRealCaptureRevisionAndSourceEnd(coordinator);
  } else if (windowsProviderCaptureRestartPhase) {
    await exerciseWindowsProviderRestartRecovery(coordinator);
    return;
  } else if (windowsProviderCaptureSmokeMode) {
    await exerciseWindowsProviderRevisionAndTargetClose(coordinator);
    return;
  }
  if (preserveDaemonProjectionAfterSmoke) {
    console.log("Ling Stack Desktop daemon projection persistence checkpoint passed");
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

async function runMacosTccRevocationSmoke(): Promise<{
  readonly activeCaptureBeforeRevocation: true;
  readonly sourceEndedOrPermissionFailureObserved: true;
  readonly runtimeContinuedWithoutStop: true;
  readonly stopRequestCount: 0;
}> {
  if (process.platform !== "darwin") {
    throw new Error("desktop_macos_tcc_revocation_requires_darwin");
  }
  const coordinator = computerUse;
  const projectionClient = realCaptureSmokeProjectionClient;
  if (!coordinator || !projectionClient) {
    throw new Error("desktop_macos_tcc_revocation_fixture_missing");
  }
  await waitForSmokeCondition(
    () => {
      const snapshot = coordinator.getRendererSnapshot();
      return coordinator.getSummary()?.visible === true &&
        snapshot?.frameReady === true &&
        snapshot.sourceStatus === "live";
    },
    "desktop_macos_tcc_revocation_first_frame_timeout",
    30_000,
  );
  const webContentsId = coordinator.getPreviewWebContentsId();
  if (webContentsId === undefined) {
    throw new Error("desktop_macos_tcc_revocation_renderer_missing");
  }
  await assertSmokeRendererMediaState(webContentsId, "live");
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    throw new Error("desktop_macos_tcc_revocation_permission_not_granted");
  }
  console.log(
    `LING_MACOS_TCC_REVOCATION_READY=${JSON.stringify({
      sessionId: coordinator.getSummary()?.sessionId,
      sourceRevision: coordinator.getRendererSnapshot()?.sourceRevision,
    })}`,
  );
  await readMacosTccRevocationCommand(10 * 60_000);
  await waitForSmokeCondition(
    () => {
      const sourceStatus = coordinator.getRendererSnapshot()?.sourceStatus;
      return sourceStatus === "stalled" ||
        sourceStatus === "permission_denied" ||
        sourceStatus === "failed";
    },
    "desktop_macos_tcc_revocation_source_end_timeout",
    30_000,
  );
  if (coordinator.getSummary()?.status !== "running") {
    throw new Error("desktop_macos_tcc_revocation_stopped_runtime");
  }
  if (projectionClient.getStopRequestCount() !== 0) {
    throw new Error("desktop_macos_tcc_revocation_stop_requested");
  }
  return {
    activeCaptureBeforeRevocation: true,
    sourceEndedOrPermissionFailureObserved: true,
    runtimeContinuedWithoutStop: true,
    stopRequestCount: 0,
  };
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
  return createRealCaptureSmokeDescriptor(smokeComputerUseProjection.preview?.revision ?? 1);
}

function createWindowsProviderSmokeDescriptor(): ResolvedComputerUsePreviewDescriptor {
  if (process.platform !== "win32") {
    throw new Error("desktop_windows_provider_smoke_platform_unsupported");
  }
  const preview = smokeComputerUseProjection.preview;
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
  const preview = smokeComputerUseProjection.preview;
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
  const preview = smokeComputerUseProjection.preview;
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
  if (!nativeWindowId) {
    throw new Error("desktop_real_capture_smoke_native_source_id_invalid");
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
      processId: process.pid,
      nativeWindowId,
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
  const replacementRevision = (smokeComputerUseProjection.preview?.revision ?? 1) + 1;
  const replacement = await createRealCaptureSmokeDescriptor(replacementRevision);
  registry.register(replacement);
  projectionClient.emit({
    ...smokeComputerUseProjection,
    preview: {
      ...smokeComputerUseProjection.preview!,
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
  await verifyWindowsPackagedBundledProviderRuntime();
  const initialRevision = smokeComputerUseProjection.preview?.revision ?? 1;
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
    ...smokeComputerUseProjection,
    preview: {
      ...smokeComputerUseProjection.preview!,
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
    await desktopExitLifecycle.requestExit(0);
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
  await verifyWindowsPackagedBundledProviderRuntime();
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

async function verifyWindowsPackagedBundledProviderRuntime(): Promise<void> {
  if (
    process.platform !== "win32"
    || process.arch !== "x64"
    || !app.isPackaged
    || cuaDriverPackagedStartupAuthority?.runtimeEligible !== true
    || cuaDriverPackagedStartupAuthority.authority?.providerExpected !== true
    || cuaDriverPackagedStartupAuthority.authority.platform !== "win32"
    || cuaDriverPackagedStartupAuthority.policy?.platform !== "win32"
    || !cuaDriverFeatureFlags
    || !desktopBundledCuaDriverGateEnabled(cuaDriverFeatureFlags, "win32")
  ) {
    throw new Error("desktop_windows_bundled_provider_authority_not_eligible");
  }
  const expectedPaths = resolveCuaDriverResourcePaths({
    resourcesPath: process.resourcesPath,
    platform: "win32",
    architecture: "x86_64",
  });
  const deadline = Date.now() + 45_000;
  let activeCoordinator: BundledCuaDriverDesktopCoordinator | undefined;
  while (Date.now() < deadline) {
    const candidate = desktopRuntime?.cuaDriverCoordinator;
    if (
      candidate instanceof BundledCuaDriverDesktopCoordinator
      && candidate.providerHost?.state === "ready"
      && candidate.snapshot.lifecycle === "active"
      && candidate.snapshot.providerState === "ready"
    ) {
      activeCoordinator = candidate;
      break;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  const host = activeCoordinator?.providerHost;
  const snapshot = activeCoordinator?.snapshot;
  if (
    !host
    || host.state !== "ready"
    || !readSafePositiveInteger(host.pid)
    || snapshot?.endpoint?.generation !== host.generation
    || snapshot.integrityCoverage !== "standard"
    || !/^[0-9a-f]{64}$/u.test(snapshot.artifacts?.lockDigest ?? "")
    || !/^[0-9a-f]{64}$/u.test(snapshot.artifacts?.providerSealDigest ?? "")
    || !/^[0-9a-f]{64}$/u.test(snapshot.artifacts?.providerCatalogDigest ?? "")
  ) {
    throw new Error("desktop_windows_bundled_provider_child_not_ready");
  }
  const observedExecutablePath = resolve(host.executablePath).toLowerCase();
  const expectedExecutablePath = resolve(expectedPaths.executablePath).toLowerCase();
  if (observedExecutablePath !== expectedExecutablePath) {
    throw new Error("desktop_windows_bundled_provider_executable_path_mismatch");
  }
  const descriptor = realCaptureSmokeDescriptor;
  const processId = readSafePositiveInteger(descriptor?.target.processId);
  const nativeWindowId = readCanonicalNativeWindowId(descriptor?.target.nativeWindowId);
  if (
    !descriptor
    || descriptor.platform !== "windows"
    || descriptor.sourceKind !== "window"
    || processId === undefined
    || nativeWindowId === undefined
  ) {
    throw new Error("desktop_windows_bundled_provider_target_missing");
  }
  const daemonProof = await verifyWindowsDaemonBundledProviderTarget({
    processId,
    nativeWindowId,
  });
  if (
    daemonProof.runtime.desktopInstanceId !== desktopRuntime?.desktopInstanceId
    || daemonProof.runtime.generation !== host.generation
    || daemonProof.runtime.providerVersion !== "0.8.3"
    || daemonProof.runtime.lockDigest !== snapshot.artifacts?.lockDigest
    || daemonProof.runtime.providerSealDigest !== snapshot.artifacts?.providerSealDigest
    || daemonProof.runtime.providerCatalogDigest !== snapshot.artifacts?.providerCatalogDigest
  ) {
    throw new Error("desktop_windows_bundled_provider_runtime_proof_mismatch");
  }
  console.log(
    `Ling Stack Desktop Windows bundled provider runtime ready ${JSON.stringify({
      schemaVersion: 1,
      desktopInstanceId: daemonProof.runtime.desktopInstanceId,
      desktopInstanceEpoch: daemonProof.runtime.desktopInstanceEpoch,
      generation: host.generation,
      providerProcessId: host.pid,
      executablePath: expectedPaths.executablePath,
      providerChildInstanceNonceSha256: createHash("sha256")
        .update(host.childInstanceNonce, "utf8")
        .digest("hex"),
      lockDigest: daemonProof.runtime.lockDigest,
      providerSealDigest: daemonProof.runtime.providerSealDigest,
      providerCatalogDigest: daemonProof.runtime.providerCatalogDigest,
      target: daemonProof.target,
    })}`,
  );
}

interface WindowsBundledProviderTargetProof {
  readonly verified: true;
  readonly target: {
    readonly platform: "windows";
    readonly processId: number;
    readonly nativeWindowId: string;
  };
  readonly runtime: {
    readonly desktopInstanceId: string;
    readonly desktopInstanceEpoch: number;
    readonly generation: number;
    readonly providerVersion: "0.8.3";
    readonly lockDigest: string;
    readonly providerSealDigest: string;
    readonly providerCatalogDigest: string;
  };
}

async function verifyWindowsDaemonBundledProviderTarget(target: {
  readonly processId: number;
  readonly nativeWindowId: string;
}): Promise<WindowsBundledProviderTargetProof> {
  const bridgeToken = desktopBridgeToken;
  if (!bridgeToken) {
    throw new Error("desktop_windows_bundled_provider_bridge_token_missing");
  }
  const url = new URL("/computer-use/provider-target/verify", daemonBaseUrl);
  url.searchParams.set(
    "cwd",
    resolve(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD ?? (
      app.isPackaged ? resolve(app.getPath("userData"), "workspace") : resolve(app.getAppPath(), "../..")
    )),
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ling-Desktop-Bridge-Token": bridgeToken,
    },
    body: JSON.stringify({ platform: "windows", ...target }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("desktop_windows_bundled_provider_target_proof_json_invalid");
  }
  if (!response.ok) {
    throw new Error(`desktop_windows_bundled_provider_target_proof_http_${response.status}:${text}`);
  }
  if (!isRecord(value) || value.verified !== true || !isRecord(value.target) || !isRecord(value.runtime)) {
    throw new Error("desktop_windows_bundled_provider_target_proof_invalid");
  }
  const provedTarget = value.target;
  const runtime = value.runtime;
  if (
    provedTarget.platform !== "windows"
    || provedTarget.processId !== target.processId
    || provedTarget.nativeWindowId !== target.nativeWindowId
    || typeof runtime.desktopInstanceId !== "string"
    || runtime.desktopInstanceId.length === 0
    || !readSafePositiveInteger(runtime.desktopInstanceEpoch)
    || !readSafePositiveInteger(runtime.generation)
    || runtime.providerVersion !== "0.8.3"
    || !/^[0-9a-f]{64}$/u.test(String(runtime.lockDigest ?? ""))
    || !/^[0-9a-f]{64}$/u.test(String(runtime.providerSealDigest ?? ""))
    || !/^[0-9a-f]{64}$/u.test(String(runtime.providerCatalogDigest ?? ""))
  ) {
    throw new Error("desktop_windows_bundled_provider_target_proof_invalid");
  }
  return value as unknown as WindowsBundledProviderTargetProof;
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

async function readMacosTccRevocationCommand(timeoutMs: number): Promise<void> {
  const iterator = macosTccRevocationCommandIterator;
  if (!iterator) {
    throw new Error("desktop_macos_tcc_revocation_command_channel_missing");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("desktop_macos_tcc_revocation_command_timeout")),
          timeoutMs,
        );
      }),
    ]);
    if (next.done) {
      throw new Error("desktop_macos_tcc_revocation_command_channel_closed");
    }
    let command: unknown;
    try {
      command = JSON.parse(next.value);
    } catch {
      throw new Error("desktop_macos_tcc_revocation_command_invalid");
    }
    if (!isRecord(command) || command.type !== "permission_revoked") {
      throw new Error("desktop_macos_tcc_revocation_command_unexpected");
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

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
  const activeMainWindowOpen = mainWindowOpenCoordinator.stopAcceptingAndWait();
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
    mainSession = (mainWindow ?? loadingMainWindow)?.webContents.session;
  });

  const activeComputerUse = computerUse;
  computerUse = undefined;
  const activeUnregisterLockedControlPreview = unregisterLockedControlPreview;
  unregisterLockedControlPreview = undefined;
  await attemptCleanup(() => activeUnregisterLockedControlPreview?.());
  await attemptCleanup(() => activeComputerUse?.dispose());

  await attemptCleanup(() => windowsProviderSmokeCommandReader?.close());
  await attemptCleanup(() => macosTccRevocationCommandReader?.close());

  const activeUnregisterThemePackageIpc = unregisterThemePackageIpc;
  unregisterThemePackageIpc = undefined;
  await attemptCleanup(() => activeUnregisterThemePackageIpc?.());

  const activeUnregisterIpc = unregisterIpc;
  unregisterIpc = undefined;
  await attemptCleanup(() => activeUnregisterIpc?.());

  const activeMainWindow = mainWindow;
  const activeLoadingMainWindow = loadingMainWindow;
  mainWindow = undefined;
  loadingMainWindow = undefined;
  for (const window of new Set([activeMainWindow, activeLoadingMainWindow])) {
    await attemptCleanup(() => {
      if (window && !window.isDestroyed()) {
        window.destroy();
      }
    });
  }

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

  const activeDesktopRuntime = desktopRuntime;
  desktopRuntime = undefined;
  await attemptCleanup(() => activeDesktopRuntime?.shutdown());
  await attemptCleanup(() => activeMainWindowOpen);

  if (cleanupFailed) {
    throw firstCleanupError;
  }
}
