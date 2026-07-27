import { createRequire } from "node:module";
import type { BrowserWindow, IpcMain } from "electron";
import {
  COMPUTER_USE_HOST_OBSTACLE_KINDS,
  COMPUTER_USE_PREVIEW_RELEASE_MEDIA_STATUSES,
  isComputerUsePreviewLocale,
  type ComputerUseHostLayout,
  type ComputerUseHostObstacle,
  type ComputerUseHostObstacleKind,
  type ComputerUsePreviewReleaseMediaAck,
  type DesktopRect,
} from "../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";
import type { ComputerUsePreviewCoordinator } from "./computer-use/coordinator.js";
import type { DesktopDaemonLifecycle } from "./daemon-lifecycle.js";
import { DesktopNavigationIntentStore } from "./navigation-intent.js";
import { DesktopRendererThemeStore } from "./renderer-theme-store.js";
import { sendToLiveDesktopWindow } from "./safe-window-send.js";

const MAX_HOST_OBSTACLES = 128;
const MAX_DESKTOP_COORDINATE = 1_000_000;
const MAX_DESKTOP_DIMENSION = 100_000;
const MAX_HOST_LAYOUT_AGE_MS = 5 * 60 * 1_000;
const MAX_HOST_LAYOUT_FUTURE_SKEW_MS = 60 * 1_000;

export function registerDesktopIpc(input: {
  readonly daemon: DesktopDaemonLifecycle;
  readonly computerUse: ComputerUsePreviewCoordinator;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly navigationIntents?: DesktopNavigationIntentStore;
  readonly themeStore?: DesktopRendererThemeStore;
  readonly fixedComputerUseConversationId?: string;
  readonly ipcMainImpl?: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeAllListeners">;
}): () => void {
  const desktopIpcMain = input.ipcMainImpl ?? resolveIpcMain();
  const navigationIntents = input.navigationIntents ?? new DesktopNavigationIntentStore();
  const themeStore = input.themeStore ?? new DesktopRendererThemeStore();
  let pendingRendererSelectionObserved = false;
  let pendingRendererSelection: string | undefined;
  let pendingRendererSelectionApplied = false;
  let pendingRendererSelectionAppliedValue: string | undefined;
  const isMainWindowSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    input.getMainWindow()?.webContents.id === event.sender.id;
  const isPreviewSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    input.computerUse.ownsPreviewWebContents(event.sender.id);

  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.daemonStatus, async (event) =>
    isMainWindowSender(event) ? input.daemon.status : { state: "disconnected", baseUrl: "", ownedByDesktop: false });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.daemonRestart, async (event) =>
    isMainWindowSender(event)
      ? input.daemon.restart()
      : { state: "disconnected", baseUrl: "", ownedByDesktop: false, message: "unauthorized_sender" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.navigationIntentGet, async (event) =>
    isMainWindowSender(event) ? navigationIntents.getPendingIntent() : undefined);
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.navigationIntentAck, async (event, requestId: unknown) => {
    if (!isMainWindowSender(event) || !isPositiveSafeInteger(requestId)) {
      return { accepted: false, reason: "unauthorized_or_invalid_navigation_intent" };
    }
    const result = navigationIntents.acknowledge(requestId);
    if (
      result.accepted
      && !navigationIntents.getPendingIntent()
      && pendingRendererSelectionObserved
      && (!pendingRendererSelectionApplied || pendingRendererSelectionAppliedValue !== pendingRendererSelection)
    ) {
      input.computerUse.reportSelectedConversation(pendingRendererSelection);
    }
    if (result.accepted && !navigationIntents.getPendingIntent()) {
      pendingRendererSelectionObserved = false;
      pendingRendererSelection = undefined;
      pendingRendererSelectionApplied = false;
      pendingRendererSelectionAppliedValue = undefined;
    }
    return result;
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.desktopThemeSnapshotGet, async (event) => {
    if (!isPreviewSender(event)) {
      return undefined;
    }
    themeStore.trackRenderer(event.sender);
    return themeStore.getSnapshot();
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.desktopThemeReport, (event, value: unknown) => {
    if (isMainWindowSender(event)) {
      themeStore.report(value);
    }
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseSummaryGet, async (event) =>
    isMainWindowSender(event) ? input.computerUse.getSummary() : undefined);
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseAutoShowGet, async (event) =>
    isMainWindowSender(event) ? input.computerUse.getPreferences() : { previewAutoShow: true });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseAutoShowSet, async (event, enabled: unknown) => {
    if (!isMainWindowSender(event) || typeof enabled !== "boolean") {
      return { accepted: false, reason: "unauthorized_or_invalid_auto_show" };
    }
    return input.computerUse.setAutoShow(enabled);
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewSnapshotGet, (event) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id)
      ? input.computerUse.getRendererSnapshot()
      : undefined);
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewRetry, (event) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id)
      ? input.computerUse.retryCapture()
      : { accepted: false, reason: "unauthorized_preview_sender" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewResetPosition, (event) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id)
      ? input.computerUse.resetPosition()
      : { accepted: false, reason: "unauthorized_preview_sender" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewClose, (event) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id)
      ? input.computerUse.closeCurrent()
      : { accepted: false, reason: "unauthorized_preview_sender" });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUseReportLocale, (event, locale: unknown) => {
    if (isMainWindowSender(event) && isComputerUsePreviewLocale(locale)) {
      input.computerUse.reportLocale(locale);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUseReportSelectedConversation, (event, conversationId: unknown) => {
    if (!isMainWindowSender(event)) {
      return;
    }
    const selectedConversationId = input.fixedComputerUseConversationId ??
      (typeof conversationId === "string" && conversationId.trim() ? conversationId.trim() : undefined);
    if (navigationIntents.getPendingIntent()) {
      pendingRendererSelectionObserved = true;
      pendingRendererSelection = selectedConversationId;
    }
    if (!navigationIntents.acceptRendererSelection(selectedConversationId)) {
      return;
    }
    const selectionToApply = !navigationIntents.getPendingIntent() && pendingRendererSelectionObserved
      ? pendingRendererSelection
      : selectedConversationId;
    input.computerUse.reportSelectedConversation(selectionToApply);
    pendingRendererSelectionApplied = true;
    pendingRendererSelectionAppliedValue = selectionToApply;
    if (!navigationIntents.getPendingIntent()) {
      pendingRendererSelectionObserved = false;
      pendingRendererSelection = undefined;
      pendingRendererSelectionApplied = false;
      pendingRendererSelectionAppliedValue = undefined;
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, (event, layout: unknown) => {
    if (!isMainWindowSender(event)) {
      return;
    }
    const parsed = readHostLayout(layout);
    if (parsed) {
      input.computerUse.reportHostLayout(parsed);
    }
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseShow, async (event, sessionId: unknown) =>
    !isMainWindowSender(event)
      ? { accepted: false, reason: "unauthorized_sender" }
      : typeof sessionId === "string" ? input.computerUse.show(sessionId) : { accepted: false, reason: "bad_session_id" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseHide, async (event, sessionId: unknown) =>
    !isMainWindowSender(event)
      ? { accepted: false, reason: "unauthorized_sender" }
      : typeof sessionId === "string" ? input.computerUse.hide(sessionId) : { accepted: false, reason: "bad_session_id" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseStop, async (event, sessionId: unknown) => {
    if (isPreviewSender(event)) {
      return input.computerUse.stopCurrent();
    }
    if (!isMainWindowSender(event)) {
      return { accepted: false, reason: "unauthorized_sender" };
    }
    return typeof sessionId === "string" ? input.computerUse.stop(sessionId) : input.computerUse.stopCurrent();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseOpenOwnerConversation, async (event) => {
    if (!isMainWindowSender(event) && !isPreviewSender(event)) {
      return { accepted: false, reason: "unauthorized_sender" };
    }
    return input.computerUse.openOwnerConversation();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseOpenPermissionSettings, async (event) => {
    if (!isMainWindowSender(event) && !isPreviewSender(event)) {
      return { accepted: false, reason: "unauthorized_sender" };
    }
    await input.computerUse.openPermissionSettings();
    return { accepted: true };
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewHide, async (event) =>
    isPreviewSender(event)
      ? input.computerUse.hideCurrent()
      : { accepted: false, reason: "unauthorized_preview_sender" });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMediaAck, (event, value: unknown) => {
    if (!isPreviewSender(event)) {
      return;
    }
    const ack = readComputerUsePreviewReleaseMediaAck(value);
    if (ack) {
      input.computerUse.reportMediaReleased(ack, event.sender.id);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameReady, (
    event,
    sessionId: unknown,
    revision: unknown,
    sourceGeneration: unknown,
  ) => {
    if (
      input.computerUse.ownsPreviewWebContents(event.sender.id) &&
      isNonEmptyString(sessionId) &&
      isNonNegativeSafeInteger(revision) &&
      isPositiveSafeInteger(sourceGeneration)
    ) {
      input.computerUse.reportFrameReady(sessionId, revision, sourceGeneration);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameActivity, (
    event,
    sessionId: unknown,
    revision: unknown,
    sourceGeneration: unknown,
  ) => {
    if (
      input.computerUse.ownsPreviewWebContents(event.sender.id) &&
      isNonEmptyString(sessionId) &&
      isNonNegativeSafeInteger(revision) &&
      isPositiveSafeInteger(sourceGeneration)
    ) {
      input.computerUse.reportFrameActivity(sessionId, revision, sourceGeneration);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewInteraction, (event, interaction: unknown) => {
    if (!input.computerUse.ownsPreviewWebContents(event.sender.id) || !isRecord(interaction)) {
      return;
    }
    const kind = interaction.kind;
    const active = interaction.active;
    if ((kind === "hover" || kind === "focus") && typeof active === "boolean") {
      input.computerUse.reportInteraction(kind, active);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewSourceEnded, (
    event,
    sessionId: unknown,
    revision: unknown,
    sourceGeneration: unknown,
    reason: unknown,
  ) => {
    if (
      input.computerUse.ownsPreviewWebContents(event.sender.id) &&
      isNonEmptyString(sessionId) &&
      isNonNegativeSafeInteger(revision) &&
      isPositiveSafeInteger(sourceGeneration)
    ) {
      input.computerUse.reportSourceEnded(
        sessionId,
        revision,
        sourceGeneration,
        typeof reason === "string" ? reason : "source_ended",
      );
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewSourceFailed, (
    event,
    sessionId: unknown,
    revision: unknown,
    sourceGeneration: unknown,
    reason: unknown,
  ) => {
    if (
      input.computerUse.ownsPreviewWebContents(event.sender.id) &&
      isNonEmptyString(sessionId) &&
      isNonNegativeSafeInteger(revision) &&
      isPositiveSafeInteger(sourceGeneration)
    ) {
      input.computerUse.reportSourceFailure(
        sessionId,
        revision,
        sourceGeneration,
        typeof reason === "string" ? reason : "source_failed",
      );
    }
  });

  const unsubscribeStatus = input.daemon.onStatusChanged((status) => {
    sendToLiveDesktopWindow(input.getMainWindow(), DESKTOP_IPC_CHANNELS.daemonStatus, status);
  });
  const unsubscribeNavigationIntents = navigationIntents.onIntentChanged((intent) => {
    pendingRendererSelectionObserved = false;
    pendingRendererSelection = undefined;
    pendingRendererSelectionApplied = false;
    pendingRendererSelectionAppliedValue = undefined;
    sendToLiveDesktopWindow(
      input.getMainWindow(),
      DESKTOP_IPC_CHANNELS.navigationIntentChanged,
      intent,
    );
  });
  return () => {
    unsubscribeStatus();
    unsubscribeNavigationIntents();
    themeStore.dispose();
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      desktopIpcMain.removeHandler(channel);
      desktopIpcMain.removeAllListeners(channel);
    }
  };
}

function resolveIpcMain(): IpcMain {
  const require = createRequire(import.meta.url);
  const electron = require("electron") as { readonly ipcMain?: IpcMain };
  if (!electron.ipcMain) {
    throw new Error("electron_ipc_main_unavailable");
  }
  return electron.ipcMain;
}

function readHostLayout(value: unknown): ComputerUseHostLayout | undefined {
  if (!isRecord(value) || !Array.isArray(value.obstacles)) {
    return undefined;
  }
  const windowBounds = readRect(value.windowBounds);
  if (!windowBounds) {
    return undefined;
  }
  const obstacles = value.obstacles
    .slice(0, MAX_HOST_OBSTACLES)
    .map(readHostObstacle)
    .filter((obstacle): obstacle is ComputerUseHostObstacle => obstacle !== undefined);
  return {
    windowBounds,
    obstacles,
    reportedAt: readHostLayoutReportedAt(value.reportedAt),
  };
}

function readHostLayoutReportedAt(value: unknown): string {
  const now = Date.now();
  if (typeof value === "string") {
    const reportedAt = Date.parse(value);
    if (
      Number.isFinite(reportedAt)
      && reportedAt >= now - MAX_HOST_LAYOUT_AGE_MS
      && reportedAt <= now + MAX_HOST_LAYOUT_FUTURE_SKEW_MS
    ) {
      return value;
    }
  }
  return new Date(now).toISOString();
}

function readComputerUsePreviewReleaseMediaAck(
  value: unknown,
): ComputerUsePreviewReleaseMediaAck | undefined {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.requestId)
    || !isNonEmptyString(value.sessionId)
    || !isNonNegativeSafeInteger(value.sourceRevision)
    || !isPositiveSafeInteger(value.sourceGeneration)
    || !isComputerUsePreviewReleaseMediaStatus(value.status)
    || !isNonNegativeSafeInteger(value.releasedTrackCount)
    || typeof value.allTracksEnded !== "boolean"
  ) {
    return undefined;
  }
  return {
    requestId: value.requestId,
    sessionId: value.sessionId,
    sourceRevision: value.sourceRevision,
    sourceGeneration: value.sourceGeneration,
    status: value.status,
    releasedTrackCount: value.releasedTrackCount,
    allTracksEnded: value.allTracksEnded,
  };
}

function readHostObstacle(value: unknown): ComputerUseHostObstacle | undefined {
  const bounds = readRect(value);
  if (!bounds) {
    return undefined;
  }
  const kind = isRecord(value) && isComputerUseHostObstacleKind(value.kind)
    ? value.kind
    : "other";
  return { ...bounds, kind };
}

function readRect(value: unknown): DesktopRect | undefined {
  if (
    !isRecord(value)
    || !isFiniteNumber(value.x)
    || !isFiniteNumber(value.y)
    || !isFiniteNumber(value.width)
    || !isFiniteNumber(value.height)
    || value.width <= 0
    || value.height <= 0
    || value.width > MAX_DESKTOP_DIMENSION
    || value.height > MAX_DESKTOP_DIMENSION
    || value.x < -MAX_DESKTOP_COORDINATE
    || value.y < -MAX_DESKTOP_COORDINATE
    || value.x + value.width > MAX_DESKTOP_COORDINATE
    || value.y + value.height > MAX_DESKTOP_COORDINATE
  ) {
    return undefined;
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function isComputerUseHostObstacleKind(value: unknown): value is ComputerUseHostObstacleKind {
  return typeof value === "string" && COMPUTER_USE_HOST_OBSTACLE_KINDS.some((kind) => kind === value);
}

function isComputerUsePreviewReleaseMediaStatus(
  value: unknown,
): value is ComputerUsePreviewReleaseMediaAck["status"] {
  return typeof value === "string"
    && COMPUTER_USE_PREVIEW_RELEASE_MEDIA_STATUSES.some((status) => status === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
