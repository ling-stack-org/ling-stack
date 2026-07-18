import { contextBridge, ipcRenderer } from "electron";
import type {
  ComputerUsePreviewInteraction,
  ComputerUsePreviewReleaseMediaAck,
  ComputerUsePreviewReleaseMediaRequest,
  ComputerUsePreviewReleaseMediaResult,
  ComputerUsePipRendererSnapshot,
  LingComputerUsePreviewCapabilities,
} from "../shared/desktop-capabilities.js";
import { COMPUTER_USE_PREVIEW_RELEASE_MEDIA_STATUSES } from "../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";

const capabilities: LingComputerUsePreviewCapabilities = {
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewSnapshotGet),
  activatePage: (pageId: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewActivatePage, pageId),
  closePage: (pageId: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewClosePage, pageId),
  retryCapture: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewRetry),
  resetPosition: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewResetPosition),
  close: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewClose),
  hide: async () => {
    await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewHide);
  },
  openOwnerConversation: async () => {
    await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseOpenOwnerConversation);
  },
  requestStop: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseStop),
  openScreenPermissionSettings: async () => {
    await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.computerUseOpenPermissionSettings);
  },
  reportFrameReady: (sessionId: string, revision: number, sourceGeneration: number) => {
    ipcRenderer.send(
      DESKTOP_IPC_CHANNELS.computerUsePreviewFrameReady,
      sessionId,
      revision,
      sourceGeneration,
    );
  },
  reportFrameActivity: (sessionId: string, revision: number, sourceGeneration: number) => {
    ipcRenderer.send(
      DESKTOP_IPC_CHANNELS.computerUsePreviewFrameActivity,
      sessionId,
      revision,
      sourceGeneration,
    );
  },
  reportInteraction: (interaction: ComputerUsePreviewInteraction) => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.computerUsePreviewInteraction, interaction);
  },
  reportSourceEnded: (sessionId: string, revision: number, sourceGeneration: number, reason: string) => {
    ipcRenderer.send(
      DESKTOP_IPC_CHANNELS.computerUsePreviewSourceEnded,
      sessionId,
      revision,
      sourceGeneration,
      reason,
    );
  },
  reportSourceFailure: (sessionId: string, revision: number, sourceGeneration: number, reason: string) => {
    ipcRenderer.send(
      DESKTOP_IPC_CHANNELS.computerUsePreviewSourceFailed,
      sessionId,
      revision,
      sourceGeneration,
      reason,
    );
  },
  onReleaseMedia: (listener) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      requestValue: unknown,
    ): void => {
      void (async () => {
        if (!isReleaseMediaRequest(requestValue)) {
          return;
        }
        let result: ComputerUsePreviewReleaseMediaResult;
        try {
          result = await listener(requestValue);
        } catch {
          // Main owns the 500 ms fail-safe timeout and exact-window teardown.
          return;
        }
        if (!isReleaseMediaResult(result)) {
          return;
        }
        const ack: ComputerUsePreviewReleaseMediaAck = {
          ...requestValue,
          ...result,
        };
        ipcRenderer.send(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMediaAck, ack);
      })().catch(() => undefined);
    };
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMedia, wrapped);
    return () => ipcRenderer.off(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMedia, wrapped);
  },
  onSnapshotChanged: (listener: (snapshot: ComputerUsePipRendererSnapshot | undefined) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: ComputerUsePipRendererSnapshot | undefined): void => listener(snapshot);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.computerUsePreviewSnapshotChanged, wrapped);
    return () => ipcRenderer.off(DESKTOP_IPC_CHANNELS.computerUsePreviewSnapshotChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld("lingComputerUsePreview", capabilities);

function isReleaseMediaRequest(value: unknown): value is ComputerUsePreviewReleaseMediaRequest {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.requestId === "string" && value.requestId.length > 0 &&
    typeof value.sessionId === "string" && value.sessionId.length > 0 &&
    Number.isSafeInteger(value.sourceRevision) && Number(value.sourceRevision) >= 0 &&
    Number.isSafeInteger(value.sourceGeneration) && Number(value.sourceGeneration) > 0;
}

function isReleaseMediaResult(value: unknown): value is ComputerUsePreviewReleaseMediaResult {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.status === "string" &&
    COMPUTER_USE_PREVIEW_RELEASE_MEDIA_STATUSES.includes(
      value.status as ComputerUsePreviewReleaseMediaResult["status"],
    ) &&
    Number.isInteger(value.releasedTrackCount) && Number(value.releasedTrackCount) >= 0 &&
    typeof value.allTracksEnded === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
