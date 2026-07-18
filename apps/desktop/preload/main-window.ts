import { contextBridge, ipcRenderer } from "electron";
import type {
  ComputerUseHostLayout,
  ComputerUsePipDeckOwner,
  ComputerUsePreviewLocale,
  ComputerUsePreviewPreferences,
  ComputerUsePreviewSummary,
  DesktopNavigationIntent,
  LingDesktopCapabilities,
} from "../shared/desktop-capabilities.js";
import { isDesktopNavigationIntent } from "../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";
import { desktopPlatform } from "../main/platform.js";
import { subscribeWithInitialRead } from "../shared/initial-state-subscription.js";

const daemonBaseUrl = process.argv
  .find((argument) => argument.startsWith("--ling-daemon-base-url="))
  ?.slice("--ling-daemon-base-url=".length) ?? "http://127.0.0.1:17891";

const capabilities: LingDesktopCapabilities = {
  platform: desktopPlatform(),
  daemonBaseUrl,
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

contextBridge.exposeInMainWorld("lingDesktop", capabilities);
