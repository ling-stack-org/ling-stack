import { contextBridge, ipcRenderer } from "electron";
import type {
  ComputerUseHostLayout,
  ComputerUsePreviewLocale,
  ComputerUsePreviewPreferences,
  ComputerUsePreviewSummary,
  LingDesktopCapabilities,
} from "../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";
import { desktopPlatform } from "../main/platform.js";

const daemonBaseUrl = process.argv
  .find((argument) => argument.startsWith("--ling-daemon-base-url="))
  ?.slice("--ling-daemon-base-url=".length) ?? "http://127.0.0.1:17891";

const capabilities: LingDesktopCapabilities = {
  platform: desktopPlatform(),
  daemonBaseUrl,
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
      let active = true;
      const wrapped = (_event: Electron.IpcRendererEvent, summary: ComputerUsePreviewSummary | undefined): void => listener(summary);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.computerUseSummaryChanged, wrapped);
      void ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseSummaryGet).then((summary: ComputerUsePreviewSummary | undefined) => {
        if (active) {
          listener(summary);
        }
      });
      return () => {
        active = false;
        ipcRenderer.off(DESKTOP_IPC_CHANNELS.computerUseSummaryChanged, wrapped);
      };
    },
  },
};

contextBridge.exposeInMainWorld("lingDesktop", capabilities);
