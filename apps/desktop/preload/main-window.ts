import { contextBridge, ipcRenderer } from "electron";
import type {
  ComputerUseHostLayout,
  ComputerUsePreviewLocale,
  ComputerUsePreviewPreferences,
  ComputerUsePreviewSummary,
  DesktopNavigationIntent,
  LingDesktopCapabilities,
} from "../shared/desktop-capabilities.js";
import { isDesktopNavigationIntent } from "../shared/desktop-capabilities.js";
import type {
  DesktopThemePackageArchiveRequest,
  DesktopThemePackageDeleteRequest,
  DesktopThemePackageReimportRequest,
} from "../shared/theme-package-capabilities.js";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_THEME_PACKAGE_IPC_CHANNELS,
} from "../shared/ipc-channels.js";
import { parseDesktopThemePackageFirstPaintArgument } from "../shared/theme-package-first-paint.js";
import { desktopPlatform } from "../main/platform.js";
import { subscribeWithInitialRead } from "../shared/initial-state-subscription.js";

const daemonBaseUrl = process.argv
  .find((argument) => argument.startsWith("--ling-daemon-base-url="))
  ?.slice("--ling-daemon-base-url=".length) ?? "http://127.0.0.1:17891";
const themePackageFirstPaint = parseDesktopThemePackageFirstPaintArgument(process.argv);

const capabilities: LingDesktopCapabilities = {
  platform: desktopPlatform(),
  daemonBaseUrl,
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
  },
  computerUse: {
    reportLocale: (locale: ComputerUsePreviewLocale) => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.computerUseReportLocale, locale);
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

contextBridge.exposeInMainWorld("lingDesktop", capabilities);

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
