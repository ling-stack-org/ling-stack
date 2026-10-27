import { contextBridge, ipcRenderer } from "electron";
import { createLocalFileCapabilities } from "../shared/local-file-activation.js";
import type { ExternalExecutionEngineId } from "@ling-stack/contracts";
import type {
  ComputerUseHostLayout,
  ComputerUsePipDeckOwner,
  ComputerUsePreviewLocale,
  ComputerUsePreviewPreferences,
  ComputerUsePreviewSummary,
  ComputerControlPermissionKind,
  DesktopNavigationIntent,
  DesktopDaemonStatus,
  DesktopWindowState,
  LingDesktopCapabilities,
} from "../shared/desktop-capabilities.js";
import { isDesktopNavigationIntent, isDesktopDaemonStatus } from "../shared/desktop-capabilities.js";
import type {
  DesktopThemePackageArchiveRequest,
  DesktopThemePackageDeleteRequest,
  DesktopThemePackageReimportRequest,
} from "../shared/theme-package-capabilities.js";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_THEME_PACKAGE_IPC_CHANNELS,
  DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS,
} from "../shared/ipc-channels.js";
import { parseDesktopThemePackageFirstPaintArgument } from "../shared/theme-package-first-paint.js";
import { desktopPlatform } from "../main/platform.js";
import { subscribeWithInitialRead } from "../shared/initial-state-subscription.js";

const daemonBaseUrl = process.argv
  .find((argument) => argument.startsWith("--ling-daemon-base-url="))
  ?.slice("--ling-daemon-base-url=".length) ?? "http://127.0.0.1:17891";
const themePackageFirstPaint = parseDesktopThemePackageFirstPaintArgument(process.argv);
const computerControlPlatform = process.argv
  .find((argument) => argument.startsWith("--ling-computer-control-platform="))
  ?.slice("--ling-computer-control-platform=".length);
const platform = desktopPlatform();

const capabilities: LingDesktopCapabilities = {
  platform,
  daemonBaseUrl,
  ...(platform === "macos" ? {
    humanEvaluation: {
      // Main is the authoritative exact-payload parser; no auth flags are added here.
      submit: (request: import("../shared/human-evaluation-capabilities.js").DesktopHumanEvaluationRequest) =>
        ipcRenderer.invoke(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.submit, request),
      cancel: (requestId: string) => ipcRenderer.invoke(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.cancel, requestId),
      inspect: (request: import("../shared/human-evaluation-capabilities.js").DesktopHumanEvaluationInspectRequest) =>
        ipcRenderer.invoke(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.inspect, request),
      list: (request: import("../shared/human-evaluation-capabilities.js").DesktopHumanEvaluationListRequest) =>
        ipcRenderer.invoke(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.list, request),
      generateReport: (request: import("../shared/human-evaluation-capabilities.js").DesktopHumanEvaluationReportRef) =>
        ipcRenderer.invoke(DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS.generateReport, request),
    },
  } : {}),
  appearance: {
    reportTheme: (theme) => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.desktopThemeReport, theme);
    },
  },
  themePackages: {
    ...(themePackageFirstPaint ? { firstPaint: themePackageFirstPaint } : {}),
    bootstrap: () => ipcRenderer.invoke(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesBootstrap,
    ),
    list: () => ipcRenderer.invoke(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesList,
    ),
    read: (request) => ipcRenderer.invoke(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesRead,
      {
        themeId: request.themeId,
        includePreviewBytes: request.includePreviewBytes,
      },
    ),
    install: (request) => ipcRenderer.invoke(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesInstall,
      cloneArchiveRequest(request),
    ),
    reimport: (request) => ipcRenderer.invoke(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesReimport,
      cloneReimportRequest(request),
    ),
    delete: (request) => ipcRenderer.invoke(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesDelete,
      cloneDeleteRequest(request),
    ),
    setActive: (request) => ipcRenderer.invoke(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesActiveSet,
      { themeId: request.themeId },
    ),
  },
  ...(platform === "windows"
    ? {
        windowControls: {
          getState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowStateGet),
          minimize: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowMinimize),
          toggleMaximize: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowToggleMaximize),
          close: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowClose),
          onStateChanged: (listener: (state: DesktopWindowState) => void) => {
            return subscribeWithInitialRead<DesktopWindowState>({
              read: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowStateGet),
              subscribe: (onState) => {
                const wrapped = (
                  _event: Electron.IpcRendererEvent,
                  state: DesktopWindowState,
                ): void => onState(state);
                ipcRenderer.on(DESKTOP_IPC_CHANNELS.windowStateChanged, wrapped);
                return () => ipcRenderer.off(DESKTOP_IPC_CHANNELS.windowStateChanged, wrapped);
              },
              onValue: listener,
            });
          },
        },
      }
    : {}),
  navigation: {
    acknowledgeIntent: (requestId: number) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.navigationIntentAck, requestId),
    onIntent: (listener: (intent: DesktopNavigationIntent) => void) => {
      return subscribeWithInitialRead<DesktopNavigationIntent | undefined>({
        read: async () => {
          const intent: unknown = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.navigationIntentGet);
          return isDesktopNavigationIntent(intent) ? intent : undefined;
        },
        subscribe: (onIntent) => {
          const wrapped = (_event: Electron.IpcRendererEvent, intent: unknown): void => {
            if (isDesktopNavigationIntent(intent)) {
              onIntent(intent);
            }
          };
          ipcRenderer.on(DESKTOP_IPC_CHANNELS.navigationIntentChanged, wrapped);
          return () => ipcRenderer.off(DESKTOP_IPC_CHANNELS.navigationIntentChanged, wrapped);
        },
        onValue: (intent) => {
          if (intent) {
            listener(intent);
          }
        },
      });
    },
  },
  daemon: {
    getStatus: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.daemonStatus),
    restart: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.daemonRestart),
    onStatusChanged: listener => subscribeWithInitialRead<DesktopDaemonStatus | undefined>({
      read: async () => {
        const status: unknown = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.daemonStatus);
        return isDesktopDaemonStatus(status) && status.baseUrl === daemonBaseUrl ? status : undefined;
      },
      subscribe: onStatus => {
        const wrapped = (_event: Electron.IpcRendererEvent, status: unknown): void => {
          if (isDesktopDaemonStatus(status) && status.baseUrl === daemonBaseUrl) onStatus(status);
        };
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.daemonStatus, wrapped);
        return () => { ipcRenderer.off(DESKTOP_IPC_CHANNELS.daemonStatus, wrapped); };
      },
      onValue: status => { if (status) listener(status); },
    }),
  },
  mobileAccess: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileAccessStatus),
    enable: (gatewayOrigin) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileAccessEnable, gatewayOrigin),
    disable: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileAccessDisable),
    startPairing: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileAccessPairingStart),
    confirmPairing: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileAccessPairingConfirm),
    rejectPairing: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileAccessPairingReject),
    revoke: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileAccessRevoke),
  },
  executionEngines: {
    discover: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEnginesDiscover),
    install: (engineId: ExternalExecutionEngineId) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEnginesInstall, engineId),
    installStatus: (engineId: ExternalExecutionEngineId) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEnginesInstallStatus, engineId),
    listProfiles: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEnginesList),
    getProfile: (engineId) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineProfileGet, engineId),
    saveProfile: (engineId, request) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineProfileSave, engineId, request),
    saveProfileWithSecret: (engineId, request) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineProfileSecretSave, engineId, request),
    disconnectProfile: (engineId, revision) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineProfileDisconnect, engineId, revision),
    probeProfile: (engineId, revision) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineProfileProbe, engineId, revision),
    probeConnection: (engineId, revision) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineConnectionProbe, engineId, revision),
    startLogin: (engineId, revision, method) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineLoginStart, engineId, revision, method),
    getLogin: (engineId, operationId) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineLoginGet, engineId, operationId),
    cancelLogin: (engineId, operationId) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.executionEngineLoginCancel, engineId, operationId),
  },
  ...(computerControlPlatform === "macos" || computerControlPlatform === "windows"
    ? {
        computerControl: {
          packagedBundledCapable: true as const,
          platform: computerControlPlatform,
          requestPermissions: () => ipcRenderer.invoke(
            DESKTOP_IPC_CHANNELS.computerControlRequestPermissions,
          ),
          openPermissionSettings: (permission: ComputerControlPermissionKind) =>
            ipcRenderer.invoke(
              DESKTOP_IPC_CHANNELS.computerControlOpenPermissionSettings,
              permission,
            ),
        },
      }
    : {}),
  lockedTaskContinuation: {
    getLockedTaskContinuationPreferences: () => ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.computerControlLockedTaskContinuationGet,
    ),
    setContinueTasksWhileLocked: (enabled: boolean) => ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.computerControlLockedTaskContinuationSet,
      enabled,
    ),
  },
  computerUse: {
    reportLocale: (locale: ComputerUsePreviewLocale) => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.computerUseReportLocale, locale);
    },
    reportSelectedDeckOwner: (owner?: ComputerUsePipDeckOwner) => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.computerUseReportSelectedDeckOwner, owner);
    },
    reportSelectedConversation: (conversationId?: string) => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.computerUseReportSelectedConversation, conversationId);
    },
    reportHostLayout: (layout: ComputerUseHostLayout) => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, layout);
    },
    show: (sessionId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseShow, sessionId),
    hide: (sessionId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseHide, sessionId),
    stop: (sessionId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseStop, sessionId),
    getPreferences: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseAutoShowGet) as Promise<ComputerUsePreviewPreferences>,
    setAutoShow: (enabled: boolean) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseAutoShowSet, enabled),
    onSummaryChanged: (listener: (summary: ComputerUsePreviewSummary | undefined) => void) => {
      return subscribeWithInitialRead({
        read: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseSummaryGet) as Promise<ComputerUsePreviewSummary | undefined>,
        subscribe: (onSummary) => {
          const wrapped = (
            _event: Electron.IpcRendererEvent,
            summary: ComputerUsePreviewSummary | undefined,
          ): void => onSummary(summary);
          ipcRenderer.on(DESKTOP_IPC_CHANNELS.computerUseSummaryChanged, wrapped);
          return () => ipcRenderer.off(DESKTOP_IPC_CHANNELS.computerUseSummaryChanged, wrapped);
        },
        onValue: listener,
      });
    },
  },
};

contextBridge.exposeInMainWorld("lingDesktop", {
  ...capabilities,
  localFiles: createLocalFileCapabilities((channel, request) => ipcRenderer.invoke(channel, request), globalThis.document),
});

function cloneArchiveRequest(
  request: DesktopThemePackageArchiveRequest,
): DesktopThemePackageArchiveRequest {
  return {
    requestId: request.requestId,
    originalFileName: request.originalFileName,
    archiveBytes: request.archiveBytes.slice(0),
    rendererPackageChecksumSha256: request.rendererPackageChecksumSha256,
  };
}

function cloneReimportRequest(
  request: DesktopThemePackageReimportRequest,
): DesktopThemePackageReimportRequest {
  return {
    ...cloneArchiveRequest(request),
    themeId: request.themeId,
    expectedRecordRevision: request.expectedRecordRevision,
    ...(request.expectedCurrentChecksumSha256 !== undefined
      ? { expectedCurrentChecksumSha256: request.expectedCurrentChecksumSha256 }
      : {}),
  };
}

function cloneDeleteRequest(
  request: DesktopThemePackageDeleteRequest,
): DesktopThemePackageDeleteRequest {
  return {
    requestId: request.requestId,
    themeId: request.themeId,
    expectedRecordRevision: request.expectedRecordRevision,
    ...(request.expectedCurrentChecksumSha256 !== undefined
      ? { expectedCurrentChecksumSha256: request.expectedCurrentChecksumSha256 }
      : {}),
  };
}
